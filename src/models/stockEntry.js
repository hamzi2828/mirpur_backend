// src/models/stockEntry.js
// Stock history: one row each time pieces of a product come into (or leave) a
// branch other than by a sale. Sales live in POS orders.
//   opening      - stock typed when the product was created
//   received     - "Receive stock" (a delivery)
//   adjustment   - stock changed in the product form (+ or -)
//   transfer_in  - came from another branch
//   transfer_out - sent to another branch (quantity is negative)
// Written by services/stockHistoryService.js; never edited afterwards.
const mongoose = require('mongoose');

const STOCK_ENTRY_TYPES = ['opening', 'received', 'adjustment', 'transfer_in', 'transfer_out'];

const stockEntrySchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, default: '' },
    variantId: { type: String, default: null },
    variantLabel: { type: String, default: '' },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    type: { type: String, enum: STOCK_ENTRY_TYPES, required: true },
    // Pieces in (+) or out (-).
    quantity: { type: Number, required: true },
    // Pieces of this item in this branch right after the change.
    stockAfter: { type: Number, default: null },
    boxes: { type: Number, default: null },
    loosePieces: { type: Number, default: null },
    piecesPerBox: { type: Number, default: null },
    batchNo: { type: String, default: null },
    costPrice: { type: Number, default: null },
    expiryDate: { type: Date, default: null },
    note: { type: String, default: '' },
    // Other branch of a transfer.
    otherBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    // Set only by the backfill script (old stock); real time otherwise.
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

stockEntrySchema.index({ branch: 1, date: -1 });
stockEntrySchema.index({ product: 1, date: -1 });
stockEntrySchema.index({ type: 1, date: -1 });

module.exports = mongoose.models.StockEntry || mongoose.model('StockEntry', stockEntrySchema);
module.exports.STOCK_ENTRY_TYPES = STOCK_ENTRY_TYPES;
