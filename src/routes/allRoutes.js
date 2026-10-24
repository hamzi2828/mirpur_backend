// src/routes/allRoutes.js
//
// Access control
// - Public / customer routes keep their original middleware (no permission checks).
// - Every admin/staff route: `...staff` (= auth + loadAccess) and then either
//   `can(key, action)` (permission from the user's Role, see
//   constants/rolePermissions.js; the super admin passes every check) or
//   `superAdmin` (super admin only).
// - HTTP method -> action: GET view, POST create, PUT/PATCH edit, DELETE delete,
//   export endpoints export.
// - Permission checks run BEFORE upload middleware so refused requests don't upload.

const express = require('express');
const router = express.Router();
const userController = require('../controller/userController');
const auth = require('../middleware/auth');
const { loadAccess, optionalAccess, requirePermission, requireSuperAdmin } = require('../middleware/access');
const categoryController = require('../controller/categoryController');
const colorController = require('../controller/colorController');
const sizeController = require('../controller/sizeController');
const carController = require('../controller/carController');
const carHierarchyController = require('../controller/carHierarchyController');
const productController = require('../controller/productController');
const labelController = require('../controller/labelController');
const inventoryController = require('../controller/inventoryController');
const settingsController = require('../controller/settingsController');
const guidelineController = require('../controller/guidelineController');
const optionalAuth = require('../middleware/optionalAuth');
const { cache } = require('../middleware/cache');
const ONE_HOUR = 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const { uploadSingle, uploadArray, uploadFields, heroUploadFields, mediaUploadFields, toPublicPath } = require('../helper/upload');
const vendorController = require('../controller/vendorController');
const purchaseController = require('../controller/purchaseController');
const auditLogController = require('../controller/auditLogController');
const bankController = require('../controller/bankController');
const assetController = require('../controller/assetController');
const expenseController = require('../controller/expenseController');
const roleController = require('../controller/roleController');
const networkController = require('../controller/networkController');
const branchController = require('../controller/branchController');
const staffController = require('../controller/staffController');
const transferController = require('../controller/transferController');

// ----- access helpers ---------------------------------------------------------
// Logged-in staff: verify JWT, then load role/branch/permissions into req.access.
const staff = [auth, loadAccess];
// Permission check (any of the keys with this action). Tagged for the route tests.
const can = (keys, action = 'view') => {
  const mw = requirePermission(keys, action);
  mw.permission = { keys: [].concat(keys), action };
  return mw;
};
const superAdmin = requireSuperAdmin;

// Read-only lookups shared by several screens (product form, POS, receive, transfers).
const PRODUCT_READ = ['products', 'pos', 'product_stock', 'stock_receive', 'stock_transfers'];
const CATEGORY_READ = ['product_categories', 'products'];
const ATTRIBUTE_READ = ['product_attributes', 'products'];

// Map each HTTP method to the corresponding controller function
// ----- Auth (public) -----
router.post('/user/login', userController.loginUser);
router.post('/user/signup', userController.createUser);
router.post('/user/google-login', userController.googleLoginUser);
router.post('/user/stack-sync', userController.stackAuthSync);
// ----- Own profile (any logged-in user, customers included) -----
router.put('/update/user', auth, userController.updateUser);
router.delete('/user', auth, userController.deleteUser);
router.get('/userDetailForProfile', auth, userController.getUserDetailForProfile);
// ----- Admin: users list -----
router.get('/get/allUsers', ...staff, can('customers', 'view'), userController.getAllUsers);

// Google OAuth 2.0 redirect flow
router.get('/auth/google', userController.startGoogleOAuth);
router.get('/auth/google/callback', userController.googleOAuthCallback);

// Admin operations by ID (staff accounts: super admin only, enforced in the controller)
router.put('/update/status/:id', ...staff, can('customers', 'edit'), userController.updateUserStatusById);
// Setting role 'admin' gives admin-panel access -> super admin only.
router.put('/update/role/:id', ...staff, superAdmin, userController.updateUserRoleById);
router.delete('/delete/:id', ...staff, can('customers', 'delete'), userController.deleteUserById);

// User Password
router.put('/user/change-password', auth, userController.changePassword);

// User Address routes
router.get('/user/addresses', auth, userController.getUserAddresses);
router.post('/user/addresses', auth, userController.addUserAddress);
router.put('/user/addresses/:addressId', auth, userController.updateUserAddress);
router.delete('/user/addresses/:addressId', auth, userController.deleteUserAddress);
router.put('/user/addresses/:addressId/default', auth, userController.setDefaultAddress);

