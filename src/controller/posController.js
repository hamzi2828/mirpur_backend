// POS Controller — sales, customers, orders, dashboard stats.
// POS customers share the main User collection so records created here show
// up in /admin/users and vice-versa.
const Product = require('../models/product');
const User = require('../models/user');
const POSOrder = require('../models/posOrder');
const Category = require('../models/category');
const { PAYMENT_NOTES, PAYMENT_STATUS } = require('../constants/paymentNotes');
const { findProductByCode, resolveScan, variantLabel, normalizeCode } = require('../helper/productCodes');
const stockService = require('../services/stockService');
const Branch = require('../models/branch');
const { resolveWriteBranch } = require('../middleware/access');
const { productScopeFilter } = require('../helper/productScope');
const {
  getMainBranchId,
  scopedBranchFilter,
  branchScope,
  byBranchBreakdown,
  unitBranchStock,
  withBranchStock,
  branchProductStockQuery,
  sameId,
} = require('../helper/branchScope');

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Branch the POS sells from: branch staff -> their branch; super admin -> the
// picked branch, or the main branch when none is picked. Sends 403 and returns
// null when the user has no branch.
const posBranchOr403 = async (req, res) => {
  try {
    return String(await resolveWriteBranch(req));
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ success: false, message: err.message });
      return null;
    }
    throw err;
  }
};

// May this user see other branches' stock? (super admin / stock_transfers view)
const seesOtherBranches = (req) => {
  const a = req.access || {};
  return !!a.isSuperAdmin || (typeof a.can === 'function' && a.can('stock_transfers', 'view'));
};

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc);

// Put an order's pieces back into stock exactly once. The stockRestored flag is
// claimed atomically first, so two delete/refund clicks can't restore twice.
// Pieces go back to the ORDER's branch (old orders without one -> main branch),
// not to the branch of whoever clicks refund/delete.
const restoreOrderStockOnce = async (order) => {
  if (order.stockRestored) return { claimed: false, errors: [] };
  const claim = await POSOrder.updateOne(
    { _id: order._id, stockRestored: { $ne: true } },
    { $set: { stockRestored: true } }
  );
  order.stockRestored = true;
  const modified = claim ? (claim.modifiedCount !== undefined ? claim.modifiedCount : claim.nModified) : 0;
  if (!modified) return { claimed: false, errors: [] };
  const orderBranch = order.branch && order.branch._id ? order.branch._id : order.branch;
  const branchId = orderBranch ? String(orderBranch) : await getMainBranchId();
  const { errors } = await stockService.restoreOrderItems(order.items, { branchId });
  return { claimed: true, errors };
};

