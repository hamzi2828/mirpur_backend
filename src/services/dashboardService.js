const mongoose = require('mongoose');
const Order = require('../models/order');
const User = require('../models/user');
const Product = require('../models/product');
const POSOrder = require('../models/posOrder');
const { branchStockExpr, withBranchStock, byBranchBreakdown } = require('../helper/branchScope');

// Branch scope (built by the controller from req):
//   { allBranches, branchId, mainBranchId, isMain, filter }
//   filter = scopedBranchFilter(req) -> condition on POSOrder.branch.
// Default = all branches (old behaviour).
// Web (ecommerce) orders have no branch: they belong to the main branch, so a
// non-main branch sees none of them. Customers and the catalog are shared.
const ALL_BRANCHES = { allBranches: true, branchId: null, mainBranchId: null, isMain: false, filter: {} };
const NO_MATCH = { _id: null };
const withScope = (scope) => scope || ALL_BRANCHES;
// Products a branch sees: shared ones + its own (see helper/productScope.js).
const productsOf = (scope) => {
  const sc = withScope(scope);
  if (sc.allBranches || !sc.branchId) return {};
  return { ownerBranch: { $in: [null, new mongoose.Types.ObjectId(String(sc.branchId))] } };
};
const webFilter = (scope, filter = {}) => {
  const sc = withScope(scope);
  return sc.allBranches || sc.isMain ? filter : { ...filter, ...NO_MATCH };
};

class DashboardService {
  async getDashboardData(timeRange, scope) {
    const [stats, recentOrders, quickStats, salesTrend, topProducts, recentActivity, customerDistribution] = await Promise.all([
      this.getDashboardStats(timeRange, scope),
      this.getRecentOrders(10, scope),
      this.getQuickStats(scope),
      this.getSalesTrend(timeRange, 'day', scope),
      this.getTopProducts(10, timeRange, scope),
      this.getRecentActivity(20, scope),
      this.getCustomerDistribution()
    ]);

    return {
      stats,
      recentOrders,
      quickStats,
      salesTrend,
      topProducts,
      recentActivity,
      customerDistribution
    };
  }

  async getDashboardStats(timeRange, scope) {
    const sc = withScope(scope);
    const dateFilter = this.getDateFilter(timeRange);
    const webDate = webFilter(sc, dateFilter);
    const posMatch = { ...dateFilter, orderStatus: 'completed', isDeleted: { $ne: true } };

    const [totalOrders, totalUsers, totalProducts, orderStats, posStats, byBranch] = await Promise.all([
      Order.countDocuments(webDate),
      User.countDocuments(),
      Product.countDocuments({ status: 'published', ...productsOf(sc) }),
      Order.aggregate([
        { $match: webDate },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
            avgOrderValue: { $avg: '$total' },
            ordersToday: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', new Date().setHours(0, 0, 0, 0)] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),
      // POS (counter) sales in this branch scope.
      POSOrder.aggregate([
        { $match: { ...posMatch, ...(sc.filter || {}) } },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }
      ]),
      // Super admin, all branches: POS sales per branch.
      sc.allBranches
        ? byBranchBreakdown(POSOrder, posMatch, sc.mainBranchId ? { mainBranchId: sc.mainBranchId } : {})
        : Promise.resolve(undefined)
    ]);

    const stats = orderStats[0] || { totalRevenue: 0, avgOrderValue: 0, ordersToday: 0 };
    const pos = posStats[0] || { revenue: 0, orders: 0 };

    const conversionRate = await this.calculateConversionRate(timeRange);
    const refundRate = await this.calculateRefundRate(timeRange, sc);

    return {
      totalSales: totalOrders,
      totalUsers,
      totalProducts,
      totalRevenue: stats.totalRevenue,
      ordersToday: stats.ordersToday,
      avgOrderValue: stats.avgOrderValue,
      conversionRate,
      refundRate,
      posRevenue: pos.revenue || 0,
      posOrders: pos.orders || 0,
      branchId: sc.branchId || null,
      byBranch
    };
  }

  async getRecentOrders(limit, scope) {
    const orders = await Order.find(webFilter(scope))
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return orders.map(order => ({
      id: order._id.toString(),
      customerId: order.user?._id?.toString() || '',
      customerName: order.user?.name || 'Guest',
      amount: order.total,
      status: order.orderStatus || order.status,
      createdAt: order.createdAt
    }));
  }

  // Published products counted by stock in the scope's branch (all branches = total stock).
  async countProductsByStock(stockCond, scope) {
    const sc = withScope(scope);
    if (sc.allBranches) return Product.countDocuments({ stock: stockCond, status: 'published' });
    const rows = await Product.aggregate([
      { $match: { status: 'published', ...productsOf(sc) } },
      { $addFields: { _branchStock: branchStockExpr(sc.branchId, sc.isMain) } },
      { $match: { _branchStock: stockCond } },
      { $count: 'n' }
    ]);
    return (rows[0] && rows[0].n) || 0;
  }

  async getQuickStats(scope) {
    const [pendingOrders, lowStockItems, newCustomers, returnedItems] = await Promise.all([
      Order.countDocuments(webFilter(scope, { orderStatus: 'submitted' })),
      this.countProductsByStock({ $lt: 10 }, scope),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }),
      Order.countDocuments(webFilter(scope, { orderStatus: 'refunded' }))
    ]);

