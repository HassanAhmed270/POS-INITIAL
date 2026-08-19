// f:\Billing System js\models\Product.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const productSchema = new Schema({
  productID: { 
    type: String, 
    required: true, 
    match: /^#\d{4}$/, 
    unique: true 
  },
  category: { type: String, required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  // How many units are currently held in an open cart (added-to-bill but
  // not yet committed). "Available to sell" is always quantity - reserved.
  reserved: { type: Number, required: true, min: 0, default: 0 },
  // Below this many *available* units, the row gets highlighted low-stock
  // in Products and Billing (see CLAUDE.md Stage 3).
  lowStockThreshold: { type: Number, required: true, min: 0, default: 10 },
  // What we charge customers, over time — always read via
  // getLatestSellingPrice() (lib/pricing.js), never index [0].
  // Replaces the old, ambiguously-named `unitPrice` field (Stage 5).
  sellingPriceHistory: [
    {
      price: { type: Number, required: true },
      date: { type: Date, default: Date.now }
    }
  ],
  // What we paid suppliers, over time — populated only by recording a
  // supplier purchase (POST /supplier/purchase), never by the product
  // add/restock form. See CLAUDE.md Stage 5.
  buyingPriceHistory: [
    {
      price: { type: Number, required: true },
      date: { type: Date, default: Date.now },
      supplierID: { type: Schema.Types.ObjectId, ref: 'Supplier' }
    }
  ],
  buyingDate: { type: Date, default: Date.now },
  supplier: { type: String },
  hidden: { type: Boolean, default: false }
});

module.exports = mongoose.model('Product', productSchema);