// User Car routes — the user's "my garage" (see admin/products/attributes?tab=cars for the catalog)
router.get('/user/cars', auth, userController.listUserCars);
router.post('/user/cars', auth, userController.addUserCar);
router.put('/user/cars/:carId', auth, userController.updateUserCar);
router.delete('/user/cars/:carId', auth, userController.removeUserCar);

// ----- Me / branches / staff ------------------------------------------------------
// What the logged-in user is and can do (+ branches they can switch to).
router.get('/me/access', ...staff, staffController.me);

// Branches: GET for any logged-in staff (controller limits what they see); writes super admin.
router.get('/admin/branches', ...staff, branchController.list);
router.post('/admin/branches', ...staff, superAdmin, branchController.create);
router.post('/admin/branches/:id/set-main', ...staff, superAdmin, branchController.setMain);
router.get('/admin/branches/:id', ...staff, branchController.getById);
router.put('/admin/branches/:id', ...staff, superAdmin, branchController.update);
router.delete('/admin/branches/:id', ...staff, superAdmin, branchController.remove);

// Staff users (super admin, or permission `staff` limited to own branch — see staffController).
router.get('/admin/staff', ...staff, can('staff', 'view'), staffController.list);
router.post('/admin/staff', ...staff, can('staff', 'create'), staffController.create);
router.post('/admin/staff/:id/reset-password', ...staff, can('staff', 'edit'), staffController.resetPassword);
router.get('/admin/staff/:id', ...staff, can('staff', 'view'), staffController.getById);
router.put('/admin/staff/:id', ...staff, can('staff', 'edit'), staffController.update);
router.delete('/admin/staff/:id', ...staff, can('staff', 'delete'), staffController.remove);

// Stock transfers between branches (branch staff: only FROM their own branch).
router.get('/admin/stock-transfers', ...staff, can('stock_transfers', 'view'), transferController.list);
router.post('/admin/stock-transfers', ...staff, can('stock_transfers', 'create'), transferController.create);
if (typeof transferController.cancel === 'function') {
  router.post('/admin/stock-transfers/:id/cancel', ...staff, can('stock_transfers', 'edit'), transferController.cancel);
}
router.get('/admin/stock-transfers/:id', ...staff, can('stock_transfers', 'view'), transferController.getById);

// Category routes
router.get('/categories/featured-with-products', cache(SEVEN_DAYS, 'categories:featured-with-products'), categoryController.listFeaturedCategoriesWithProducts); // cached 7d, invalidated on any admin CRUD
router.put('/categories/:id/featured-products', ...staff, can('product_categories', 'edit'), categoryController.setFeaturedProducts);
router.get('/categories/:id/products', ...staff, can(CATEGORY_READ, 'view'), categoryController.listProductsByCategory);
router.get('/categories/public', cache(SEVEN_DAYS, 'categories:public'), categoryController.listCategories); // Public route for popular categories — cached 7d, invalidated on any admin CRUD
router.get('/categories', categoryController.listCategories);
router.post('/categories', ...staff, can('product_categories', 'create'), uploadFields([
  { name: 'thumbnail', maxCount: 10 },
  { name: 'banner', maxCount: 1 }
]), categoryController.createCategory);
router.put('/categories/reorder', ...staff, can('product_categories', 'edit'), categoryController.reorderCategories);
router.put('/categories/:id', ...staff, can('product_categories', 'edit'), uploadFields([
  { name: 'thumbnail', maxCount: 10 },
  { name: 'banner', maxCount: 1 },
  { name: 'sizeChartRegularCm', maxCount: 1 },
  { name: 'sizeChartRegularInch', maxCount: 1 },
  { name: 'sizeChartRelaxedCm', maxCount: 1 },
  { name: 'sizeChartRelaxedInch', maxCount: 1 },
  { name: 'measuringTipImage', maxCount: 1 }
]), categoryController.updateCategory);
router.delete('/categories/:id', ...staff, can('product_categories', 'delete'), categoryController.deleteCategory);

// Color routes
router.get('/colors/active', colorController.listActiveColors); // Public route
router.get('/colors', ...staff, can(ATTRIBUTE_READ, 'view'), colorController.listColors);
router.post('/colors', ...staff, can('product_attributes', 'create'), colorController.createColor);
router.put('/colors/:id', ...staff, can('product_attributes', 'edit'), colorController.updateColor);
router.delete('/colors/:id', ...staff, can('product_attributes', 'delete'), colorController.deleteColor);

