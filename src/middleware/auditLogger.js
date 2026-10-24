const AuditLog = require('../models/auditLog');
const { runWithChanges } = require('../helper/changeLog');

// ONLY update operations are logged (owner's choice): PUT / PATCH, plus the
// POST routes that change an existing record. Each log carries the changed
// fields (old -> new) in details.changes — see helper/changeLog.js.
const UPDATE_POST = /\/:id\/(payment|payments|refund|set-main|reset-password|cancel|stock\/receive)$/;
const UPDATE_POST_PATHS = new Set(['/products/:id/stock/receive']);
const isUpdateRequest = (method, normalizedPath) =>
  method === 'PUT' || method === 'PATCH' ||
  (method === 'POST' && (UPDATE_POST.test(normalizedPath) || UPDATE_POST_PATHS.has(normalizedPath)));

// Named actions for known routes (for nicer labels in the UI)
const ROUTE_ACTION_MAP = {
  // Auth
  'POST /user/login':           'login',
  'POST /user/signup':          'signup',
  'POST /user/google-login':    'google_login',
  'POST /user/stack-sync':      'stack_auth_sync',
  'GET /auth/google/callback':  'google_oauth_callback',

  // Profile
  'PUT /update/user':           'update_profile',
  'DELETE /user':               'delete_account',
  'GET /userDetailForProfile':  'view_profile',
  'PUT /user/change-password':  'change_password',

  // Addresses
  'POST /user/addresses':       'add_address',
  'PUT /user/addresses/:id':    'update_address',
  'DELETE /user/addresses/:id': 'delete_address',
  'GET /user/addresses':        'view_addresses',

  // User Cars
  'POST /user/cars':            'add_car',
  'PUT /user/cars/:id':         'update_car',
  'DELETE /user/cars/:id':      'remove_car',
  'GET /user/cars':             'view_cars',

  // Cart
  'POST /cart':                 'add_to_cart',
  'POST /cart/add':             'add_to_cart',
  'PUT /cart/update':           'update_cart',
  'PUT /cart/item/:id':         'update_cart_item',
  'DELETE /cart/item/:id':      'remove_from_cart',
  'DELETE /cart':               'clear_cart',
  'POST /cart/merge':           'merge_guest_cart',
  'GET /cart':                  'view_cart',

  // Wishlist
  'POST /wishlist':             'add_to_wishlist',
  'POST /wishlist/add':         'add_to_wishlist',
  'POST /wishlist/toggle':      'toggle_wishlist',
  'DELETE /wishlist/:id':       'remove_from_wishlist',
  'GET /wishlist':              'view_wishlist',

  // Orders
  'POST /orders':               'place_order',
  'POST /orders/create':        'place_order',
  'GET /orders':                'view_orders',
  'GET /orders/:id':            'view_order_detail',

  // Products
  'GET /products/public':       'browse_products',
  'GET /products/public/:id':   'view_product',
  'GET /products/slug/:id':     'view_product',
  'GET /product-detail/:id':    'view_product',
  'GET /products/:id':          'view_product',

  // Categories
  'GET /categories':            'browse_categories',
  'GET /categories/public':     'browse_categories',

  // Reviews
  'POST /reviews':              'create_review',
  'POST /reviews/create':       'create_review',
  'PUT /reviews/:id':           'update_review',
  'DELETE /reviews/:id':        'delete_review',
  'GET /reviews/product/:id':   'view_reviews',

  // Returns
  'POST /returns':              'create_return',
  'POST /returns/create':       'create_return',
  'GET /returns':               'view_returns',

  // Preorders
  'POST /preorders':            'create_preorder',
  'POST /preorders/create':     'create_preorder',
  'DELETE /preorders/:id':      'cancel_preorder',
  'GET /preorders':             'view_preorders',
  'GET /user/preorders':        'view_preorders',

  // Contact
  'POST /contact':              'submit_contact',
  'POST /contact/submit':       'submit_contact',

  // Newsletter
  'POST /newsletter/subscribe':   'newsletter_subscribe',
  'POST /newsletter/unsubscribe': 'newsletter_unsubscribe',

  // Discount
  'POST /discounts/apply':      'apply_discount',
  'POST /discount/apply':       'apply_discount',

  // Blog
  'GET /blogs':                 'browse_blogs',
  'GET /blogs/:id':             'view_blog',
  'GET /blogs/slug/:id':        'view_blog',
  'POST /blog-comments':        'post_blog_comment',

  // Services
  'GET /service-categories':    'view_services',

  // Pages
  'GET /pages/:id':             'view_page',

  // Settings
  'GET /settings/public':       'view_settings',

  // Car makes
  'GET /car-makes/active':      'browse_car_makes',

  // Admin user management
  'PUT /update/status/:id':     'admin_update_user_status',
  'PUT /update/role/:id':       'admin_update_user_role',
  'DELETE /delete/:id':         'admin_delete_user',
  'GET /get/allUsers':          'admin_view_users',

  // Admin roles
  'GET /admin/roles':              'admin_view_roles',
  'GET /admin/roles/:id':          'admin_view_role',
  'POST /admin/roles':             'admin_create_role',
  'PUT /admin/roles/:id':          'admin_update_role',
  'PUT /admin/roles/:id/permissions': 'admin_update_role_permissions',
  'DELETE /admin/roles/:id':       'admin_delete_role',

  // Branches
  'POST /admin/branches':                'admin_create_branch',
  'PUT /admin/branches/:id':             'admin_update_branch',
  'DELETE /admin/branches/:id':          'admin_delete_branch',
  'POST /admin/branches/:id/set-main':   'admin_set_main_branch',

  // Staff users
  'POST /admin/staff':                     'admin_create_staff',
  'PUT /admin/staff/:id':                  'admin_update_staff',
  'POST /admin/staff/:id/reset-password':  'admin_reset_staff_password',
  'DELETE /admin/staff/:id':               'admin_delete_staff',

  // Stock
  'POST /products/:id/stock/receive':          'receive_stock',
  'POST /admin/stock-transfers':               'stock_transfer',
  'POST /admin/stock-transfers/:id/cancel':    'cancel_stock_transfer',
};

