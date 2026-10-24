// src/helper/changeLog.js
// Old -> new values for every record changed during an UPDATE request.
//
// How: the audit logger runs each update request inside runWithChanges(); a
// global Mongoose plugin (install(), called before any model is compiled)
// watches updateOne / updateMany / findOneAndUpdate / replaceOne / doc.save()
// and, only while such a request is running, reads the record before and
// after the write and adds the changed fields to that request's list.
// The audit logger stores the list in AuditLog.details.changes.
//
// Writes outside an update request (sales, logins, scripts) are not tracked.
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const store = new AsyncLocalStorage();

const SKIP_MODELS = new Set(['AuditLog', 'StockEntry']);
const SKIP_FIELDS = new Set(['updatedAt', 'createdAt', '__v', 'scanCodes']);
const SECRET = /password|token|secret|otp/i;
const MAX_DOCS = 25; // records read per write (updateMany)
const MAX_FIELDS = 60; // changed fields kept per record
const MAX_VALUE = 300; // characters kept per value

// ctx = { changes: [] } owned by the caller (the audit logger reads it at the end).
const runWithChanges = (ctx, fn) => store.run(ctx, fn);
const currentChanges = () => {
  const ctx = store.getStore();
  return ctx ? ctx.changes : null;
};

// ---------- diff ----------

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) &&
  !(v instanceof mongoose.Types.ObjectId) && !Buffer.isBuffer(v) && v._bsontype === undefined;

const show = (v) => {
  if (v === undefined) return null;
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof mongoose.Types.ObjectId || (v && v._bsontype)) return String(v);
  if (typeof v === 'object') {
    let s;
    try {
      s = JSON.stringify(v);
    } catch (_) {
      s = String(v);
    }
    return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
  }
  if (typeof v === 'string' && v.length > MAX_VALUE) return `${v.slice(0, MAX_VALUE)}…`;
  return v;
};

// Flatten nested objects to dotted paths. Arrays are compared as a whole.
function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id' && prefix === '') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const same = (a, b) => {
  try {
    return JSON.stringify(show(a)) === JSON.stringify(show(b)) ||
      JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
};

function diff(before, after) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const fields = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP_FIELDS.has(key.split('.')[0])) continue;
    if (same(a[key], b[key])) continue;
    const secret = SECRET.test(key);
    fields.push({ field: key, from: secret ? '(hidden)' : show(a[key]), to: secret ? '(hidden)' : show(b[key]) });
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

const plain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true, depopulate: true }) : doc;

const labelOf = (doc) => {
  if (!doc) return '';
  const name =
    doc.name || doc.title || doc.transferNo || doc.orderNumber || doc.orderNo || doc.invoiceNumber ||
    [doc.firstName, doc.lastName].filter(Boolean).join(' ') || doc.email || doc.code || '';
  return String(name).slice(0, 120);
};

function push(modelName, before, after) {
  const changes = currentChanges();
  if (!changes) return;
  const fields = diff(plain(before), plain(after));
  if (!fields.length) return;
  changes.push({
    model: modelName,
    id: String((after && after._id) || (before && before._id) || ''),
    label: labelOf(after || before),
    fields,
  });
}

// Read documents without other plugins hiding them (soft-deleted, etc.).
const readMany = async (Model, filter, ids) => {
  let q = Model.find(ids ? { _id: { $in: ids } } : filter);
  if (typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true, skipChangeLog: true });
  return q.limit(MAX_DOCS).lean();
};

// ---------- plugin ----------

function changeLogPlugin(schema) {
  const QUERY_OPS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'];

  schema.pre(QUERY_OPS, async function preQuery() {
    if (!currentChanges() || !this.model || SKIP_MODELS.has(this.model.modelName)) return;
    try {
      this._changeLogBefore = await readMany(this.model, this.getFilter());
    } catch (_) {
      this._changeLogBefore = null;
    }
  });

  schema.post(QUERY_OPS, async function postQuery() {
    const before = this._changeLogBefore;
    if (!before || !before.length || !currentChanges()) return;
    try {
      const after = await readMany(this.model, null, before.map((d) => d._id));
      const byId = new Map(after.map((d) => [String(d._id), d]));
      for (const old of before) push(this.model.modelName, old, byId.get(String(old._id)));
    } catch (err) {
      console.error('Change log (query) failed:', err.message);
    }
  });

  schema.pre('save', async function preSave() {
    const Model = this.constructor;
    // Embedded sub-documents are covered by their parent record.
    if (this.$isSubdocument || typeof Model.findById !== 'function') return;
    if (this.isNew || !currentChanges() || SKIP_MODELS.has(Model.modelName)) return;
    try {
      let q = Model.findById(this._id);
      if (typeof q.setOptions === 'function') q = q.setOptions({ withDeleted: true });
      this.$locals.changeLogBefore = await q.lean();
    } catch (_) {
      this.$locals.changeLogBefore = null;
    }
  });

  schema.post('save', function postSave(doc) {
    const before = doc.$locals && doc.$locals.changeLogBefore;
    if (!before || !currentChanges()) return;
    doc.$locals.changeLogBefore = null;
    push(doc.constructor.modelName, before, doc);
  });
}

let installed = false;
// Must run before models are compiled (top of index.js).
function install() {
  if (installed) return;
  installed = true;
  mongoose.plugin(changeLogPlugin);
}

module.exports = { install, runWithChanges, currentChanges, diff };
