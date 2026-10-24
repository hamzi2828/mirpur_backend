// One-time (safe to re-run) migration for the BRANCHES feature.
//
//   npm run migrate:branches                 -> DRY RUN, prints what would change, writes nothing
//   npm run migrate:branches -- --apply      -> writes to the database
//
// What it does (see docs/BRANCHES_AND_PERMISSIONS.md):
// 1. Makes sure there is a main branch (creates "Main Branch" / "B1" if none).
// 2. Products: every unit (single product / each variant) without `branchStock`
//    gets `branchStock = [{ branch: main, stock: unit.stock }]` (or, when it has
//    batches, the batch totals per branch); every batch without `branch` gets the
//    main branch. Totals (`stock`) are never changed, updatedAt is not bumped.
// 3. POS orders, held orders, purchases and expenses without a branch -> main branch.
// 4. Existing admins (role 'admin', no staffRole, no branch) -> isSuperAdmin: true.
//    Customers (role 'user') are not touched.
// 5. Optional: creates a super admin from env SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD
//    when no user has that email (the password is never printed).
// 6. Makes sure the system "Admin" role exists and creates the default roles
//    "Branch Manager" and "Cashier" when missing (existing roles are left as they are).
//
// Writes go through the raw collections (Model.collection), so they work even if a
// schema does not declare the new `branch` fields yet, and they include soft-deleted
// rows (so a restored record is migrated too).

const path = require('path');
const bcrypt = require('bcryptjs');
const Branch = require('../src/models/branch');
const Product = require('../src/models/product');
const POSOrder = require('../src/models/posOrder');
const HeldOrder = require('../src/models/heldOrder');
const Purchase = require('../src/models/purchase');
const Expense = require('../src/models/expense');
const User = require('../src/models/user');
const Role = require('../src/models/role');
const rolePermissions = require('../src/constants/rolePermissions');

// ---------- default roles ----------

// 'all' = every action the catalogue allows for that key. Keys that do not exist
// in the catalogue at runtime (e.g. new keys not deployed yet) are skipped.
const DEFAULT_ROLES = [
  {
    name: 'Branch Manager',
    description: 'Runs the whole shop of one branch: POS, orders, products, stock, customers, staff, banks, load, expenses and branch reports.',
    // Everything except owner-only screens (branches, roles, settings, activity log).
    // Sales, stock, expenses, staff and reports stay limited to the manager's own branch.
    permissions: {
      dashboard: 'all',
      pos: 'all',
      pos_orders: 'all',
      networks: 'all',
      report_sales: 'all',
      report_cost_analysis: 'all',
      report_stock: 'all',
      report_expenses: 'all',
      report_receivables: 'all',
      report_cash_in_hand: 'all',
      products: 'all',
      product_categories: 'all',
      product_attributes: 'all',
      product_stock: 'all',
      stock_receive: 'all',
      stock_transfers: 'all',
      customers: 'all',
      banks: 'all',
      expenses: 'all',
      staff: 'all',
    },
  },
  {
    name: 'Cashier',
    description: 'Sells at the POS counter of one branch.',
    permissions: {
      dashboard: ['view'],
      pos: ['view', 'create'],
      pos_orders: ['view'],
      customers: ['view', 'create'],
      products: ['view'],
    },
  },
];