// Actions with elevated severity — audit-relevant / security-sensitive.
const SEVERITY_MAP = {
  // Critical — destructive or authentication-impacting
  login:                    'warn',
  signup:                   'warn',
  google_login:             'warn',
  change_password:          'critical',
  delete_account:           'critical',
  admin_delete_user:        'critical',
  admin_update_user_status: 'critical',
  admin_update_user_role:   'critical',
  admin_create_role:        'warn',
  admin_update_role:        'warn',
  admin_update_role_permissions: 'critical',
  admin_delete_role:        'critical',
  admin_create_branch:      'warn',
  admin_update_branch:      'warn',
  admin_delete_branch:      'critical',
  admin_set_main_branch:    'critical',
  admin_create_staff:       'warn',
  admin_update_staff:       'critical',
  admin_reset_staff_password: 'critical',
  admin_delete_staff:       'critical',
  stock_transfer:           'warn',
  cancel_stock_transfer:    'warn',
};

// Routes to completely skip (health, static, audit logs themselves)
const SKIP_PREFIXES = ['/uploads', '/health', '/admin/audit-logs', '/favicon'];

// Noisy polling endpoints — keep every Nth hit instead of every one, so they don't
// drown out meaningful activity. Tune by raising N.
const SAMPLE_ROUTES = new Map([
  ['GET /orders/admin/count',      10],
  ['GET /preorders/admin/count',   10],
  ['GET /returns/admin/count',     10],
]);
const sampleCounters = new Map();

const AUTH_ACTIONS = new Set(['login', 'signup', 'google_login', 'stack_auth_sync', 'google_oauth_callback']);
const SENSITIVE_QUERY_KEYS = new Set(['password', 'token', 'secret', 'apikey', 'api_key', 'authorization']);

function normalizePathForMatching(path) {
  return path
    .replace(/\/[a-f0-9]{24}/g, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/** Get client IP respecting X-Forwarded-For (first in the list is the client). */
function extractIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.connection?.remoteAddress || null;
}

/** Minimal UA parser — good enough for filtering without pulling in a package. */
function parseUserAgent(ua) {
  if (!ua) return { browser: null, os: null, device: null };
  const s = String(ua);
  const lower = s.toLowerCase();

  let device = 'desktop';
  if (/bot|spider|crawler|slurp|bingpreview|facebookexternalhit/i.test(s)) device = 'bot';
  else if (/tablet|ipad/i.test(s)) device = 'tablet';
  else if (/mobile|android|iphone|ipod/i.test(s)) device = 'mobile';

  let os = null;
  if (lower.includes('windows nt 10')) os = 'Windows 10/11';
  else if (lower.includes('windows'))  os = 'Windows';
  else if (/mac os x|macintosh/.test(lower)) os = 'macOS';
  else if (lower.includes('android'))  os = 'Android';
  else if (/iphone|ipad|ipod/.test(lower)) os = 'iOS';
  else if (lower.includes('linux'))    os = 'Linux';

  let browser = null;
  if (/edg\//i.test(s))         browser = 'Edge';
  else if (/opr\/|opera/i.test(s))  browser = 'Opera';
  else if (/chrome\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/postman/i.test(s))  browser = 'Postman';
  else if (/curl|wget|axios|node-fetch/i.test(s)) browser = 'CLI';

  return { browser, os, device };
}

/** Extract the most likely "resource id" touched by this request. */
function extractResourceId(req) {
  const p = req.params || {};
  return (
    p.id ||
    p.productId ||
    p.orderId ||
    p.userId ||
    p.returnId ||
    p.reviewId ||
    p.itemId ||
    p.roleId ||
    p.blogId ||
    p.categoryId ||
    p.commentId ||
    p.vendorId ||
    null
  );
}

/** Strip secrets out of ?query=... so we never persist them. */
function sanitizeQuery(query) {
  if (!query || typeof query !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(query)) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) continue;
    // keep scalars + short arrays; drop objects
    if (Array.isArray(v)) out[k] = v.slice(0, 5).map(String);
    else if (v != null && typeof v !== 'object') out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

/** If body is an object with a known error-ish shape, pull a short message out. */
function extractErrorMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 500);
  if (typeof body !== 'object') return null;
  const candidate = body.message || body.error || body.msg;
  if (typeof candidate === 'string') return candidate.slice(0, 500);
  if (candidate && typeof candidate === 'object') {
    try { return JSON.stringify(candidate).slice(0, 500); } catch { return null; }
  }
  return null;
}

