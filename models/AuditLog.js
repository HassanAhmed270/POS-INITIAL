const mongoose = require('mongoose');
const { Schema } = mongoose;

// A single durable record of "what happened, when, and who did it" —
// Stage 14. Deliberately separate from Order.editHistory (per-order,
// Stage 7) and the Refund model: this is the one place that spans every
// tracked action across orders/products/customers/suppliers, for a
// single admin-visible timeline instead of hunting through several
// collections.
//
// This collection is a bounded ring buffer, not an unbounded log — see
// lib/auditLog.js for the eviction policy (oldest entries are dropped
// once AUDIT_LOG_MAX_ENTRIES is reached). Written to via logAudit() only;
// nothing should insert into this collection directly.
const auditLogSchema = new Schema({
  // e.g. 'order.created', 'order.edited', 'order.refunded',
  // 'product.created', 'product.updated', 'customer.updated',
  // 'supplier.created', 'supplier.updated'.
  action: { type: String, required: true },
  actor: {
    username: { type: String, required: true },
    role: { type: String, required: true },
  },
  // What kind of thing this action was about ('order' | 'product' |
  // 'customer' | 'supplier') and its business ID (orderID/productID/
  // customerName/supplierName) — not the Mongo _id, consistent with how
  // the rest of the app treats these as the real lookup key.
  targetType: { type: String, required: true },
  targetId: { type: String, required: true },
  // Snapshots, not diffs — simpler to reason about and to render, at the
  // cost of some redundancy. null on either side is normal: a create has
  // no `before`, nothing here currently produces a delete-only entry.
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  date: { type: Date, default: Date.now },
});

auditLogSchema.index({ date: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
