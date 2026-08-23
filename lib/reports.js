// Single source of truth for "what does a sales/refund/credit/payable
// report look like" — built for Stage 9 (dashboard) and reused as-is by
// Stage 10 (CSV/Excel export) so the two surfaces can never drift apart.
// Nothing in here is export-specific; routes/export.js just calls these
// same functions and serializes the result differently.
const Order = require('../models/Order');
const Refund = require('../models/Refunds');
const Customer = require('../models/Customers');
const Supplier = require('../models/Supplier');
const { roundMoney } = require('./money');

// Same range resolution /dashboard/load has used since Stage 9: week =
// back to Sunday, month = start of calendar month (default), year = Jan 1.
function resolveRangeStart(range) {
  const startDate = new Date();
  if (range === 'week') {
    startDate.setDate(startDate.getDate() - startDate.getDay());
    startDate.setHours(0, 0, 0, 0);
  } else if (range === 'year') {
    startDate.setMonth(0, 1);
    startDate.setHours(0, 0, 0, 0);
  } else {
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);
  }
  return startDate;
}

// The exact aggregation /dashboard/load ran inline before Stage 10 —
// moved here unchanged so the dashboard and the export's "summary" sheet
// are guaranteed to report the same numbers for the same range.
async function getDashboardSummary(range = 'month') {
  const startDate = resolveRangeStart(range);

  const dashboardData = await Order.aggregate([
    { $match: { orderDate: { $gte: startDate } } },
    {
      $facet: {
        overallSales: [{ $group: { _id: null, total: { $sum: '$totalAmount' } } }],
        totalOrders: [{ $count: 'count' }],
        refundedOrders: [{ $match: { status: 'refunded' } }, { $count: 'count' }],
        exchangedOrders: [{ $match: { editHistory: { $elemMatch: { action: 'edit' } } } }, { $count: 'count' }],
        customerSales: [
          { $group: { _id: '$customerName', total: { $sum: '$totalAmount' } } },
          { $sort: { total: -1 } },
        ],
        productSales: [
          { $unwind: '$products' },
          {
            $group: {
              _id: '$products.productID',
              totalQuantity: { $sum: '$products.quantity' },
              totalRevenue: { $sum: '$products.amount' },
            },
          },
          { $sort: { totalQuantity: -1 } },
        ],
        totalCustomers: [{ $group: { _id: '$customerName' } }, { $count: 'count' }],
        totalProducts: [{ $unwind: '$products' }, { $group: { _id: null, total: { $sum: '$products.quantity' } } }],
        // Stage 22 — batch/FIFO profit. Reuses the exact same
        // post-edit/post-refund `products` arrays every other facet
        // here reads (a refunded line is already gone, an edited-down
        // line's `amount`/`costAmount` are already reduced — see
        // applyLineReduction in main.js), so profit can never
        // double-count a sale that's since been undone or shrunk.
        // Only the known-cost portion of each line (`costQuantity` of
        // `quantity`) contributes revenue+cost to this total; the rest
        // (legacy pre-Stage-22 sales, or stock added with no cost via
        // the Products form) is left out rather than priced at today's
        // cost — see lib/costing.js and CLAUDE.md Stage 22.
        totalProfit: [
          { $unwind: '$products' },
          {
            $project: {
              lineProfit: {
                $cond: [
                  { $gt: ['$products.quantity', 0] },
                  {
                    $subtract: [
                      {
                        $multiply: [
                          { $divide: ['$products.amount', '$products.quantity'] },
                          { $ifNull: ['$products.costQuantity', 0] },
                        ],
                      },
                      { $ifNull: ['$products.costAmount', 0] },
                    ],
                  },
                  0,
                ],
              },
              lineCost: { $ifNull: ['$products.costAmount', 0] },
              lineUnknownQty: { $subtract: ['$products.quantity', { $ifNull: ['$products.costQuantity', 0] }] },
            },
          },
          {
            $group: {
              _id: null,
              totalProfit: { $sum: '$lineProfit' },
              totalCost: { $sum: '$lineCost' },
              unknownCostUnits: { $sum: '$lineUnknownQty' },
            },
          },
        ],
      },
    },
  ]);

  const refundAgg = await Refund.aggregate([
    { $match: { refundDate: { $gte: startDate } } },
    { $group: { _id: null, total: { $sum: '$refundAmount' } } },
  ]);

  const creditAgg = await Customer.aggregate([
    { $unwind: { path: '$orders', preserveNullAndEmptyArrays: true } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$orders.balanceDue', 0] } } } },
  ]);
  const payableAgg = await Supplier.aggregate([
    { $unwind: { path: '$purchases', preserveNullAndEmptyArrays: true } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$purchases.balanceDue', 0] } } } },
  ]);

  const facets = dashboardData[0];
  const profitFacet = facets.totalProfit[0] || {};
  return {
    range,
    startDate,
    overallSales: roundMoney(facets.overallSales[0]?.total || 0),
    totalOrders: facets.totalOrders[0]?.count || 0,
    refundedOrders: facets.refundedOrders[0]?.count || 0,
    refundedAmount: roundMoney(refundAgg[0]?.total || 0),
    exchangedOrders: facets.exchangedOrders[0]?.count || 0,
    totalCustomerCreditOutstanding: roundMoney(creditAgg[0]?.total || 0),
    totalSupplierPayable: roundMoney(payableAgg[0]?.total || 0),
    customerSales: facets.customerSales || [],
    productSales: facets.productSales || [],
    totalCustomers: facets.totalCustomers[0]?.count || 0,
    totalProducts: facets.totalProducts[0]?.total || 0,
    // Stage 22 — see the totalProfit facet above for what feeds this.
    totalProfit: roundMoney(profitFacet.totalProfit || 0),
    totalCostOfGoodsSold: roundMoney(profitFacet.totalCost || 0),
    // Units sold in range with no batch cost behind them (legacy sales,
    // or stock added via the Products form) — not priced at today's
    // cost, just left out of totalProfit. Surfaced so that's visible
    // rather than silent; see CLAUDE.md Stage 22.
    unknownCostUnits: profitFacet.unknownCostUnits || 0,
  };
}

// Row-level detail behind the "sales" export — one row per order in range.
async function getSalesRows(range = 'month') {
  const startDate = resolveRangeStart(range);
  const orders = await Order.find(
    { orderDate: { $gte: startDate } },
    'orderID customerName cashier orderDate totalAmount amountPaid balanceDue paymentStatus status'
  ).sort({ orderDate: 1 });

  return orders.map((o) => ({
    orderID: o.orderID,
    customerName: o.customerName,
    cashier: o.cashier,
    orderDate: o.orderDate.toISOString(),
    totalAmount: roundMoney(o.totalAmount),
    amountPaid: roundMoney(o.amountPaid),
    balanceDue: roundMoney(o.balanceDue),
    paymentStatus: o.paymentStatus,
    status: o.status,
  }));
}

// Row-level detail behind the "refunds" export — one row per refund
// action in range (a refund covering 3 line items is still one row here,
// matching the Refund document itself; see progress.md Stage 7/9).
async function getRefundRows(range = 'month') {
  const startDate = resolveRangeStart(range);
  const refunds = await Refund.find({ refundDate: { $gte: startDate } }).sort({ refundDate: 1 });

  return refunds.map((r) => ({
    orderID: r.orderID,
    customerName: r.customerName,
    refundAmount: roundMoney(r.refundAmount),
    itemCount: r.refundedItems.length,
    reason: r.reason || '',
    refundDate: r.refundDate.toISOString(),
    processedBy: r.processedBy,
  }));
}

// Snapshot (as-of-now, not date-scoped — same convention the dashboard
// uses for credit/payable) — one row per customer order that still has a
// balance due.
async function getCustomerCreditRows() {
  const customers = await Customer.find({ 'orders.balanceDue': { $gt: 0 } }, 'customerName mobileNo orders');

  const rows = [];
  for (const c of customers) {
    for (const o of c.orders) {
      if ((o.balanceDue || 0) > 0) {
        rows.push({
          customerName: c.customerName,
          mobileNo: c.mobileNo || '',
          orderNo: o.orderNo,
          orderDate: o.orderDate ? o.orderDate.toISOString() : '',
          totalAmount: roundMoney(o.totalAmount),
          amountPaid: roundMoney(o.amountPaid),
          balanceDue: roundMoney(o.balanceDue),
        });
      }
    }
  }
  return rows;
}

// Snapshot mirror of getCustomerCreditRows for what the shop owes
// suppliers — one row per purchase still carrying a balance.
async function getSupplierPayableRows() {
  const suppliers = await Supplier.find({ 'purchases.balanceDue': { $gt: 0 } }, 'supplierName phone purchases');

  const rows = [];
  for (const s of suppliers) {
    for (const p of s.purchases) {
      if ((p.balanceDue || 0) > 0) {
        rows.push({
          supplierName: s.supplierName,
          phone: s.phone || '',
          purchaseID: p.purchaseID,
          date: p.date ? p.date.toISOString() : '',
          totalAmount: roundMoney(p.totalAmount),
          amountPaid: roundMoney(p.amountPaid),
          balanceDue: roundMoney(p.balanceDue),
        });
      }
    }
  }
  return rows;
}

module.exports = {
  resolveRangeStart,
  getDashboardSummary,
  getSalesRows,
  getRefundRows,
  getCustomerCreditRows,
  getSupplierPayableRows,
};
