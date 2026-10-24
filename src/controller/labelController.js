// src/controller/labelController.js
//
// Barcode sticker printing. The backend renders a self-contained HTML page
// (inline CSS + inline SVG barcodes, no external requests) that the frontend
// fetches with its Bearer token and opens through a blob URL. The browser
// print dialog then sends it to a thermal label printer (one label per page)
// or to an A4 sheet printer.
//
// Handlers:
//   getLabelData  GET  /products/:id/label-data   JSON for a label picker UI
//   printLabels   GET  /products/:id/labels       text/html, one product
//   printBulk     POST /products/labels/print     text/html, many products
//
// Label types (`type`):
//   unit      barcode = shortCode (fallback sku); copies = stock
//   box       barcode = shortCode (one scan = 1 piece) + "Box of N"; copies = ceil(stock / piecesPerBox)
//   full-box  barcode = "<shortCode>-BOX" (one scan = N pieces) + "Full box · N pcs"; copies = ceil(stock / piecesPerBox)
//   batch     barcode = batch.barcode, shows batch no + expiry; copies = batch quantity (in boxes for box products)
//   barcode   barcode = `code` param (must be one of the unit's own codes); copies = ceil(stock / code qty)
//
// Branches: default copies use the stock of the request's branch
// (req.access.branchId: staff -> own branch, super admin -> picked branch;
// super admin with none / no access info -> total of all branches). `batch`
// labels list that branch's batches (all branches: one entry per batchNo).
//
// Sizes: 38x25 (default), 40x30, 50x25, 50x30, 60x40 (thermal, one label per page),
//        a4 (A4 sheet, 3 columns x 8 rows = 24 labels of 70 x 37 mm, no page margins).

const mongoose = require('mongoose');
const Product = require('../models/product');
const { productScopeFilter, canSeeProduct } = require('../helper/productScope');
const Settings = require('../models/settings');
const code128 = require('../helper/code128');
const {
  listUnits,
  variantLabel,
  normalizeCode,
  PRODUCT_UNIT,
  unitBranchStock,
  batchBranchId,
  sameBranch,
  getMainBranchId,
} = require('../helper/productCodes');

const MAX_LABELS = 1000;
const MAX_BULK_ITEMS = 500;

const SIZES = {
  '38x25': { key: '38x25', label: '38 x 25 mm (thermal)', widthMm: 38, heightMm: 25, kind: 'thermal' },
  '40x30': { key: '40x30', label: '40 x 30 mm (thermal)', widthMm: 40, heightMm: 30, kind: 'thermal' },
  '50x25': { key: '50x25', label: '50 x 25 mm (thermal)', widthMm: 50, heightMm: 25, kind: 'thermal' },
  '50x30': { key: '50x30', label: '50 x 30 mm (thermal)', widthMm: 50, heightMm: 30, kind: 'thermal' },
  '60x40': { key: '60x40', label: '60 x 40 mm (thermal)', widthMm: 60, heightMm: 40, kind: 'thermal' },
  a4: {
    key: 'a4',
    label: 'A4 sheet, 24 labels (3 x 8, 70 x 37 mm)',
    widthMm: 70,
    heightMm: 37,
    kind: 'sheet',
    cols: 3,
    rows: 8,
    pageWidthMm: 210,
    pageHeightMm: 297,
  },
};
const DEFAULT_SIZE = '38x25';
const TYPES = ['unit', 'box', 'full-box', 'batch', 'barcode'];
const CURRENCY_SYMBOLS = { PKR: 'Rs', USD: '$', GBP: '£', EUR: '€' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- small helpers ----------

const badRequest = (message, extra = {}) => {
  const err = new Error(message);
  err.status = 400;
  Object.assign(err, extra);
  return err;
};

const notFound = (message, extra = {}) => {
  const err = new Error(message);
  err.status = 404;
  Object.assign(err, extra);
  return err;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const truncate = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

// "1", "true", "yes", "on" -> true; "0", "false", "no", "off" -> false; else fallback.
const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
};

const parseCopies = (value, where = 'copies') => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LABELS) {
    throw badRequest(`${where} must be a whole number from 1 to ${MAX_LABELS}`);
  }
  return n;
};

