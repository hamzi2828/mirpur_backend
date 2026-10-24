// Stock history for stock that existed before the history started.
// For every product with NO history rows yet, writes one "opening" row per item
// per branch holding stock, dated when the product was created.
//
//   npm run backfill:stock-history              -> DRY RUN, prints what it would write
//   npm run backfill:stock-history -- --apply   -> writes
//
// Safe to run again: products that already have history are skipped.
const path = require('path');
const Product = require('../src/models/product');
const StockEntry = require('../src/models/stockEntry');
const { snapshot } = require('../src/services/stockHistoryService');
const { getMainBranchId } = require('../src/helper/productCodes');

async function backfill({ apply = false, log = console.log } = {}) {
  const mainBranchId = await getMainBranchId();
  const products = await Product.find({}).lean();
  const done = new Set((await StockEntry.distinct('product')).map(String));
  let rows = 0;
  let productsTouched = 0;
  for (const p of products) {
    if (done.has(String(p._id))) continue;
    const items = [];
    for (const unit of snapshot(p, mainBranchId).values()) {
      for (const [branch, stock] of unit.rows) {
        if (stock <= 0) continue;
        items.push({
          product: p._id,
          productName: p.name || '',
          variantId: unit.variantId,
          variantLabel: unit.label,
          branch,
          type: 'opening',
          quantity: stock,
          stockAfter: stock,
          piecesPerBox: p.piecesPerBox || null,
          costPrice: Number.isFinite(Number(p.costPrice)) ? Number(p.costPrice) : null,
          note: 'Stock before history started',
          date: p.createdAt || new Date(),
        });
      }
    }
    if (!items.length) continue;
    productsTouched++;
    rows += items.length;
    log(`  ${apply ? 'ADD' : 'WOULD ADD'}  ${p.name}: ${items.map((i) => `${i.variantLabel || 'item'} ${i.quantity}`).join(', ')}`);
    if (apply) await StockEntry.insertMany(items);
  }
  log(`[${apply ? 'APPLY' : 'DRY RUN'}] ${productsTouched} product(s), ${rows} history row(s)`);
  return { productsTouched, rows };
}

module.exports = { backfill };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { mongoose, ensureConnection } = require('../src/config/mongo');
  (async () => {
    let code = 0;
    try {
      await ensureConnection();
      await backfill({ apply: process.argv.includes('--apply') });
    } catch (err) {
      console.error('Backfill failed:', (err && err.message) || err);
      code = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
      process.exit(code);
    }
  })();
}
