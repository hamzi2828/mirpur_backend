// src/middleware/access.js
// Who is calling, which branch they work in, and what they may do.
//
// Use AFTER `auth` (which only verifies the JWT):
//   router.get('/x', auth, loadAccess, requirePermission('products', 'view'), handler)
//
// req.access = {
//   userId, isSuperAdmin,
//   userBranchId,   // branch the user belongs to (null for super admin)
//   branchId,       // branch this request works on:
//                   //   branch user  -> always their own branch (cannot change it)
//                   //   super admin  -> branch picked with header `x-branch-id`
//                   //                   or query `branchId`/`branch`; null = all branches
//   permissions,    // { products: ['view','create'], ... }
//   can(key, action)
// }
//
// Helpers for controllers:
//   branchFilter(req, field='branch')  -> {} (all branches) or { [field]: branchId }
//   resolveWriteBranch(req)            -> branch id to write to (sale, receive stock...).
//                                         Super admin with no branch picked -> main branch.

const mongoose = require('mongoose');
const User = require('../models/user');
const Role = require('../models/role');
const Branch = require('../models/branch');

const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { at, data }

const clearAccessCache = (userId) => {
  if (userId) cache.delete(String(userId));
  else cache.clear();
};

const toPlainPermissions = (perms) => {
  if (!perms) return {};
  if (perms instanceof Map) return Object.fromEntries(perms);
  return { ...perms };
};

async function loadUserAccess(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const user = await User.findById(userId)
    .select('role isSuperAdmin staffRole branch isActive firstName lastName email')
    .lean();
  if (!user) return null;

  let permissions = {};
  let roleName = null;
  if (user.staffRole) {
    const role = await Role.findOne({ _id: user.staffRole, isDeleted: { $ne: true } }).lean();
    if (role) {
      permissions = toPlainPermissions(role.permissions);
      roleName = role.name;
    }
  }

  // Before the branches migration runs, existing admins have no staffRole and
  // no branch: keep treating them as super admins so nothing breaks.
  const legacyAdmin = user.role === 'admin' && !user.staffRole && !user.branch;
  const data = {
    user,
    isSuperAdmin: !!user.isSuperAdmin || legacyAdmin,
    permissions,
    roleName,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

const pickRequestedBranch = (req) => {
  const raw = req.headers['x-branch-id'] || req.query.branchId || req.query.branch || null;
  if (!raw || raw === 'all') return null;
  return mongoose.Types.ObjectId.isValid(String(raw)) ? String(raw) : null;
};

async function loadAccess(req, res, next) {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Authorization token required' });

    const info = await loadUserAccess(userId);
    if (!info) return res.status(401).json({ message: 'User not found' });
    if (info.user.isActive === false) return res.status(403).json({ message: 'Account is disabled' });

    const userBranchId = info.user.branch ? String(info.user.branch) : null;
    let branchId;
    if (info.isSuperAdmin) {
      branchId = pickRequestedBranch(req);
    } else {
      // Staff must belong to a branch; customers (no staff role) have none.
      branchId = userBranchId;
    }

    req.access = {
      userId: String(userId),
      isSuperAdmin: info.isSuperAdmin,
      roleName: info.isSuperAdmin ? 'Super Admin' : info.roleName,
      userBranchId,
      branchId,
      permissions: info.permissions,
      can(key, action = 'view') {
        if (this.isSuperAdmin) return true;
        const list = this.permissions[key];
        return Array.isArray(list) && list.includes(action);
      },
    };
    return next();
  } catch (err) {
    console.error('loadAccess error:', err);
    return res.status(500).json({ message: 'Could not load access', error: err.message });
  }
}

// For public routes that staff also use (e.g. GET /products): when the caller
// sends a valid STAFF token, load req.access like loadAccess; otherwise (no
// token, bad token, customer, disabled account) carry on as a public call.
async function optionalAccess(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return next();
    let decoded;
    try {
      decoded = require('jsonwebtoken').verify(token, secret);
    } catch (_) {
      return next();
    }
    const userId = decoded && (decoded._id || decoded.id);
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return next();
    const info = await loadUserAccess(userId);
    if (!info || info.user.isActive === false) return next();
    if (!info.isSuperAdmin && !info.user.staffRole) return next(); // customer
    req.user = req.user || decoded;
    return loadAccess(req, res, next);
  } catch (err) {
    console.error('optionalAccess error:', err);
    return next();
  }
}

// Middleware factory: needs req.access (loadAccess). Accepts one key or a list
// (any one of them is enough), e.g. requirePermission(['pos', 'pos_orders'], 'view').
const requirePermission = (keys, action = 'view') => {
  const list = Array.isArray(keys) ? keys : [keys];
  return (req, res, next) => {
    if (!req.access) return res.status(500).json({ message: 'Access not loaded' });
    if (list.some((k) => req.access.can(k, action))) return next();
    return res.status(403).json({
      message: 'You do not have permission for this action',
      required: { keys: list, action },
    });
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (req.access?.isSuperAdmin) return next();
  return res.status(403).json({ message: 'Only the super admin can do this' });
};

// Matches nothing: used for non-super-admin users without a branch.
const NO_BRANCH = new mongoose.Types.ObjectId('000000000000000000000000');

const branchFilter = (req, field = 'branch') => {
  const id = req.access?.branchId;
  if (id) return { [field]: new mongoose.Types.ObjectId(id) };
  if (req.access?.isSuperAdmin) return {}; // all branches
  return { [field]: NO_BRANCH };
};

async function resolveWriteBranch(req) {
  if (req.access?.branchId) return req.access.branchId;
  if (!req.access?.isSuperAdmin) {
    const err = new Error('Your account is not assigned to a branch. Ask the super admin.');
    err.status = 403;
    throw err;
  }
  const main = await Branch.getMain();
  return String(main._id);
}

module.exports = {
  loadAccess,
  optionalAccess,
  requirePermission,
  requireSuperAdmin,
  branchFilter,
  resolveWriteBranch,
  clearAccessCache,
  loadUserAccess,
};
