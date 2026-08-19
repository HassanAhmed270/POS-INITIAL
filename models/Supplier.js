const mongoose = require('mongoose');
const { Schema } = mongoose;

// One line item within a purchase — what was bought, how much, at what
// per-unit cost. Mirrors Order.products in shape/spirit.
const purchaseItemSchema = new Schema(
  {
    productID: { type: String, required: true, match: /^#\d{4}$/ },
    quantity: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

// A single restock transaction from this supplier. Balance math mirrors
// Order's (Stage 5): totalAmount - amountPaid = balanceDue, i.e. what we
// still owe *them* rather than what a customer owes *us*.
const purchaseSchema = new Schema(
  {
    purchaseID: { type: String, required: true, match: /^PUR-\d{4}$/, unique: true },
    date: { type: Date, default: Date.now },
    totalAmount: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, required: true, min: 0, default: 0 },
    balanceDue: { type: Number, required: true, min: 0, default: 0 },
    items: [purchaseItemSchema]
  },
  { _id: false }
);

const supplierSchema = new Schema({
  supplierName: {
    type: String,
    required: true,
    unique: true,
    set: (value) => value.trim().replace(/\s+/g, ' ')
  },
  contactPerson: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  purchases: [purchaseSchema]
});

// Total we still owe this supplier across every purchase — queryable
// straight off the document (Stage 5 exit criteria), same pattern as
// Customer.totalBalanceDue.
supplierSchema.virtual('totalBalanceDue').get(function () {
  return this.purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0);
});

module.exports = mongoose.model('Supplier', supplierSchema);