const parseSize = (value) => {
  const key = value === undefined || value === null || value === '' ? DEFAULT_SIZE : String(value).trim().toLowerCase();
  if (!SIZES[key]) throw badRequest(`Unknown label size "${value}". Use one of: ${Object.keys(SIZES).join(', ')}`);
  return SIZES[key];
};

const parseType = (value, where = 'type') => {
  const t = value === undefined || value === null || value === '' ? 'unit' : String(value).trim().toLowerCase();
  if (!TYPES.includes(t)) throw badRequest(`Unknown ${where} "${value}". Use one of: ${TYPES.join(', ')}`);
  return t;
};

const asString = (value) => (value === undefined || value === null || value === '' ? undefined : String(value).trim());

const formatMoney = (amount, symbol) => {
  const n = Number(amount) || 0;
  const text = n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol} ${text}` : text;
};

// Unambiguous: "31 Mar 2027"
const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d)) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const sellPrice = (unit) => {
  const discounted = Number(unit.discountedPrice);
  if (Number.isFinite(discounted) && discounted > 0) return discounted;
  return Number(unit.price) || 0;
};

const ceilDiv = (a, b) => Math.ceil((Number(a) || 0) / Math.max(1, Number(b) || 1));
const atLeastOne = (n) => Math.max(1, Math.floor(Number(n) || 0));

const getShopSettings = async (overrides = {}) => {
  let shopName = '';
  try {
    const s = await Settings.findOne({ isActive: true }).lean();
    if (s && s.siteName) shopName = String(s.siteName).trim();
  } catch (e) {
    // labels still print without a shop name
  }
  // The POS screens always price in PKR, so labels default to "Rs" regardless
  // of the website currency in Settings. `currency` can override (code or symbol).
  let currency = 'Rs';
  const cur = asString(overrides.currency);
  if (cur) currency = CURRENCY_SYMBOLS[cur.toUpperCase()] || truncate(cur, 4);
  return { shopName, currency };
};

const isFullBoxCode = (unit, code) => code === `${normalizeCode(unit.shortCode)}-BOX`;

// The unit's barcode entry for "<shortCode>-BOX", if it exists.
const fullBoxEntry = (unit) => {
  if (!unit.shortCode) return null;
  return (unit.barcodes || []).find((b) => b && isFullBoxCode(unit, normalizeCode(b.code))) || null;
};

const unitMainCode = (unit) => normalizeCode(unit.shortCode) || normalizeCode(unit.sku);

// Branch whose stock sets the default copies. null = all branches.
const labelBranch = async (req) => {
  const branchId = req && req.access && req.access.branchId ? String(req.access.branchId) : null;
  return { branchId, mainBranchId: branchId ? await getMainBranchId() : null };
};

// Batches of a unit for labels (plain objects). With a branch: that branch's
// batches. Without: one entry per batchNo (a lot split over branches by a
// transfer has the same code everywhere), quantity summed.
const unitBatchesFor = (unit, branchId, mainBranchId) => {
  const out = [];
  const byNo = new Map();
  for (const b of unit.batches || []) {
    if (!b) continue;
    if (branchId && !sameBranch(batchBranchId(b, mainBranchId), branchId)) continue;
    const batchNo = normalizeCode(b.batchNo);
    const quantity = Number(b.quantity) || 0;
    const prev = byNo.get(batchNo);
    if (prev) {
      prev.quantity += quantity;
      continue;
    }
    const row = { batchNo: b.batchNo, barcode: b.barcode || null, quantity, expiryDate: b.expiryDate || null };
    byNo.set(batchNo, row);
    out.push(row);
  }
  return out;
};

// Units of a product, optionally only one variant.
const pickUnits = (product, variantId) => {
  const units = listUnits(product);
  if (!variantId) return { units, specific: product.productType !== 'variant' };
  if (product.productType !== 'variant') throw badRequest('variantId was given but this product has no variants');
  const hit = units.find(({ key, variant }) => String(key) === variantId || String(variant && variant._id) === variantId);
  if (!hit) throw notFound(`Variant "${variantId}" not found on this product`);
  return { units: [hit], specific: true };
};

// ---------- building label entries ----------

/**
 * Label entries for one product.
 * opts: { variantId, type, batchNo, code, copies, branchId?, mainBranchId? }
 *   branchId: default copies from that branch's stock / batches (null = all branches)
 * Returns { entries: [{ ...labelContent, copies }], skipped: [string] }.
 * Throws 400 when a specific unit was asked for and it cannot produce the label.
 */
const buildEntries = (product, opts) => {
  const type = opts.type || 'unit';
  const ppb = Math.max(1, Math.floor(Number(product.piecesPerBox) || 1));
  const { units, specific } = pickUnits(product, opts.variantId);
  const entries = [];
  const skipped = [];

  for (const { key, variant, unit } of units) {
    const vLabel = variant ? variantLabel(variant) || variant.sku || 'Variant' : '';
    const who = variant ? `${product.name} (${vLabel})` : product.name;
    const base = {
      productId: String(product._id),
      variantId: key === PRODUCT_UNIT ? null : key,
      name: product.name,
      variant: vLabel,
      price: sellPrice(unit),
      extra: [],
    };
    const stock = unitBranchStock(unit, opts.branchId || null, opts.mainBranchId);
    const mainCode = unitMainCode(unit);
    const fail = (reason) => {
      if (specific) throw badRequest(`${who}: ${reason}`);
      skipped.push(`${who}: ${reason}`);
    };

    if (type === 'unit' || type === 'box') {
      if (!mainCode) {
        fail('no short code or SKU to print. Save the product again to generate a short code');
        continue;
      }
      if (type === 'box') {
        if (ppb <= 1) {
          fail('box labels need "pieces per box" greater than 1');
          continue;
        }
        entries.push({ ...base, kind: 'box', code: mainCode, extra: [`Box of ${ppb}`], defaultCopies: atLeastOne(ceilDiv(stock, ppb)) });
      } else {
        entries.push({ ...base, kind: 'unit', code: mainCode, defaultCopies: atLeastOne(stock) });
      }
      continue;
    }

    if (type === 'full-box') {
      const fb = ppb > 1 ? fullBoxEntry(unit) : null;
      if (!fb) {
        fail(
          ppb > 1
            ? `no full-box barcode (${unit.shortCode ? `${normalizeCode(unit.shortCode)}-BOX` : 'short code missing'}). Enable the full-box barcode on the product first`
            : 'full-box labels need "pieces per box" greater than 1'
        );
        continue;
      }
      entries.push({
        ...base,
        kind: 'full-box',
        code: normalizeCode(fb.code),
        extra: [`Full box · ${ppb} pcs`],
        // price of the whole box, since one scan sells ppb pieces
        price: base.price * ppb,
        defaultCopies: atLeastOne(ceilDiv(stock, ppb)),
      });
      continue;
    }

    if (type === 'batch') {
      const all = unitBatchesFor(unit, opts.branchId, opts.mainBranchId).filter((b) => b.barcode);
      let list;
      if (opts.batchNo) {
        const want = normalizeCode(opts.batchNo);
        const hit = (b) => normalizeCode(b.batchNo) === want || normalizeCode(b.barcode) === want;
        list = all.filter(hit);
        // Lot not in this branch: still printable (copies default to 1).
        if (!list.length && opts.branchId) {
          list = unitBatchesFor(unit, null)
            .filter((b) => b.barcode && hit(b))
            .map((b) => ({ ...b, quantity: 0 }));
        }
        if (!list.length) {
          fail(`batch "${opts.batchNo}" not found`);
          continue;
        }
      } else {
        list = all.filter((b) => (Number(b.quantity) || 0) > 0);
        if (!list.length) {
          fail(all.length ? 'no batch has stock left' : 'no batches');
          continue;
        }
      }
      for (const b of list) {
        const qty = Number(b.quantity) || 0;
        const extra = [`Batch ${normalizeCode(b.batchNo)}`];
        const exp = formatDate(b.expiryDate);
        if (exp) extra.push(`Exp ${exp}`);
        entries.push({
          ...base,
          kind: 'batch',
          code: normalizeCode(b.barcode),
          batchNo: normalizeCode(b.batchNo),
          extra,
          defaultCopies: atLeastOne(ppb > 1 ? ceilDiv(qty, ppb) : qty),
        });
      }
      continue;
    }

    if (type === 'barcode') {
      const want = normalizeCode(opts.code);
      if (!want) throw badRequest('type=barcode needs a `code`');
      let qty = null;
      let extra = [];
      if (want === normalizeCode(unit.shortCode) || want === normalizeCode(unit.sku)) qty = 1;
      const bc = (unit.barcodes || []).find((b) => b && normalizeCode(b.code) === want);
      if (bc) {
        qty = Math.max(1, Number(bc.qty) || 1);
        if (isFullBoxCode(unit, want)) extra = [`Full box · ${qty} pcs`];
        else if (qty > 1) extra = [`Pack of ${qty}`];
      }
      const batch = (unit.batches || []).find((b) => b && normalizeCode(b.barcode) === want);
      if (!qty && batch) {
        qty = 1;
        extra = [`Batch ${normalizeCode(batch.batchNo)}`];
        const exp = formatDate(batch.expiryDate);
        if (exp) extra.push(`Exp ${exp}`);
      }
      if (!qty) {
        fail(`code "${want}" does not belong to this item`);
        continue;
      }
      entries.push({
        ...base,
        kind: 'barcode',
        code: want,
        extra,
        price: base.price * qty,
        defaultCopies: atLeastOne(ceilDiv(stock, qty)),
      });
      continue;
    }
  }

  // Codes must be printable in Code 128 (ASCII 32..126).
  for (const e of entries) {
    try {
      code128.validate(e.code);
    } catch (err) {
      throw badRequest(`${e.name}: ${err.message}`);
    }
  }

  return { entries, skipped };
};

// Expand entries to individual labels, honouring `copies` and the 1000 cap.
const applyCopies = (entries, copiesOverride, state) => {
  const labels = [];
  for (const e of entries) {
    const want = copiesOverride !== undefined ? copiesOverride : e.defaultCopies;
    const room = MAX_LABELS - state.count;
    const n = Math.min(want, room);
    if (n < want) state.capped = true;
    if (n > 0) {
      labels.push({ ...e, copies: n });
      state.count += n;
    }
    if (state.count >= MAX_LABELS) {
      if (entries.indexOf(e) < entries.length - 1) state.capped = true;
      break;
    }
  }
  return labels;
};

// ---------- HTML rendering ----------

const svgCache = new Map();
const barcodeSvg = (code) => {
  let svg = svgCache.get(code);
  if (!svg) {
    svg = code128.toSVG(code, { height: 40, quietZone: 10 });
    if (svgCache.size > 2000) svgCache.clear();
    svgCache.set(code, svg);
  }
  return svg;
};

const codeFontPct = (code) => (code.length <= 6 ? 100 : code.length <= 9 ? 82 : code.length <= 13 ? 66 : 52);

const renderLabel = (item, ctx) => {
  const showRow = item.variant || ctx.showPrice;
  const parts = ['<div class="label">'];
  if (ctx.showShop && ctx.shopName) parts.push(`<div class="shop">${escapeHtml(truncate(ctx.shopName, 40))}</div>`);
  parts.push(`<div class="name">${escapeHtml(truncate(item.name, 90))}</div>`);
  if (showRow) {
    parts.push('<div class="row">');
    parts.push(`<span class="variant">${escapeHtml(truncate(item.variant, 40))}</span>`);
    if (ctx.showPrice) parts.push(`<span class="price">${escapeHtml(formatMoney(item.price, ctx.currency))}</span>`);
    parts.push('</div>');
  }
  if (item.extra && item.extra.length) {
    parts.push(`<div class="extra">${item.extra.map((x) => `<span>${escapeHtml(x)}</span>`).join('')}</div>`);
  }
  parts.push(`<div class="bc">${barcodeSvg(item.code)}</div>`);
  parts.push(`<div class="code" style="font-size:${codeFontPct(item.code)}%">${escapeHtml(item.code)}</div>`);
  parts.push('</div>');
  return parts.join('');
};

const buildCss = (size) => {
  const w = size.widthMm;
  const h = size.heightMm;
  // Text scale: 1 for 25 mm tall labels, bigger for taller labels.
  const s = Math.min(1.6, Math.max(1, h / 25)).toFixed(3);
  const common = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#000}
body{font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.label{--s:${s};width:${w}mm;height:${h}mm;overflow:hidden;padding:calc(0.9mm * var(--s)) 1.5mm;display:flex;flex-direction:column;background:#fff;line-height:1.12}
.shop{font-size:calc(1.85mm * var(--s));font-weight:600;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;flex:none}
.name{font-size:calc(2.45mm * var(--s));font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;flex:none;max-height:2.25em}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;flex:none}
.variant{font-size:calc(2.15mm * var(--s));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.price{font-size:calc(2.75mm * var(--s));font-weight:800;white-space:nowrap;flex:none}
.extra{display:flex;justify-content:space-between;gap:1mm;font-size:calc(1.95mm * var(--s));font-weight:600;white-space:nowrap;overflow:hidden;flex:none}
.extra span{overflow:hidden;text-overflow:ellipsis}
.bc{position:relative;flex:1 1 auto;min-height:4.5mm;margin-top:calc(0.5mm * var(--s))}
.bc svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono","Courier New",monospace;font-size:calc(3.6mm * var(--s));font-weight:800;letter-spacing:.08em;text-align:center;line-height:1.05;white-space:nowrap;overflow:hidden;flex:none}
.toolbar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#111827;color:#fff;font-size:14px}
.toolbar button{font:inherit;font-weight:600;padding:6px 16px;border:0;border-radius:6px;background:#dc2626;color:#fff;cursor:pointer}
.toolbar .tip{opacity:.75;font-size:12px}
.toolbar .warn{flex-basis:100%;color:#fde68a;font-size:12px}
.toolbar .warn li{margin-left:18px}
@media print{.toolbar{display:none!important}}
`;
  if (size.kind === 'sheet') {
    return `${common}
@page{size:A4;margin:0}
.sheet{width:${size.pageWidthMm}mm;height:${size.pageHeightMm}mm;padding-top:0.5mm;display:grid;grid-template-columns:repeat(${size.cols},${w}mm);grid-auto-rows:${h}mm;align-content:start;overflow:hidden;break-after:page;page-break-after:always;background:#fff}
.sheet:last-child{break-after:auto;page-break-after:auto}
.sheet .label{padding:2.5mm 4mm}
@media screen{html,body{background:#e5e7eb;min-height:100%}.sheet{margin:16px auto;box-shadow:0 1px 6px rgba(0,0,0,.25)}.sheet .label{outline:1px dashed #cbd5e1;outline-offset:-1px}}
`;
  }
  return `${common}
@page{size:${w}mm ${h}mm;margin:0}
@media print{html,body{width:${w}mm}.label{break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}}
@media screen{html,body{background:#e5e7eb;min-height:100%}.labels{display:flex;flex-wrap:wrap;gap:8px;padding:16px}.label{box-shadow:0 1px 4px rgba(0,0,0,.3)}}
`;
};