/** Try to coerce a response chunk (string/Buffer) into JSON if applicable. */
function tryParseBody(chunk, contentType) {
  if (chunk == null) return null;
  if (typeof chunk === 'object' && !Buffer.isBuffer(chunk)) return chunk;
  const asString = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (!contentType || !contentType.includes('json')) {
    // non-JSON body (html, file, redirect) — keep just the first 500 chars as a string
    return asString.slice(0, 500);
  }
  try { return JSON.parse(asString); } catch { return asString.slice(0, 500); }
}

function shouldSample(key) {
  const rate = SAMPLE_ROUTES.get(key);
  if (!rate) return true;
  const next = (sampleCounters.get(key) || 0) + 1;
  sampleCounters.set(key, next);
  return next % rate === 0;
}

function buildDetails(action, req, responseBody) {
  const d = {};

  switch (action) {
    case 'login':
    case 'google_login':
    case 'signup':
    case 'stack_auth_sync':
      d.email = req.body?.email || responseBody?.data?.email || null;
      break;
    case 'add_to_cart':
      d.productId = req.body?.productId || null;
      d.quantity = req.body?.quantity || null;
      break;
    case 'remove_from_cart':
    case 'update_cart_item':
      d.itemId = req.params?.id || req.params?.itemId || null;
      d.quantity = req.body?.quantity || null;
      break;
    case 'add_to_wishlist':
    case 'toggle_wishlist':
      d.productId = req.body?.productId || null;
      break;
    case 'remove_from_wishlist':
      d.productId = req.params?.id || req.params?.productId || null;
      break;
    case 'place_order':
      d.orderId = responseBody?.data?._id || null;
      d.total = req.body?.total || responseBody?.data?.total || null;
      break;
    case 'apply_discount':
      d.code = req.body?.code || null;
      break;
    case 'create_review':
      d.productId = req.body?.productId || null;
      d.rating = req.body?.rating || null;
      break;
    case 'create_return':
      d.orderId = req.body?.orderId || null;
      d.reason = req.body?.reason || null;
      break;
    case 'create_preorder':
      d.productId = req.body?.productId || null;
      break;
    case 'admin_update_user_status':
      d.targetUserId = req.params?.id || null;
      d.isActive = req.body?.isActive;
      break;
    case 'admin_update_user_role':
      d.targetUserId = req.params?.id || null;
      d.newRole = req.body?.role || null;
      break;
    case 'admin_delete_user':
      d.targetUserId = req.params?.id || null;
      break;
    case 'admin_create_role':
    case 'admin_update_role':
      d.name = req.body?.name || null;
      break;
    case 'admin_update_role_permissions': {
      const perms = req.body?.permissions || {};
      d.groupCount = Object.keys(perms).length;
      d.actionCount = Object.values(perms).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      );
      break;
    }
    case 'admin_create_staff':
      d.email = req.body?.email || null;
      d.isSuperAdmin = req.body?.isSuperAdmin === true;
      d.staffRole = req.body?.staffRole || null;
      d.branch = req.body?.branch || null;
      break;
    case 'admin_update_staff':
      d.targetUserId = req.params?.id || null;
      d.fields = Object.keys(req.body || {}).filter((k) => !/password/i.test(k));
      if (req.body?.staffRole !== undefined) d.staffRole = req.body.staffRole;
      if (req.body?.branch !== undefined) d.branch = req.body.branch;
      if (req.body?.isActive !== undefined) d.isActive = req.body.isActive;
      if (req.body?.isSuperAdmin !== undefined) d.isSuperAdmin = req.body.isSuperAdmin;
      break;
    case 'admin_reset_staff_password':
    case 'admin_delete_staff':
      d.targetUserId = req.params?.id || null;
      break;
    case 'admin_create_branch':
    case 'admin_update_branch':
      d.name = req.body?.name || null;
      d.code = req.body?.code || null;
      break;
    case 'receive_stock':
      d.productId = req.params?.id || null;
      d.variantId = req.body?.variantId || null;
      d.quantity = req.body?.quantity ?? null;
      d.branchId = req.access?.branchId || null;
      break;
    case 'stock_transfer':
      d.fromBranchId = req.body?.fromBranchId || null;
      d.toBranchId = req.body?.toBranchId || null;
      d.itemCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
      break;
    case 'submit_contact':
      d.email = req.body?.email || null;
      d.subject = req.body?.subject || null;
      break;
    case 'view_product':
    case 'view_blog':
      d.slug = req.params?.slug || req.params?.id || req.path.split('/').pop() || null;
      break;
    default:
      break;
  }

  return Object.keys(d).length > 0 ? d : null;
}