// Turn a { key: 'all' | [actions] } spec into a permission map limited to the
// keys/actions present in the catalogue right now.
function buildRolePermissions(spec, catalogue = rolePermissions) {
  const groups = new Map((catalogue.PERMISSION_GROUPS || []).map((g) => [g.key, g]));
  const out = {};
  for (const [key, want] of Object.entries(spec)) {
    const group = groups.get(key);
    if (!group) continue;
    const actions = want === 'all' ? [...group.actions] : want.filter((a) => group.actions.includes(a));
    if (actions.length) out[key] = actions;
  }
  return catalogue.sanitizePermissions ? catalogue.sanitizePermissions(out) : out;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ensure the system Admin role + default roles exist. Returns
// { admin: 'exists'|'created'|'would create'|'skipped', roles: [{ name, status, id? }] }.
async function ensureDefaultRoles({ apply = false, log = console.log } = {}) {
  const result = { admin: 'skipped', roles: [] };

  // System Admin role (roleController.ensureAdminRole keeps it in shape).
  const existingAdmin = await Role.findOne({ isSystem: true, isDeleted: { $ne: true } });
  if (apply) {
    let ensureAdminRole = null;
    try {
      ({ ensureAdminRole } = require('../src/controller/roleController'));
    } catch (_) {
      ensureAdminRole = null;
    }
    if (typeof ensureAdminRole === 'function') {
      await ensureAdminRole();
      result.admin = existingAdmin ? 'exists' : 'created';
    } else {
      result.admin = existingAdmin ? 'exists' : 'skipped (ensureAdminRole not available)';
    }
  } else {
    result.admin = existingAdmin ? 'exists' : 'would create';
  }

  for (const def of DEFAULT_ROLES) {
    const found = await Role.findOne({
      name: new RegExp(`^${escapeRegex(def.name)}$`, 'i'),
      isDeleted: { $ne: true },
    });
    if (found) {
      result.roles.push({ name: def.name, status: 'exists', id: String(found._id) });
      continue;
    }
    const permissions = buildRolePermissions(def.permissions);
    if (!apply) {
      result.roles.push({ name: def.name, status: 'would create', permissions });
      continue;
    }
    const created = await Role.create({
      name: def.name,
      description: def.description,
      permissions,
      isSystem: false,
      userCount: 0,
    });
    result.roles.push({ name: def.name, status: 'created', id: String(created._id), permissions });
  }
  log(`Roles: Admin ${result.admin}; ${result.roles.map((r) => `${r.name} ${r.status}`).join('; ')}`);
  return result;
}

// ---------- per-branch stock helpers (same rules as the contract invariants) ----------

const idStr = (v) => (v === undefined || v === null ? null : String(v));
const isVariantProduct = (p) => p.productType === 'variant';
const hasBranchStock = (unit) => Array.isArray(unit.branchStock) && unit.branchStock.length > 0;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

// Pieces per branch from batches (batches without branch count for the main branch).
const batchTotalsByBranch = (batches, mainId) => {
  const totals = new Map();
  for (const b of batches) {
    const key = idStr(b.branch) || idStr(mainId);
    totals.set(key, (totals.get(key) || 0) + num(b.quantity));
  }
  return totals;
};

// Plan the $set for one unit. `prefix` is '' (single product) or 'variants.N.'.
// Returns { set: {...}, warnings: [...] }.
function planUnit(unit, prefix, mainId) {
  const set = {};
  const warnings = [];
  const batches = Array.isArray(unit.batches) ? unit.batches : [];

  batches.forEach((b, i) => {
    if (!b || !idStr(b.branch)) set[`${prefix}batches.${i}.branch`] = mainId;
  });

  if (batches.length) {
    const totals = batchTotalsByBranch(batches, mainId);
    const batchSum = [...totals.values()].reduce((a, n) => a + n, 0);
    if (batchSum !== num(unit.stock)) {
      warnings.push(`stock ${num(unit.stock)} != sum of batches ${batchSum}`);
    }
    if (!hasBranchStock(unit)) {
      // Keep main first; branch ids as stored (ObjectId) - main uses mainId.
      const entries = [];
      const byKey = new Map();
      batches.forEach((b) => {
        const key = idStr(b.branch) || idStr(mainId);
        if (!byKey.has(key)) byKey.set(key, b && idStr(b.branch) ? b.branch : mainId);
      });
      for (const [key, branch] of byKey) entries.push({ branch, stock: totals.get(key) || 0 });
      set[`${prefix}branchStock`] = entries;
    } else {
      // Already has branchStock: only report if it disagrees with the batches.
      for (const [key, qty] of totals) {
        const row = unit.branchStock.find((r) => idStr(r.branch) === key);
        if (!row || num(row.stock) !== qty) {
          warnings.push(`branchStock for branch ${key} is ${row ? num(row.stock) : 'missing'}, batches say ${qty}`);
        }
      }
    }
  } else if (!hasBranchStock(unit)) {
    set[`${prefix}branchStock`] = [{ branch: mainId, stock: num(unit.stock) }];
  } else {
    const sum = unit.branchStock.reduce((a, r) => a + num(r && r.stock), 0);
    if (sum !== num(unit.stock)) warnings.push(`stock ${num(unit.stock)} != sum of branchStock ${sum}`);
  }
  return { set, warnings };
}

// Plan the whole product. Returns { set, filter, warnings }.
function planProduct(p, mainId) {
  const set = {};
  const warnings = [];
  const filter = { _id: p._id };
  if (p.updatedAt !== undefined) filter.updatedAt = p.updatedAt; // optimistic guard

  if (isVariantProduct(p)) {
    (p.variants || []).forEach((v, i) => {
      if (!v) return;
      const r = planUnit(v, `variants.${i}.`, mainId);
      Object.assign(set, r.set);
      r.warnings.forEach((w) => warnings.push(`variant ${v.variantId || `#${i + 1}`}: ${w}`));
      if (v.variantId) filter[`variants.${i}.variantId`] = v.variantId;
    });
    const sum = (p.variants || []).reduce((a, v) => a + num(v && v.stock), 0);
    if (sum !== num(p.stock)) warnings.push(`product stock ${num(p.stock)} != sum of variants ${sum}`);
  } else {
    const r = planUnit(p, '', mainId);
    Object.assign(set, r.set);
    warnings.push(...r.warnings);
  }
  return { set, filter, warnings };
}

// ---------- main logic (no connect/disconnect here, so it can be tested) ----------

const RECORD_MODELS = [
  ['POS orders', POSOrder],
  ['Held orders', HeldOrder],
  ['Purchases', Purchase],
  ['Expenses', Expense],
];

async function findMainBranch({ apply, log }) {
  if (apply) {
    const main = await Branch.getMain();
    log(`Main branch: ${main.name} (${main.code}) ${main._id}`);
    return { main, created: false };
  }
  let main = await Branch.findOne({ isMain: true });
  if (!main) main = await Branch.findOne({}).sort({ createdAt: 1 });
  if (main) {
    log(`Main branch: ${main.name} (${main.code}) ${main._id}${main.isMain ? '' : ' (would be marked as main)'}`);
    return { main, created: false };
  }
  log('Main branch: none yet -> would create "Main Branch" (B1)');
  // Placeholder id so the dry run can still count what would change.
  const mongoose = require('mongoose');
  return { main: { _id: new mongoose.Types.ObjectId(), name: 'Main Branch', code: 'B1' }, created: true };
}

async function migrateProducts({ apply, log, mainId, summary }) {
  const projection = {
    name: 1, productType: 1, stock: 1, branchStock: 1, batches: 1, updatedAt: 1,
    'variants.variantId': 1, 'variants.stock': 1, 'variants.branchStock': 1, 'variants.batches': 1,
  };
  const products = await Product.collection.find({}, { projection }).toArray();
  summary.products.total = products.length;

  for (const p of products) {
    const name = p.name || String(p._id);
    const { set, filter, warnings } = planProduct(p, mainId);
    warnings.forEach((w) => summary.products.warnings.push(`"${name}" (${p._id}): ${w}`));
    if (!Object.keys(set).length) {
      summary.products.unchanged++;
      continue;
    }
    if (apply) {
      const res = await Product.collection.updateOne(filter, { $set: set });
      if (!res || !(res.matchedCount ?? res.n ?? 0)) {
        summary.products.skipped++;
        summary.products.warnings.push(`"${name}" (${p._id}): changed while migrating, run again`);
        log(`  SKIP  ${name}: changed while migrating, run again`);
        continue;
      }
    }
    summary.products.updated++;
    log(`  ${apply ? 'UPDATED' : 'WOULD UPDATE'}  ${name} (${p._id}): ${Object.keys(set).length} field(s)`);
  }
}

async function migrateRecords({ apply, mainId, summary }) {
  for (const [label, Model] of RECORD_MODELS) {
    const filter = { branch: null }; // matches missing or null
    let count;
    if (apply) {
      const res = await Model.collection.updateMany(filter, { $set: { branch: mainId } });
      count = res ? res.modifiedCount ?? res.nModified ?? 0 : 0;
    } else {
      count = await Model.collection.countDocuments(filter);
    }
    summary.records[label] = count;
  }
}

async function migrateUsers({ apply, summary }) {
  const admins = await User.collection
    .find({ role: 'admin' }, { projection: { email: 1, staffRole: 1, branch: 1, isSuperAdmin: 1, isDeleted: 1 } })
    .toArray();
  for (const u of admins) {
    if (u.isDeleted === true) continue;
    if (u.isSuperAdmin === true || idStr(u.staffRole) || idStr(u.branch)) continue;
    if (apply) {
      await User.collection.updateOne({ _id: u._id, isSuperAdmin: { $ne: true } }, { $set: { isSuperAdmin: true } });
    }
    summary.superAdmins.push(u.email);
  }

  // Staff that will have no permissions after this (no staffRole, not super admin).
  const others = await User.collection
    .find({ role: { $in: ['admin', 'moderator'] } }, { projection: { email: 1, role: 1, staffRole: 1, branch: 1, isSuperAdmin: 1, isDeleted: 1 } })
    .toArray();
  for (const u of others) {
    if (u.isDeleted === true || u.isSuperAdmin === true || idStr(u.staffRole)) continue;
    if (summary.superAdmins.includes(u.email)) continue;
    summary.staffWithoutRole.push(`${u.email} (${u.role}${idStr(u.branch) ? ', has branch' : ', no branch'})`);
  }
}

async function ensureSuperAdminFromEnv({ apply, summary, env = process.env }) {
  const email = String(env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD || '';
  if (!email || !password) {
    summary.envSuperAdmin = 'not requested (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set)';
    return;
  }
  const existing = await User.findOne({ email }).setOptions({ withDeleted: true });
  if (existing) {
    summary.envSuperAdmin = `${email} already exists - not changed`;
    return;
  }
  if (!apply) {
    summary.envSuperAdmin = `would create super admin ${email}`;
    return;
  }
  const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
  await User.create({
    firstName: 'Super',
    lastName: 'Admin',
    email,
    password: hash,
    provider: 'local',
    role: 'admin',
    isSuperAdmin: true,
    staffRole: null,
    branch: null,
    isActive: true,
  });
  summary.envSuperAdmin = `created super admin ${email}`;
}

async function migrate({ apply = false, log = console.log, env = process.env } = {}) {
  const summary = {
    mode: apply ? 'APPLY' : 'DRY RUN',
    mainBranch: null,
    products: { total: 0, updated: 0, unchanged: 0, skipped: 0, warnings: [] },
    records: {},
    superAdmins: [],
    staffWithoutRole: [],
    envSuperAdmin: null,
    roles: null,
  };
  log(`[${summary.mode}] Branches migration`);

  const { main, created } = await findMainBranch({ apply, log });
  summary.mainBranch = { id: String(main._id), name: main.name, code: main.code, wouldCreate: created };
  const mainId = main._id;

  await migrateProducts({ apply, log, mainId, summary });
  await migrateRecords({ apply, mainId, summary });
  await migrateUsers({ apply, summary });
  await ensureSuperAdminFromEnv({ apply, summary, env });
  summary.roles = await ensureDefaultRoles({ apply, log: () => {} });

  // ----- summary -----
  const w = apply ? '' : 'would be ';
  log('');
  log(`[${summary.mode}] Summary`);
  log(`  Main branch: ${summary.mainBranch.name} (${summary.mainBranch.code})${created ? ' - would be created' : ''}`);
  log(`  Products: ${summary.products.total} checked | ${w}updated: ${summary.products.updated} | unchanged: ${summary.products.unchanged} | skipped: ${summary.products.skipped}`);
  for (const [label, n] of Object.entries(summary.records)) log(`  ${label} without branch ${w}set to main: ${n}`);
  log(`  Admins ${w}made super admin: ${summary.superAdmins.length}`);
  summary.superAdmins.forEach((e) => log(`    - ${e}`));
  if (summary.staffWithoutRole.length) {
    log(`  Staff with NO permission role (give them a role + branch in Staff screen):`);
    summary.staffWithoutRole.forEach((e) => log(`    - ${e}`));
  }
  log(`  Super admin from env: ${summary.envSuperAdmin}`);
  log(`  Roles: Admin ${summary.roles.admin}; ${summary.roles.roles.map((r) => `${r.name} ${r.status}`).join('; ')}`);
  if (summary.products.warnings.length) {
    log(`  Stock warnings (${summary.products.warnings.length}) - totals were NOT changed, please check these:`);
    summary.products.warnings.forEach((m) => log(`    - ${m}`));
  }
  if (!apply) log('Dry run only. Run again with --apply to write these changes.');
  return summary;
}

const parseArgs = (argv) => ({ apply: argv.includes('--apply') });

module.exports = {
  migrate,
  parseArgs,
  ensureDefaultRoles,
  buildRolePermissions,
  planProduct,
  DEFAULT_ROLES,
};

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  (async () => {
    let code = 0;
    try {
      const args = parseArgs(process.argv.slice(2));
      await ensureConnection();
      await migrate(args);
    } catch (err) {
      console.error('Migration failed:', (err && err.message) || err);
      code = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
      process.exit(code);
    }
  })();
}