    const avgFulfillmentTime = await this.calculateAvgFulfillmentTime(scope);

    return {
      pendingOrders,
      lowStockItems,
      newCustomers,
      returnedItems,
      avgFulfillmentTime
    };
  }

  async getSalesTrend(timeRange, interval, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));
    const groupFormat = this.getGroupFormat(interval);

    const trend = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: { $dateToString: { format: groupFormat, date: '$createdAt' } },
          sales: { $sum: '$total' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    return trend.map(item => ({
      date: item._id,
      sales: item.sales,
      orders: item.orders
    }));
  }

  async getTopProducts(limit, timeRange, scope) {
    const sc = withScope(scope);
    const dateFilter = webFilter(sc, this.getDateFilter(timeRange));

    const topProducts = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          sales: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' }
    ]);

    return topProducts.map(item => ({
      id: item._id.toString(),
      name: item.productInfo.name,
      sales: item.sales,
      revenue: item.revenue,
      // Stock in the scope's branch (all branches = total).
      stock: sc.allBranches
        ? item.productInfo.stock || 0
        : withBranchStock(item.productInfo, sc.branchId, sc.mainBranchId).stock || 0
    }));
  }

  async getRecentActivity(limit, scope) {
    const activities = [];

    const [recentOrders, recentUsers, recentProducts] = await Promise.all([
      Order.find(webFilter(scope))
        .populate('user', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      User.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      Product.find(productsOf(scope))
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean()
    ]);

    recentOrders.forEach(order => {
      activities.push({
        id: order._id.toString(),
        type: 'order',
        description: `New order #${order._id.toString().slice(-6)} placed`,
        timestamp: order.createdAt,
        userId: order.user?._id?.toString(),
        userName: order.user?.name
      });
    });

    recentUsers.forEach(user => {
      activities.push({
        id: user._id.toString(),
        type: 'user',
        description: `New user registered: ${user.name}`,
        timestamp: user.createdAt,
        userId: user._id.toString(),
        userName: user.name
      });
    });

    recentProducts.forEach(product => {
      activities.push({
        id: product._id.toString(),
        type: 'product',
        description: `Product updated: ${product.name}`,
        timestamp: product.updatedAt
      });
    });

    return activities
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  async getCustomerDistribution() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [newCustomers, returningCustomers, vipCustomers] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      User.countDocuments({
        createdAt: { $lt: thirtyDaysAgo, $gte: ninetyDaysAgo }
      }),
      User.countDocuments({ totalPurchases: { $gte: 10 } })
    ]);

    return {
      new: newCustomers,
      returning: returningCustomers,
      vip: vipCustomers
    };
  }

  async getAnalytics(timeRange, scope) {
    const currentPeriod = this.getDateFilter(timeRange);
    const previousPeriod = this.getPreviousPeriodFilter(timeRange);

    const [current, previous] = await Promise.all([
      this.getPeriodMetrics(currentPeriod, scope),
      this.getPeriodMetrics(previousPeriod, scope)
    ]);

    const topCategories = await this.getTopCategories(timeRange, scope);
    const geographicDistribution = await this.getGeographicDistribution(timeRange, scope);

    return {
      periodComparison: {
        current,
        previous,
        percentageChange: {
          revenue: this.calculatePercentageChange(current.revenue, previous.revenue),
          orders: this.calculatePercentageChange(current.orders, previous.orders),
          customers: this.calculatePercentageChange(current.customers, previous.customers)
        }
      },
      topCategories,
      geographicDistribution
    };
  }

  async generateReport(timeRange, scope) {
    const data = await this.getDashboardData(timeRange, scope);
    return Buffer.from(JSON.stringify(data));
  }

  async exportData(format, timeRange, scope) {
    const data = await this.getDashboardData(timeRange, scope);

    if (format === 'csv') {
      return this.convertToCSV(data);
    } else if (format === 'excel') {
      return this.convertToExcel(data);
    } else {
      return this.convertToPDF(data);
    }
  }

  async refreshDashboardCache() {
    return true;
  }

  async getNotifications(userId, unreadOnly) {
    const filter = { userId };
    if (unreadOnly) {
      filter.read = false;
    }

    return [];
  }

  async markNotificationAsRead(notificationId, userId) {
    return true;
  }

  async getMetrics(metricType, timeRange, scope) {
    const userDateFilter = this.getDateFilter(timeRange);
    const userPreviousFilter = this.getPreviousPeriodFilter(timeRange);
    // Order metrics are branch-scoped; customers are shared.
    const dateFilter = webFilter(scope, userDateFilter);
    const previousFilter = webFilter(scope, userPreviousFilter);

    let current = 0;
    let previous = 0;
    let trend = [];

    switch (metricType) {
      case 'revenue':
        const revenueData = await Order.aggregate([
          { $match: dateFilter },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        current = revenueData[0]?.total || 0;

        const prevRevenueData = await Order.aggregate([
          { $match: previousFilter },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        previous = prevRevenueData[0]?.total || 0;
        break;

      case 'orders':
        current = await Order.countDocuments(dateFilter);
        previous = await Order.countDocuments(previousFilter);
        break;

      case 'customers':
        current = await User.countDocuments(userDateFilter);
        previous = await User.countDocuments(userPreviousFilter);
        break;
    }

    const change = this.calculatePercentageChange(current, previous);

    return {
      current,
      previous,
      change,
      trend
    };
  }

  async getRevenueBreakdown(timeRange, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));

    const breakdown = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $group: {
          _id: '$productInfo.category',
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          orders: { $sum: 1 }
        }
      },
      { $sort: { revenue: -1 } }
    ]);

    return breakdown;
  }

  async getInventoryStatus(scope) {
    const [totalProducts, outOfStock, lowStock, inStock] = await Promise.all([
      Product.countDocuments({ status: 'published', ...productsOf(scope) }),
      withScope(scope).allBranches
        ? Product.countDocuments({ stock: 0, status: 'published' })
        : this.countProductsByStock({ $lte: 0 }, scope),
      this.countProductsByStock({ $gt: 0, $lt: 10 }, scope),
      this.countProductsByStock({ $gte: 10 }, scope)
    ]);

    return {
      totalProducts,
      outOfStock,
      lowStock,
      inStock
    };
  }

  async getPerformanceMetrics(timeRange, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));

    const metrics = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
          avgOrderValue: { $avg: '$total' },
          maxOrderValue: { $max: '$total' },
          minOrderValue: { $min: '$total' }
        }
      }
    ]);

    return metrics[0] || {
      totalOrders: 0,
      totalRevenue: 0,
      avgOrderValue: 0,
      maxOrderValue: 0,
      minOrderValue: 0
    };
  }

  getDateFilter(timeRange) {
    const now = new Date();
    let startDate;

    switch (timeRange) {
      case 'today':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return { createdAt: { $gte: startDate } };
  }

  getPreviousPeriodFilter(timeRange) {
    const now = new Date();
    let startDate, endDate;

    switch (timeRange) {
      case 'today':
        endDate = new Date(now.setHours(0, 0, 0, 0));
        startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        endDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        endDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        endDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        endDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return { createdAt: { $gte: startDate, $lt: endDate } };
  }

  getGroupFormat(interval) {
    switch (interval) {
      case 'hour':
        return '%Y-%m-%d %H:00';
      case 'day':
        return '%Y-%m-%d';
      case 'week':
        return '%Y-%U';
      case 'month':
        return '%Y-%m';
      default:
        return '%Y-%m-%d';
    }
  }

  calculatePercentageChange(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  }

  async calculateConversionRate(timeRange) {
    return 2.4;
  }

  async calculateRefundRate(timeRange, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));
    const [totalOrders, refundedOrders] = await Promise.all([
      Order.countDocuments(dateFilter),
      Order.countDocuments({ ...dateFilter, orderStatus: 'refunded' })
    ]);

    if (totalOrders === 0) return 0;
    return (refundedOrders / totalOrders) * 100;
  }

  async calculateAvgFulfillmentTime(scope) {
    const fulfilledOrders = await Order.find(webFilter(scope, {
      orderStatus: 'completed',
      completedAt: { $exists: true }
    })).lean();

    if (fulfilledOrders.length === 0) return 0;

    const totalTime = fulfilledOrders.reduce((sum, order) => {
      const timeDiff = new Date(order.completedAt) - new Date(order.createdAt);
      return sum + timeDiff;
    }, 0);

    const avgTimeInMs = totalTime / fulfilledOrders.length;
    const avgTimeInDays = avgTimeInMs / (1000 * 60 * 60 * 24);

    return avgTimeInDays;
  }

  async getPeriodMetrics(dateFilter, scope) {
    const orderFilter = webFilter(scope, dateFilter);
    const [revenue, orders, customers] = await Promise.all([
      Order.aggregate([
        { $match: orderFilter },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]),
      Order.countDocuments(orderFilter),
      User.countDocuments(dateFilter)
    ]);

    return {
      revenue: revenue[0]?.total || 0,
      orders,
      customers
    };
  }

  async getTopCategories(timeRange, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));

    const categories = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $group: {
          _id: '$productInfo.category',
          sales: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    return categories.map(cat => ({
      category: cat._id || 'Uncategorized',
      sales: cat.sales,
      revenue: cat.revenue
    }));
  }

  async getGeographicDistribution(timeRange, scope) {
    const dateFilter = webFilter(scope, this.getDateFilter(timeRange));

    const distribution = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$shippingAddress.state',
          orders: { $sum: 1 },
          revenue: { $sum: '$total' }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 }
    ]);

    return distribution.map(item => ({
      region: item._id || 'Unknown',
      orders: item.orders,
      revenue: item.revenue
    }));
  }

  convertToCSV(data) {
    const csvRows = [];
    csvRows.push('Metric,Value');
    csvRows.push(`Total Sales,${data.stats.totalSales}`);
    csvRows.push(`Total Users,${data.stats.totalUsers}`);
    csvRows.push(`Total Products,${data.stats.totalProducts}`);
    csvRows.push(`Total Revenue,${data.stats.totalRevenue}`);
    return Buffer.from(csvRows.join('\n'));
  }

  convertToExcel(data) {
    return Buffer.from(JSON.stringify(data));
  }

  convertToPDF(data) {
    return Buffer.from(JSON.stringify(data));
  }
}

module.exports = new DashboardService();