// Reports Controller — server-side aggregation for the admin Reports section.
//
// The cash-in-hand report is the critical one. All figures are computed here
// so the frontend displays a single trusted snapshot. Dates are interpreted in
// the server's local timezone at the day boundary (start: 00:00:00, end:
// 23:59:59.999) — the client sends YYYY-MM-DD strings.
const POSOrder = require('../models/posOrder');
const Order = require('../models/order');
const Expense = require('../models/expense');
const Salary = require('../models/salary');
const Purchase = require('../models/purchase');
const Product = require('../models/product');
const {
  scopedBranchFilter,
  branchScope,
  includesMainOnlyData,
  byBranchBreakdown,
  branchStockExpr,
} = require('../helper/branchScope');
const { productScopeFilter } = require('../helper/productScope');
// Force-register schemas referenced only through populate() so isolated test
// runs (that don't touch these models directly) don't crash with
// "Schema hasn't been registered for model X".
require('../models/user');
require('../models/employee');
require('../models/vendor');

// Read pagination params off the query with sane defaults + upper bound so a
// bad client can't exfil the whole collection.
function parsePagination(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  let limit = parseInt(String(query.limit || defaultLimit), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(maxLimit, limit);
  return { page, limit, skip: (page - 1) * limit };
}

function buildPagination(page, limit, total) {
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ---------------- Branches ----------------
// Every report is scoped with scopedBranchFilter(req): branch staff -> their
// branch; super admin -> the picked branch, or all branches when none picked.
// Old records without a branch count for the main branch. Data that has no
// branch at all (web/online orders, salaries) is shown only for "all branches"
// or the main branch.

// Parse YYYY-MM-DD → Date set to local start/end of day. Invalid input returns null.
const toStartOfDay = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};
const toEndOfDay = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

// Normalize expense paymentMethod string → 'cash' | 'bank' | 'other'.
const normalizeExpenseMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'bank transfer' || v === 'bank_transfer' || v === 'bank' || v === 'debit card' || v === 'credit card' || v === 'cheque' || v === 'check') return 'bank';
  return 'other';
};

// Normalize salary / purchase payment method → 'cash' | 'bank' | 'other'.
const normalizeFinanceMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'bank' || v === 'bank_transfer' || v === 'card' || v === 'cheque' || v === 'check') return 'bank';
  return 'other';
};

// Normalize POS payment method → 'cash' | 'card' | 'bank' | 'other'.
// Card is split out for sales because cards settle through bank but operators
// often want to see the card slice independently.
const normalizePOSMethod = (m) => {
  const v = String(m || '').toLowerCase().trim();
  if (v === 'cash') return 'cash';
  if (v === 'card') return 'card';
  if (v === 'bank_transfer' || v === 'bank') return 'bank';
  return 'other';
};

