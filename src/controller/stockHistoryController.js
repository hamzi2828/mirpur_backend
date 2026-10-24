// src/controller/stockHistoryController.js
// GET /admin/stock-history — stock added / changed / moved, newest first.
// Query: productId, variantId, type (opening|received|adjustment|transfer_in|transfer_out|in|out),
//        search (product name), startDate, endDate (YYYY-MM-DD), page, limit.
// Branch staff only see their own branch; the super admin sees the branch picked
// in the header (x-branch-id) or all branches.
const mongoose = require('mongoose');
const StockEntry = require('../models/stockEntry');
const { STOCK_ENTRY_TYPES } = require('../models/stockEntry');
const { branchFilter } = require('../middleware/access');

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dayStart = (s) => {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dayEnd = (s) => {
  const d = new Date(`${s}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const stockHistoryController = {
  list: async (req, res) => {
    try {
      const q = req.query || {};
      const page = Math.max(1, parseInt(q.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));

      const match = { ...branchFilter(req) };
      if (q.productId) {
        if (!isId(q.productId)) return res.status(400).json({ success: false, message: 'Invalid productId' });
        match.product = new mongoose.Types.ObjectId(String(q.productId));
      }
      if (q.variantId) match.variantId = String(q.variantId);
      if (q.type === 'in') match.quantity = { $gt: 0 };
      else if (q.type === 'out') match.quantity = { $lt: 0 };
      else if (q.type && STOCK_ENTRY_TYPES.includes(q.type)) match.type = q.type;
      if (q.search && String(q.search).trim()) {
        match.productName = { $regex: escapeRegex(String(q.search).trim()), $options: 'i' };
      }
      const from = q.startDate ? dayStart(q.startDate) : null;
      const to = q.endDate ? dayEnd(q.endDate) : null;
      if (from || to) match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };

      const [rows, total, sums] = await Promise.all([
        StockEntry.find(match)
          .sort({ date: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate('branch', 'name code')
          .populate('otherBranch', 'name code')
          .lean(),
        StockEntry.countDocuments(match),
        StockEntry.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              piecesIn: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } },
              piecesOut: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, '$quantity', 0] } },
            },
          },
        ]),
      ]);

      return res.status(200).json({
        success: true,
        data: rows,
        summary: {
          piecesIn: (sums[0] && sums[0].piecesIn) || 0,
          piecesOut: Math.abs((sums[0] && sums[0].piecesOut) || 0),
        },
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          hasNextPage: page * limit < total,
          hasPreviousPage: page > 1,
        },
      });
    } catch (error) {
      console.error('Stock history error:', error);
      return res.status(500).json({ success: false, message: 'Failed to load stock history', error: error.message });
    }
  },
};

module.exports = stockHistoryController;
