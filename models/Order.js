const mongoose = require('mongoose');
const { Schema } = mongoose;

const orderSchema = new Schema({
  orderID: {
    type: String,
    required: true,
    match: /^#\d{4}$/,
    unique: true
  },
  customerName: { type: String, required: true },
  products: [
    {
      productID: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      amount: { type: Number, required: true, min: 0 },
      discount: { type: Number, required: true, min: 0, max: 100 }, // discountValue (%)
      discountType: { type: String, enum: ['none', 'preset', 'manual'], default: 'manual' },
      discountAmount: { type: Number, required: true, min: 0, default: 0 } // $ saved on this line
    }
  ],
  cashier: { type: String, required: true },
  totalAmount: { type: Number, required: true, min: 0 },
  // Payment tracking (Stage 5) — an order no longer has to be paid in
  // full at commit time; the difference becomes customer credit.
  amountPaid: { type: Number, required: true, min: 0, default: 0 },
  balanceDue: { type: Number, required: true, min: 0, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['paid', 'partial', 'unpaid'],
    required: true,
    default: 'unpaid'
  },
  payments: [
    {
      amount: { type: Number, required: true, min: 0 },
      date: { type: Date, default: Date.now },
      method: { type: String, enum: ['cash', 'card', 'other'], default: 'cash' }
    }
  ],
  orderDate: { type: Date, default: Date.now },
  // Stage 7: admin bill editing & refunds.
  status: { type: String, enum: ['active', 'refunded'], default: 'active', required: true },
  // Every reduce/remove edit appends one entry here — the order is never
  // silently mutated. One entry per line-item change (not per API call),
  // so a multi-item refund produces multiple entries.
  editHistory: [
    {
      editedBy: { type: String, required: true },
      editedAt: { type: Date, default: Date.now },
      productID: { type: String, required: true },
      originalQty: { type: Number, required: true, min: 0 },
      newQty: { type: Number, required: true, min: 0 },
      reason: { type: String, required: true },
      action: { type: String, enum: ['edit', 'refund'], required: true }
    }
  ]
});

module.exports = mongoose.model('Order', orderSchema);