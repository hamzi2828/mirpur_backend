// Gives the existing "Branch Manager" role the default permissions from
// migrateBranches.js (DEFAULT_ROLES), so managers can run their whole branch.
//
//   npm run sync:branch-manager              -> DRY RUN, prints the change, writes nothing
//   npm run sync:branch-manager -- --apply   -> writes to the database
//
// Only the Branch Manager role is changed. Logins pick up the new permissions
// within ~30 seconds (access cache); a page refresh shows the new menu items.

const path = require('path');
const Role = require('../src/models/role');
const { DEFAULT_ROLES, buildRolePermissions } = require('./migrateBranches');

const ROLE_NAME = 'Branch Manager';
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (p) => (p instanceof Map ? Object.fromEntries(p) : { ...(p || {}) });

async function syncBranchManagerRole({ apply = false, log = console.log } = {}) {
  const def = DEFAULT_ROLES.find((r) => r.name === ROLE_NAME);
  const permissions = buildRolePermissions(def.permissions);
  const role = await Role.findOne({
    name: new RegExp(`^${escapeRegex(ROLE_NAME)}$`, 'i'),
    isDeleted: { $ne: true },
  });
  if (!role) {
    log(`No "${ROLE_NAME}" role found. Run "npm run migrate:branches -- --apply" to create it.`);
    return { status: 'missing' };
  }

  const before = plain(role.permissions);
  const added = [];
  const removed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(permissions)])) {
    const was = new Set(before[key] || []);
    const now = new Set(permissions[key] || []);
    [...now].filter((a) => !was.has(a)).forEach((a) => added.push(`${key}:${a}`));
    [...was].filter((a) => !now.has(a)).forEach((a) => removed.push(`${key}:${a}`));
  }

  log(`[${apply ? 'APPLY' : 'DRY RUN'}] "${role.name}" (${role._id})`);
  log(`  Added (${added.length}): ${added.join(', ') || '-'}`);
  log(`  Removed (${removed.length}): ${removed.join(', ') || '-'}`);
  if (!added.length && !removed.length) {
    log('  Already up to date.');
    return { status: 'unchanged' };
  }
  if (!apply) {
    log('Dry run only. Run again with --apply to save.');
    return { status: 'would update', added, removed };
  }
  role.permissions = permissions;
  role.description = def.description;
  await role.save();
  log('  Saved.');
  return { status: 'updated', added, removed };
}

module.exports = { syncBranchManagerRole };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  (async () => {
    let code = 0;
    try {
      await ensureConnection();
      await syncBranchManagerRole({ apply: process.argv.includes('--apply') });
    } catch (err) {
      console.error('Sync failed:', (err && err.message) || err);
      code = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
      process.exit(code);
    }
  })();
}
