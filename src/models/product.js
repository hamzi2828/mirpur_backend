// src/model/product.js

const mongoose = require('mongoose');

// One scannable code on a product or variant. `qty` = how many pieces one
// scan sells (1 for a normal/box label, N for a "full box" code).
const barcodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    qty: { type: Number, min: 1, default: 1 },
    label: { type: String, trim: true, default: '' }, // e.g. 'manufacturer', 'box', 'full-box'
  },
  { _id: false }
);

// A received lot of stock. When a product/variant has batches, its stock is
// the sum of the batches' remaining `quantity` (sold oldest/expiring first).
const batchSchema = new mongoose.Schema(
  {
    batchNo: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, trim: true, uppercase: true, default: undefined },
    quantity: { type: Number, min: 0, default: 0 }, // remaining pieces
    initialQuantity: { type: Number, min: 0, default: 0 },
    costPrice: { type: Number, min: 0, default: undefined },
    expiryDate: { type: Date, default: undefined },
    receivedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: '' },
    // Branch holding these pieces. Old batches without one belong to the main
    // branch. The same batchNo/barcode can exist once per branch inside one
    // unit (a lot split by a stock transfer), so stickers scan everywhere.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: undefined },
  },
  { _id: true }
);

// Pieces of one unit held by one branch. Kept in sync by helper/productCodes.js
// (syncProductBranchStock) and services/stockService.js — do not edit by hand.
//   unit with batches:    stock per branch = sum of that branch's batches
//   unit without batches: unit.stock = sum of branchStock
// Missing/empty on old data = everything is in the main branch.
const branchStockSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    stock: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const variantSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true, unique: false, trim: true }, // Custom unique ID for variant
    // color/size kept for the website; any other options (Storage, RAM...) go in `attributes`.
    color: { type: String, trim: true, default: '' },
    size: { type: String, trim: true, default: '' },
    attributes: { type: Map, of: String, default: undefined },
    shortCode: { type: String, trim: true, default: undefined }, // small number cashier can type
    barcodes: { type: [barcodeSchema], default: [] },
    batches: { type: [batchSchema], default: [] },
    branchStock: { type: [branchStockSchema], default: [] },
    price: { type: Number, required: true, min: 0 },
    websitePrice: { type: Number, min: 0, default: undefined },
    stock: { type: Number, required: true, min: 0 },
    sku: { type: String, trim: true, default: undefined },
    costPrice: { type: Number, min: 0, default: undefined },
    discountedPrice: { type: Number, min: 0, default: undefined },
    websiteDiscountedPrice: { type: Number, min: 0, default: undefined },
  },
  { _id: true } // Enable MongoDB _id for variants
);

const colorMediaSchema = new mongoose.Schema(
  {
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    category: { type: String, required: true, trim: true },
    subCategory: { type: String, trim: true, default: undefined },
    price: { type: Number, required: true, min: 0 },
    websitePrice: { type: Number, min: 0, default: undefined },
    discountedPrice: { type: Number, min: 0, default: undefined },
    websiteDiscountedPrice: { type: Number, min: 0, default: undefined },
    costPrice: { type: Number, min: 0, default: undefined },
    sku: { type: String, trim: true, default: undefined },
    // TOTAL pieces across all branches (website / reports read this).
    stock: { type: Number, required: true, min: 0 },
    // Pieces per branch. Single product: its own stock. Variant product: sum of
    // the variants' branchStock per branch (kept in sync on every write).
    branchStock: { type: [branchStockSchema], default: [] },
    // Branch that owns this product (made by its staff): only that branch and
    // the super admin see it. null = shared product, every branch sees it.
    // See helper/productScope.js.
    ownerBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

    // ----- Barcode / packaging (single products; variants carry their own) -----
    shortCode: { type: String, trim: true, default: undefined },
    barcodes: { type: [barcodeSchema], default: [] },
    batches: { type: [batchSchema], default: [] },
    // Pieces inside one box. 1 = sold loose. Stock is always counted in pieces.
    piecesPerBox: { type: Number, min: 1, default: 1 },
    // Every code that can be scanned/typed for this product (uppercased).
    // Built by helper/productCodes.js — do not edit by hand.
    scanCodes: { type: [String], default: [], index: true },

    status: { type: String, enum: ['published', 'draft', 'out_of_stock'], default: 'draft', index: true },
    featured: { type: Boolean, default: false, index: true },

    // Global media (hidden in variant mode on UI but kept here for compatibility)
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },

    productType: { type: String, enum: ['single', 'variant'], default: 'single', index: true },
    displayOn: { type: String, enum: ['website', 'pos', 'both'], default: 'both', index: true },
    variants: { type: [variantSchema], default: [] },

    // Optional future use: media per color
    colorMedia: {
      type: Map,
      of: colorMediaSchema,
      default: undefined,
    },

    // Description fields
    description: { type: String, trim: true, default: undefined },
    shortDescription: { type: String, trim: true, maxLength: 500, default: undefined },
    features: { type: String, trim: true, default: undefined },

    // Tags
    tags: { type: [String], default: [] },

    // SEO fields
    metaTitle: { type: String, trim: true, maxLength: 120, default: undefined },
    metaDescription: { type: String, trim: true, maxLength: 320, default: undefined },
    metaKeywords: { type: String, trim: true, default: undefined },
    metaSchema: { type: String, trim: true, default: undefined },

    // Preorder fields
    preorderEnabled: { type: Boolean, default: false, index: true },
    preorderMessage: { type: String, trim: true, default: '' },

    guidelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Guideline', default: null },
    showGuidelines: { type: Boolean, default: false },

    // Dimensions (L x W x H) and weight
    dimensionLength: { type: String, trim: true, default: undefined },
    dimensionWidth: { type: String, trim: true, default: undefined },
    dimensionHeight: { type: String, trim: true, default: undefined },
    weight: { type: String, trim: true, default: undefined },

    // Compatible Cars (array of car variant IDs)
    compatibleCars: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'CarVariant',
      default: [],
    },

    // Related Products
    relatedProducts: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Product',
      default: [],
    },
  },
  { timestamps: true }
);