const posController = {
  // GET /api/pos/products — published products visible on POS with stock > 0
  // in the POS branch. `stock` (and variants[].stock / batches) = this branch's
  // stock; `totalStock` = all branches.
  getProducts: async (req, res) => {
    try {
      const { search, category, limit } = req.query;
      const branchId = await posBranchOr403(req, res);
      if (!branchId) return undefined;
      const mainBranchId = await getMainBranchId();

      const query = {
        status: 'published',
        displayOn: { $in: ['pos', 'both'] },
        ...productScopeFilter(req, branchId), // shared + this branch's own products
        $and: [branchProductStockQuery(branchId, mainBranchId)],
      };

      if (category) query.category = category;

      if (search) {
        const searchWords = String(search).trim().split(/\s+/).filter(Boolean);
        if (searchWords.length) {
          const wordPatterns = searchWords.map(escapeRegex);
          const allWordsPattern = wordPatterns.map((w) => `(?=.*${w})`).join('');
          const anyWordPattern = wordPatterns.join('|');
          const raw = escapeRegex(search);

          query.$or = [
            { name: { $regex: allWordsPattern, $options: 'i' } },
            { name: { $regex: anyWordPattern, $options: 'i' } },
            { slug: { $regex: raw, $options: 'i' } },
            { category: { $regex: raw, $options: 'i' } },
            { 'variants.sku': { $regex: raw, $options: 'i' } },
            { tags: { $regex: raw, $options: 'i' } },
            // exact barcode / short code / batch code
            { scanCodes: String(search).trim().toUpperCase() },
          ];
        }
      }

      let productsQuery = Product.find(query).sort({ name: 1 });
      if (limit) productsQuery = productsQuery.limit(parseInt(limit, 10));

      const found = await productsQuery.lean();
      const products = (found || [])
        .map((p) => withBranchStock(p, branchId, mainBranchId, { restrict: !seesOtherBranches(req) }))
        .filter((p) => (Number(p.stock) || 0) > 0);

      return res.status(200).json({
        success: true,
        data: products,
        branchId,
        message: 'Products fetched successfully',
      });
    } catch (error) {
      console.error('Get POS products error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching products', error: error.message });
    }
  },

  // GET /api/pos/products/barcode/:barcode — any scanned/typed code: short code,
  // barcode, box / full-box code, batch code, SKU or slug.
  // data = the product (unchanged for the frontend); match = what the code means.
  // Stock numbers are for the POS branch (same branch createOrder sells from).
  // match.otherBranches = [{ branchId, name, code, stock }] where this unit has
  // stock elsewhere — only for super admin or users who can view stock_transfers.
  getProductByBarcode: async (req, res) => {
    try {
      const { barcode } = req.params;
      const branchId = await posBranchOr403(req, res);
      if (!branchId) return undefined;
      const mainBranchId = await getMainBranchId();
      const found = await findProductByCode(barcode, {
        ...productScopeFilter(req, branchId), // other branches' own products: "not found"
        // out_of_stock included so the cashier sees "out of stock" instead of "not found"
        status: { $in: ['published', 'out_of_stock'] },
        displayOn: { $in: ['pos', 'both'] },
      });
      if (!found) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      const { product, match: m } = found;

      // Variant product found by a product-level code (slug) with only one variant -> use it.
      let variant = m.variant;
      let variantId = m.variantId;
      if (!variant && product.productType === 'variant' && (product.variants || []).length === 1) {
        variant = product.variants[0];
        variantId = variant.variantId;
      }
      // Plain copies: per-branch fields (branchStock, batch.branch) read reliably.
      const plain = toPlain(product);
      let unit = null;
      if (variant) unit = (plain.variants || []).find((v) => String(v.variantId) === String(variantId)) || toPlain(variant);
      else if (product.productType !== 'variant') unit = plain;
      // Product as seen from this branch: stock / variants[].stock / batches = here.
      const here = withBranchStock(plain, branchId, mainBranchId, { restrict: !seesOtherBranches(req) });
      const available = unit
        ? Math.max(0, Number(stockService.unitAvailable(unit, branchId, mainBranchId)) || 0)
        : Math.max(0, Number(here.stock) || 0);

      // Batch info from this branch's batches only (quantity = pieces here).
      let batch = null;
      if (m.batchNo && unit) {
        const hereUnit = variantId
          ? (here.variants || []).find((v) => String(v.variantId) === String(variantId))
          : here;
        const b = ((hereUnit && hereUnit.batches) || []).find((x) => normalizeCode(x.batchNo) === m.batchNo);
        if (b) batch = { batchNo: b.batchNo, quantity: b.quantity, expiryDate: b.expiryDate, costPrice: b.costPrice };
      }

      const match = {
        variantId: variantId || null,
        batchNo: m.batchNo || null,
        qty: m.qty || 1, // pieces one scan of this code sells (full-box code = piecesPerBox)
        kind: m.kind,
        code: m.code,
        variantLabel: variantLabel(variant),
        available,
        batch,
        branchId,
      };

      // Other branches holding this unit (lets the cashier say "available in Branch 2").
      const branches = await Branch.find({ isActive: { $ne: false } }).select('name code isMain').lean();
      const branchName = (branches.find((b) => sameId(b._id, branchId)) || {}).name || 'this branch';
      if (seesOtherBranches(req)) {
        match.otherBranches = branches
          .filter((b) => !sameId(b._id, branchId))
          .map((b) => ({
            branchId: String(b._id),
            name: b.name,
            code: b.code,
            stock: unit
              ? unitBranchStock(unit, String(b._id), mainBranchId)
              : Number(withBranchStock(plain, String(b._id), mainBranchId).stock) || 0,
          }))
          .filter((b) => b.stock > 0);
      }

      const label = match.variantLabel ? `${product.name} (${match.variantLabel})` : product.name;
      if (available <= 0) {
        return res.status(400).json({
          success: false,
          data: here,
          match,
          message: `${label} is out of stock in ${branchName}`,
        });
      }
      if (available < match.qty) {
        return res.status(400).json({
          success: false,
          data: here,
          match,
          message: `Not enough stock for ${label} in ${branchName}. Available: ${available}, this code sells ${match.qty}`,
        });
      }
      return res.status(200).json({ success: true, data: here, match, message: 'Product fetched successfully' });
    } catch (error) {
      console.error('Get product by barcode error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching product', error: error.message });
    }
  },

  // GET /api/pos/categories — distinct category list
  getCategories: async (req, res) => {
    try {
      let categoryNames = [];
      try {
        const categories = await Category.find().select('name').sort({ name: 1 });
        categoryNames = categories.map((c) => c.name).filter(Boolean);
      } catch (_) {
        // Fallback to distinct on Product if Category schema lookup fails
      }
      if (!categoryNames.length) {
        categoryNames = await Product.distinct('category', {
          status: 'published',
          displayOn: { $in: ['pos', 'both'] },
        });
        categoryNames = categoryNames.filter(Boolean).sort();
      }
      return res.status(200).json({ success: true, data: categoryNames, message: 'Categories fetched successfully' });
    } catch (error) {
      console.error('Get categories error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching categories', error: error.message });
    }
  },

  // GET /api/pos/customers — active POS customers
  getCustomers: async (req, res) => {
    try {
      const customers = await User.find({
        isActive: true,
        isDeleted: { $ne: true },
        role: { $ne: 'admin' },
      })
        .select('firstName lastName email phone carDetails addresses customerType source role')
        .sort({ firstName: 1 });
      return res.status(200).json({ success: true, data: customers, message: 'Customers fetched successfully' });
    } catch (error) {
      console.error('Get customers error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customers', error: error.message });
    }
  },

  // GET /api/pos/customers/search?q=
  searchCustomers: async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) return posController.getCustomers(req, res);

      const raw = escapeRegex(q);
      const customers = await User.find({
        isActive: true,
        isDeleted: { $ne: true },
        role: { $ne: 'admin' },
        $or: [
          { firstName: { $regex: raw, $options: 'i' } },
          { lastName: { $regex: raw, $options: 'i' } },
          { email: { $regex: raw, $options: 'i' } },
          { phone: { $regex: raw, $options: 'i' } },
          { 'carDetails.brand': { $regex: raw, $options: 'i' } },
          { 'carDetails.model': { $regex: raw, $options: 'i' } },
          { 'carDetails.numberPlate': { $regex: raw, $options: 'i' } },
        ],
      })
        .select('firstName lastName email phone carDetails address customerType source')
        .sort({ firstName: 1 })
        .limit(20);

      return res.status(200).json({ success: true, data: customers, message: 'Customers fetched successfully' });
    } catch (error) {
      console.error('Search customers error:', error);
      return res.status(400).json({ success: false, message: 'Error searching customers', error: error.message });
    }
  },

  // GET /api/pos/customers/:id
  getCustomerById: async (req, res) => {
    try {
      const customer = await User.findById(req.params.id).select(
        'firstName lastName email phone carDetails address customerType source'
      );
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }
      return res.status(200).json({ success: true, data: customer, message: 'Customer fetched successfully' });
    } catch (error) {
      console.error('Get customer by ID error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customer', error: error.message });
    }
  },

  // POST /api/pos/customers — find by email or phone, otherwise create.
  // Email is required (matches the /admin/users profile flow).
  createOrFindCustomer: async (req, res) => {
    try {
      const { firstName, lastName, email, phone, vehicleName } = req.body;
      if (!firstName || !firstName.trim()) {
        return res.status(400).json({ success: false, message: 'Customer name is required' });
      }
      if (!email || !email.trim()) {
        return res.status(400).json({ success: false, message: 'Email is required' });
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address' });
      }
      if (!phone || !phone.trim()) {
        return res.status(400).json({ success: false, message: 'Mobile number is required' });
      }
      if (!vehicleName || !vehicleName.trim()) {
        return res.status(400).json({ success: false, message: 'Vehicle name is required' });
      }

      // Try email first (the unique key on User), then fall back to phone.
      let customer = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } });
      if (!customer) {
        customer = await User.findOne({ phone: phone.trim(), isDeleted: { $ne: true } });
      }

      if (customer) {
        const exists = customer.carDetails?.some(
          (c) => c.model?.toLowerCase() === vehicleName.trim().toLowerCase()
        );
        if (!exists) {
          customer.carDetails = customer.carDetails || [];
          customer.carDetails.push({ brand: '', model: vehicleName.trim(), numberPlate: '' });
        }
        // Back-fill phone if it was missing before.
        if (!customer.phone) customer.phone = phone.trim();
        await customer.save();
        return res.status(200).json({ success: true, data: customer, message: 'Existing customer found', isNew: false });
      }

      customer = new User({
        firstName: firstName.trim(),
        lastName: lastName?.trim() || 'Customer',
        email: normalizedEmail,
        role: 'user',
        phone: phone.trim(),
        customerType: 'walk-in',
        carDetails: [{ brand: '', model: vehicleName.trim(), numberPlate: '' }],
        isActive: true,
      });
      await customer.save();

      return res.status(201).json({ success: true, data: customer, message: 'Customer created successfully', isNew: true });
    } catch (error) {
      console.error('Create/find customer error:', error);
      return res.status(400).json({ success: false, message: 'Error creating customer', error: error.message });
    }
  },

  // POST /api/pos/customers/:id/cars — add a car to an existing customer.
  // Body: { brand, model, numberPlate? }. Silent dedupe on (brand, model,
  // numberPlate) to avoid duplicate rows from repeated clicks.
  addCustomerCar: async (req, res) => {
    try {
      const { id } = req.params;
      const { brand, model, numberPlate } = req.body || {};
      if (!brand || !String(brand).trim()) {
        return res.status(400).json({ success: false, message: 'Brand is required' });
      }
      if (!model || !String(model).trim()) {
        return res.status(400).json({ success: false, message: 'Model is required' });
      }

      const customer = await User.findOne({ _id: id, isDeleted: { $ne: true } });
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      const newCar = {
        brand: String(brand).trim(),
        model: String(model).trim(),
        numberPlate: String(numberPlate || '').trim(),
      };

      // Duplicate detection. A plate alone is enough for a collision (plates
      // are unique in practice). Otherwise match on brand+model exactly.
      const existing = (customer.carDetails || []).find((c) => {
        const sameBrand = (c.brand || '').toLowerCase() === newCar.brand.toLowerCase();
        const sameModel = (c.model || '').toLowerCase() === newCar.model.toLowerCase();
        const samePlate =
          newCar.numberPlate &&
          (c.numberPlate || '').toLowerCase() === newCar.numberPlate.toLowerCase();
        if (samePlate) return true;
        if (sameBrand && sameModel) {
          // If both have a plate but differ, they're different cars.
          if (newCar.numberPlate && (c.numberPlate || '').trim()) {
            return samePlate;
          }
          return true;
        }
        return false;
      });

      if (existing) {
        return res.status(409).json({
          success: false,
          message: `This car is already on ${customer.firstName}'s garage${existing.numberPlate ? ` (plate: ${existing.numberPlate})` : ''}.`,
          data: customer,
          code: 'duplicate_car',
        });
      }

      customer.carDetails = customer.carDetails || [];
      customer.carDetails.push(newCar);
      await customer.save();

      return res.status(200).json({
        success: true,
        data: customer,
        message: 'Car added to customer',
      });
    } catch (error) {
      console.error('Add customer car error:', error);
      return res.status(400).json({ success: false, message: 'Error adding car', error: error.message });
    }
  },

  // POST /api/pos/orders — create sale, validate stock, deduct inventory
  createOrder: async (req, res) => {
    try {
      const {
        items,
        customer,
        customerInfo,
        subtotal,
        tax,
        appliedTaxes,
        discount,
        discountType,
        discountReason,
        total,
        paymentMethod,
        cashAmount,
        cardAmount,
        change,
        bankTransferScreenshot,
        notes,
        isPartialPayment,
        paidAmount: requestedPaidAmount,
      } = req.body;

      const cashierId = req.user?._id || req.user?.id;
      if (!cashierId) {
        return res.status(401).json({ success: false, message: 'Authentication required - cashier not found' });
      }
      if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Order must have at least one item' });
      }
      if (!paymentMethod) {
        return res.status(400).json({ success: false, message: 'Payment method is required' });
      }

      // Branch this sale belongs to; stock is taken from this branch only.
      const branchId = await posBranchOr403(req, res);
      if (!branchId) return undefined;
      const branchDoc = await Branch.findById(branchId).select('name code').lean();

      // Partial payment logic
      let actualPaidAmount = total;
      let actualPendingAmount = 0;
      let actualPaymentStatus = PAYMENT_STATUS.FULL;
      let actualOrderStatus = 'completed';

      if (isPartialPayment && requestedPaidAmount !== undefined) {
        actualPaidAmount = parseFloat(requestedPaidAmount) || 0;
        actualPendingAmount = Math.max(0, total - actualPaidAmount);
        if (actualPendingAmount > 0) {
          actualPaymentStatus = actualPaidAmount > 0 ? PAYMENT_STATUS.PARTIAL : PAYMENT_STATUS.PENDING;
          actualOrderStatus = 'pending';
        } else {
          actualPaymentStatus = PAYMENT_STATUS.FULL;
        }
      }

      // Items that only carry a scanned code: fill product / variant / batch from it.
      const orderItems = [];
      for (const raw of items) {
        const item = { ...raw };
        delete item.batchAllocations; // always computed here
        if (!item.isLabour && !item.isOutsource) {
          const qty = Number(item.quantity);
          if (!Number.isInteger(qty) || qty < 1) {
            return res.status(400).json({ success: false, message: 'Item quantity must be a whole number of at least 1' });
          }
          if (item.scannedCode && (!item.product || !item.variantId)) {
            let product = null;
            let match = null;
            if (item.product) {
              product = await Product.findById(item.product);
              match = product ? resolveScan(product, item.scannedCode) : null;
            } else {
              const found = await findProductByCode(item.scannedCode);
              if (found) ({ product, match } = found);
            }
            if (!product) {
              return res.status(404).json({ success: false, message: `Product not found: ${item.product || item.scannedCode}` });
            }
            item.product = product._id;
            if (match) {
              if (!item.variantId && match.variantId) item.variantId = match.variantId;
              if (!item.batchNo && match.batchNo) item.batchNo = match.batchNo;
            }
          }
          if (!item.product) {
            return res.status(400).json({ success: false, message: 'Each product item needs a product' });
          }
        }
        orderItems.push(item);
      }

      // Deduct stock FIRST: this checks and reserves the pieces in one safe step,
      // so two counters can never sell the same last piece.
      let deducted;
      try {
        deducted = await stockService.deductOrderItems(orderItems, { branchId });
      } catch (stockErr) {
        if (stockErr.isStockError) {
          return res.status(stockErr.status || 400).json({ success: false, message: stockErr.message });
        }
        throw stockErr;
      }
      orderItems.forEach((item, i) => {
        if (deducted[i]) item.batchAllocations = deducted[i].allocations;
      });

      let order;
      try {
        const orderNumber = await POSOrder.generateOrderNumber();

        const initialPaymentHistoryStatus = isPartialPayment ? actualPaymentStatus : PAYMENT_STATUS.FULL;
        const initialPaymentHistory = actualPaidAmount > 0
          ? [
              {
                amount: actualPaidAmount,
                paymentMethod,
                paidAt: new Date(),
                receivedBy: cashierId,
                note: isPartialPayment ? PAYMENT_NOTES.INITIAL_PARTIAL : PAYMENT_NOTES.FULL,
                paymentStatus: initialPaymentHistoryStatus,
                bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined,
              },
            ]
          : [];

        const orderData = {
          orderNumber,
          branch: branchId,
          branchCode: (branchDoc && branchDoc.code) || '',
          customer: customer || undefined,
          customerInfo: customerInfo || undefined,
          items: orderItems,
          subtotal,
          tax,
          appliedTaxes: appliedTaxes || [],
          discount: discount || 0,
          discountType: discountType || null,
          discountReason: discountReason || '',
          total,
          paymentMethod,
          paymentStatus: actualPaymentStatus,
          orderStatus: actualOrderStatus,
          paidAmount: actualPaidAmount,
          pendingAmount: actualPendingAmount,
          paymentHistory: initialPaymentHistory,
          cashAmount: paymentMethod === 'cash' ? cashAmount : undefined,
          cardAmount: paymentMethod === 'card' ? cardAmount : undefined,
          changeGiven: change,
          bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined,
          cashier: cashierId,
          notes: notes || 'POS Order',
          completedAt:
            actualPaymentStatus === PAYMENT_STATUS.FULL || actualPaymentStatus === PAYMENT_STATUS.COMPLETED
              ? new Date()
              : undefined,
        };

        order = new POSOrder(orderData);
        await order.save();
      } catch (saveErr) {
        // Order was not saved -> give the pieces back (same branch).
        await stockService.restoreOrderItems(orderItems, { branchId });
        throw saveErr;
      }

      const populatedOrder = await POSOrder.findById(order._id)
        .populate('customer', 'firstName lastName email phone carDetails')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('branch', 'name code address phone');

      return res.status(201).json({ success: true, data: populatedOrder, message: 'Order created successfully' });
    } catch (error) {
      console.error('Create POS order error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error creating order',
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  },

  // GET /api/pos/orders
  getOrders: async (req, res) => {
    try {
      const { date, startDate, endDate, paymentMethod, orderType, search } = req.query;
      const query = { isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) };

      if (startDate && endDate) {
        const rangeStart = new Date(startDate);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(endDate);
        rangeEnd.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: rangeStart, $lte: rangeEnd };
      } else if (date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: startOfDay, $lte: endOfDay };
      }
      if (paymentMethod && paymentMethod !== 'all') query.paymentMethod = paymentMethod;
      if (orderType && orderType !== 'all') query.orderStatus = orderType;
      if (search && String(search).trim()) {
        const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.$or = [
          { orderNumber: { $regex: esc, $options: 'i' } },
          { 'customerInfo.name': { $regex: esc, $options: 'i' } },
          { 'customerInfo.phone': { $regex: esc, $options: 'i' } },
        ];
      }

      // Pagination — default 25 per page, matches admin convention.
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limitParam = parseInt(String(req.query.limit || '25'), 10);
      const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 25));
      const skip = (page - 1) * limit;

      // Summary totals should reflect the full filtered set, not just the page.
      const [total, orders, summaryAgg] = await Promise.all([
        POSOrder.countDocuments(query),
        POSOrder.find(query)
          .populate('customer', 'firstName lastName email phone carDetails customerType source')
          .populate('cashier', 'firstName lastName email')
          .populate('items.product', 'name thumbnailUrl bannerUrls price')
          .populate('branch', 'name code')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        POSOrder.aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              totalSales: { $sum: '$total' },
              totalPaid: { $sum: '$paidAmount' },
              totalPending: { $sum: '$pendingAmount' },
            },
          },
        ]),
      ]);

      // Enrich customerInfo with customerType/source if missing
      const ordersData = orders.map((o) => o.toObject());
      const phonesToLookup = ordersData
        .filter((o) => o.customerInfo?.phone && (!o.customerInfo.customerType || !o.customerInfo.source))
        .map((o) => o.customerInfo.phone);
      if (phonesToLookup.length) {
        const customers = await User.find({
          phone: { $in: phonesToLookup },
          isDeleted: { $ne: true },
        }).select('phone customerType source');
        const map = {};
        customers.forEach((c) => (map[c.phone] = { customerType: c.customerType, source: c.source }));
        ordersData.forEach((o) => {
          if (o.customerInfo?.phone && map[o.customerInfo.phone]) {
            if (!o.customerInfo.customerType) o.customerInfo.customerType = map[o.customerInfo.phone].customerType;
            if (!o.customerInfo.source) o.customerInfo.source = map[o.customerInfo.phone].source;
          }
        });
      }

      const s = summaryAgg[0] || { totalSales: 0, totalPaid: 0, totalPending: 0 };

      return res.status(200).json({
        success: true,
        data: ordersData,
        summary: {
          totalOrders: total,
          totalSales: s.totalSales || 0,
          totalPaid: s.totalPaid || 0,
          totalPending: s.totalPending || 0,
        },
        pagination: { total, page, pages: Math.max(1, Math.ceil(total / limit)), limit },
        message: 'Orders fetched successfully',
      });
    } catch (error) {
      console.error('Get POS orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching orders', error: error.message });
    }
  },

  // GET /api/pos/orders/:id
  getOrderById: async (req, res) => {
    try {
      // Orders of another branch are "not found" for branch staff.
      const order = await POSOrder.findOne({
        _id: req.params.id,
        isDeleted: { $ne: true },
        ...(await scopedBranchFilter(req)),
      })
        .populate('customer', 'firstName lastName email phone carDetails')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName')
        .populate('branch', 'name code address phone');
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      return res.status(200).json({ success: true, data: order, message: 'Order fetched successfully' });
    } catch (error) {
      console.error('Get order by ID error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching order', error: error.message });
    }
  },

  // GET /api/pos/dashboard/stats
  getDashboardStats: async (req, res) => {
    try {
      const { filter = 'today', startDate, endDate } = req.query;
      const now = new Date();
      let periodStart, periodEnd, comparisonStart, comparisonEnd, periodLabel;

      switch (filter) {
        case 'weekly': {
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 7);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 7);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Week';
          break;
        }
        case 'monthly':
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          comparisonStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Month';
          break;
        case 'custom': {
          if (!startDate || !endDate) {
            return res.status(400).json({ success: false, message: 'Start date and end date are required for custom filter' });
          }
          periodStart = new Date(startDate);
          periodStart.setHours(0, 0, 0, 0);
          periodEnd = new Date(endDate);
          periodEnd.setHours(23, 59, 59, 999);
          const duration = periodEnd.getTime() - periodStart.getTime();
          comparisonEnd = new Date(periodStart);
          comparisonStart = new Date(comparisonEnd.getTime() - duration);
          periodLabel = 'Custom Period';
          break;
        }
        case 'all':
          if (startDate && endDate) {
            periodStart = new Date(startDate);
            periodStart.setHours(0, 0, 0, 0);
            periodEnd = new Date(endDate);
            periodEnd.setHours(23, 59, 59, 999);
          } else {
            periodStart = new Date(2000, 0, 1);
            periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          }
          comparisonStart = periodStart;
          comparisonEnd = periodEnd;
          periodLabel = 'All Time';
          break;
        case 'today':
        default:
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 1);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'Today';
      }

      const bf = await scopedBranchFilter(req);
      const scope = await branchScope(req);

      const periodStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            totalItems: { $sum: { $size: '$items' } },
            avgOrderValue: { $avg: '$total' },
            totalDiscount: { $sum: '$discount' },
          },
        },
      ]);

      const paymentStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, isDeleted: { $ne: true }, ...bf } },
        { $unwind: { path: '$paymentHistory', preserveNullAndEmptyArrays: false } },
        { $group: { _id: '$paymentHistory.paymentMethod', total: { $sum: '$paymentHistory.amount' } } },
      ]);

      const paymentsByMethod = { cashSales: 0, cardSales: 0, bankSales: 0 };
      paymentStats.forEach((s) => {
        if (s._id === 'cash') paymentsByMethod.cashSales = s.total;
        else if (s._id === 'card') paymentsByMethod.cardSales = s.total;
        else if (s._id === 'bank_transfer') paymentsByMethod.bankSales = s.total;
      });

      const comparisonStats = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: comparisonStart, $lt: comparisonEnd }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        { $group: { _id: null, totalSales: { $sum: '$total' }, totalOrders: { $sum: 1 } } },
      ]);

      const topProducts = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: periodStart, $lt: periodEnd }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            totalQuantity: 1,
            totalRevenue: 1,
            productName: { $ifNull: ['$product.name', 'Unknown Product'] },
            productImage: '$product.thumbnailUrl',
          },
        },
      ]);

      const recentOrders = await POSOrder.find({
        orderStatus: 'completed',
        createdAt: { $gte: periodStart, $lt: periodEnd },
        isDeleted: { $ne: true },
        ...bf,
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('customer', 'firstName lastName')
        .populate('cashier', 'firstName lastName')
        .populate('branch', 'name code')
        .select('orderNumber total paymentMethod createdAt customer cashier branch branchCode');

      // Super admin looking at all branches: sales per branch for the period.
      const byBranch = scope.allBranches
        ? await byBranchBreakdown(
            POSOrder,
            { createdAt: { $gte: periodStart, $lt: periodEnd }, orderStatus: 'completed', isDeleted: { $ne: true } },
            { mainBranchId: scope.mainBranchId }
          )
        : undefined;

      const calcChange = (current, previous) => {
        if (!previous || previous === 0) return current > 0 ? 100 : 0;
        return (((current - previous) / previous) * 100).toFixed(1);
      };
      const current = periodStats[0] || { totalSales: 0, totalOrders: 0, totalItems: 0, avgOrderValue: 0, totalDiscount: 0 };
      const previous = comparisonStats[0] || { totalSales: 0, totalOrders: 0 };

      const getComparisonLabel = () => {
        switch (filter) {
          case 'weekly':
            return 'vs last week';
          case 'monthly':
            return 'vs last month';
          case 'custom':
            return 'vs previous period';
          case 'all':
            return 'all time data';
          default:
            return 'vs yesterday';
        }
      };

      return res.status(200).json({
        success: true,
        data: {
          period: {
            totalSales: current.totalSales || 0,
            totalOrders: current.totalOrders || 0,
            totalItems: current.totalItems || 0,
            avgOrderValue: current.avgOrderValue || 0,
            totalDiscount: current.totalDiscount || 0,
            cashSales: paymentsByMethod.cashSales,
            cardSales: paymentsByMethod.cardSales,
            bankSales: paymentsByMethod.bankSales,
            salesChange: calcChange(current.totalSales, previous.totalSales),
            ordersChange: calcChange(current.totalOrders, previous.totalOrders),
          },
          periodLabel,
          comparisonLabel: getComparisonLabel(),
          filter,
          dateRange: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
          topProducts,
          recentOrders,
          branchId: scope.branchId,
          byBranch,
        },
        message: 'Dashboard stats fetched successfully',
      });
    } catch (error) {
      console.error('Get dashboard stats error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching dashboard stats', error: error.message });
    }
  },

  // GET /api/pos/dashboard/sales-chart
  getSalesChart: async (req, res) => {
    try {
      const { period = '7days' } = req.query;
      const now = new Date();
      let startDate, groupFormat, dateFormat;

      switch (period) {
        case '30days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 30);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
          break;
        case '12months':
          startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - 12);
          groupFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
          dateFormat = 'monthly';
          break;
        case '7days':
        default:
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 7);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
      }

      const bf = await scopedBranchFilter(req);
      const salesChart = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: startDate }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        {
          $group: {
            _id: groupFormat,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            cashSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$total', 0] } },
            cardSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$total', 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hourlyChart = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: todayStart }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        { $group: { _id: { $hour: '$createdAt' }, totalSales: { $sum: '$total' }, totalOrders: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);

      const paymentDistribution = await POSOrder.aggregate([
        { $match: { createdAt: { $gte: startDate }, orderStatus: 'completed', isDeleted: { $ne: true }, ...bf } },
        { $group: { _id: '$paymentMethod', totalSales: { $sum: '$total' }, count: { $sum: 1 } } },
      ]);

      return res.status(200).json({
        success: true,
        data: { salesChart, hourlyChart, paymentDistribution, period, dateFormat },
        message: 'Sales chart data fetched successfully',
      });
    } catch (error) {
      console.error('Get sales chart error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching sales chart data', error: error.message });
    }
  },

  // GET /api/pos/orders/pending
  getPendingOrders: async (req, res) => {
    try {
      const { customerId } = req.query;
      const query = {
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
        ...(await scopedBranchFilter(req)),
      };
      if (customerId) query.customer = customerId;

      const orders = await POSOrder.find(query)
        .populate('customer', 'firstName lastName email phone carDetails')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName')
        .populate('branch', 'name code')
        .sort({ createdAt: -1 });

      const totalPending = orders.reduce((sum, o) => sum + (o.pendingAmount || 0), 0);
      const totalPaid = orders.reduce((sum, o) => sum + (o.paidAmount || 0), 0);

      return res.status(200).json({
        success: true,
        data: orders,
        summary: { totalOrders: orders.length, totalPending, totalPaid, totalAmount: totalPending + totalPaid },
        message: 'Pending orders fetched successfully',
      });
    } catch (error) {
      console.error('Get pending orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching pending orders', error: error.message });
    }
  },

  // POST /api/pos/orders/:id/payment — add payment to existing pending order
  addPayment: async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, paymentMethod, note, bankTransferScreenshot, discount } = req.body;
      const userId = req.user?._id || req.user?.id;

      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Payment amount must be greater than 0' });
      }
      if (!paymentMethod) {
        return res.status(400).json({ success: false, message: 'Payment method is required' });
      }

      const order = await POSOrder.findOne({ _id: id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      if (order.paymentStatus === 'completed')
        return res.status(400).json({ success: false, message: 'Order is already fully paid' });
      if (order.paymentStatus === 'refunded')
        return res.status(400).json({ success: false, message: 'Cannot add payment to a refunded order' });

      const paymentAmount = parseFloat(amount);
      const discountAmount = discount ? parseFloat(discount) : 0;

      if (discountAmount > 0) {
        if (discountAmount > order.pendingAmount) {
          return res.status(400).json({
            success: false,
            message: `Discount amount (${discountAmount}) exceeds pending amount (${order.pendingAmount})`,
          });
        }
        order.discount = (order.discount || 0) + discountAmount;
        order.total = order.total - discountAmount;
        order.pendingAmount = order.pendingAmount - discountAmount;
      }

      if (paymentAmount > order.pendingAmount) {
        return res.status(400).json({
          success: false,
          message: `Payment amount (${paymentAmount}) exceeds pending amount (${order.pendingAmount})`,
        });
      }

      const newPendingAmount = order.pendingAmount - paymentAmount;
      const newPaymentStatus = newPendingAmount <= 0 ? 'completed' : 'partial';

      order.paymentHistory.push({
        amount: paymentAmount,
        paymentMethod,
        paidAt: new Date(),
        receivedBy: userId,
        note: discountAmount > 0 ? `${note || PAYMENT_NOTES.PAYMENT} (Discount: ${discountAmount})` : (note || PAYMENT_NOTES.ADDITIONAL),
        paymentStatus: newPaymentStatus,
        bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined,
      });

      order.paidAmount += paymentAmount;
      order.pendingAmount = newPendingAmount;
      if (newPendingAmount <= 0) {
        order.paymentStatus = 'completed';
        order.orderStatus = 'completed';
        order.completedAt = new Date();
        order.pendingAmount = 0;
      } else {
        order.paymentStatus = 'partial';
      }

      await order.save();

      const populatedOrder = await POSOrder.findById(order._id)
        .populate('customer', 'firstName lastName email phone carDetails')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName');

      return res.status(200).json({
        success: true,
        data: populatedOrder,
        message:
          order.paymentStatus === 'completed'
            ? 'Payment completed successfully'
            : 'Payment added successfully',
      });
    } catch (error) {
      console.error('Add payment error:', error);
      return res.status(400).json({ success: false, message: 'Error adding payment', error: error.message });
    }
  },

  // GET /api/pos/customers/:id/pending
  getCustomerPendingOrders: async (req, res) => {
    try {
      const { id } = req.params;
      const orders = await POSOrder.find({
        customer: id,
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
        ...(await scopedBranchFilter(req)),
      })
        .populate('cashier', 'firstName lastName email')
        .populate('branch', 'name code')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .sort({ createdAt: -1 });
      const totalPending = orders.reduce((sum, o) => sum + (o.pendingAmount || 0), 0);
      return res.status(200).json({
        success: true,
        data: orders,
        summary: { totalOrders: orders.length, totalPending },
        message: 'Customer pending orders fetched successfully',
      });
    } catch (error) {
      console.error('Get customer pending orders error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching customer pending orders', error: error.message });
    }
  },

  // DELETE /api/pos/orders/:id — soft delete; puts the pieces back into stock once.
  deleteOrder: async (req, res) => {
    try {
      const userId = req.user?._id || req.user?.id;
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

      let stock = null;
      if (!['refunded', 'cancelled'].includes(order.orderStatus)) {
        stock = await restoreOrderStockOnce(order);
      }
      order.isDeleted = true;
      order.deletedAt = new Date();
      order.deletedBy = userId;
      await order.save();
      return res.status(200).json({
        success: true,
        message: 'Order deleted successfully',
        stockRestored: !!(stock && stock.claimed),
        stockWarnings: stock && stock.errors.length ? stock.errors : undefined,
      });
    } catch (error) {
      console.error('Delete order error:', error);
      return res.status(400).json({ success: false, message: 'Error deleting order', error: error.message });
    }
  },

  // POST /api/pos/orders/:id/refund — body { reason? }. Marks the order refunded
  // and puts its pieces back into stock (only once).
  refundOrder: async (req, res) => {
    try {
      const { reason } = req.body || {};
      const order = await POSOrder.findOne({ _id: req.params.id, isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) });
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      if (order.orderStatus === 'refunded' || order.paymentStatus === 'refunded') {
        return res.status(400).json({ success: false, message: 'Order is already refunded' });
      }
      if (order.orderStatus === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Cannot refund a cancelled order' });
      }

      const stock = await restoreOrderStockOnce(order);

      order.orderStatus = 'refunded';
      order.paymentStatus = 'refunded';
      order.refundedAt = new Date();
      order.pendingAmount = 0; // nothing is owed on a refunded order
      const cleanReason = reason ? String(reason).trim() : '';
      if (cleanReason) {
        order.notes = order.notes ? `${order.notes}\nRefund reason: ${cleanReason}` : `Refund reason: ${cleanReason}`;
      }
      await order.save();

      const populatedOrder = await POSOrder.findById(order._id)
        .populate('customer', 'firstName lastName email phone carDetails')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName');

      return res.status(200).json({
        success: true,
        data: populatedOrder,
        stockRestored: !!stock.claimed,
        stockWarnings: stock.errors.length ? stock.errors : undefined,
        message: 'Order refunded successfully',
      });
    } catch (error) {
      console.error('Refund order error:', error);
      return res.status(400).json({ success: false, message: 'Error refunding order', error: error.message });
    }
  },

  // POST /api/pos/upload/screenshot — bank transfer proof upload
  uploadScreenshot: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      const { toPublicPath } = require('../helper/upload');
      // Vercel Blob flow
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        try {
          const { put } = require('@vercel/blob');
          const extMatch = (req.file.originalname || '').match(/\.[a-z0-9]+$/i);
          const ext = extMatch ? extMatch[0] : '';
          const key = `pos/screenshots/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
          const blob = await put(key, req.file.buffer, {
            access: 'public',
            contentType: req.file.mimetype,
            token: process.env.BLOB_READ_WRITE_TOKEN,
          });
          return res.status(200).json({
            success: true,
            data: { url: blob.url, originalFilename: req.file.originalname, uploadedAt: new Date().toISOString() },
            message: 'Screenshot uploaded',
          });
        } catch (e) {
          console.error('Blob upload failed:', e);
        }
      }
      // Local disk flow (default)
      const url = toPublicPath(req.file.filename || req.file.originalname);
      return res.status(200).json({
        success: true,
        data: { url, originalFilename: req.file.originalname, uploadedAt: new Date().toISOString() },
        message: 'Screenshot uploaded',
      });
    } catch (error) {
      console.error('Upload screenshot error:', error);
      return res.status(400).json({ success: false, message: 'Error uploading screenshot', error: error.message });
    }
  },
};

module.exports = posController;
