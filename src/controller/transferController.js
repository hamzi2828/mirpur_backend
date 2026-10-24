// src/controller/transferController.js
// Stock transfers between branches. Creating a transfer moves the stock right
// away (no pending state): each line goes through stockService.transferStock
// (one guarded write per product); lines that fail are recorded with the reason.
//
// Routes (wired in routes with auth + loadAccess + requirePermission('stock_transfers', ...)):
//   GET  /admin/stock-transfers       list   ?from=&to=&status=&search=&productId=&startDate=&endDate=&page=&limit=
//   GET  /admin/stock-transfers/:id   getById
//   POST /admin/stock-transfers       create { fromBranchId, toBranchId, items: [{ productId, variantId?, quantity, batchNo? }], note? }
//
// Branch staff see only transfers from/to their branch and may only send FROM
// their own branch. The super admin sees all (or the branch picked with
// x-branch-id / ?branchId) and may send between any two branches.
// To undo a transfer, create the opposite transfer.

const mongoose = require('mongoose');
const StockTransfer = require('../models/stockTransfer');
const Branch = require('../models/branch');
const Product = require('../models/product');
const stockService = require('../services/stockService');
const { variantLabel, toBranchId, sameBranch } = require('../helper/productCodes');

const MAX_ITEMS = 200;
const MAX_SAVE_ATTEMPTS = 5;

const isValidId = (id) => !!id && mongoose.Types.ObjectId.isValid(String(id)) && /^[0-9a-fA-F]{24}$/.test(String(id));
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

const needAccess = (req, res) => {
  if (!req.access) {
    fail(res, 500, 'Access not loaded');
    return false;
  }
  if (!req.access.isSuperAdmin && !req.access.branchId) {
    fail(res, 403, 'Your account is not assigned to a branch. Ask the super admin.');
    return false;
  }
  return true;
};

// "2026-10-17" -> start / end of that day; full ISO strings are used as given.
const parseDate = (value, endOfDay) => {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) d.setUTCHours(23, 59, 59, 999);
  return d;
};

const populateQuery = (q) =>
  q
    .populate('fromBranch', 'name code isMain')
    .populate('toBranch', 'name code isMain')
    .populate('createdBy', 'firstName lastName email');

const involves = (transfer, branchId) => {
  const id = (b) => (b && b._id ? b._id : b);
  return sameBranch(id(transfer.fromBranch), branchId) || sameBranch(id(transfer.toBranch), branchId);
};