const renderPage = ({ labels, size, ctx, title, skipped = [], capped = false }) => {
  const flat = [];
  for (const item of labels) {
    const html = renderLabel(item, ctx);
    for (let i = 0; i < item.copies; i++) flat.push(html);
  }
  const total = flat.length;

  let body;
  if (size.kind === 'sheet') {
    const per = size.cols * size.rows;
    const sheets = [];
    for (let i = 0; i < flat.length; i += per) sheets.push(`<div class="sheet">${flat.slice(i, i + per).join('')}</div>`);
    body = sheets.join('\n');
  } else {
    body = `<div class="labels">${flat.join('\n')}</div>`;
  }

  const pages = size.kind === 'sheet' ? Math.ceil(total / (size.cols * size.rows)) : total;
  const warnings = [];
  if (capped) warnings.push(`Only the first ${MAX_LABELS} labels are shown (limit per print).`);
  for (const s of skipped) warnings.push(`Skipped ${s}`);

  const tip =
    size.kind === 'sheet'
      ? 'In the print dialog choose paper A4, margins None, scale 100%.'
      : `In the print dialog choose your label printer, paper ${size.widthMm} x ${size.heightMm} mm, margins None, scale 100%.`;

  const toolbar = `<div class="toolbar"><button type="button" onclick="window.print()">Print</button><strong>${total} label${total === 1 ? '' : 's'}</strong><span>${escapeHtml(size.label)}${size.kind === 'sheet' ? ` · ${pages} sheet${pages === 1 ? '' : 's'}` : ''}</span><span class="tip">${escapeHtml(tip)}</span>${
    warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''
  }</div>`;

  const autoPrint = ctx.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)});</script>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${buildCss(size)}</style>