// Size routes
router.get('/sizes/active', sizeController.listActiveSizes); // Public route
router.get('/sizes', ...staff, can(ATTRIBUTE_READ, 'view'), sizeController.listSizes);
router.post('/sizes', ...staff, can('product_attributes', 'create'), sizeController.createSize);
router.put('/sizes/:id', ...staff, can('product_attributes', 'edit'), sizeController.updateSize);
router.delete('/sizes/:id', ...staff, can('product_attributes', 'delete'), sizeController.deleteSize);

// Car routes (legacy flat schema — kept for backwards compat)
router.get('/cars', ...staff, can(ATTRIBUTE_READ, 'view'), carController.listCars);
router.post('/cars', ...staff, can('product_attributes', 'create'), carController.createCar);
router.put('/cars/:id', ...staff, can('product_attributes', 'edit'), carController.updateCar);
router.delete('/cars/:id', ...staff, can('product_attributes', 'delete'), carController.deleteCar);

// Car Make routes (with optional logo upload)
router.get('/car-makes/active', cache(SEVEN_DAYS, 'car-makes:active'), carHierarchyController.listActiveMakes); // Public route — cached 7d, invalidated on any admin car CRUD
router.get('/car-makes/active/stats', cache(SEVEN_DAYS, 'car-makes:stats'), carHierarchyController.listActiveMakesWithStats); // Public route - with counts — cached 7d, invalidated on any admin car CRUD
router.get('/car-makes/featured', cache(SEVEN_DAYS, 'car-makes:featured'), carHierarchyController.listFeaturedMakes); // Public route — cached 7d, invalidated on any admin car CRUD
router.get('/car-makes', ...staff, can(ATTRIBUTE_READ, 'view'), carHierarchyController.listMakes);
router.patch('/car-makes/:id/featured', ...staff, can('product_attributes', 'edit'), carHierarchyController.toggleFeaturedMake);
router.post(
  '/car-makes',
  ...staff,
  can('product_attributes', 'create'),
  uploadFields([{ name: 'logo', maxCount: 1 }]),
  carHierarchyController.createMake
);
router.put(
  '/car-makes/:id',
  ...staff,
  can('product_attributes', 'edit'),
  uploadFields([{ name: 'logo', maxCount: 1 }]),
  carHierarchyController.updateMake
);
router.delete('/car-makes/:id', ...staff, can('product_attributes', 'delete'), carHierarchyController.deleteMake);

// Car Model routes
router.get('/car-models/active', cache(SEVEN_DAYS, 'car-models:active'), carHierarchyController.listActiveModels); // Public route — cached 7d, invalidated on any admin car CRUD
router.get('/car-models/make/:slug', cache(SEVEN_DAYS, 'car-models:by-make'), carHierarchyController.listActiveModelsByMakeSlug); // Public route - cached 7d, invalidated on any admin car CRUD
router.get('/car-models', ...staff, can(ATTRIBUTE_READ, 'view'), carHierarchyController.listModels);
router.post('/car-models', ...staff, can('product_attributes', 'create'), carHierarchyController.createModel);
router.put('/car-models/:id', ...staff, can('product_attributes', 'edit'), carHierarchyController.updateModel);
router.delete('/car-models/:id', ...staff, can('product_attributes', 'delete'), carHierarchyController.deleteModel);

// Car Variant routes (with optional image upload)
router.get('/car-variants/active', carHierarchyController.listActiveVariants); // Public route
router.get('/car-variants', ...staff, can(ATTRIBUTE_READ, 'view'), carHierarchyController.listVariants);
router.post(
  '/car-variants',
  ...staff,
  can('product_attributes', 'create'),
  uploadFields([{ name: 'image', maxCount: 1 }]),
  carHierarchyController.createVariant
);
router.put(
  '/car-variants/:id',
  ...staff,
  can('product_attributes', 'edit'),
  uploadFields([{ name: 'image', maxCount: 1 }]),
  carHierarchyController.updateVariant
);
router.delete('/car-variants/:id', ...staff, can('product_attributes', 'delete'), carHierarchyController.deleteVariant);

