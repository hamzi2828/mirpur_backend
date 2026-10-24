// src/controller/productController.js
const Product = require('../models/product');
const { toPublicPath } = require('../helper/upload');
const { processColorMedia } = require('../helper/colorMediaHelper');
const { resolveWriteBranch } = require('../middleware/access');
const {
  getMainBranchId,
  withBranchStock,
  branchStockLevelQuery,
  toBranchId,
} = require('../helper/productCodes');
const Branch = require('../models/branch');
const { productScopeFilter, canSeeProduct, ownerBranchForCreate } = require('../helper/productScope');
const stockHistory = require('../services/stockHistoryService');

// 409 for a barcode / short code that is already used (thrown by helper/productCodes.js)
const duplicateCodeResponse = (res, error) =>
  res.status(409).json({
    message: error.message,
    duplicateCode: error.duplicateCode,
    conflictProductId: error.conflictProductId,
  });


// ----- Branch view -----
// Admin calls (req.access set by loadAccess): `stock` = stock in the request's
// branch (staff: their branch; super admin: picked branch or all), plus
// `totalStock` and `branchStock` (super admin only — staff only see their own
// branch). Public calls (no req.access, e.g. the website): totals as before.
const branchView = async (req) => {
  if (!req.access) return null;
  return {
    branchId: req.access.branchId || null,
    mainBranchId: await getMainBranchId(),
    restrict: !req.access.isSuperAdmin,
  };
};

const toView = (product, view) =>
  view && product ? withBranchStock(product, view.branchId, view.mainBranchId, { restrict: view.restrict }) : product;

// Who gets the stock typed in the product form (see services/products/*).
// The super admin may pick the branch in the product form (`stockBranchId`);
// branch staff always write to their own branch.
const writeOptions = async (req) => {
  if (!req.access) return { warnings: [] }; // not wired yet -> main branch, legacy admin
  const picked = req.access.isSuperAdmin ? toBranchId(req.body && req.body.stockBranchId) : null;
  if (picked) {
    const branch = await Branch.findById(picked).select('_id').lean();
    if (!branch) {
      const err = new Error('Branch not found');
      err.status = 400;
      throw err;
    }
    return { branchId: picked, isSuperAdmin: true, allBranches: false, warnings: [] };
  }
  return {
    branchId: await resolveWriteBranch(req),
    isSuperAdmin: !!req.access.isSuperAdmin,
    allBranches: !!req.access.isSuperAdmin && !req.access.branchId,
    warnings: [],
  };
};

const uniq = (list) => [...new Set(list || [])];

// Status-carrying errors (403 no branch, 400 bad branchStock, 409 conflict).
const statusError = (res, error) => {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ message: error.message, code: typeof error.code === 'string' ? error.code : undefined });
  }
  return null;
};