</head>
<body>
${toolbar}
${body}
${autoPrint}
</body>
</html>`;
};

const sendError = (res, err, fallbackMsg) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(fallbackMsg, err);
  const payload = { message: status === 500 ? fallbackMsg : err.message };
  if (err.missing) payload.missing = err.missing;
  if (err.index !== undefined) payload.index = err.index;
  if (status === 500) payload.error = err.message;
  return res.status(status).json(payload);
};

const loadProduct = async (id, req) => {
  if (!mongoose.isValidObjectId(id)) throw badRequest('Invalid product id');
  const product = await Product.findById(id);
  if (!product || !canSeeProduct(req, product)) throw notFound('Product not found');
  return product;
};

// ---------- handlers ----------

const labelController = {
  // GET /products/:id/label-data — everything a frontend needs to show a label picker.
  getLabelData: async (req, res) => {
    try {
      const product = await loadProduct(req.params.id, req);
      const ppb = Math.max(1, Math.floor(Number(product.piecesPerBox) || 1));
      const { shopName, currency } = await getShopSettings(req.query || {});
      const where = await labelBranch(req);

      const units = listUnits(product).map(({ key, variant, unit }) => {
        // stock of the request's branch (all branches when none)
        const stock = unitBranchStock(unit, where.branchId, where.mainBranchId);
        const fb = ppb > 1 ? fullBoxEntry(unit) : null;
        return {
          variantId: key === PRODUCT_UNIT ? null : key,
          label: variant ? variantLabel(variant) || variant.sku || 'Variant' : '',
          shortCode: unit.shortCode ? normalizeCode(unit.shortCode) : null,
          sku: unit.sku || null,
          printCode: unitMainCode(unit) || null,
          price: sellPrice(unit),
          regularPrice: Number(unit.price) || 0,
          // cost per piece (variant's own, else the product's)
          costPrice: Number.isFinite(Number(unit.costPrice ?? product.costPrice))
            ? Number(unit.costPrice ?? product.costPrice)
            : null,
          stock,
          barcodes: (unit.barcodes || []).map((b) => ({ code: b.code, qty: b.qty || 1, label: b.label || '' })),
          fullBoxCode: fb ? normalizeCode(fb.code) : null,
          batches: unitBatchesFor(unit, where.branchId, where.mainBranchId).map((b) => {
            const quantity = Number(b.quantity) || 0;
            return {
              batchNo: b.batchNo,
              barcode: b.barcode || null,
              quantity,
              expiryDate: b.expiryDate || null,
              suggestedCopies: atLeastOne(ppb > 1 ? ceilDiv(quantity, ppb) : quantity),
            };
          }),
          suggested: {
            unit: atLeastOne(stock),
            box: ppb > 1 ? atLeastOne(ceilDiv(stock, ppb)) : null,
            fullBox: fb ? atLeastOne(ceilDiv(stock, ppb)) : null,
          },
        };
      });

      return res.status(200).json({
        message: 'Label data fetched successfully',
        data: {
          product: {
            id: String(product._id),
            name: product.name,
            productType: product.productType || 'single',
            piecesPerBox: ppb,
          },
          shop: { name: shopName, currency },
          stockBranch: where.branchId, // branch the stock / suggested copies are for (null = all)
          units,
          types: TYPES,
          sizes: Object.values(SIZES).map((s) => ({
            key: s.key,
            label: s.label,
            widthMm: s.widthMm,
            heightMm: s.heightMm,
            kind: s.kind,
            perPage: s.kind === 'sheet' ? s.cols * s.rows : 1,
          })),
          defaultSize: DEFAULT_SIZE,
          maxLabels: MAX_LABELS,
        },
      });
    } catch (err) {
      return sendError(res, err, 'Error fetching label data');
    }
  },

  // GET /products/:id/labels?variantId=&type=&batchNo=&code=&copies=&size=&showPrice=&showShop=&currency=&autoPrint=
  printLabels: async (req, res) => {
    try {
      const q = req.query || {};
      const size = parseSize(q.size);
      const type = parseType(q.type);
      const copies = parseCopies(q.copies);
      const product = await loadProduct(req.params.id, req);
      const where = await labelBranch(req);

      const { entries, skipped } = buildEntries(product, {
        variantId: asString(q.variantId),
        type,
        batchNo: asString(q.batchNo),
        code: asString(q.code),
        branchId: where.branchId,
        mainBranchId: where.mainBranchId,
      });
      if (!entries.length) throw badRequest(skipped.length ? `Nothing to print. ${skipped.join('; ')}` : 'Nothing to print');

      const state = { count: 0, capped: false };
      const labels = applyCopies(entries, copies, state);
      const settings = await getShopSettings(q);
      const html = renderPage({
        labels,
        size,
        title: `Labels - ${product.name}`,
        skipped,
        capped: state.capped,
        ctx: {
          ...settings,
          showPrice: parseBool(q.showPrice, true),
          showShop: parseBool(q.showShop, true),
          autoPrint: parseBool(q.autoPrint, false),
        },
      });
      res.set('Cache-Control', 'no-store');
      res.set('X-Label-Count', String(state.count));
      return res.status(200).type('html').send(html);
    } catch (err) {
      return sendError(res, err, 'Error printing labels');
    }
  },

  // POST /products/labels/print
  // body: { items: [{ productId, variantId?, type?, batchNo?, code?, copies? }], size?, showPrice?, showShop?, currency?, autoPrint? }
  printBulk: async (req, res) => {
    try {
      const body = req.body || {};
      const items = body.items;
      if (!Array.isArray(items) || !items.length) throw badRequest('items must be a non-empty array');
      if (items.length > MAX_BULK_ITEMS) throw badRequest(`Too many items (max ${MAX_BULK_ITEMS})`);
      const size = parseSize(body.size);

      const parsed = items.map((it, index) => {
        if (!it || typeof it !== 'object') throw badRequest(`items[${index}] must be an object`, { index });
        const productId = asString(it.productId);
        if (!productId || !mongoose.isValidObjectId(productId)) throw badRequest(`items[${index}].productId is invalid`, { index });
        try {
          return {
            productId,
            variantId: asString(it.variantId),
            type: parseType(it.type, `items[${index}].type`),
            batchNo: asString(it.batchNo),
            code: asString(it.code),
            copies: parseCopies(it.copies, `items[${index}].copies`),
          };
        } catch (e) {
          e.index = index;
          throw e;
        }
      });

      const ids = [...new Set(parsed.map((p) => p.productId))];
      const products = await Product.find({ _id: { $in: ids }, ...productScopeFilter(req) });
      const byId = new Map(products.map((p) => [String(p._id), p]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw notFound(`Product not found: ${missing.join(', ')}`, { missing });

      const where = await labelBranch(req);
      const state = { count: 0, capped: false };
      const labels = [];
      const skipped = [];
      for (let index = 0; index < parsed.length; index++) {
        const p = parsed[index];
        let built;
        try {
          built = buildEntries(byId.get(p.productId), { ...p, branchId: where.branchId, mainBranchId: where.mainBranchId });
        } catch (e) {
          // One bad line (no batches, unknown variant...) should not block the
          // whole print run: list it in the page's warnings instead.
          if (e.status !== 400 && e.status !== 404) throw e;
          const name = byId.get(p.productId).name;
          skipped.push(`item ${index + 1}: ${e.message.startsWith(name) ? e.message : `${name}: ${e.message}`}`);
          continue;
        }
        skipped.push(...built.skipped);
        if (state.count >= MAX_LABELS) {
          if (built.entries.length) state.capped = true;
          continue;
        }
        labels.push(...applyCopies(built.entries, p.copies, state));
      }
      if (!labels.length) throw badRequest(skipped.length ? `Nothing to print. ${skipped.join('; ')}` : 'Nothing to print');

      const settings = await getShopSettings(body);
      const html = renderPage({
        labels,
        size,
        title: `Labels - ${parsed.length} item${parsed.length === 1 ? '' : 's'}`,
        skipped,
        capped: state.capped,
        ctx: {
          ...settings,
          showPrice: parseBool(body.showPrice, true),
          showShop: parseBool(body.showShop, true),
          autoPrint: parseBool(body.autoPrint, false),
        },
      });
      res.set('Cache-Control', 'no-store');
      res.set('X-Label-Count', String(state.count));
      return res.status(200).type('html').send(html);
    } catch (err) {
      return sendError(res, err, 'Error printing labels');
    }
  },
};

// Exposed for tests / reuse.
labelController._internal = { buildEntries, applyCopies, renderPage, SIZES, MAX_LABELS };

module.exports = labelController;