// Product routes
router.get('/products/random', productController.getRandomProducts); // Public route for random products
router.get('/products/latest', productController.getLatestProducts); // Public route for latest products
// Public (website). A staff token is optional: with it, the list is limited to the
// staff member's branch (own + shared products) and `stock` is that branch's stock.
router.get('/products', optionalAccess, productController.listProducts);
// Codes + stock receiving. Must sit before /products/:id.
router.get('/products/codes/check', ...staff, can('products', 'view'), inventoryController.checkCode);
router.get('/products/codes/new-short-code', ...staff, can('products', 'view'), inventoryController.generateShortCode);
router.get('/products/codes/lookup/:code', ...staff, can(PRODUCT_READ, 'view'), inventoryController.lookupCode);
router.post('/products/:id/stock/receive', ...staff, can('stock_receive', 'create'), inventoryController.receiveStock);
// Barcode stickers (HTML page to print, JSON for a picker). Must sit before /products/:id.
router.post('/products/labels/print', ...staff, can('products', 'view'), labelController.printBulk);
router.get('/products/:id/labels', ...staff, can('products', 'view'), labelController.printLabels);
router.get('/products/:id/label-data', ...staff, can('products', 'view'), labelController.getLabelData);
router.get('/products/:id', ...staff, can(PRODUCT_READ, 'view'), productController.getProductById);
// Accept multipart form-data with fields: thumbnail (1), banners (up to 10), colorThumbnail (multiple), colorBanner (multiple)
router.post(
  '/products',
  ...staff,
  can('products', 'create'),
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'banners', maxCount: 10 },
    { name: 'colorThumbnail', maxCount: 10 }, // Allow multiple color thumbnails
    { name: 'colorBanner', maxCount: 20 },    // Allow multiple color banners
  ]),
  productController.createProduct
);
router.put('/products/:id', ...staff, can('products', 'edit'), uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'banners', maxCount: 10 },
    { name: 'colorThumbnail', maxCount: 10 }, // Allow multiple color thumbnails
    { name: 'colorBanner', maxCount: 20 },    // Allow multiple color banners
  ]), productController.updateProduct);

router.delete('/products/:id', ...staff, can('products', 'delete'), productController.deleteProduct);

// Blog Category routes

// Blog routes

// Author routes

// Blog Hero routes

// Settings routes (reads: settings:view; every write: super admin)
router.get('/settings/public', cache(SEVEN_DAYS, 'settings:public'), settingsController.getPublicSettings); // Public route - no auth — cached 7d, invalidated on any admin write
router.get('/settings', ...staff, can('settings', 'view'), settingsController.getSettings);
router.put('/settings', ...staff, superAdmin, settingsController.updateSettings);
router.post('/settings/logo', ...staff, superAdmin, uploadFields([{ name: 'logo', maxCount: 1 }]), settingsController.uploadLogo);
router.delete('/settings/logo', ...staff, superAdmin, settingsController.removeLogo);
router.post('/settings/footer-logo', ...staff, superAdmin, uploadFields([{ name: 'logo', maxCount: 1 }]), settingsController.uploadFooterLogo);
router.delete('/settings/footer-logo', ...staff, superAdmin, settingsController.removeFooterLogo);
router.post('/settings/favicon', ...staff, superAdmin, uploadFields([{ name: 'favicon', maxCount: 1 }]), settingsController.uploadFavicon);
router.delete('/settings/favicon', ...staff, superAdmin, settingsController.removeFavicon);
router.post('/settings/reset', ...staff, superAdmin, settingsController.resetSettings);
router.post('/settings/cache/reset', ...staff, superAdmin, settingsController.resetCaches);

// Hero Slide routes

// Product Detail routes (Public - No authentication required)

// Cart routes (Authentication required)

// Wishlist routes (Authentication required)

// Payment and Order Management Routes


// Public Product Routes - No authentication required

// Newsletter routes

// Contact routes

// Review routes

// Admin Review routes

// Order routes (for COD and direct orders)

// Admin Order count route

// Blog Comment routes

// Dynamic Pages routes

// Return Order routes

// Admin Return Order routes

// Discount/Coupon routes

// Preorder routes

// Admin Preorder routes

// Shipping routes

// Guideline routes
router.get('/guidelines/public', guidelineController.listGuidelines); // Public - for frontend
router.get('/guidelines', ...staff, can('guidelines', 'view'), guidelineController.listGuidelines);
router.get('/guidelines/:id', ...staff, can('guidelines', 'view'), guidelineController.getGuidelineById);
router.post('/guidelines', ...staff, can('guidelines', 'create'), uploadFields([{ name: 'images', maxCount: 10 }]), guidelineController.createGuideline);
router.put('/guidelines/:id', ...staff, can('guidelines', 'edit'), uploadFields([{ name: 'images', maxCount: 10 }]), guidelineController.updateGuideline);
router.patch('/guidelines/:id/toggle-active', ...staff, can('guidelines', 'edit'), guidelineController.toggleActive);
router.delete('/guidelines/:id', ...staff, can('guidelines', 'delete'), guidelineController.deleteGuideline);

