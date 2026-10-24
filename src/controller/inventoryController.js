// Inventory Controller — admin stock receiving and barcode / short-code tools.
// Stock is always counted in pieces (see helper/productCodes.js).
const mongoose = require('mongoose');
const Product = require('../models/product');
const stockService = require('../services/stockService');
const {
  findProductByCode,
  normalizeCode,
  variantLabel,
  generateShortCode: newShortCode,
  parseMaybeJSON,
  getMainBranchId,
  withBranchStock,
  sameBranch,
} = require('../helper/productCodes');
const { resolveWriteBranch } = require('../middleware/access');
const { productScopeFilter, canSeeProduct } = require('../helper/productScope');
const stockHistory = require('../services/stockHistoryService');

// Admin view of a product: `stock` = stock in the request's branch (staff: own
// branch; super admin: picked branch or all) — see productCodes.withBranchStock.
const branchView = async (req) => {
  if (!req.access) return { branchId: null, mainBranchId: null, restrict: false, none: true };
  return {
    branchId: req.access.branchId || null,
    mainBranchId: await getMainBranchId(),
    restrict: !req.access.isSuperAdmin,
  };
};
const toView = (product, view) =>
  view.none ? product : withBranchStock(product, view.branchId, view.mainBranchId, { restrict: view.restrict });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

const sendError = (res, error, fallbackMessage) => {
  const status = error && error.status && error.status >= 400 && error.status < 600 ? error.status : 400;
  return res.status(status).json({
    success: false,
    message:
      (error && (error.isStockError || error.code === 'DUPLICATE_CODE' || status === 403) && error.message) ||
      fallbackMessage,
    error: error && error.message,
    code: error && typeof error.code === 'string' ? error.code : undefined,
    duplicateCode: error && error.duplicateCode,
  });
};

const inventoryController = {
  // POST /products/:id/stock/receive
  // body { variantId?, quantity?, boxes?, loosePieces?, batch?: {batchNo?, barcode?, costPrice?, expiryDate?, note?} }
  // quantity wins; otherwise boxes * piecesPerBox + loosePieces.
  // Stock goes into the request's branch (resolveWriteBranch: staff -> own
  // branch, super admin -> picked branch or the main branch).
  receiveStock: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid product id' });
      const body = req.body || {};
      const batch = parseMaybeJSON(body.batch);
      const branchId = req.access ? await resolveWriteBranch(req) : undefined;
      // A branch's own product can only get stock in that branch.
      const owner = await Product.findById(id).select('ownerBranch').lean();
      if (!owner || !canSeeProduct(req, owner, branchId)) {
        return res.status(404).json({ success: false, message: 'Product not found in this branch' });
      }

      const result = await stockService.receiveStock({
        productId: id,
        variantId: body.variantId || undefined,
        quantity: body.quantity,
        boxes: body.boxes,
        loosePieces: body.loosePieces,
        batch: batch && typeof batch === 'object' ? batch : undefined,
        branchId,
      });
      await stockHistory.recordReceive(result, { req, body: { ...body, costPrice: batch && batch.costPrice } });
      const view = await branchView(req);
      const branchName = await stockService.branchName(result.branchId);

      return res.status(200).json({
        success: true,
        data: toView(result.product, view),
        batch: result.batch, // null when no batch was created (plain stock)
        received: result.quantity,
        variantId: result.variantId,
        branchId: result.branchId,
        message: `Received ${result.quantity} piece(s)${result.batch ? ` into batch ${result.batch.batchNo}` : ''} in ${branchName}`,
      });
    } catch (error) {
      console.error('Receive stock error:', error);
      return sendError(res, error, 'Error receiving stock');
    }
  },

  // GET /products/codes/check?code=X&excludeId=Y
  // Is this code free to use (not on any other product)?
  checkCode: async (req, res) => {
    try {
      const code = normalizeCode(req.query.code);
      if (!code) return res.status(400).json({ success: false, message: 'Code is required' });
      const { excludeId } = req.query;

      const filter = { scanCodes: code };
      if (excludeId) {
        if (!isValidId(excludeId)) return res.status(400).json({ success: false, message: 'Invalid excludeId' });
        filter._id = { $ne: excludeId };
      }
      // Codes are unique across ALL branches; a product of another branch is
      // reported without its name.
      const owner = await Product.findOne(filter, { name: 1, ownerBranch: 1 }).lean();
      const visible = owner && canSeeProduct(req, owner);
      const result = {
        code,
        available: !owner,
        usedBy: owner
          ? visible
            ? { productId: owner._id, name: owner.name }
            : { productId: null, name: "another branch's product" }
          : undefined,
      };
      return res.status(200).json({ success: true, ...result, data: result });
    } catch (error) {
      console.error('Check code error:', error);
      return sendError(res, error, 'Error checking code');
    }
  },

  // GET /products/codes/lookup/:code — admin version of the POS scan (any status).
  lookupCode: async (req, res) => {
    try {
      const found = await findProductByCode(req.params.code, productScopeFilter(req));
      if (!found) return res.status(404).json({ success: false, message: 'No product uses this code' });

      const { product, match: m } = found;
      const view = await branchView(req);
      const here = toView(product, view);
      const unit = m.variant || (product.productType === 'variant' ? null : product);
      // The same unit as seen from this branch (its batches = this branch's batches).
      const hereUnit = m.variantId
        ? (here.variants || []).find((v) => String(v.variantId) === String(m.variantId))
        : product.productType === 'variant' ? null : here;
      let batch = null;
      if (m.batchNo && unit) {
        const list = (hereUnit && hereUnit.batches) || unit.batches || [];
        batch = list.find((b) => normalizeCode(b.batchNo) === m.batchNo) || null;
        // Lot not in this branch: show it anyway (other branch's batch).
        if (!batch && unit.batches) batch = unit.batches.find((b) => normalizeCode(b.batchNo) === m.batchNo) || null;
        if (batch && view.branchId && !sameBranch(batch.branch || view.mainBranchId, view.branchId)) {
          batch = { ...(typeof batch.toObject === 'function' ? batch.toObject() : batch), quantity: 0 };
        }
      }
      const match = {
        variantId: m.variantId || null,
        batchNo: m.batchNo || null,
        qty: m.qty || 1,
        kind: m.kind,
        code: m.code,
        variantLabel: variantLabel(m.variant),
        // pieces in the request's branch (all branches for super admin without one)
        available: unit
          ? stockService.unitAvailable(unit, view.branchId, view.mainBranchId)
          : Math.max(0, Number(here.stock) || 0),
        batch,
        branchId: view.branchId,
      };
      return res.status(200).json({ success: true, data: here, match, message: 'Product found' });
    } catch (error) {
      console.error('Lookup code error:', error);
      return sendError(res, error, 'Error looking up code');
    }
  },

  // GET /products/codes/new-short-code — a free short code to pre-fill a form.
  // Not reserved: it is checked again when the product is saved.
  generateShortCode: async (req, res) => {
    try {
      const shortCode = await newShortCode();
      return res.status(200).json({ success: true, shortCode, data: { shortCode } });
    } catch (error) {
      console.error('Generate short code error:', error);
      return sendError(res, error, 'Error generating short code');
    }
  },
};

module.exports = inventoryController;
