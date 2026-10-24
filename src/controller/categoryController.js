// src/controller/categoryController.js
const Category = require('../models/category');
const { invalidate } = require('../middleware/cache');

const CATEGORIES_PUBLIC_TAG = 'categories:public';
const CATEGORIES_FEATURED_TAG = 'categories:featured-with-products';

function invalidateCategoryCaches() {
  invalidate(CATEGORIES_PUBLIC_TAG);
  invalidate(CATEGORIES_FEATURED_TAG);
}

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const categoryController = {
  // GET /categories - list all categories
  listCategories: async (req, res) => {
    try {
      const { parentOnly, flat, active, search } = req.query;

      // /categories/public is consumed by popular-categories carousel, category
      // browse page, checkout shipping lookup, and products nav. None of those
      // need the size-chart URLs, measuringTipImage, thumbnailUrls[], or the
      // featuredProducts array, and all of them only render active rows. We
      // skip those heavy fields and DB-filter to active=true for that path.
      const isPublic = req.path === '/categories/public' || req.baseUrl + req.path === '/categories/public';

      const query = {};
      if (parentOnly === 'true') query.parentId = null;
      if (active === 'true') query.active = true;
      else if (active === 'false') query.active = false;
      else if (isPublic) query.active = true;
      if (search && String(search).trim()) {
        const s = String(search).trim();
        if (s.length >= 3) {
          query.$text = { $search: s };
        } else {
          const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          query.name = rx;
        }
      }

      const Product = require('../models/product');

      // Projection: public path drops size-chart / measuringTip / thumbnailUrls
      // / featuredProducts — admin path keeps everything.
      const publicProjection =
        '-sizeChartRegularCm -sizeChartRegularInch -sizeChartRelaxedCm ' +
        '-sizeChartRelaxedInch -measuringTipImage -thumbnailUrls -featuredProducts';

      // Parallelize the find + aggregate. `.lean()` drops Mongoose hydration
      // on the list, and avoids per-row `.toObject()` below.
      const findQuery = Category.find(query)
        .populate('parentId', 'name slug')
        .sort({ sortOrder: 1, createdAt: -1 })
        .lean();
      if (isPublic) findQuery.select(publicProjection);

      const [categories, productCounts] = await Promise.all([
        findQuery,
        Product.aggregate([
          { $match: { status: 'published' } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
        ]),
      ]);

      const countMap = Object.create(null);
      for (const pc of productCounts) countMap[pc._id] = pc.count;

      for (const c of categories) c.productCount = countMap[c.name] || 0;

      if (flat === 'false') {
        const parents = [];
        const children = [];
        for (const c of categories) (c.parentId ? children : parents).push(c);
        const childrenByParent = new Map();
        for (const child of children) {
          const pid = child.parentId?._id?.toString();
          if (!pid) continue;
          const arr = childrenByParent.get(pid) || [];
          arr.push(child);
          childrenByParent.set(pid, arr);
        }
        const hierarchical = parents.map((p) => ({
          ...p,
          children: childrenByParent.get(p._id.toString()) || [],
        }));
        return res.status(200).json({ message: 'Categories fetched successfully', data: hierarchical });
      }

      return res.status(200).json({ message: 'Categories fetched successfully', data: categories });
    } catch (error) {
      console.error('List categories error:', error);
      return res.status(400).json({ message: 'Error fetching categories', error: error.message });
    }
  },
  listFeaturedCategoriesWithProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 6;
      const Product = require('../models/product');

      // Get featured categories that are active. .lean() skips Mongoose
      // hydration so the per-category spread below doesn't need .toObject().
      const categories = await Category.find({
        featured: true,
        active: true,
      })
        .limit(limit)
        .sort({ sortOrder: 1, createdAt: -1 })
        .lean();

      // Collapse the per-category product lookups into ONE Product.find call.
      // Previously this ran N parallel finds (N = # featured categories), each
      // paying an Atlas round trip; one query cuts that to a single RTT.
      const pickedIds = new Set();
      const fallbackNames = new Set();
      for (const c of categories) {
        if (Array.isArray(c.featuredProducts) && c.featuredProducts.length > 0) {
          for (const pid of c.featuredProducts) pickedIds.add(String(pid));
        } else {
          fallbackNames.add(c.name);
        }
      }

      const [pickedProducts, fallbackProducts] = await Promise.all([
        pickedIds.size
          ? Product.find({
              _id: { $in: Array.from(pickedIds) },
              status: 'published',
              ownerBranch: null, // website: shared products only
            }).lean()
          : Promise.resolve([]),
        fallbackNames.size
          ? Product.find({
              category: { $in: Array.from(fallbackNames) },
              status: 'published',
              stock: { $gt: 0 },
              ownerBranch: null, // website: shared products only
            }).lean()
          : Promise.resolve([]),
      ]);

      const pickedById = new Map(pickedProducts.map((p) => [String(p._id), p]));
      const fallbackByCategory = new Map();
      for (const p of fallbackProducts) {
        const list = fallbackByCategory.get(p.category) || [];
        if (list.length < 6) list.push(p);
        fallbackByCategory.set(p.category, list);
      }

      const categoriesWithProducts = categories.map((category) => {
        let products = [];
        if (Array.isArray(category.featuredProducts) && category.featuredProducts.length > 0) {
          // Preserve the admin's chosen order.
          products = category.featuredProducts
            .map((id) => pickedById.get(String(id)))
            .filter(Boolean);
        } else {
          products = fallbackByCategory.get(category.name) || [];
        }
        return { ...category, products };
      });

      return res.status(200).json({
        message: 'Featured categories with products fetched successfully',
        data: categoriesWithProducts,
      });
    } catch (error) {
      console.error('List featured categories with products error:', error);
      return res.status(400).json({ message: 'Error fetching featured categories with products', error: error.message });
    }
  },

  // PUT /categories/:id/featured-products - save admin-selected products for a category
  setFeaturedProducts: async (req, res) => {
    try {
      const { id } = req.params;
      const { productIds } = req.body || {};

      if (!Array.isArray(productIds)) {
        return res.status(400).json({ message: 'productIds must be an array' });
      }

      const Product = require('../models/product');
      const mongoose = require('mongoose');

      const validIds = productIds.filter((pid) => mongoose.Types.ObjectId.isValid(pid));
      const existing = await Product.find({ _id: { $in: validIds } }).select('_id');
      const existingSet = new Set(existing.map((p) => String(p._id)));
      const cleanIds = validIds.filter((pid) => existingSet.has(String(pid)));

      const category = await Category.findByIdAndUpdate(
        id,
        { featuredProducts: cleanIds },
        { new: true }
      );

      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }

      invalidateCategoryCaches();

      return res.status(200).json({
        message: 'Featured products updated successfully',
        data: category,
      });
    } catch (error) {
      console.error('Set featured products error:', error);
      return res.status(400).json({ message: 'Error saving featured products', error: error.message });
    }
  },

  // GET /categories/:id/products - list products belonging to a category (for admin selector)
  listProductsByCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const Product = require('../models/product');

      const category = await Category.findById(id);
      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }

      const { productScopeFilter } = require('../helper/productScope');
      const products = await Product.find({ category: category.name, ...productScopeFilter(req) }).sort({ createdAt: -1 });
      return res.status(200).json({
        message: 'Products fetched successfully',
        data: {
          category,
          products,
          featuredProductIds: category.featuredProducts || [],
        },
      });
    } catch (error) {
      console.error('List products by category error:', error);
      return res.status(400).json({ message: 'Error fetching category products', error: error.message });
    }
  },

  // POST /categories - create a new category
  createCategory: async (req, res) => {
    try {
      let { name, slug, description = '', active = true, featured = false, parentId = null, shippingCost = 0, metaTitle = '', metaDescription = '', metaKeywords = '' } = req.body || {};

      if (!name || !slug) {
        return res.status(400).json({ message: 'name and slug are required' });
      }

      name = String(name).trim();
      slug = String(slug).trim().toLowerCase();
      description = String(description || '').trim();
      active = active === 'true' || active === true;
      featured = featured === 'true' || featured === true;

      // Handle parentId - convert empty string or 'null' to actual null
      if (parentId === '' || parentId === 'null' || parentId === 'undefined') {
        parentId = null;
      }

      // Validate parentId if provided
      if (parentId) {
        const parentExists = await Category.findById(parentId);
        if (!parentExists) {
          return res.status(400).json({ message: 'Parent category not found' });
        }
      }

      // Handle file uploads
      const thumbnailFiles = req.files?.thumbnail || [];
      const bannerFile = req.files?.banner?.[0];

      // Parse existing thumbnail URLs (kept from the client, if any)
      let keptUrls = [];
      if (typeof req.body?.existingThumbnailUrls !== 'undefined') {
        try {
          const parsed = JSON.parse(req.body.existingThumbnailUrls);
          if (Array.isArray(parsed)) keptUrls = parsed.filter(u => typeof u === 'string');
        } catch (_) { /* ignore */ }
      }

      const newThumbnailUrls = [];
      let bannerUrl = null;

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        for (const file of thumbnailFiles) {
          const url = await blobUpload.uploadToBlob(
            file.buffer,
            file.originalname,
            file.mimetype,
            'categories/thumbnails'
          );
          newThumbnailUrls.push(url);
        }
        if (bannerFile) {
          bannerUrl = await blobUpload.uploadToBlob(
            bannerFile.buffer,
            bannerFile.originalname,
            bannerFile.mimetype,
            'categories/banners'
          );
        }
      } else {
        // Local storage
        for (const file of thumbnailFiles) {
          newThumbnailUrls.push(`/uploads/${file.filename}`);
        }
        bannerUrl = bannerFile ? `/uploads/${bannerFile.filename}` : null;
      }

      // Parse shippingCost as number
      const parsedShippingCost = parseFloat(shippingCost) || 0;

      const thumbnailUrls = [...keptUrls, ...newThumbnailUrls];
      // keep single thumbnailUrl pointing at the first one for backward compat
      const thumbnailUrl = thumbnailUrls[0] || null;

      const categoryData = {
        name,
        slug,
        description,
        active,
        featured,
        thumbnailUrl,
        thumbnailUrls,
        bannerUrl,
        parentId,
        shippingCost: parsedShippingCost,
        metaTitle: String(metaTitle || '').trim(),
        metaDescription: String(metaDescription || '').trim(),
        metaKeywords: String(metaKeywords || '').trim(),
      };

      const created = await Category.create(categoryData);

      invalidateCategoryCaches();

      return res.status(201).json({ message: 'Category created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create category error:', error);
      return res.status(400).json({ message: 'Error creating category', error: error.message });
    }
  },

  // PUT /categories/:id - update a category
  updateCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.description !== 'undefined') updates.description = String(payload.description || '').trim();
      if (typeof payload.active !== 'undefined') updates.active = payload.active === 'true' || payload.active === true;
      if (typeof payload.featured !== 'undefined') updates.featured = payload.featured === 'true' || payload.featured === true;
      if (typeof payload.shippingCost !== 'undefined') updates.shippingCost = parseFloat(payload.shippingCost) || 0;
      if (typeof payload.estimatedDays !== 'undefined') updates.estimatedDays = String(payload.estimatedDays || '').trim();
      if (typeof payload.metaTitle !== 'undefined') updates.metaTitle = String(payload.metaTitle || '').trim();
      if (typeof payload.metaDescription !== 'undefined') updates.metaDescription = String(payload.metaDescription || '').trim();
      if (typeof payload.metaKeywords !== 'undefined') updates.metaKeywords = String(payload.metaKeywords || '').trim();

      // Handle parentId update
      if (typeof payload.parentId !== 'undefined') {
        let parentId = payload.parentId;
        if (parentId === '' || parentId === 'null' || parentId === 'undefined') {
          updates.parentId = null;
        } else if (parentId) {
          // Prevent setting self as parent
          if (parentId === id) {
            return res.status(400).json({ message: 'Category cannot be its own parent' });
          }
          // Validate parent exists
          const parentExists = await Category.findById(parentId);
          if (!parentExists) {
            return res.status(400).json({ message: 'Parent category not found' });
          }
          updates.parentId = parentId;
        }
      }

      // Handle file uploads
      const thumbnailFiles = req.files?.thumbnail || [];
      const bannerFile = req.files?.banner?.[0];
      const sizeChartRegularCmFile = req.files?.sizeChartRegularCm?.[0];
      const sizeChartRegularInchFile = req.files?.sizeChartRegularInch?.[0];
      const sizeChartRelaxedCmFile = req.files?.sizeChartRelaxedCm?.[0];
      const sizeChartRelaxedInchFile = req.files?.sizeChartRelaxedInch?.[0];
      const measuringTipImageFile = req.files?.measuringTipImage?.[0];

      // Handle size guide image removals (empty string = remove)
      if (payload.sizeChartRegularCm === '' || payload.sizeChartRegularCm === 'null') {
        updates.sizeChartRegularCm = null;
      }
      if (payload.sizeChartRegularInch === '' || payload.sizeChartRegularInch === 'null') {
        updates.sizeChartRegularInch = null;
      }
      if (payload.sizeChartRelaxedCm === '' || payload.sizeChartRelaxedCm === 'null') {
        updates.sizeChartRelaxedCm = null;
      }
      if (payload.sizeChartRelaxedInch === '' || payload.sizeChartRelaxedInch === 'null') {
        updates.sizeChartRelaxedInch = null;
      }
      if (payload.measuringTipImage === '' || payload.measuringTipImage === 'null') {
        updates.measuringTipImage = null;
      }

      // Parse existing thumbnail URLs (kept from the client, if any)
      let keptUrls = [];
      let hasExistingThumbnailUrls = false;
      if (typeof payload.existingThumbnailUrls !== 'undefined') {
        hasExistingThumbnailUrls = true;
        try {
          const parsed = JSON.parse(payload.existingThumbnailUrls);
          if (Array.isArray(parsed)) keptUrls = parsed.filter(u => typeof u === 'string');
        } catch (_) { /* ignore */ }
      }

      const newThumbnailUrls = [];

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        for (const file of thumbnailFiles) {
          const url = await blobUpload.uploadToBlob(
            file.buffer,
            file.originalname,
            file.mimetype,
            'categories/thumbnails'
          );
          newThumbnailUrls.push(url);
        }
        if (bannerFile) {
          updates.bannerUrl = await blobUpload.uploadToBlob(
            bannerFile.buffer,
            bannerFile.originalname,
            bannerFile.mimetype,
            'categories/banners'
          );
        }
        if (sizeChartRegularCmFile) {
          updates.sizeChartRegularCm = await blobUpload.uploadToBlob(
            sizeChartRegularCmFile.buffer,
            sizeChartRegularCmFile.originalname,
            sizeChartRegularCmFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRegularInchFile) {
          updates.sizeChartRegularInch = await blobUpload.uploadToBlob(
            sizeChartRegularInchFile.buffer,
            sizeChartRegularInchFile.originalname,
            sizeChartRegularInchFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRelaxedCmFile) {
          updates.sizeChartRelaxedCm = await blobUpload.uploadToBlob(
            sizeChartRelaxedCmFile.buffer,
            sizeChartRelaxedCmFile.originalname,
            sizeChartRelaxedCmFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRelaxedInchFile) {
          updates.sizeChartRelaxedInch = await blobUpload.uploadToBlob(
            sizeChartRelaxedInchFile.buffer,
            sizeChartRelaxedInchFile.originalname,
            sizeChartRelaxedInchFile.mimetype,
            'categories/size-guides'
          );
        }
        if (measuringTipImageFile) {
          updates.measuringTipImage = await blobUpload.uploadToBlob(
            measuringTipImageFile.buffer,
            measuringTipImageFile.originalname,
            measuringTipImageFile.mimetype,
            'categories/measuring-tips'
          );
        }
      } else {
        // Local storage
        for (const file of thumbnailFiles) {
          newThumbnailUrls.push(`/uploads/${file.filename}`);
        }
        if (bannerFile) {
          updates.bannerUrl = `/uploads/${bannerFile.filename}`;
        }
        if (sizeChartRegularCmFile) {
          updates.sizeChartRegularCm = `/uploads/${sizeChartRegularCmFile.filename}`;
        }
        if (sizeChartRegularInchFile) {
          updates.sizeChartRegularInch = `/uploads/${sizeChartRegularInchFile.filename}`;
        }
        if (sizeChartRelaxedCmFile) {
          updates.sizeChartRelaxedCm = `/uploads/${sizeChartRelaxedCmFile.filename}`;
        }
        if (sizeChartRelaxedInchFile) {
          updates.sizeChartRelaxedInch = `/uploads/${sizeChartRelaxedInchFile.filename}`;
        }
        if (measuringTipImageFile) {
          updates.measuringTipImage = `/uploads/${measuringTipImageFile.filename}`;
        }
      }

      // Merge kept + new thumbnail URLs. Only touch the field if the client
      // sent existingThumbnailUrls or uploaded new thumbnail files.
      if (hasExistingThumbnailUrls || newThumbnailUrls.length > 0) {
        updates.thumbnailUrls = [...keptUrls, ...newThumbnailUrls];
        // Backward compatibility: keep single thumbnailUrl pointing at the first one
        updates.thumbnailUrl = updates.thumbnailUrls[0] || null;
      }

      const updated = await Category.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Category not found' });
      }

      invalidateCategoryCaches();

      return res.status(200).json({ message: 'Category updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update category error:', error);
      return res.status(400).json({ message: 'Error updating category', error: error.message });
    }
  },

  // PUT /categories/reorder - reorder categories
  reorderCategories: async (req, res) => {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ message: 'Items array is required' });
      }

      const bulkOps = items.map((item, index) => ({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { sortOrder: index } },
        },
      }));

      await Category.bulkWrite(bulkOps);
      const categories = await Category.find()
        .populate('parentId', 'name slug')
        .sort({ sortOrder: 1, createdAt: -1 });

      invalidateCategoryCaches();

      return res.status(200).json({ message: 'Categories reordered successfully', data: categories });
    } catch (error) {
      console.error('Reorder categories error:', error);
      return res.status(400).json({ message: 'Error reordering categories', error: error.message });
    }
  },

  // DELETE /categories/:id - delete a category
  deleteCategory: async (req, res) => {
    try {
      const { id } = req.params;

      // Check if category has children
      const childCount = await Category.countDocuments({ parentId: id });
      if (childCount > 0) {
        // Option 1: Move children to top-level (set parentId to null)
        await Category.updateMany({ parentId: id }, { $set: { parentId: null } });
      }

      const deleted = await Category.softDeleteById(id, req.user?._id || null);
      if (!deleted) {
        return res.status(404).json({ message: 'Category not found' });
      }

      invalidateCategoryCaches();

      return res.status(200).json({
        message: 'Category deleted successfully',
        id,
        childrenMoved: childCount,
      });
    } catch (error) {
      console.error('Delete category error:', error);
      return res.status(400).json({ message: 'Error deleting category', error: error.message });
    }
  },
};

module.exports = categoryController;