const reportsController = {
  // GET /api/reports/cash-in-hand?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  cashInHand: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);

      if (!start || !end) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate (YYYY-MM-DD) are required',
        });
      }

      const bf = await scopedBranchFilter(req);
      const scope = await branchScope(req);

      // ---------- 1. POS orders in window ----------
      const periodOrders = await POSOrder.find({
        isDeleted: { $ne: true },
        createdAt: { $gte: start, $lte: end },
        ...bf,
      }).lean();

      // Full-paid orders = sales that settled at the register. Their totals go
      // straight to "Total Sales" bucketed by payment method.
      const salesBreakdown = { totalSales: 0, cashSales: 0, cardSales: 0, bankTransfer: 0 };
      const fullPaidOrders = periodOrders.filter((o) => o.paymentStatus === 'full' || o.paymentStatus === 'completed');
      for (const o of fullPaidOrders) {
        salesBreakdown.totalSales += o.total || 0;
        const m = normalizePOSMethod(o.paymentMethod);
        if (m === 'cash') salesBreakdown.cashSales += o.total || 0;
        else if (m === 'card') salesBreakdown.cardSales += o.total || 0;
        else if (m === 'bank') salesBreakdown.bankTransfer += o.total || 0;
      }

      // Receivables snapshot = pending + partial orders as of now (not date
      // filtered: receivables are a balance, not a flow).
      const openOrders = await POSOrder.find({
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] },
        ...bf,
      })
        .select('paymentStatus pendingAmount total')
        .lean();

      const pendingOrders = openOrders.filter((o) => o.paymentStatus === 'pending');
      const partialOrders = openOrders.filter((o) => o.paymentStatus === 'partial');
      const receivableData = {
        totalReceivable:
          pendingOrders.reduce((s, o) => s + (o.pendingAmount ?? o.total ?? 0), 0) +
          partialOrders.reduce((s, o) => s + (o.pendingAmount ?? 0), 0),
        pendingCount: pendingOrders.length,
        partialCount: partialOrders.length,
      };

      // ---------- 2. Payments received (installments on pending/partial orders) ----------
      // Any order whose paymentHistory is not a single "full at register" entry
      // contributes individual payments to this flow when the payment date falls
      // within the window. This captures initial partials + later catch-up
      // payments without double-counting full-paid sales.
      const ordersWithHistory = await POSOrder.find({
        isDeleted: { $ne: true },
        'paymentHistory.0': { $exists: true },
        ...bf,
      })
        .select('total paymentHistory')
        .lean();

      const paymentsReceived = { total: 0, cash: 0, card: 0, bank: 0, count: 0 };
      for (const o of ordersWithHistory) {
        const history = o.paymentHistory || [];
        const isDirectFullPayment =
          history.length === 1 && (history[0].amount || 0) >= (o.total || 0);
        if (isDirectFullPayment) continue;

        for (const p of history) {
          const paidAt = p.paidAt ? new Date(p.paidAt) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(p.amount) || 0;
          paymentsReceived.count += 1;
          const m = normalizePOSMethod(p.paymentMethod);
          if (m === 'cash') paymentsReceived.cash += amt;
          else if (m === 'card') paymentsReceived.card += amt;
          else if (m === 'bank') paymentsReceived.bank += amt;
        }
      }
      paymentsReceived.total = paymentsReceived.cash + paymentsReceived.card + paymentsReceived.bank;

      // ---------- 3. Expenses in window ----------
      const expenses = await Expense.find({
        isDeleted: { $ne: true },
        date: { $gte: start, $lte: end },
        ...bf,
      })
        .select('amount paymentMethod')
        .lean();

      const expenseSummary = { totalExpenses: 0, cashExpenses: 0, bankExpenses: 0 };
      for (const e of expenses) {
        const amt = Number(e.amount) || 0;
        expenseSummary.totalExpenses += amt;
        const m = normalizeExpenseMethod(e.paymentMethod);
        if (m === 'cash') expenseSummary.cashExpenses += amt;
        else if (m === 'bank') expenseSummary.bankExpenses += amt;
      }

      // ---------- 4. Vendor payments (purchase.payments) in window ----------
      const purchases = await Purchase.find({
        isDeleted: { $ne: true },
        'payments.0': { $exists: true },
        ...bf,
      })
        .select('payments')
        .lean();

      const vendorSummary = { totalPaid: 0, cashPaid: 0, bankPaid: 0 };
      for (const p of purchases) {
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          vendorSummary.totalPaid += amt;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') vendorSummary.cashPaid += amt;
          else if (m === 'bank') vendorSummary.bankPaid += amt;
        }
      }

      // ---------- 5. Salary payments in window ----------
      // Salaries have no branch: they count for all branches / the main branch.
      const salaries = includesMainOnlyData(scope)
        ? await Salary.find({
            isDeleted: { $ne: true },
            'payments.0': { $exists: true },
          })
            .select('payments remainingBalance')
            .lean()
        : [];

      const salarySummary = { totalPaid: 0, cashPaid: 0, bankPaid: 0, totalRemaining: 0 };
      for (const s of salaries) {
        salarySummary.totalRemaining += Number(s.remainingBalance) || 0;
        for (const pay of s.payments || []) {
          const paidAt = pay.date ? new Date(pay.date) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          salarySummary.totalPaid += amt;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') salarySummary.cashPaid += amt;
          else if (m === 'bank') salarySummary.bankPaid += amt;
        }
      }

      // ---------- 6. Derived balances ----------
      const cashBalance =
        salesBreakdown.cashSales +
        paymentsReceived.cash -
        expenseSummary.cashExpenses -
        vendorSummary.cashPaid -
        salarySummary.cashPaid;

      const bankBalance =
        salesBreakdown.bankTransfer +
        salesBreakdown.cardSales +
        paymentsReceived.bank +
        paymentsReceived.card -
        expenseSummary.bankExpenses -
        vendorSummary.bankPaid -
        salarySummary.bankPaid;

      return res.status(200).json({
        success: true,
        data: {
          period: { start: start.toISOString(), end: end.toISOString() },
          salesBreakdown,
          paymentsReceived,
          expenseSummary,
          vendorSummary,
          salarySummary,
          receivableData,
          balances: {
            cashBalance,
            bankBalance,
            totalBalance: cashBalance + bankBalance,
          },
          branchId: scope.branchId,
          salariesIncluded: includesMainOnlyData(scope),
        },
        message: 'Cash in hand report generated',
      });
    } catch (error) {
      console.error('Cash in hand report error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate cash-in-hand report',
        error: error.message,
      });
    }
  },

  // GET /api/reports/sales-summary?startDate=&endDate=
  // Lightweight — just POS orders stats and payment distribution.
  salesSummary: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const bf = await scopedBranchFilter(req);
      const scope = await branchScope(req);
      // Online (website) orders have no branch: they count for the main branch.
      const withOnline = includesMainOnlyData(scope);

      // Pull both POS (counter) and Online (ecommerce) orders for the window.
      const [posOrders, onlineOrders, byBranch] = await Promise.all([
        POSOrder.find({
          isDeleted: { $ne: true },
          createdAt: { $gte: start, $lte: end },
          ...bf,
        })
          .select('orderNumber branch branchCode total paidAmount pendingAmount paymentMethod paymentStatus orderStatus createdAt items customerInfo customer')
          .populate('customer', 'firstName lastName phone')
          .populate('branch', 'name code')
          .populate('items.product', 'name costPrice')
          .sort({ createdAt: -1 })
          .lean(),
        withOnline
          ? Order.find({
              isDeleted: { $ne: true },
              isPOS: { $ne: true },
              createdAt: { $gte: start, $lte: end },
            })
              .select('orderNumber total paymentMethod paymentStatus orderStatus createdAt items user shippingAddress discount tax subtotal')
              .populate('user', 'firstName lastName email phone')
              .populate('items.product', 'name costPrice')
              .sort({ createdAt: -1 })
              .lean()
          : Promise.resolve([]),
        // Super admin, all branches: POS sales per branch (online orders are
        // not in this list, see summary.onlineSales).
        scope.allBranches
          ? byBranchBreakdown(
              POSOrder,
              { isDeleted: { $ne: true }, createdAt: { $gte: start, $lte: end } },
              { mainBranchId: scope.mainBranchId }
            )
          : Promise.resolve(undefined),
      ]);

      const summary = {
        totalOrders: 0,
        totalSales: 0,
        totalPaid: 0,
        totalPending: 0,
        totalCost: 0,
        totalProfit: 0,
        cashSales: 0,
        cardSales: 0,
        bankSales: 0,
        itemsSold: 0,
        avgOrderValue: 0,
        // Source split
        posOrders: 0,
        posSales: 0,
        onlineOrders: 0,
        onlineSales: 0,
      };

      // Helper: compute order cost from items (handles both POS and Online).
      const computeCost = (items) => {
        let cost = 0;
        for (const it of items || []) {
          const qty = Number(it.quantity) || 0;
          if (it.isLabour) continue;
          if (it.isOutsource) {
            cost += (Number(it.costPrice) || 0) * qty;
            continue;
          }
          const prod = it.product && typeof it.product === 'object' ? it.product : null;
          const cp = prod ? Number(prod.costPrice) : NaN;
          if (!Number.isNaN(cp) && cp > 0) cost += cp * qty;
        }
        return cost;
      };

      // POS orders — already in the POS-specific shape.
      const enrichedPOS = posOrders.map((o) => {
        const orderCost = computeCost(o.items);
        const profit = (o.total || 0) - orderCost;
        summary.totalCost += orderCost;
        summary.totalProfit += profit;
        summary.totalSales += o.total || 0;
        summary.totalPaid += o.paidAmount || 0;
        summary.totalPending += o.pendingAmount || 0;
        summary.itemsSold += (o.items || []).length;
        summary.posOrders += 1;
        summary.posSales += o.total || 0;
        const m = normalizePOSMethod(o.paymentMethod);
        if (m === 'cash') summary.cashSales += o.total || 0;
        else if (m === 'card') summary.cardSales += o.total || 0;
        else if (m === 'bank') summary.bankSales += o.total || 0;
        return { ...o, source: 'pos', costPrice: orderCost, profit };
      });

      // Online orders — normalize to the same shape as POS orders so the
      // frontend doesn't need two separate renderers. We map customerInfo
      // from the shipping address (or user) and card-like methods to the
      // closest POS method bucket.
      const mapOnlineMethod = (m) => {
        const v = String(m || '').toLowerCase();
        if (v === 'cod') return 'cash';
        if (v === 'cash') return 'cash';
        if (v === 'card' || v === 'stripe' || v === 'paypal') return 'card';
        if (v === 'bank_transfer' || v === 'bank') return 'bank_transfer';
        return 'card';
      };
      const mapOnlinePaymentStatus = (s, orderStatus) => {
        // Web orders don't track partial/pending the same way POS does.
        if (s === 'completed') return 'full';
        if (s === 'refunded' || orderStatus === 'refunded') return 'refunded';
        if (s === 'failed' || orderStatus === 'cancelled') return 'cancelled';
        return 'pending';
      };

      const enrichedOnline = onlineOrders.map((o) => {
        const orderCost = computeCost(o.items);
        const profit = (o.total || 0) - orderCost;
        const isComplete = o.paymentStatus === 'completed';
        const paid = isComplete ? (o.total || 0) : 0;
        const pending = isComplete ? 0 : (o.total || 0);
        summary.totalCost += orderCost;
        summary.totalProfit += profit;
        summary.totalSales += o.total || 0;
        summary.totalPaid += paid;
        summary.totalPending += pending;
        summary.itemsSold += (o.items || []).length;
        summary.onlineOrders += 1;
        summary.onlineSales += o.total || 0;
        const m = mapOnlineMethod(o.paymentMethod);
        if (m === 'cash') summary.cashSales += o.total || 0;
        else if (m === 'card') summary.cardSales += o.total || 0;
        else if (m === 'bank_transfer') summary.bankSales += o.total || 0;

        // Build a customerInfo-like shape for consistency.
        const u = o.user && typeof o.user === 'object' ? o.user : null;
        const ship = o.shippingAddress || {};
        const customerInfo = {
          name:
            ship.fullName ||
            (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '') ||
            '',
          phone: ship.phone || u?.phone || '',
        };

        return {
          _id: o._id,
          orderNumber: o.orderNumber,
          total: o.total || 0,
          paidAmount: paid,
          pendingAmount: pending,
          paymentMethod: m,
          rawPaymentMethod: o.paymentMethod,
          paymentStatus: mapOnlinePaymentStatus(o.paymentStatus, o.orderStatus),
          orderStatus: o.orderStatus || 'submitted',
          createdAt: o.createdAt,
          items: o.items || [],
          customer: u
            ? { firstName: u.firstName, lastName: u.lastName, phone: u.phone }
            : undefined,
          customerInfo,
          source: 'online',
          costPrice: orderCost,
          profit,
        };
      });

      // Source filter + pagination. Summary is always computed over the
      // full filtered set; only the rows slice is paginated.
      const source = String(req.query.source || 'all').toLowerCase();
      const all = [...enrichedPOS, ...enrichedOnline].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const scoped = all.filter(
        (o) => source === 'all' || o.source === source,
      );

      summary.totalOrders = all.length;
      summary.avgOrderValue = summary.totalOrders ? summary.totalSales / summary.totalOrders : 0;

      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
      const paged = scoped.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: { summary, orders: paged, byBranch, branchId: scope.branchId },
        pagination: buildPagination(page, limit, scoped.length),
        message: 'Sales summary generated',
      });
    } catch (error) {
      console.error('Sales summary error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate sales summary', error: error.message });
    }
  },

  // GET /api/reports/purchases-summary?startDate=&endDate=
  purchasesSummary: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const purchases = await Purchase.find({
        isDeleted: { $ne: true },
        purchaseDate: { $gte: start, $lte: end },
        ...(await scopedBranchFilter(req)),
      })
        .select('invoiceNumber branch vendorName vendorId purchaseDate total paidAmount pendingAmount paymentStatus items payments')
        .sort({ purchaseDate: -1 })
        .lean();

      const summary = {
        totalPurchases: purchases.length,
        totalAmount: 0,
        totalPaid: 0,
        totalPending: 0,
        cashPaid: 0,
        bankPaid: 0,
      };
      for (const p of purchases) {
        summary.totalAmount += p.total || 0;
        summary.totalPaid += p.paidAmount || 0;
        summary.totalPending += p.pendingAmount || 0;
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          const m = normalizeFinanceMethod(pay.paymentMethod);
          if (m === 'cash') summary.cashPaid += amt;
          else if (m === 'bank') summary.bankPaid += amt;
        }
      }

      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
      const pagePurchases = purchases.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: { summary, purchases: pagePurchases },
        pagination: buildPagination(page, limit, purchases.length),
        message: 'Purchases summary generated',
      });
    } catch (error) {
      console.error('Purchases summary error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate purchases summary', error: error.message });
    }
  },

  // GET /api/reports/labour-revenue?startDate=&endDate=
  // All POS order items flagged as labour, grouped by description, for the
  // window. Helps the shop see which services earn the most.

  // GET /api/reports/stock?filter=all|low|out&threshold=10
  // Snapshot of current product inventory. Not date-filtered — stock is a
  // balance, not a flow.
  stock: async (req, res) => {
    try {
      const filter = String(req.query.filter || 'all').toLowerCase();
      const threshold = Math.max(0, parseInt(String(req.query.threshold || '10'), 10) || 10);
      const search = String(req.query.search || '').trim();
      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });

      // Build stock-status filter via query expressions so the DB does the work.
      // Shared products + the branch's own (super admin on "all branches": every product).
      const baseQuery = { isDeleted: { $ne: true }, ...productScopeFilter(req) };
      if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        baseQuery.$or = [{ name: rx }, { category: rx }, { slug: rx }];
      }
      // One branch picked (or branch staff): use that branch's stock.
      const scope = await branchScope(req);
      if (!scope.allBranches) {
        return reportsController.branchStockReport(req, res, {
          scope, filter, threshold, baseQuery, page, limit, skip,
        });
      }

      const stockFilteredQuery = { ...baseQuery };
      if (filter === 'out') stockFilteredQuery.stock = { $lte: 0 };
      else if (filter === 'low') stockFilteredQuery.stock = { $gt: 0, $lte: threshold };

      // Summary aggregated across all products (ignores status filter so the
      // tiles give a shop-wide view) — fast single pipeline.
      const [summaryAgg, total, pageProducts] = await Promise.all([
        Product.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              totalProducts: { $sum: 1 },
              totalInStock: {
                $sum: { $cond: [{ $gt: ['$stock', threshold] }, 1, 0] },
              },
              totalLowStock: {
                $sum: {
                  $cond: [
                    { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', threshold] }] },
                    1,
                    0,
                  ],
                },
              },
              totalOutOfStock: {
                $sum: { $cond: [{ $lte: ['$stock', 0] }, 1, 0] },
              },
              totalUnits: { $sum: { $ifNull: ['$stock', 0] } },
              totalInventoryValue: {
                $sum: {
                  $multiply: [
                    { $ifNull: ['$stock', 0] },
                    { $ifNull: ['$costPrice', 0] },
                  ],
                },
              },
            },
          },
        ]),
        Product.countDocuments(stockFilteredQuery),
        Product.find(stockFilteredQuery)
          .select('name slug category status productType stock variants price costPrice discountedPrice thumbnailUrl displayOn updatedAt')
          .sort({ category: 1, name: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      const rows = pageProducts.map((p) => {
        const stock = Number(p.stock) || 0;
        const costPrice = Number(p.costPrice) || 0;
        const inventoryValue = stock * costPrice;
        let stockStatus = 'in_stock';
        if (stock <= 0) stockStatus = 'out_of_stock';
        else if (stock <= threshold) stockStatus = 'low_stock';
        return {
          _id: p._id,
          name: p.name,
          slug: p.slug,
          category: p.category,
          status: p.status,
          productType: p.productType,
          stock,
          variantCount: Array.isArray(p.variants) ? p.variants.length : 0,
          price: Number(p.price) || 0,
          costPrice,
          discountedPrice: p.discountedPrice ?? null,
          thumbnailUrl: p.thumbnailUrl || null,
          displayOn: p.displayOn,
          inventoryValue,
          stockStatus,
          updatedAt: p.updatedAt,
        };
      });

      const sa = summaryAgg[0] || {
        totalProducts: 0,
        totalInStock: 0,
        totalLowStock: 0,
        totalOutOfStock: 0,
        totalUnits: 0,
        totalInventoryValue: 0,
      };

      return res.status(200).json({
        success: true,
        data: { summary: { ...sa, threshold }, products: rows },
        pagination: buildPagination(page, limit, total),
        message: 'Stock report generated',
      });
    } catch (error) {
      console.error('Stock report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate stock report', error: error.message });
    }
  },

  // Stock report for one branch (not a route; called by `stock`). Same response
  // shape; `stock` = pieces in this branch, `totalStock` = all branches.
  branchStockReport: async (req, res, { scope, filter, threshold, baseQuery, page, limit, skip }) => {
    const qty = branchStockExpr(scope.branchId, scope.isMain);
    let stockMatch = {};
    if (filter === 'out') stockMatch = { _branchStock: { $lte: 0 } };
    else if (filter === 'low') stockMatch = { _branchStock: { $gt: 0, $lte: threshold } };
    const [agg] = await Product.aggregate([
      { $match: baseQuery },
      { $addFields: { _branchStock: qty } },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalProducts: { $sum: 1 },
                totalInStock: { $sum: { $cond: [{ $gt: ['$_branchStock', threshold] }, 1, 0] } },
                totalLowStock: {
                  $sum: {
                    $cond: [{ $and: [{ $gt: ['$_branchStock', 0] }, { $lte: ['$_branchStock', threshold] }] }, 1, 0],
                  },
                },
                totalOutOfStock: { $sum: { $cond: [{ $lte: ['$_branchStock', 0] }, 1, 0] } },
                totalUnits: { $sum: '$_branchStock' },
                totalInventoryValue: { $sum: { $multiply: ['$_branchStock', { $ifNull: ['$costPrice', 0] }] } },
              },
            },
          ],
          count: [{ $match: stockMatch }, { $count: 'n' }],
          rows: [
            { $match: stockMatch },
            { $sort: { category: 1, name: 1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, slug: 1, category: 1, status: 1, productType: 1, stock: 1, _branchStock: 1,
                variantCount: { $size: { $ifNull: ['$variants', []] } },
                price: 1, costPrice: 1, discountedPrice: 1, thumbnailUrl: 1, displayOn: 1, updatedAt: 1,
              },
            },
          ],
        },
      },
    ]);
    const out = agg || {};
    const rows = (out.rows || []).map((p) => {
      const stock = Number(p._branchStock) || 0;
      const costPrice = Number(p.costPrice) || 0;
      let stockStatus = 'in_stock';
      if (stock <= 0) stockStatus = 'out_of_stock';
      else if (stock <= threshold) stockStatus = 'low_stock';
      return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        category: p.category,
        status: p.status,
        productType: p.productType,
        stock,
        totalStock: Number(p.stock) || 0,
        variantCount: p.variantCount || 0,
        price: Number(p.price) || 0,
        costPrice,
        discountedPrice: p.discountedPrice ?? null,
        thumbnailUrl: p.thumbnailUrl || null,
        displayOn: p.displayOn,
        inventoryValue: stock * costPrice,
        stockStatus,
        updatedAt: p.updatedAt,
      };
    });
    const sa = { ...((out.summary || [])[0] || {
      totalProducts: 0, totalInStock: 0, totalLowStock: 0, totalOutOfStock: 0, totalUnits: 0, totalInventoryValue: 0,
    }) };
    delete sa._id;
    const total = ((out.count || [])[0] || {}).n || 0;
    return res.status(200).json({
      success: true,
      data: { summary: { ...sa, threshold }, products: rows, branchId: scope.branchId },
      pagination: buildPagination(page, limit, total),
      message: 'Stock report generated',
    });
  },

  // GET /api/reports/expenses?startDate=&endDate=&category=&method=
  expensesReport: async (req, res) => {
    try {
      const { startDate, endDate, category, method, search } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const query = { isDeleted: { $ne: true }, date: { $gte: start, $lte: end }, ...(await scopedBranchFilter(req)) };
      if (category && category !== 'all') query.category = category;
      if (method && method !== 'all') query.paymentMethod = method;
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ title: rx }, { reference: rx }, { category: rx }];
      }

      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });

      // Summary aggregation — runs on indexed fields, independent of pagination.
      const [summaryAgg, byCategoryAgg, byMethodAgg, total, pageRows] = await Promise.all([
        Expense.aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              cashTotal: {
                $sum: {
                  $cond: [{ $eq: [{ $toLower: '$paymentMethod' }, 'cash'] }, '$amount', 0],
                },
              },
              bankTotal: {
                $sum: {
                  $cond: [
                    { $in: [{ $toLower: '$paymentMethod' }, ['bank transfer', 'bank_transfer', 'bank', 'debit card', 'credit card', 'cheque', 'check']] },
                    '$amount',
                    0,
                  ],
                },
              },
            },
          },
        ]),
        Expense.aggregate([
          { $match: query },
          { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ]),
        Expense.aggregate([
          { $match: query },
          { $group: { _id: { $ifNull: ['$paymentMethod', 'Other'] }, amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ]),
        Expense.countDocuments(query),
        Expense.find(query)
          .select('title amount category categories date paymentMethod reference notes')
          .sort({ date: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      const s = summaryAgg[0] || { total: 0, count: 0, cashTotal: 0, bankTotal: 0 };

      return res.status(200).json({
        success: true,
        data: {
          summary: {
            total: s.total || 0,
            count: s.count || 0,
            cashTotal: s.cashTotal || 0,
            bankTotal: s.bankTotal || 0,
            avgExpense: s.count ? s.total / s.count : 0,
          },
          byCategory: byCategoryAgg.map((b) => ({ category: b._id, amount: b.amount })),
          byMethod: byMethodAgg.map((b) => ({ method: b._id, amount: b.amount })),
          expenses: pageRows,
        },
        pagination: buildPagination(page, limit, total),
        message: 'Expense report generated',
      });
    } catch (error) {
      console.error('Expense report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate expense report', error: error.message });
    }
  },

  // GET /api/reports/vendor-payments?startDate=&endDate=&vendorId=
  vendorPaymentsReport: async (req, res) => {
    try {
      const { startDate, endDate, vendorId } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      // Pull all non-deleted purchases (not just ones with payments) so the
      // page can also surface unpaid invoices as outstanding obligations.
      const query = { isDeleted: { $ne: true }, ...(await scopedBranchFilter(req)) };
      if (vendorId) query.vendorId = vendorId;

      const purchases = await Purchase.find(query)
        .select('invoiceNumber vendorId vendorName purchaseDate dueDate total paidAmount pendingAmount paymentStatus payments')
        .populate('vendorId', 'name email phone')
        .lean();

      const payments = [];
      const byVendor = new Map();
      const byMethod = new Map();
      let total = 0;
      let cashTotal = 0;
      let bankTotal = 0;

      for (const p of purchases) {
        for (const pay of p.payments || []) {
          const paidAt = pay.paymentDate ? new Date(pay.paymentDate) : null;
          if (!paidAt || paidAt < start || paidAt > end) continue;
          const amt = Number(pay.amount) || 0;
          total += amt;
          const n = normalizeFinanceMethod(pay.paymentMethod);
          if (n === 'cash') cashTotal += amt;
          else if (n === 'bank') bankTotal += amt;

          const vendorName = p.vendorName || (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') || 'Unknown vendor';
          const vKey = vendorName.toLowerCase();
          if (!byVendor.has(vKey)) {
            byVendor.set(vKey, { vendor: vendorName, count: 0, amount: 0 });
          }
          const vStat = byVendor.get(vKey);
          vStat.count += 1;
          vStat.amount += amt;

          const mKey = String(pay.paymentMethod || 'other').toLowerCase();
          byMethod.set(mKey, (byMethod.get(mKey) || 0) + amt);

          payments.push({
            _id: pay._id,
            date: pay.paymentDate,
            amount: amt,
            paymentMethod: pay.paymentMethod,
            reference: pay.reference || '',
            notes: pay.notes || '',
            invoiceNumber: p.invoiceNumber,
            purchaseId: p._id,
            vendorName,
            vendorId: p.vendorId && typeof p.vendorId === 'object' ? p.vendorId._id : p.vendorId,
            invoiceTotal: Number(p.total) || 0,
            invoicePaid: Number(p.paidAmount) || 0,
            invoicePending: Number(p.pendingAmount) || 0,
          });
        }
      }

      payments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Server-side search filter on payments (by vendor / invoice / reference).
      const searchRaw = String(req.query.search || '').trim();
      let filteredPayments = payments;
      if (searchRaw) {
        const q = searchRaw.toLowerCase();
        filteredPayments = payments.filter(
          (p) =>
            (p.vendorName || '').toLowerCase().includes(q) ||
            (p.invoiceNumber || '').toLowerCase().includes(q) ||
            (p.reference || '').toLowerCase().includes(q),
        );
      }

      // Per-vendor roll-up across ALL of their invoices (not just the ones
      // with a payment in the window). Gives operators a full AP picture
      // side-by-side with the window payment totals.
      const vendorRollup = new Map();
      for (const p of purchases) {
        const vendorName =
          p.vendorName ||
          (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') ||
          'Unknown vendor';
        const key = vendorName.toLowerCase();
        if (!vendorRollup.has(key)) {
          vendorRollup.set(key, {
            vendor: vendorName,
            invoiceCount: 0,
            invoiceTotal: 0,
            invoicePaid: 0,
            invoicePending: 0,
          });
        }
        const r = vendorRollup.get(key);
        r.invoiceCount += 1;
        r.invoiceTotal += Number(p.total) || 0;
        r.invoicePaid += Number(p.paidAmount) || 0;
        r.invoicePending += Number(p.pendingAmount) || 0;
      }

      // Merge payment-window stats with the lifetime roll-up. Every vendor
      // shows up regardless of whether they had activity in the window.
      const byVendorRows = Array.from(vendorRollup.values()).map((r) => {
        const key = r.vendor.toLowerCase();
        const windowStats = byVendor.get(key) || { count: 0, amount: 0 };
        return {
          vendor: r.vendor,
          count: windowStats.count,
          amount: windowStats.amount,
          invoiceCount: r.invoiceCount,
          invoiceTotal: r.invoiceTotal,
          invoicePaid: r.invoicePaid,
          invoicePending: r.invoicePending,
        };
      });

      // Outstanding invoices — unpaid balance across all non-deleted invoices,
      // regardless of whether any payment has been made inside the window.
      // This is what owners usually want to see on "vendor payments".
      const outstandingInvoices = purchases
        .filter((p) => (Number(p.pendingAmount) || 0) > 0)
        .map((p) => ({
          _id: p._id,
          invoiceNumber: p.invoiceNumber,
          vendorName:
            p.vendorName ||
            (p.vendorId && typeof p.vendorId === 'object' ? p.vendorId.name : '') ||
            'Unknown vendor',
          vendorId: p.vendorId && typeof p.vendorId === 'object' ? p.vendorId._id : p.vendorId,
          purchaseDate: p.purchaseDate,
          dueDate: p.dueDate || null,
          total: Number(p.total) || 0,
          paidAmount: Number(p.paidAmount) || 0,
          pendingAmount: Number(p.pendingAmount) || 0,
          paymentStatus: p.paymentStatus,
        }))
        .sort((a, b) => b.pendingAmount - a.pendingAmount);

      const outstandingSummary = outstandingInvoices.reduce(
        (acc, inv) => {
          acc.count += 1;
          acc.totalPending += inv.pendingAmount;
          acc.totalInvoiced += inv.total;
          acc.totalPaid += inv.paidAmount;
          return acc;
        },
        { count: 0, totalPending: 0, totalInvoiced: 0, totalPaid: 0 },
      );

      // Payments tab is the one the user paginates; Outstanding + By Vendor
      // are small aggregations and stay full. The `count` summary reflects
      // the window-level total regardless of search so the summary tiles
      // don't shift when the user types.
      const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25 });
      const pagePayments = filteredPayments.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: {
          summary: {
            total,
            count: payments.length,
            cashTotal,
            bankTotal,
            uniqueVendors: byVendor.size,
            outstanding: outstandingSummary,
          },
          byVendor: byVendorRows.sort(
            (a, b) => (b.invoicePending || 0) - (a.invoicePending || 0) || b.invoiceTotal - a.invoiceTotal,
          ),
          byMethod: Array.from(byMethod.entries())
            .map(([method, amount]) => ({ method, amount }))
            .sort((a, b) => b.amount - a.amount),
          payments: pagePayments,
          outstandingInvoices,
        },
        pagination: buildPagination(page, limit, filteredPayments.length),
        message: 'Vendor payments report generated',
      });
    } catch (error) {
      console.error('Vendor payments report error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate vendor payments report', error: error.message });
    }
  },

  // GET /api/reports/salary?month=1-12&year=YYYY|&startDate=&endDate=
  // Can filter by a specific month+year OR a date range that covers the
  // salary records. Returns salary records + payment flow within the window.


  // GET /api/reports/cost-analysis?startDate=&endDate=
  // Revenue (sales), COGS approximation (outsource cost + labour excluded),
  // expenses, profit estimate.
  costAnalysis: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const start = toStartOfDay(startDate);
      const end = toEndOfDay(endDate);
      if (!start || !end) {
        return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
      }

      const bf = await scopedBranchFilter(req);
      const orders = await POSOrder.find({
        isDeleted: { $ne: true },
        createdAt: { $gte: start, $lte: end },
        orderStatus: { $ne: 'cancelled' },
        ...bf,
      })
        .select('total items')
        .populate('items.product', 'price costPrice discountedPrice')
        .lean();

      let revenue = 0;
      let outsourceCost = 0;
      let estimatedProductCost = 0;
      let itemCount = 0;
      for (const o of orders) {
        revenue += o.total || 0;
        for (const it of o.items || []) {
          itemCount += it.quantity || 0;
          if (it.isOutsource) {
            outsourceCost += (Number(it.costPrice) || 0) * (Number(it.quantity) || 1);
          } else if (!it.isLabour && it.product && typeof it.product === 'object') {
            // Use product.costPrice if available, otherwise skip.
            const cp = Number(it.product.costPrice);
            if (!Number.isNaN(cp) && cp > 0) {
              estimatedProductCost += cp * (Number(it.quantity) || 1);
            }
          }
        }
      }

      const expenses = await Expense.find({
        isDeleted: { $ne: true },
        date: { $gte: start, $lte: end },
        ...bf,
      })
        .select('amount')
        .lean();
      const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

      const cogs = outsourceCost + estimatedProductCost;
      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - totalExpenses;

      return res.status(200).json({
        success: true,
        data: {
          revenue,
          cogs,
          outsourceCost,
          estimatedProductCost,
          totalExpenses,
          grossProfit,
          netProfit,
          itemCount,
          grossMargin: revenue ? (grossProfit / revenue) * 100 : 0,
          netMargin: revenue ? (netProfit / revenue) * 100 : 0,
        },
        message: 'Cost analysis generated',
      });
    } catch (error) {
      console.error('Cost analysis error:', error);
      return res.status(500).json({ success: false, message: 'Failed to generate cost analysis', error: error.message });
    }
  },
};

module.exports = reportsController;