// Name / label of a product line, best effort (used for failed lines).
const describeLine = async (productId, variantId) => {
  try {
    let q = Product.findById(productId);
    if (q && typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
    if (q && typeof q.select === 'function') q = q.select('name sku productType variants');
    if (q && typeof q.lean === 'function') q = q.lean();
    const p = await q;
    if (!p) return { productName: '', variantLabel: '', sku: '' };
    const picked = stockService.pickUnit(p, variantId, { required: false });
    const v = picked && picked.variant;
    return { productName: p.name || '', variantLabel: v ? variantLabel(v) : '', sku: (v ? v.sku : p.sku) || '' };
  } catch (_) {
    return { productName: '', variantLabel: '', sku: '' };
  }
};

const transferController = {
  // GET /admin/stock-transfers
  list: async (req, res) => {
    try {
      if (!needAccess(req, res)) return undefined;
      const access = req.access;
      const q = req.query || {};
      const and = [];

      // Branch scope: staff -> own branch; super admin -> picked branch (if any).
      if (access.branchId) {
        const b = new mongoose.Types.ObjectId(String(access.branchId));
        and.push({ $or: [{ fromBranch: b }, { toBranch: b }] });
      }

      const from = q.from || q.fromBranchId || q.fromBranch;
      const to = q.to || q.toBranchId || q.toBranch;
      if (from) {
        if (!isValidId(from)) return fail(res, 400, 'Invalid from branch');
        and.push({ fromBranch: new mongoose.Types.ObjectId(String(from)) });
      }
      if (to) {
        if (!isValidId(to)) return fail(res, 400, 'Invalid to branch');
        and.push({ toBranch: new mongoose.Types.ObjectId(String(to)) });
      }
      if (q.status && ['completed', 'partial', 'failed'].includes(q.status)) and.push({ status: q.status });
      if (q.productId) {
        if (!isValidId(q.productId)) return fail(res, 400, 'Invalid productId');
        and.push({ 'items.product': new mongoose.Types.ObjectId(String(q.productId)) });
      }
      if (q.search && String(q.search).trim()) {
        const rx = new RegExp(escapeRegex(String(q.search).trim()), 'i');
        and.push({ $or: [{ transferNo: rx }, { 'items.productName': rx }, { note: rx }] });
      }
      const start = parseDate(q.startDate || q.dateFrom, false);
      const end = parseDate(q.endDate || q.dateTo, true);
      if (start === undefined || end === undefined) return fail(res, 400, 'Invalid date');
      if (start || end) {
        const createdAt = {};
        if (start) createdAt.$gte = start;
        if (end) createdAt.$lte = end;
        and.push({ createdAt });
      }

      const filter = and.length ? { $and: and } : {};
      const page = Math.max(1, parseInt(q.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));

      const [rows, total] = await Promise.all([
        populateQuery(
          StockTransfer.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
        ).lean(),
        StockTransfer.countDocuments(filter),
      ]);

      return res.status(200).json({
        success: true,
        message: 'Stock transfers fetched successfully',
        data: rows,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          hasNextPage: page * limit < total,
          hasPreviousPage: page > 1,
        },
      });
    } catch (error) {
      console.error('List stock transfers error:', error);
      return fail(res, 500, 'Error fetching stock transfers', { error: error.message });
    }
  },

  // GET /admin/stock-transfers/:id
  getById: async (req, res) => {
    try {
      if (!needAccess(req, res)) return undefined;
      const { id } = req.params;
      if (!isValidId(id)) return fail(res, 400, 'Invalid transfer id');
      const transfer = await populateQuery(StockTransfer.findById(id)).lean();
      if (!transfer) return fail(res, 404, 'Stock transfer not found');
      if (!req.access.isSuperAdmin && !involves(transfer, req.access.branchId)) {
        return fail(res, 403, 'This transfer does not involve your branch');
      }
      return res.status(200).json({ success: true, message: 'Stock transfer fetched successfully', data: transfer });
    } catch (error) {
      console.error('Get stock transfer error:', error);
      return fail(res, 500, 'Error fetching stock transfer', { error: error.message });
    }
  },

  // POST /admin/stock-transfers
  create: async (req, res) => {
    try {
      if (!needAccess(req, res)) return undefined;
      const access = req.access;
      const body = req.body || {};

      const fromRaw = body.fromBranchId || body.fromBranch || (!access.isSuperAdmin ? access.branchId : null);
      const toRaw = body.toBranchId || body.toBranch;
      const from = toBranchId(fromRaw);
      const to = toBranchId(toRaw);
      if (!from) return fail(res, 400, 'Choose the branch to send stock from (fromBranchId)');
      if (!to) return fail(res, 400, 'Choose the branch to send stock to (toBranchId)');
      if (from === to) return fail(res, 400, 'From and to branch must be different');
      if (!access.isSuperAdmin && !sameBranch(from, access.branchId)) {
        return fail(res, 403, 'You can only transfer stock from your own branch');
      }

      let bq = Branch.find({ _id: { $in: [from, to] } });
      if (bq && typeof bq.select === 'function') bq = bq.select('name code isActive isMain');
      if (bq && typeof bq.lean === 'function') bq = bq.lean();
      const branches = (await bq) || [];
      const fromBranch = branches.find((b) => sameBranch(b._id, from));
      const toBranch = branches.find((b) => sameBranch(b._id, to));
      if (!fromBranch) return fail(res, 404, 'From branch not found');
      if (!toBranch) return fail(res, 404, 'To branch not found');
      if (fromBranch.isActive === false) return fail(res, 400, `${fromBranch.name} is inactive`);
      if (toBranch.isActive === false) return fail(res, 400, `${toBranch.name} is inactive`);

      let items = body.items;
      if (typeof items === 'string') {
        try {
          items = JSON.parse(items);
        } catch (_) {
          items = null;
        }
      }
      if (!Array.isArray(items) || !items.length) return fail(res, 400, 'Add at least one item to transfer');
      if (items.length > MAX_ITEMS) return fail(res, 400, `Too many items (max ${MAX_ITEMS})`);
      const lines = [];
      for (let index = 0; index < items.length; index++) {
        const it = items[index];
        const productId = it && (it.productId || it.product);
        if (!isValidId(productId)) return fail(res, 400, `items[${index}].productId is invalid`, { index });
        const quantity = Number(it.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          return fail(res, 400, `items[${index}].quantity must be a whole number of pieces (1 or more)`, { index });
        }
        lines.push({
          productId: String(productId),
          variantId: it.variantId ? String(it.variantId) : null,
          quantity,
          batchNo: it.batchNo ? String(it.batchNo).trim().toUpperCase() : null,
        });
      }

      // A branch's own product (ownerBranch set) stays in that branch: it can't be
      // sent to another branch (the super admin can make it shared first).
      const owned = await Product.find({
        _id: { $in: [...new Set(lines.map((l) => l.productId))] },
        ownerBranch: { $ne: null },
      }).select('name ownerBranch').lean();
      if (owned && owned.length) {
        const p = owned[0];
        const ownerName = (branches.find((b) => sameBranch(b._id, p.ownerBranch)) || {}).name || 'another branch';
        return fail(res, 400, `"${p.name}" belongs to ${ownerName} only and can't be moved to another branch`);
      }

      // Move the stock, line by line.
      const resultItems = [];
      const errors = [];
      let moved = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        try {
          const r = await stockService.transferStock({
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity,
            fromBranchId: from,
            toBranchId: to,
            batchNo: line.batchNo,
          });
          const picked = stockService.pickUnit(r.product, r.variantId, { required: false });
          const v = picked && picked.variant;
          resultItems.push({
            product: line.productId,
            productName: r.product.name || '',
            variantId: r.variantId || null,
            variantLabel: v ? variantLabel(v) : '',
            sku: (v ? v.sku : r.product.sku) || '',
            quantity: line.quantity,
            batchNo: line.batchNo,
            allocations: r.allocations || [],
            status: 'done',
            error: '',
          });
          moved += line.quantity;
        } catch (e) {
          if (!e.isStockError) console.error('Stock transfer line error:', e);
          const info = await describeLine(line.productId, line.variantId);
          resultItems.push({
            product: line.productId,
            ...info,
            variantId: line.variantId,
            quantity: line.quantity,
            batchNo: line.batchNo,
            allocations: [],
            status: 'failed',
            error: e.message,
          });
          errors.push({ index, productId: line.productId, variantId: line.variantId, message: e.message });
        }
      }

      const doneCount = resultItems.filter((i) => i.status === 'done').length;
      const status = doneCount === resultItems.length ? 'completed' : doneCount ? 'partial' : 'failed';

      // Save the record (stock already moved: retry on a transferNo clash).
      let created = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS && !created; attempt++) {
        try {
          const transferNo = await StockTransfer.generateTransferNo();
          created = await StockTransfer.create({
            transferNo,
            fromBranch: from,
            toBranch: to,
            items: resultItems,
            note: body.note ? String(body.note).trim().slice(0, 1000) : '',
            status,
            totalQuantity: moved,
            createdBy: access.userId || null,
          });
        } catch (e) {
          lastErr = e;
          if (!(e && e.code === 11000)) break;
        }
      }
      if (!created) {
        console.error('[stock-transfer] stock moved but record not saved:', JSON.stringify({ from, to, resultItems }), lastErr);
        return fail(res, 500, 'Stock was moved but the transfer record could not be saved. Please tell the admin.', {
          items: resultItems,
          error: lastErr && lastErr.message,
        });
      }

      const plain = typeof created.toObject === 'function' ? created.toObject() : created;
      const data = {
        ...plain,
        fromBranch: { _id: fromBranch._id, name: fromBranch.name, code: fromBranch.code },
        toBranch: { _id: toBranch._id, name: toBranch.name, code: toBranch.code },
      };

      if (status === 'failed') {
        return res.status(400).json({ success: false, message: 'Nothing was transferred', data, errors });
      }
      return res.status(201).json({
        success: true,
        message:
          status === 'completed'
            ? `Moved ${moved} piece(s) from ${fromBranch.name} to ${toBranch.name}`
            : `Moved ${moved} piece(s) from ${fromBranch.name} to ${toBranch.name}; ${errors.length} line(s) failed`,
        data,
        errors,
      });
    } catch (error) {
      console.error('Create stock transfer error:', error);
      return fail(res, 500, 'Error creating stock transfer', { error: error.message });
    }
  },
};

module.exports = transferController;