// Ensure formatting on save
productSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = String(this.name).trim();
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Simple length validator for banners
productSchema.path('bannerUrls').validate(function (value) {
  return !value || value.length <= 5;
}, 'You can upload up to 5 banner images');

// ----- Indexes: serve the admin product list + stock page efficiently -----
// Default sort column on the list page.
productSchema.index({ createdAt: -1 });
// status + newest-first (status filter + default sort)
productSchema.index({ status: 1, createdAt: -1 });
// category + newest-first (category filter + default sort)
productSchema.index({ category: 1, createdAt: -1 });
// category + status combined (common combo filter)
productSchema.index({ category: 1, status: 1, createdAt: -1 });
// Stock page queries — low / out of stock
productSchema.index({ stock: 1 });
productSchema.index({ status: 1, stock: 1 });
// Per-branch stock lookups (branchStockQuery / branch stock page)
productSchema.index({ 'branchStock.branch': 1, 'branchStock.stock': 1 });
productSchema.index({ 'variants.branchStock.branch': 1 });
// displayOn filter (website vs pos vs both)
productSchema.index({ displayOn: 1, status: 1, createdAt: -1 });

// compatibleCars multikey index — drives /make, /make/:slug, and the car
// finder. Without this, `compatibleCars: { $in: [...] }` scans the whole
// Product collection and the stats endpoint becomes O(products × variants).
productSchema.index({ compatibleCars: 1 });
// Compound for the exact hot-path query used by the stats aggregations.
productSchema.index({ compatibleCars: 1, status: 1 });

// Covers /categories/public's productCounts aggregation:
//   Product.aggregate([{ $match: { status: 'published' } },
//                      { $group: { _id: '$category', count: { $sum: 1 } } }])
// Previously this walked the { status, createdAt } index then pulled each doc
// for its category; the new order lets Mongo run the group straight off the
// index keys (covered index scan).
productSchema.index({ status: 1, category: 1 });

// Covers /api/public/products sort-by-price / sort-by-name paths when the
// controller falls back to `find().sort({ [sortBy]: ... })` (non-price sort
// or when admin-specified). The existing { status, createdAt } already covers
// the default newest-first case.
productSchema.index({ status: 1, price: 1 });
productSchema.index({ status: 1, name: 1 });

// Full-text search over the fields the admin search box hits
productSchema.index(
  { name: 'text', slug: 'text', category: 'text', tags: 'text' },
  { name: 'product_text_idx', weights: { name: 10, slug: 8, category: 4, tags: 3 } }
);

// Delete cached model to ensure schema updates are applied
if (mongoose.models.Product) {
  delete mongoose.models.Product;
}

productSchema.plugin(require('../helper/softDeletePlugin'));

function invalidateProductCache() {
  try {
    const { invalidate } = require('../middleware/cache');
    invalidate('products:featured');
    invalidate('products:by-make');
    invalidate('products:by-model');
    invalidate('categories:featured-with-products');
    // Product changes can shift the productCount on make/model stat cards
    // (homepage + /make + /make/:slug). Bust those too.
    invalidate('car-makes:stats');
    invalidate('car-models:by-make');
  } catch (_) { /* noop */ }
}
productSchema.post('save', invalidateProductCache);
productSchema.post('findOneAndUpdate', invalidateProductCache);
productSchema.post('findOneAndDelete', invalidateProductCache);
productSchema.post('deleteOne', invalidateProductCache);
productSchema.post('updateOne', invalidateProductCache); // stock changes from POS sales
productSchema.post('deleteMany', invalidateProductCache);
productSchema.post('updateMany', invalidateProductCache);

module.exports = mongoose.model('Product', productSchema);