const productController = {
  // GET /products - list all products with optional filters
  listProducts: async (req, res) => {
    try {
      const { status, category, search, displayOn, stockLevel } = req.query;
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const hasLimit = req.query.limit !== undefined;
      const limitNum = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 12));

      // Own branch's products + shared ones (super admin on "all branches": every product).
      const filter = { ...productScopeFilter(req) };
      const view = await branchView(req);
      // Stock conditions of the branch being viewed (null = total stock).
      const and = [];
      const addStockLevel = (level) =>
        view ? and.push(branchStockLevelQuery(view.branchId, view.mainBranchId, level)) : null;

      // Status filter
      if (status && status !== 'all') {
        if (status === 'out_of_stock') {
          if (view) addStockLevel('out');
          else filter.stock = { $lte: 0 };
        } else {
          filter.status = status;
        }
      }

      // Category filter
      if (category && category !== 'all') filter.category = category;
      // Display-on filter (website / pos / both)
      if (displayOn && ['website', 'pos', 'both'].includes(displayOn)) filter.displayOn = displayOn;
      // Stock level filter (used by /admin/products/stock) — per branch for admin calls
      if (['low', 'out', 'in'].includes(stockLevel)) {
        if (view) addStockLevel(stockLevel);
        else if (stockLevel === 'low') filter.stock = { $gt: 0, $lte: 5 };
        else if (stockLevel === 'out') filter.stock = { $lte: 0 };
        else filter.stock = { $gt: 0 };
      }

      // Search — use text index for 3+ chars, regex fallback for shorter
      if (search && search.trim()) {
        const s = search.trim();
        const scanCode = s.toUpperCase();
        // Exact barcode / short code / SKU hit (scanner or typed code) wins
        if (await Product.exists({ ...productScopeFilter(req), scanCodes: scanCode })) {
          filter.scanCodes = scanCode;
        } else if (s.length >= 3) {
          filter.$text = { $search: s };
        } else {
          const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          filter.$or = [{ name: rx }, { slug: rx }, { category: rx }];
        }
      }

      if (and.length) filter.$and = and;

      // Exclude heavy fields the list view never renders (big MBs saved).
      // The public website never gets per-branch numbers.
      const listProjection = view
        ? { description: 0, features: 0, metaSchema: 0 }
        : { description: 0, features: 0, metaSchema: 0, branchStock: 0, 'variants.branchStock': 0 };

      const findQuery = Product.find(filter, listProjection)
        .sort({ createdAt: -1 })
        .lean();

      if (hasLimit) {
        findQuery.skip((pageNum - 1) * limitNum).limit(limitNum);
      }

      const [products, total] = await Promise.all([
        findQuery,
        Product.countDocuments(filter),
      ]);

      return res.status(200).json({
        message: 'Products fetched successfully',
        data: view ? products.map((p) => toView(p, view)) : products,
        // Admin calls: which branch `stock` refers to (null = all branches).
        ...(view ? { stockBranch: view.branchId } : {}),
        pagination: {
          total,
          page: pageNum,
          limit: hasLimit ? limitNum : products.length,
          totalPages: hasLimit ? Math.max(1, Math.ceil(total / limitNum)) : 1,
          hasNextPage: hasLimit ? pageNum * limitNum < total : false,
          hasPreviousPage: pageNum > 1,
        },
      });
    } catch (error) {
      console.error('List products error:', error);
      return res.status(400).json({ message: 'Error fetching products', error: error.message });
    }
  },

  // GET /products/random - get random products for collection
  getRandomProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      
      // Get all published products with stock > 0
      const products = await Product.find({
        status: 'published',
        stock: { $gt: 0 },
        ownerBranch: null, // website: shared products only
      });
      
      // Shuffle the array and limit the results
      const shuffled = products.sort(() => Math.random() - 0.5).slice(0, limit);
      
      return res.status(200).json({ 
        message: 'Random products fetched successfully', 
        data: shuffled 
      });
    } catch (error) {
      console.error('Get random products error:', error);
      return res.status(400).json({ 
        message: 'Error fetching random products', 
        error: error.message 
      });
    }
  },

  // GET /products/latest - get latest products (public route)
  getLatestProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      
      // Get latest published products sorted by creation date
      const products = await Product.find({
        status: 'published',
        ownerBranch: null, // website: shared products only
      })
      .sort({ createdAt: -1 })
      .limit(limit);
      
      return res.status(200).json({ 
        message: 'Latest products fetched successfully', 
        data: products 
      });
    } catch (error) {
      console.error('Get latest products error:', error);
      return res.status(400).json({ 
        message: 'Error fetching latest products', 
        error: error.message 
      });
    }
  },

  // GET /products/:id - get product by id
  getProductById: async (req, res) => {
    try {
      const { id } = req.params;
      const product = await Product.findById(id);
      if (!product || !canSeeProduct(req, product)) return res.status(404).json({ message: 'Product not found' });
      const view = await branchView(req);
      return res.status(200).json({ message: 'Product fetched successfully', data: toView(product, view) });
    } catch (error) {
      console.error('Get product error:', error);
      return res.status(400).json({ message: 'Error fetching product', error: error.message });
    }
  },

  // POST /products - create a new product
  createProduct: async (req, res) => {
    try {
      const payload = req.body || {};
      const files = req.files || {};

      console.log('createProduct files:', files);
      console.log('createProduct body:', payload);
      
      // Use the createProductService to handle the creation logic
      const createProductService = require('../services/products/createProductService');
      const opts = await writeOptions(req);
      // Staff: the product belongs to their branch (only that branch sees it).
      // Super admin: shared, unless a branch is picked in `ownerBranch`.
      const ownerBranch = ownerBranchForCreate(req, payload.ownerBranch);
      if (ownerBranch && !(await Branch.exists({ _id: ownerBranch }))) {
        return res.status(400).json({ message: 'Branch not found' });
      }
      delete payload.ownerBranch;
      let created = await createProductService.createProduct(payload, files, opts);
      if (ownerBranch && created && created._id) {
        created = (await Product.findByIdAndUpdate(created._id, { $set: { ownerBranch } }, { new: true })) || created;
      }
      // Stock history: the stock typed in the form = opening stock.
      await stockHistory.recordChanges(null, created, { type: 'opening', req, note: 'Added when the product was created' });
      const view = await branchView(req);

      const productId = created && created._id ? String(created._id) : '';
      return res.status(201).json({
        message: 'Product created successfully',
        data: toView(created, view),
        ...(opts.warnings.length ? { warnings: uniq(opts.warnings) } : {}),
        // Frontend opens the sticker print flow right after creating
        next: {
          printLabels: `/products/${productId}/labels`,
          labelData: `/products/${productId}/label-data`,
        },
      });
    } catch (error) {
      if (error && error.code === 'DUPLICATE_CODE') {
        return duplicateCodeResponse(res, error);
      }
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      if (statusError(res, error)) return undefined;
      console.error('Create product error:', error);
      return res.status(400).json({ message: 'Error creating product', error: error.message });
    }
  },

  // PUT /products/:id - update a product
  updateProduct: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};
      const files = req.files || {};
      
      console.log('Update product payload:', payload);
      console.log('Update product files:', files);
      // Use the updateProductService to handle the update logic
      const updateProductService = require('../services/products/updateProductService');
      const current = await Product.findById(id).lean();
      if (!current || !canSeeProduct(req, current)) return res.status(404).json({ message: 'Product not found' });
      // Only the super admin moves a product between "shared" and one branch.
      const changeOwner = !!(req.access && req.access.isSuperAdmin) && payload.ownerBranch !== undefined;
      const newOwner = changeOwner ? ownerBranchForCreate(req, payload.ownerBranch) : null;
      if (newOwner && !(await Branch.exists({ _id: newOwner }))) {
        return res.status(400).json({ message: 'Branch not found' });
      }
      delete payload.ownerBranch;
      const opts = await writeOptions(req);
      let updated = await updateProductService.updateProduct(id, payload, files, opts);
      if (changeOwner && updated && updated._id) {
        updated = (await Product.findByIdAndUpdate(updated._id, { $set: { ownerBranch: newOwner } }, { new: true })) || updated;
      }
      // Stock history: stock typed in the product form (+ or -).
      await stockHistory.recordChanges(current, updated, { type: 'adjustment', req, note: 'Changed in the product form' });
      const view = await branchView(req);

      return res.status(200).json({
        message: 'Product updated successfully',
        data: toView(updated, view),
        ...(opts.warnings.length ? { warnings: uniq(opts.warnings) } : {}),
      });
      
    } catch (error) {
      if (error && error.code === 'DUPLICATE_CODE') {
        return duplicateCodeResponse(res, error);
      }
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      if (statusError(res, error)) return undefined;
      console.error('Update product error:', error);
      return res.status(400).json({ 
        message: 'Error updating product', 
        error: error.message 
      });
    }
  },

  // DELETE /products/:id - delete a product
  deleteProduct: async (req, res) => {
    try {
      const { id } = req.params;
      const current = await Product.findById(id).select('ownerBranch').lean();
      if (!current || !canSeeProduct(req, current)) return res.status(404).json({ message: 'Product not found' });
      const deleted = await Product.softDeleteById(id, req.user?._id || null);
      if (!deleted) return res.status(404).json({ message: 'Product not found' });
      return res.status(200).json({ message: 'Product deleted successfully', id });
    } catch (error) {
      console.error('Delete product error:', error);
      return res.status(400).json({ message: 'Error deleting product', error: error.message });
    }
  },
};

module.exports = productController;
