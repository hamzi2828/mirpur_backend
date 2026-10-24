// src/helper/productScope.js
// Which products a request may see.
//
// Product.ownerBranch:
//   null / missing -> shared product, every branch sees it (made by the super admin)
//   a branch id    -> made by that branch's staff; only that branch and the
//                     super admin see it
//
//   productScopeFilter(req, branchId?) -> Mongo condition to add to product queries
//   canSeeProduct(req, product, branchId?) -> true/false for one product
//   ownerBranchForCreate(req, requested) -> ownerBranch to save on a new product
//
// `branchId` overrides the request's branch (e.g. the POS branch).
// Public calls (no req.access, e.g. the website) see shared products only.
const mongoose = require('mongoose');

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const toObjectId = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

// Branch the request looks at: null = all branches (super admin only).
const viewBranch = (req, branchId) => {
  if (branchId !== undefined) return isId(branchId) ? String(branchId) : null;
  return req && req.access && isId(req.access.branchId) ? String(req.access.branchId) : null;
};

function productScopeFilter(req, branchId) {
  const access = req && req.access;
  if (!access) return { ownerBranch: null };
  const id = viewBranch(req, branchId);
  if (!id) return access.isSuperAdmin ? {} : { ownerBranch: null };
  // `null` also matches products saved before this field existed.
  return { ownerBranch: { $in: [null, toObjectId(id)] } };
}

function canSeeProduct(req, product, branchId) {
  if (!product) return false;
  const owner = product.ownerBranch && product.ownerBranch._id ? product.ownerBranch._id : product.ownerBranch;
  if (!owner) return true;
  const access = req && req.access;
  if (!access) return false;
  if (access.isSuperAdmin && branchId === undefined) return true;
  const id = viewBranch(req, branchId);
  if (!id) return !!access.isSuperAdmin;
  return String(owner) === id;
}

// Staff -> their own branch (always). Super admin -> shared, unless they pick a
// branch in the form (`ownerBranch` = branch id; '', 'all' or null = shared).
function ownerBranchForCreate(req, requested) {
  const access = req && req.access;
  if (!access) return null;
  if (!access.isSuperAdmin) return isId(access.userBranchId) ? toObjectId(access.userBranchId) : null;
  return isId(requested) ? toObjectId(requested) : null;
}

module.exports = { productScopeFilter, canSeeProduct, ownerBranchForCreate };