// Fabric routes

// Print routes (subcategories of fabrics)

// Kind routes

// Style routes

// Shipping Option routes

// Add-on routes

// Add-on Option routes

// Service Category routes (public)

// Service Category routes (admin)

// Booking settings

// Procurement — Vendors
router.get('/admin/procurement/vendors', ...staff, can('procurement', 'view'), vendorController.list);
router.get('/admin/procurement/vendors/:id', ...staff, can('procurement', 'view'), vendorController.getById);
router.get('/admin/procurement/vendors/:id/ledger', ...staff, can('procurement', 'view'), vendorController.ledger);
router.post('/admin/procurement/vendors', ...staff, can('procurement', 'create'), vendorController.create);
router.put('/admin/procurement/vendors/:id', ...staff, can('procurement', 'edit'), vendorController.update);
router.put('/admin/procurement/vendors/:id/status', ...staff, can('procurement', 'edit'), vendorController.toggleStatus);
router.delete('/admin/procurement/vendors/:id', ...staff, can('procurement', 'delete'), vendorController.softDelete);

// Procurement — Purchases
router.get('/admin/procurement/summary', ...staff, can('procurement', 'view'), purchaseController.summary);
router.get('/admin/procurement/transactions', ...staff, can('procurement', 'view'), purchaseController.listTransactions);
router.get('/admin/procurement/products/search', ...staff, can('procurement', 'view'), purchaseController.searchProducts);
router.get('/admin/procurement/purchases', ...staff, can('procurement', 'view'), purchaseController.list);
router.get('/admin/procurement/purchases/:id', ...staff, can('procurement', 'view'), purchaseController.getById);
router.post('/admin/procurement/purchases', ...staff, can('procurement', 'create'), purchaseController.create);
router.put('/admin/procurement/purchases/:id', ...staff, can('procurement', 'edit'), purchaseController.update);
router.delete('/admin/procurement/purchases/:id', ...staff, can('procurement', 'delete'), purchaseController.softDelete);
router.post('/admin/procurement/purchases/:id/payments', ...staff, can('procurement', 'edit'), purchaseController.addPayment);
router.delete('/admin/procurement/purchases/:id/payments/:paymentId', ...staff, can('procurement', 'edit'), purchaseController.removePayment);

// Audit Log routes (activity_log; clearing everything: super admin)
router.get('/admin/audit-logs', ...staff, can('activity_log', 'view'), auditLogController.getAllAuditLogs);
router.delete('/admin/audit-logs', ...staff, superAdmin, auditLogController.clearAllAuditLogs);
router.get('/admin/audit-logs/analytics', ...staff, can('activity_log', 'view'), auditLogController.getAuditAnalytics);
router.get('/admin/audit-logs/top-users', ...staff, can('activity_log', 'view'), auditLogController.getTopUsers);
router.get('/admin/audit-logs/user/:userId', ...staff, can('activity_log', 'view'), auditLogController.getUserAuditLogs);
router.get('/admin/audit-logs/user/:userId/summary', ...staff, can('activity_log', 'view'), auditLogController.getUserAuditSummary);

// HR & Payroll — Employees

// HR & Payroll — Attendance

// HR & Payroll — Salary

// Finance — Banks
router.get('/banks', ...staff, can('banks', 'view'), bankController.getAllBanks);
router.get('/banks/:id', ...staff, can('banks', 'view'), bankController.getBankById);
router.post('/banks', ...staff, can('banks', 'create'), bankController.createBank);
router.put('/banks/:id', ...staff, can('banks', 'edit'), bankController.updateBank);
router.put('/banks/:id/status', ...staff, can('banks', 'edit'), bankController.updateBankStatus);
router.delete('/banks/:id', ...staff, can('banks', 'delete'), bankController.deleteBank);

// Easyload — Networks and their daily balance register
router.get('/networks', ...staff, can('networks', 'view'), networkController.getAllNetworks);
router.post('/networks', ...staff, can('networks', 'create'), networkController.createNetwork);
router.get('/networks/:id/days', ...staff, can('networks', 'view'), networkController.getNetworkDays);
router.get('/networks/:id/days/:date', ...staff, can('networks', 'view'), networkController.getNetworkDay);
router.put('/networks/:id/days/:date', ...staff, can('networks', 'edit'), networkController.upsertNetworkDay);
router.post('/networks/:id/days/:date/loads', ...staff, can('networks', 'create'), networkController.addLoad);
router.delete('/networks/:id/days/:date/loads/:loadId', ...staff, can('networks', 'delete'), networkController.deleteLoad);
router.get('/networks/:id', ...staff, can('networks', 'view'), networkController.getNetworkById);
router.put('/networks/:id', ...staff, can('networks', 'edit'), networkController.updateNetwork);
router.delete('/networks/:id', ...staff, can('networks', 'delete'), networkController.deleteNetwork);

