// Batch-based costing / FIFO stock consumption (Stage 22).
//
// A StockBatch is created for every restock recorded through
// POST /supplier/purchase (both the real-supplier and self-purchased
// paths — see createBatch() below and its call site in main.js).
//
// consumeFIFO() is called once per order line inside the same
// transaction as POST /billing/orderDetails's stock decrement. It draws
// from the oldest available batch(es) first and returns exactly what it
// was able to cost — anything beyond available batch stock comes back
// as `unknownQuantity` rather than being silently priced at today's
// cost (Stage 22 exit criteria #7). This never blocks a sale: billing
// stays the proven, working core flow it already was, cost tracking is
// a pure overlay on top of it.
//
// restoreConsumption() is the inverse, used by admin edit/refund
// (applyLineReduction() in main.js) to give back exactly the batch units
// a reduced/removed order line had consumed, so a later sale can draw on
// them again and the dashboard's profit figure stays consistent with
// what's actually still sold (Stage 22 exit criteria #11). It restores
// "unknown" (unbatched) units first — there's no batch to credit them
// back to anyway — then works backward through the line's own
// batchConsumption list (most-recently-consumed batch first), so the
// oldest/earliest-batch portion of what's left survives a partial
// edit/refund with its cost basis intact.
const StockBatch = require('../models/StockBatch');
const { roundMoney } = require('./money');

async function createBatch({ productID, supplierID, purchaseID, quantity, unitCost, session }) {
  const created = await StockBatch.create(
    [
      {
        productID,
        supplierID: supplierID || null,
        purchaseID,
        quantityPurchased: quantity,
        quantityRemaining: quantity,
        unitCost,
        purchaseDate: new Date()
      }
    ],
    { session }
  );
  return created[0];
}

async function consumeFIFO(productID, quantity, session) {
  let remaining = quantity;
  const consumption = [];
  let costAmount = 0;
  let costQuantity = 0;

  const batches = await StockBatch.find({ productID, quantityRemaining: { $gt: 0 } })
    .sort({ purchaseDate: 1, _id: 1 })
    .session(session);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantityRemaining, remaining);
    if (take <= 0) continue;
    // Guarded atomic decrement, not read-then-write — same pattern as
    // the product stock decrement right next to this call.
    const updated = await StockBatch.findOneAndUpdate(
      { _id: batch._id, quantityRemaining: { $gte: take } },
      { $inc: { quantityRemaining: -take } },
      { session, new: true }
    );
    if (!updated) continue; // lost a race to another concurrent sale — that portion just becomes unknown-cost below, never oversold
    consumption.push({ batchId: batch._id, quantity: take, unitCost: batch.unitCost });
    costAmount += take * batch.unitCost;
    costQuantity += take;
    remaining -= take;
  }

  return {
    consumption,
    costAmount: roundMoney(costAmount),
    costQuantity,
    unknownQuantity: remaining
  };
}

// 'batch' — every unit's cost is known; 'unknown' — none is (legacy
// stock, or stock added via the Products form with no cost input);
// 'partial' — some of each, e.g. a sale that ran a batch dry mid-line.
function deriveCostSource(costQuantity, quantity) {
  if (quantity <= 0 || costQuantity <= 0) return 'unknown';
  if (costQuantity >= quantity) return 'batch';
  return 'partial';
}

async function restoreConsumption(batchConsumption, originalQuantity, restoreQty, session) {
  const entries = (batchConsumption || []).map((e) => (e.toObject ? e.toObject() : { ...e }));
  const knownQty = entries.reduce((sum, e) => sum + e.quantity, 0);
  const unknownQty = Math.max(0, originalQuantity - knownQty);

  let toRestore = restoreQty;
  const unknownQtyRestored = Math.min(unknownQty, toRestore);
  toRestore -= unknownQtyRestored;

  let costRestored = 0;
  let knownQtyRestored = 0;

  for (let i = entries.length - 1; i >= 0 && toRestore > 0; i--) {
    const entry = entries[i];
    const take = Math.min(entry.quantity, toRestore);
    if (take <= 0) continue;
    if (entry.batchId) {
      await StockBatch.updateOne({ _id: entry.batchId }, { $inc: { quantityRemaining: take } }, { session });
    }
    costRestored += take * entry.unitCost;
    knownQtyRestored += take;
    entry.quantity -= take;
    toRestore -= take;
  }

  const remainingConsumption = entries.filter((e) => e.quantity > 0);

  return {
    remainingConsumption,
    costRestored: roundMoney(costRestored),
    knownQtyRestored,
    unknownQtyRestored
  };
}

module.exports = { createBatch, consumeFIFO, deriveCostSource, restoreConsumption };
