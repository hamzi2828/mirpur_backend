// src/services/stockHistoryService.js
// Writes the stock history (models/stockEntry.js).
//
//   recordChanges(before, after, { type, req, note, date })
//       Compares two copies of a product (before = null for a new product) and
//       writes one row per item per branch whose stock changed.
//   recordReceive(result, { req, body })     after stockService.receiveStock
//   recordTransfer(result, { req, product, note })  after stockService.transferStock
//
// History is best effort: a failure here is logged and never breaks the stock
// change itself.
const StockEntry = require('../models/stockEntry');
const {
  listUnits,
  variantLabel,
  unitBranchRows,
  unitBranchStock,
  getMainBranchId,
  toBranchId,
} = require('../helper/productCodes');
const { loadUserAccess } = require('../middleware/access');

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ flattenMaps: true }) : doc);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function who(req) {
  const userId = req && req.access && req.access.userId;
  if (!userId) return { createdBy: null, createdByName: '' };
  try {
    const info = await loadUserAccess(userId);
    const u = info && info.user;
    const name = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '' : '';
    return { createdBy: userId, createdByName: name };
  } catch (_) {
    return { createdBy: userId, createdByName: '' };
  }
}

// { unitKey: { variantId, label, rows: Map(branchId -> stock) } }
function snapshot(product, mainBranchId) {
  const out = new Map();
  if (!product) return out;
  for (const { key, variant, unit } of listUnits(product)) {
    const rows = new Map();
    for (const r of unitBranchRows(unit, mainBranchId)) rows.set(String(r.branch), Number(r.stock) || 0);
    out.set(String(key), {
      variantId: variant ? String(variant.variantId) : null,
      label: variant ? variantLabel(variant) : '',
      rows,
    });
  }
  return out;
}

async function save(rows) {
  if (!rows.length) return;
  try {
    await StockEntry.insertMany(rows, { ordered: false });
  } catch (err) {
    console.error('Stock history write failed:', err.message);
  }
}

async function recordChanges(before, after, { type, req, note = '', date } = {}) {
  try {
    const a = plain(after);
    if (!a || !a._id) return;
    const mainBranchId = await getMainBranchId();
    const was = snapshot(plain(before), mainBranchId);
    const now = snapshot(a, mainBranchId);
    const by = await who(req);
    const rows = [];
    for (const [key, unit] of now) {
      const old = was.get(key);
      const branches = new Set([...unit.rows.keys(), ...(old ? old.rows.keys() : [])]);
      for (const branch of branches) {
        const after = unit.rows.get(branch) || 0;
        const delta = after - ((old && old.rows.get(branch)) || 0);
        if (!delta) continue;
        rows.push({
          product: a._id,
          productName: a.name || '',
          variantId: unit.variantId,
          variantLabel: unit.label,
          branch,
          type,
          quantity: delta,
          stockAfter: after,
          piecesPerBox: num(a.piecesPerBox),
          costPrice: num(a.costPrice),
          note,
          ...by,
          ...(date ? { date } : {}),
        });
      }
    }
    await save(rows);
  } catch (err) {
    console.error('Stock history (changes) failed:', err.message);
  }
}

function unitOf(product, variantId) {
  if (!product) return { unit: null, variant: null };
  if (product.productType === 'variant') {
    const v = (product.variants || []).find((x) => String(x.variantId) === String(variantId));
    return { unit: v || null, variant: v || null };
  }
  return { unit: product, variant: null };
}

async function recordReceive(result, { req, body = {} } = {}) {
  try {
    const p = plain(result && result.product);
    if (!p || !result.branchId) return;
    const mainBranchId = await getMainBranchId();
    const { unit, variant } = unitOf(p, result.variantId);
    const batch = result.batch || null;
    const note = String(body.note || (batch && batch.note) || '').trim();
    await save([
      {
        product: p._id,
        productName: p.name || '',
        variantId: variant ? String(variant.variantId) : null,
        variantLabel: variant ? variantLabel(variant) : '',
        branch: result.branchId,
        type: 'received',
        quantity: Number(result.quantity) || 0,
        stockAfter: unit ? unitBranchStock(unit, result.branchId, mainBranchId) : null,
        boxes: num(body.boxes),
        loosePieces: num(body.loosePieces),
        piecesPerBox: num((unit && unit.piecesPerBox) || p.piecesPerBox),
        batchNo: batch ? batch.batchNo || null : null,
        costPrice: num((batch && batch.costPrice) ?? body.costPrice ?? (unit && unit.costPrice) ?? p.costPrice),
        expiryDate: batch && batch.expiryDate ? batch.expiryDate : null,
        note: note.slice(0, 300),
        ...(await who(req)),
      },
    ]);
  } catch (err) {
    console.error('Stock history (receive) failed:', err.message);
  }
}

async function recordTransfer(result, { req, note = '', transferNo = '' } = {}) {
  try {
    const p = plain(result && result.product);
    if (!p) return;
    const from = toBranchId(result.fromBranchId);
    const to = toBranchId(result.toBranchId);
    const qty = Number(result.quantity) || 0;
    if (!from || !to || !qty) return;
    const mainBranchId = await getMainBranchId();
    const { unit, variant } = unitOf(p, result.variantId);
    const by = await who(req);
    const text = [transferNo ? `Transfer ${transferNo}` : 'Transfer', note].filter(Boolean).join(' - ').slice(0, 300);
    const base = {
      product: p._id,
      productName: p.name || '',
      variantId: variant ? String(variant.variantId) : null,
      variantLabel: variant ? variantLabel(variant) : '',
      note: text,
      ...by,
    };
    await save([
      { ...base, branch: from, otherBranch: to, type: 'transfer_out', quantity: -qty,
        stockAfter: unit ? unitBranchStock(unit, from, mainBranchId) : null },
      { ...base, branch: to, otherBranch: from, type: 'transfer_in', quantity: qty,
        stockAfter: unit ? unitBranchStock(unit, to, mainBranchId) : null },
    ]);
  } catch (err) {
    console.error('Stock history (transfer) failed:', err.message);
  }
}

module.exports = { recordChanges, recordReceive, recordTransfer, snapshot };