// Finance — Assets
router.get('/assets', ...staff, can('assets', 'view'), assetController.getAllAssets);
router.get('/assets/:id', ...staff, can('assets', 'view'), assetController.getAssetById);
router.post('/assets', ...staff, can('assets', 'create'), assetController.createAsset);
router.put('/assets/:id', ...staff, can('assets', 'edit'), assetController.updateAsset);
router.put('/assets/:id/status', ...staff, can('assets', 'edit'), assetController.updateAssetStatus);
router.delete('/assets/:id', ...staff, can('assets', 'delete'), assetController.deleteAsset);

// Finance — Expenses
router.get('/expenses', ...staff, can('expenses', 'view'), expenseController.getAllExpenses);
router.get('/expenses/summary', ...staff, can('expenses', 'view'), expenseController.getExpenseSummary);
router.get('/expenses/categories', ...staff, can('expenses', 'view'), expenseController.getAllCategories);
router.post('/expenses/categories', ...staff, can('expenses', 'create'), expenseController.createCategory);
router.delete('/expenses/categories/:id', ...staff, can('expenses', 'delete'), expenseController.deleteCategory);
router.get('/expenses/:id', ...staff, can('expenses', 'view'), expenseController.getExpenseById);
router.post('/expenses', ...staff, can('expenses', 'create'), uploadSingle('receipt'), expenseController.createExpense);
router.put('/expenses/:id', ...staff, can('expenses', 'edit'), uploadSingle('receipt'), expenseController.updateExpense);
router.put('/expenses/:id/status', ...staff, can('expenses', 'edit'), expenseController.updateExpenseStatus);
router.delete('/expenses/:id', ...staff, can('expenses', 'delete'), expenseController.deleteExpense);

// Roles & Permissions — reading: roles:view or staff:view (staff managers need the
// role list to assign roles); every change: super admin only.
router.get('/admin/roles/catalogue', ...staff, can(['roles', 'staff'], 'view'), roleController.getCatalogue);
router.get('/admin/roles', ...staff, can(['roles', 'staff'], 'view'), roleController.getAllRoles);
router.get('/admin/roles/:id', ...staff, can(['roles', 'staff'], 'view'), roleController.getRoleById);
router.post('/admin/roles', ...staff, superAdmin, roleController.createRole);
router.put('/admin/roles/:id/permissions', ...staff, superAdmin, roleController.updatePermissions);
router.put('/admin/roles/:id', ...staff, superAdmin, roleController.updateRole);
router.delete('/admin/roles/:id', ...staff, superAdmin, roleController.deleteRole);

// Cache reset telemetry — when was each cache tag last invalidated
router.get('/admin/cache/resets', ...staff, can('settings', 'view'), async (req, res) => {
  const { getResetTimestamps } = require('../middleware/cache');
  return res.status(200).json({ success: true, data: await getResetTimestamps() });
});

// POS — Point of Sale system (auth + loadAccess + per-route permissions inside)
const posRoutes = require('./posRoutes');
router.use('/api/pos', posRoutes);

// Reports — server-side aggregations for the admin Reports section.
const reportsController = require('../controller/reportsController');
router.get('/api/reports/cash-in-hand', ...staff, can('report_cash_in_hand', 'view'), reportsController.cashInHand);
router.get('/api/reports/sales-summary', ...staff, can('report_sales', 'view'), reportsController.salesSummary);
router.get('/api/reports/purchases-summary', ...staff, can('report_purchases', 'view'), reportsController.purchasesSummary);
router.get('/api/reports/cost-analysis', ...staff, can('report_cost_analysis', 'view'), reportsController.costAnalysis);
router.get('/api/reports/stock', ...staff, can('report_stock', 'view'), reportsController.stock);
router.get('/api/reports/expenses', ...staff, can('report_expenses', 'view'), reportsController.expensesReport);
router.get('/api/reports/vendor-payments', ...staff, can('report_vendor_payments', 'view'), reportsController.vendorPaymentsReport);

module.exports = router;