/**
 * Audit every request — not just the ones that answer via res.json().
 * We hook res.send / res.end so redirects, file downloads, and error
 * responses are captured too.
 */
function auditLogger(req, res, next) {
  const method = req.method.toUpperCase();

  if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const startedAt = Date.now();
  const normalizedPath = normalizePathForMatching(req.path);
  const key = `${method} ${normalizedPath}`;

  if (!isUpdateRequest(method, normalizedPath)) return next();
  const changeCtx = { changes: [] };

  if (!shouldSample(key)) return next();

  const action = ROUTE_ACTION_MAP[key] || `${method.toLowerCase()} ${normalizedPath}`;

  let logged = false;
  let capturedBody = null;

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  res.json = function (body) {
    capturedBody = body;
    writeLog();
    return originalJson(body);
  };
  res.send = function (body) {
    if (capturedBody == null) {
      capturedBody = tryParseBody(body, res.getHeader('content-type'));
    }
    writeLog();
    return originalSend(body);
  };
  res.end = function (chunk, encoding, cb) {
    if (capturedBody == null && chunk != null) {
      capturedBody = tryParseBody(chunk, res.getHeader('content-type'));
    }
    writeLog();
    return originalEnd(chunk, encoding, cb);
  };

  res.on('close', () => {
    // Client closed the connection before we responded — still capture it.
    if (!logged) writeLog(true);
  });

  function writeLog(connectionClosed = false) {
    if (logged) return;
    logged = true;

    let userId = req.user?.id || req.user?._id || null;
    if (!userId && AUTH_ACTIONS.has(action) && capturedBody?.data?._id) {
      userId = capturedBody.data._id;
    }

    const statusCode = res.statusCode || (connectionClosed ? 499 : null);
    const failed = statusCode && statusCode >= 400;
    const severity = SEVERITY_MAP[action] || (failed ? 'warn' : 'info');
    const { browser, os, device } = parseUserAgent(req.headers['user-agent']);

    const cacheHeader = res.getHeader('X-Cache') || res.getHeader('x-cache') || null;

    const entry = {
      userId,
      action,
      method,
      path: req.path,
      details: (() => {
        const d = buildDetails(action, req, capturedBody) || {};
        if (changeCtx.changes.length) d.changes = changeCtx.changes.slice(0, 20);
        return Object.keys(d).length ? d : null;
      })(),
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'] || null,
      browser,
      os,
      device,
      referer: req.headers['referer'] || req.headers['referrer'] || null,
      queryParams: sanitizeQuery(req.query),
      resourceId: extractResourceId(req),
      errorMessage: failed ? extractErrorMessage(capturedBody) : null,
      cacheStatus: cacheHeader ? String(cacheHeader) : null,
      responseSize: typeof capturedBody === 'string'
        ? Buffer.byteLength(capturedBody)
        : (capturedBody ? Buffer.byteLength(JSON.stringify(capturedBody)) : null),
      severity,
      statusCode,
      durationMs: Date.now() - startedAt,
    };

    const marker = failed ? '⚠️' : severity === 'critical' ? '🔒' : '📋';
    console.log(
      `${marker} Audit: ${action} | ${method} ${req.path} | user: ${userId || 'guest'} | ${statusCode || '—'}`
      + (failed && entry.errorMessage ? ` | ${entry.errorMessage}` : '')
    );

    AuditLog.create(entry).catch((err) => {
      console.error('Audit log write error:', err.message);
    });
  }

  // Track old -> new values of everything this request changes.
  runWithChanges(changeCtx, next);
}

module.exports = auditLogger;
