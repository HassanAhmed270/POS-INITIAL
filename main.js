require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');

const Product = require('./models/Product');
const Order = require('./models/Order');
const Customer = require('./models/Customers');
const PendingBill = require('./models/PendingBill');
const Supplier = require('./models/Supplier');
const Refund = require('./models/Refunds');
const AuditLog = require('./models/AuditLog');
const StockBatch = require('./models/StockBatch');

const logger = require('./lib/logger');
const authRoutes = require('./routes/auth');
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { asyncHandler, errorHandler } = require('./middleware/errorHandler');
const { AppError } = require('./lib/errors');
const { roundMoney } = require('./lib/money');
const { getLatestSellingPrice, getLatestBuyingPrice } = require('./lib/pricing');
const { createBatch, consumeFIFO, deriveCostSource, restoreConsumption } = require('./lib/costing');
const { escapeRegex, parsePagination, sortAndPaginate } = require('./lib/query');
const { getDashboardSummary } = require('./lib/reports');
const { logAudit } = require('./lib/auditLog');
const exportRoutes = require('./routes/export');
const syncRoutes = require('./routes/sync');
const {
  isValidEmail,
  isValidPhone,
  isValidProductId,
  isValidOrderId,
  isValidDiscount,
  isPositiveInt,
} = require('./lib/validators');

const app = express();
const port = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/billing_system';
// How long an untouched draft (no autosave, no commit) sits before its
// reserved stock is released and it's marked abandoned — see the sweep at
// the bottom of this file and CLAUDE.md Stage 4.
const DRAFT_IDLE_TIMEOUT_MS = parseInt(process.env.DRAFT_IDLE_TIMEOUT_MS) || 15 * 60 * 1000; // 15 min
const DRAFT_SWEEP_INTERVAL_MS = parseInt(process.env.DRAFT_SWEEP_INTERVAL_MS) || 60 * 1000; // 1 min
// How long after orderDate an admin can still edit an order's line items
// (Stage 7). Refunds are NOT subject to this window — only edits are.
const ORDER_EDIT_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
// Stage 19: the sentinel customerName for a walk-in/unknown-customer sale.
// Chosen to double as the human-readable label everywhere customerName is
// displayed (receipts, Orders list, audit log) — it's a real string stored
// on Order.customerName, not a code, so nothing downstream needs to know
// about it specially except the two spots below that skip the Customer
// collection for it.
const WALKIN_CUSTOMER = 'Walk-in / Unknown';
// Stage 20: the sentinel supplier value for stock the business bought
// itself, with no external supplier involved. Mirrors WALKIN_CUSTOMER's
// pattern — a plain string, defined identically here and in
// Products.jsx/Suppliers.jsx — but unlike WALKIN_CUSTOMER it never gets
// stored as-is: Product.supplierID and buyingPriceHistory[].supplierID
// both store `null` for it (see resolveSupplierId() below), since there
// is no Supplier document to reference and Stage 20 explicitly says one
// must not be invented just to complete a purchase.
const NO_SUPPLIER = 'NoSupplier';

// ── Core middleware ─────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/dashboard/load' } }));

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    logger.info('MongoDB connected');
    // Order commit (POST /billing/orderDetails) uses a multi-document
    // transaction (see CLAUDE.md Stage 3) — those only work against a
    // replica set (or mongos), never a plain standalone mongod. Warn loudly
    // at boot rather than let every checkout fail with a cryptic Mongo error.
    try {
      await mongoose.connection.db.admin().command({ replSetGetStatus: 1 });
    } catch (err) {
      logger.warn(
        { err: err.message },
        'MongoDB does not appear to be running as a replica set — order checkout (transactions) will fail. ' +
          'For local dev: run mongod with --replSet rs0, then run rs.initiate() once in mongosh.'
      );
    }
  })
  .catch((err) => logger.error({ err: err.message }, 'MongoDB connection failed'));

// Defaults to 10 (matches the Product schema default) for missing/invalid input.
function parseThreshold(value) {
  if (value === undefined || value === null || value === '') return 10;
  const n = parseInt(value);
  return Number.isInteger(n) && n >= 0 ? n : 10;
}

// Stage 20: resolves whatever the Product/restock forms submit for
// "supplier" into either a real Supplier _id or null (self-purchased /
// NoSupplier). Rejects anything that isn't a valid, *existing* Supplier
// id — per Stage 20's exit criteria, an arbitrary/stale id must 400, not
// be silently accepted or silently coerced to null.
async function resolveSupplierId(rawSupplierId) {
  if (!rawSupplierId || rawSupplierId === NO_SUPPLIER) return { ok: true, value: null };
  if (!mongoose.Types.ObjectId.isValid(rawSupplierId)) return { ok: false };
  const exists = await Supplier.exists({ _id: rawSupplierId });
  return exists ? { ok: true, value: rawSupplierId } : { ok: false };
}

// ── Auth ─────────────────────────────────────────────────────
// POST /auth/login issues the JWT; see routes/auth.js and
// scripts/createUser.js (there is no public signup route).
app.use('/auth', authRoutes);

// Stage 10 — CSV export module. Toggleable via ENABLE_EXPORTS; set to
// "false" in .env to disable/remove the feature without touching
// anything else here. See routes/export.js and lib/reports.js.
if (process.env.ENABLE_EXPORTS !== 'false') {
  app.use('/api/export', exportRoutes);
} else {
  logger.info('Export module disabled (ENABLE_EXPORTS=false)');
}

// Stage 11 — Offline Sync module. Optional, off by default (unlike
// exports, which default on) — set ENABLE_OFFLINE_SYNC=true in .env to
// turn it on. See routes/sync.js and lib/offlineSync.js.
if (process.env.ENABLE_OFFLINE_SYNC === 'true') {
  app.use('/api/sync', syncRoutes);
} else {
  logger.info('Offline sync module disabled (set ENABLE_OFFLINE_SYNC=true to enable)');
}

// ── JSON read API for the React frontend (Stage 12: auth-gated — was
// public through Stage 11/EJS-removal, closed off since it exposed sales
// totals, customer credit exposure and the full product/customer list to
// anyone with the URL, no login needed) ──
// Stage 9's aggregation now lives in lib/reports.js (getDashboardSummary)
// so Stage 10's export module can reuse the exact same queries — this
// route is just a thin JSON wrapper around it.
app.get('/dashboard/load', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { range = 'month' } = req.query;
  const result = await getDashboardSummary(range);
  res.json({ success: true, dashboard: result });
}));

app.get('/api/products', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'productID', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
        $or: [
          { productID: { $regex: escapeRegex(search), $options: 'i' } },
          { productName: { $regex: escapeRegex(search), $options: 'i' } },
          { category: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};

  const data = await Product.find(
    filter,
    'productID productName category sellingPriceHistory buyingPriceHistory quantity reserved lowStockThreshold supplierID'
  ).populate('supplierID', 'supplierName');
  const mapped = data.map((p) => {
    const available = p.quantity - p.reserved;
    return {
      _id: p._id,
      productID: p.productID,
      productName: p.productName,
      category: p.category,
      quantity: p.quantity,
      reserved: p.reserved,
      available,
      lowStockThreshold: p.lowStockThreshold,
      lowStock: available <= p.lowStockThreshold,
      // Stage 20: p.supplierID is populated to {_id, supplierName} when
      // set, or null for self-purchased/no-supplier products — surfaced
      // as two plain fields so the frontend combobox doesn't need to know
      // about Mongoose population shapes.
      supplierId: p.supplierID?._id || null,
      supplierName: p.supplierID?.supplierName || null,
      sellingPriceHistory: p.sellingPriceHistory,
      price: roundMoney(getLatestSellingPrice(p)),
      costPrice: roundMoney(getLatestBuyingPrice(p)),
    };
  });

  const { data: products, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, products, total, page, limit });
}));

// Stage 15 — Low-Stock Notifications. Admin-only: returns every product
// currently at-or-below its lowStockThreshold, unpaginated (this feeds a
// header bell/badge, not a browsable list — Products.jsx already has the
// paginated view with the same per-row highlighting). Sorted so the most
// depleted stock (lowest available) surfaces first.
app.get('/api/products/low-stock', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const data = await Product.find(
    {},
    'productID productName category quantity reserved lowStockThreshold'
  );
  const products = data
    .map((p) => ({
      productID: p.productID,
      productName: p.productName,
      category: p.category,
      quantity: p.quantity,
      reserved: p.reserved,
      available: p.quantity - p.reserved,
      lowStockThreshold: p.lowStockThreshold,
    }))
    .filter((p) => p.available <= p.lowStockThreshold)
    .sort((a, b) => a.available - b.available || a.productID.localeCompare(b.productID));

  res.json({ success: true, count: products.length, products });
}));

app.get('/api/customers', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'customerName', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
        $or: [
          { customerName: { $regex: escapeRegex(search), $options: 'i' } },
          { mobileNo: { $regex: escapeRegex(search), $options: 'i' } },
          { email: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};

  const data = await Customer.find(filter, 'customerName mobileNo emergencyMobile email address orders');
  const mapped = data.map((c) => ({
    _id: c._id,
    customerName: c.customerName,
    mobileNo: c.mobileNo,
    emergencyMobile: c.emergencyMobile,
    email: c.email,
    address: c.address,
    orders: c.orders,
    totalBalanceDue: roundMoney(c.orders.reduce((sum, o) => sum + (o.balanceDue || 0), 0)),
  }));

  const { data: customers, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, customers, total, page, limit });
}));

// ── Mutating routes — all require a valid JWT ───────────────
// (requireAdmin is available in middleware/auth.js for role-gating
// specific actions like edits/refunds in a later stage.)

app.post('/api/product', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productId, productName, category, price, stock, supplierId, already, lowStockThreshold } = req.body;

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Product ID must look like #0001.' });
  }
  if (!productName || !productName.trim()) {
    return res.status(400).json({ success: false, message: 'Product name is required.' });
  }
  const resolvedSupplier = await resolveSupplierId(supplierId);
  if (!resolvedSupplier.ok) {
    return res.status(400).json({ success: false, message: 'Invalid supplier selected.' });
  }

  const submittedPrice = roundMoney(price);
  const threshold = parseThreshold(lowStockThreshold);
  const existingProduct = await Product.findOne({ productID: productId });
  // Stage 14: snapshot before any mutation, for the audit entry below.
  const beforeSnapshot = existingProduct ? existingProduct.toObject() : null;

  if (existingProduct) {
    const updatedStock =
      (isNaN(parseInt(stock)) ? 0 : parseInt(stock)) + (isNaN(parseInt(already)) ? 0 : parseInt(already));
    existingProduct.quantity = updatedStock;
    existingProduct.productName = productName;
    existingProduct.category = category;
    existingProduct.supplierID = resolvedSupplier.value;
    if (lowStockThreshold !== undefined) existingProduct.lowStockThreshold = threshold;

    // Only record a new price-history entry if the price actually moved —
    // this is what makes getLatestSellingPrice() meaningful instead of the
    // array just growing with the same number forever.
    const latestPrice = roundMoney(getLatestSellingPrice(existingProduct));
    if (submittedPrice > 0 && submittedPrice !== latestPrice) {
      existingProduct.sellingPriceHistory.push({ price: submittedPrice, date: new Date() });
    }
    await existingProduct.save();
    await logAudit({
      action: 'product.updated',
      actor: { username: req.user.username, role: req.user.role },
      targetType: 'product',
      targetId: productId,
      before: beforeSnapshot,
      after: existingProduct.toObject(),
    });
  } else {
    const newProduct = new Product({
      productID: productId,
      productName,
      category,
      sellingPriceHistory: [{ price: submittedPrice }],
      quantity: isNaN(parseInt(stock)) ? 0 : parseInt(stock),
      reserved: 0,
      lowStockThreshold: threshold,
      supplierID: resolvedSupplier.value,
    });
    await newProduct.save();
    await logAudit({
      action: 'product.created',
      actor: { username: req.user.username, role: req.user.role },
      targetType: 'product',
      targetId: productId,
      before: null,
      after: newProduct.toObject(),
    });
  }

  res.status(200).json({ success: true, message: 'Product saved successfully' });
}));

app.delete('/product/:productID', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID } = req.params;
  const deleted = await Product.findOneAndDelete({ productID });

  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  await logAudit({
    action: 'product.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'product',
    targetId: productID,
    before: deleted.toObject(),
    after: null,
  });

  return res.status(200).json({ success: true, message: 'Product deleted successfully' });
}));

app.post('/product/undo', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productId, productName, category, price, stock, supplierId, lowStockThreshold } = req.body;
  const threshold = parseThreshold(lowStockThreshold);
  const resolvedSupplier = await resolveSupplierId(supplierId);
  if (!resolvedSupplier.ok) {
    return res.status(400).json({ success: false, message: 'Invalid supplier selected.' });
  }

  const existingProduct = await Product.findOne({ productID: productId });
  const beforeSnapshot = existingProduct ? existingProduct.toObject() : null;
  let restoredProduct;
  if (existingProduct) {
    existingProduct.productName = productName;
    existingProduct.category = category;
    existingProduct.sellingPriceHistory = [{ price: roundMoney(price) }];
    existingProduct.quantity = isNaN(parseInt(stock)) ? 0 : parseInt(stock);
    existingProduct.reserved = 0; // a restored product starts with nothing held in any open cart
    existingProduct.lowStockThreshold = threshold;
    existingProduct.supplierID = resolvedSupplier.value;
    await existingProduct.save();
    restoredProduct = existingProduct;
  } else {
    const newProduct = new Product({
      productID: productId,
      productName,
      category,
      sellingPriceHistory: [{ price: roundMoney(price) }],
      quantity: isNaN(parseInt(stock)) ? 0 : parseInt(stock),
      reserved: 0,
      lowStockThreshold: threshold,
      supplierID: resolvedSupplier.value,
    });
    await newProduct.save();
    restoredProduct = newProduct;
  }

  await logAudit({
    action: 'product.restored',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'product',
    targetId: productId,
    before: beforeSnapshot,
    after: restoredProduct.toObject(),
  });

  res.status(201).json({ ok: true, message: 'Product restored successfully!' });
}));

app.post('/customer/updateCustomer', requireAuth, asyncHandler(async (req, res) => {
  let { customerName, mobileNo, emergencyMobile, email, address } = req.body;

  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }

  customerName = customerName.trim().replace(/\s+/g, ' ');
  mobileNo = mobileNo ? mobileNo.trim() : '';
  emergencyMobile = emergencyMobile ? emergencyMobile.trim() : '';
  email = email ? email.trim() : '';
  address = address ? address.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'That email address doesn\'t look right.' });
  }
  if (!isValidPhone(mobileNo) || !isValidPhone(emergencyMobile)) {
    return res.status(400).json({ success: false, message: 'That phone number doesn\'t look right.' });
  }

  const beforeCustomer = await Customer.findOne({ customerName });
  const updatedCustomer = await Customer.findOneAndUpdate(
    { customerName },
    { $set: { mobileNo, emergencyMobile, email, address } },
    { new: true }
  );

  if (!updatedCustomer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  await logAudit({
    action: 'customer.updated',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'customer',
    targetId: customerName,
    before: beforeCustomer ? beforeCustomer.toObject() : null,
    after: updatedCustomer.toObject(),
  });

  res.status(200).json({ success: true, message: 'Customer updated successfully', customer: updatedCustomer });
}));

app.post('/customer/deleteCustomer', requireAuth, asyncHandler(async (req, res) => {
  const { customerName } = req.body;
  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }

  const deletedCustomer = await Customer.findOneAndDelete({
    customerName: { $regex: new RegExp(`^${customerName.trim()}$`, 'i') },
  });
  if (!deletedCustomer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  await logAudit({
    action: 'customer.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'customer',
    targetId: deletedCustomer.customerName,
    before: deletedCustomer.toObject(),
    after: null,
  });

  res.status(200).json({ success: true, message: 'Customer deleted successfully', customer: deletedCustomer });
}));

app.post('/customer/undoCustomer', requireAuth, asyncHandler(async (req, res) => {
  const { customerName, mobileNo, emergencyMobile, email, address } = req.body;

  const existing = await Customer.findOne({ customerName });
  if (existing) {
    return res.status(400).json({ success: false, message: 'Customer already exists.' });
  }

  const newCustomer = new Customer({ customerName, mobileNo, emergencyMobile, email, address });
  await newCustomer.save();

  await logAudit({
    action: 'customer.restored',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'customer',
    targetId: customerName,
    before: null,
    after: newCustomer.toObject(),
  });

  res.status(200).json({ success: true, message: 'Customer restored successfully' });
}));

// ── Cart stock holds (Stage 3) ──────────────────────────────
// "Available to sell" is always quantity - reserved. Both routes below use
// a single atomic findOneAndUpdate with the guard baked into the *query*
// filter (not a separate read-then-write) so two cashiers adding the same
// last unit at the same instant can't both succeed — the second one's
// filter simply won't match, and Mongo guarantees that at the document
// level regardless of request timing.

app.post('/billing/reserve', requireAuth, asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity);

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Invalid quantity.' });
  }

  const updated = await Product.findOneAndUpdate(
    {
      productID: productId,
      // quantity - reserved >= qty, evaluated atomically as part of the match
      $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, qty] },
    },
    { $inc: { reserved: qty } },
    { new: true }
  );

  if (!updated) {
    // Either the product doesn't exist, or there isn't enough available —
    // tell them apart only for a clearer message, no behavior difference.
    const exists = await Product.exists({ productID: productId });
    return res.status(409).json({
      success: false,
      message: exists ? 'Not enough stock available.' : 'Product not found.',
    });
  }

  res.status(200).json({
    success: true,
    quantity: updated.quantity,
    reserved: updated.reserved,
    available: updated.quantity - updated.reserved,
  });
}));

app.post('/billing/release', requireAuth, asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity);

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Invalid quantity.' });
  }

  // Guard reserved >= qty so this can never push reserved negative — if a
  // release comes in "late" (e.g. duplicate call, or the reservation was
  // already consumed by a completed checkout), it's a safe no-op rather
  // than corrupting the count.
  const updated = await Product.findOneAndUpdate(
    { productID: productId, reserved: { $gte: qty } },
    { $inc: { reserved: -qty } },
    { new: true }
  );

  if (!updated) {
    return res.status(200).json({ success: true, message: 'Nothing to release.', released: false });
  }

  res.status(200).json({
    success: true,
    released: true,
    quantity: updated.quantity,
    reserved: updated.reserved,
    available: updated.quantity - updated.reserved,
  });
}));

// Manual stock correction (admin only) — e.g. a damaged-goods write-off or
// a physical stocktake adjustment. NOT part of the checkout flow anymore:
// checkout commits stock atomically inside POST /billing/orderDetails's
// transaction. Setting quantity directly here also implicitly changes
// availability (quantity - reserved), so this is intentionally gated
// tighter than the rest of the mutating routes.
app.post('/billing/update', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productId, stock } = req.body;

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const existingProduct = await Product.findOne({ productID: productId });
  if (existingProduct) {
    existingProduct.quantity = isNaN(parseInt(stock)) ? 0 : parseInt(stock);
    await existingProduct.save();
  }

  res.status(201).json({ ok: true, message: 'Stock updated successfully!' });
}));

// ── Draft bills (Stage 4) ───────────────────────────────────
// One in-progress cart per cashier, autosaved from the frontend and
// resumable after a refresh/crash. Commit (below) reads from here, not
// from whatever the client happens to POST — see CLAUDE.md Stage 4.

app.get('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  res.json({ success: true, draft: draft && draft.items.length > 0 ? draft : null });
}));

app.post('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const { billID, customerName, items, paidInput, paymentMethod } = req.body;

  if (billID && !isValidOrderId(billID)) {
    return res.status(400).json({ success: false, message: 'Invalid bill ID.' });
  }

  const cleanPaidInput = Number.isFinite(Number(paidInput)) && Number(paidInput) >= 0 ? roundMoney(paidInput) : 0;
  const cleanMethod = ['cash', 'card', 'other'].includes(paymentMethod) ? paymentMethod : 'cash';

  // Quietly drop malformed lines rather than rejecting the whole autosave —
  // this runs silently every few seconds, so a hard 400 here would be
  // disruptive for something the cashier didn't directly trigger.
  const cleanItems = Array.isArray(items)
    ? items
        .filter(
          (it) =>
            isValidProductId(it.productID) &&
            typeof it.productName === 'string' &&
            it.productName.trim() &&
            Number.isFinite(Number(it.unitPrice)) &&
            Number(it.unitPrice) >= 0 &&
            Number.isInteger(it.quantity) &&
            it.quantity >= 1 &&
            isValidDiscount(it.discount)
        )
        .map((it) => ({
          productID: it.productID,
          productName: it.productName,
          unitPrice: roundMoney(it.unitPrice),
          quantity: it.quantity,
          discount: roundMoney(it.discount),
          discountType: ['none','preset','manual'].includes(it.discountType) ? it.discountType : 'manual'
        }))
    : [];

  const draft = await PendingBill.findOneAndUpdate(
    { cashier: req.user.username },
    {
      cashier: req.user.username,
      billID: billID || null,
      customerName: customerName || '',
      items: cleanItems,
      paidInput: cleanPaidInput,
      paymentMethod: cleanMethod,
      status: 'active',
      updatedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(200).json({ success: true, draft });
}));

app.delete('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  if (!draft) {
    return res.status(200).json({ success: true, message: 'No active draft to discard.' });
  }

  // Release every reservation this draft was holding — same atomic,
  // guarded decrement as POST /billing/release (Stage 3).
  await Promise.all(
    draft.items.map((it) =>
      Product.findOneAndUpdate({ productID: it.productID, reserved: { $gte: it.quantity } }, { $inc: { reserved: -it.quantity } })
    )
  );

  draft.status = 'abandoned';
  draft.items = [];
  draft.updatedAt = new Date();
  await draft.save();

  res.status(200).json({ success: true, message: 'Draft discarded and stock released.' });
}));

app.post('/billing/orderDetails', requireAuth, asyncHandler(async (req, res) => {
  // The draft (autosaved by the frontend as the cart is built — see
  // POST /billing/draft) is the source of truth for what's being
  // committed, not whatever happens to be in this request body. This
  // closes the same class of tampering Stage 2 addressed for price, but
  // for the whole order shape.
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  if (!draft || draft.items.length === 0) {
    return res.status(400).json({ success: false, message: 'No active bill to commit. Add items to a bill first.' });
  }
  if (!isValidOrderId(draft.billID)) {
    return res.status(400).json({ success: false, message: 'This bill has no order ID yet — go to Preview first.' });
  }
  if (!draft.customerName || draft.customerName === 'unknown') {
    return res.status(400).json({ success: false, message: 'Invalid customer selected.' });
  }

  // Stage 19: a walk-in sale intentionally has no backing Customer record
  // — it's recorded against the sentinel name only, so there's nothing to
  // look up or require here.
  const isWalkIn = draft.customerName === WALKIN_CUSTOMER;
  const customer = isWalkIn ? null : await Customer.findOne({ customerName: draft.customerName });
  if (!isWalkIn && !customer) {
    return res.status(400).json({ success: false, message: `Customer "${draft.customerName}" not found.` });
  }

  // Everything from here down either all happens or none of it does: the
  // order document, the stock+reservation decrement on every product line,
  // the customer's order-history push, and marking the draft committed. A
  // crash or thrown error at any point rolls the whole thing back — there's
  // no window where an order exists but stock wasn't deducted (or the
  // draft wasn't cleared), or vice versa. On a *thrown* error specifically
  // (bad price, lost stock), the draft rollback means it's left exactly as
  // it was — still active, with its items intact — so the cashier can fix
  // whatever's wrong and retry without losing their cart.
  const session = await mongoose.startSession();
  let order;

  try {
    await session.withTransaction(async () => {
      // Re-derive every line's price from the DB's current value instead
      // of trusting the draft's captured unitPrice outright — that price
      // was accurate *when the item was added*, but may have moved since
      // (see CLAUDE.md Stage 2). Comparing against the draft (what the
      // cashier actually saw on screen) rather than an ad hoc request body
      // gives the same protection with a steadier reference point.
      const verifiedProducts = [];
      for (const item of draft.items) {
        const product = await Product.findOne({ productID: item.productID }).session(session);
        if (!product) {
          throw new AppError(400, `Product ${item.productID} no longer exists.`);
        }

        const currentPrice = getLatestSellingPrice(product);
        const expectedAmount = roundMoney(currentPrice * item.quantity * (1 - item.discount / 100));
        const draftAmount = roundMoney(item.unitPrice * item.quantity * (1 - item.discount / 100));

        // Small epsilon for floating-point noise, not for a genuinely different price.
        if (Math.abs(expectedAmount - draftAmount) > 0.01) {
          logger.warn(
            { productID: item.productID, expectedAmount, draftAmount, user: req.user.username },
            'Rejected order: current product price no longer matches the draft'
          );
          throw new AppError(409, `The price for ${item.productID} has changed since you added it. Please review your bill and try again.`);
        }

        verifiedProducts.push({
          productID: item.productID,
          quantity: item.quantity,
          amount: expectedAmount,
          discount: roundMoney(item.discount),
          discountType: item.discountType || 'manual',
          discountAmount: roundMoney(currentPrice * item.quantity - expectedAmount)
        });
      }

      // Commit stock: decrement quantity and release the matching
      // reservation together, atomically, guarded in the query filter
      // (not read-then-write) so this can never go negative even under
      // concurrent checkouts. If the guard fails, the reservation this
      // cart held was somehow lost (shouldn't happen in normal use —
      // see CLAUDE.md Stage 3 "still open" for the one known gap) and we
      // abort the whole transaction rather than partially commit.
      for (const p of verifiedProducts) {
        const updated = await Product.findOneAndUpdate(
          { productID: p.productID, quantity: { $gte: p.quantity }, reserved: { $gte: p.quantity } },
          { $inc: { quantity: -p.quantity, reserved: -p.quantity } },
          { session, new: true }
        );
        if (!updated) {
          throw new AppError(409, `Stock for ${p.productID} could not be confirmed. Please refresh and try again.`);
        }

        // Stage 22: record which cost batch(es) this line's units
        // actually came from (FIFO — oldest batch first), so the
        // dashboard's profit figure and this line's own historical cost
        // are both fixed at commit time. This never blocks the sale —
        // any quantity beyond what a batch can cover is recorded as
        // unknown-cost, not priced at today's cost (see lib/costing.js).
        const fifo = await consumeFIFO(p.productID, p.quantity, session);
        p.costAmount = fifo.costAmount;
        p.costQuantity = fifo.costQuantity;
        p.costSource = deriveCostSource(fifo.costQuantity, p.quantity);
        p.batchConsumption = fifo.consumption;
      }

      const verifiedTotal = roundMoney(verifiedProducts.reduce((sum, p) => sum + p.amount, 0));

      // Payment (Stage 5): a bill no longer has to be paid in full to
      // commit — whatever's short becomes the customer's balanceDue.
      // Capped at the total: anything paid beyond that is change handed
      // back to the customer, not credit applied to the order. This is
      // `draft.paidInput`, not a request param, for the same
      // tamper-resistance reason as everything else committed from the
      // draft (Stage 4).
      const amountPaid = roundMoney(Math.min(Math.max(draft.paidInput || 0, 0), verifiedTotal));
      const balanceDue = roundMoney(Math.max(0, verifiedTotal - amountPaid));
      const paymentStatus = amountPaid <= 0 ? 'unpaid' : balanceDue > 0 ? 'partial' : 'paid';
      const payments = amountPaid > 0 ? [{ amount: amountPaid, date: new Date(), method: draft.paymentMethod || 'cash' }] : [];

      const created = await Order.create(
        [
          {
            orderID: draft.billID,
            customerName: draft.customerName,
            totalAmount: verifiedTotal,
            products: verifiedProducts,
            cashier: req.user.username,
            amountPaid,
            balanceDue,
            paymentStatus,
            payments,
          },
        ],
        { session }
      );
      order = created[0];

      // Stage 19: walk-in sales don't get a customer order-history push —
      // there's no Customer document to push it onto, and creating one
      // just for this would defeat the point (no unnecessary customer/
      // credit record for an untracked sale).
      if (!isWalkIn) {
        await Customer.updateOne(
          { customerName: draft.customerName },
          {
            $push: {
              orders: {
                orderNo: draft.billID,
                orderDate: new Date(),
                totalAmount: verifiedTotal,
                amountPaid,
                balanceDue,
              },
            },
          },
          { session }
        );
      }

      // Consume the draft: mark it committed and clear its items so the
      // next bill this cashier starts (same document, upserted by
      // cashier) begins from a clean slate.
      await PendingBill.updateOne(
        { _id: draft._id },
        { status: 'committed', items: [], paidInput: 0, updatedAt: new Date() },
        { session }
      );

      await logAudit(
        {
          action: 'order.created',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: null,
          after: order.toObject(),
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  return res.status(200).json({
    success: true,
    message: 'Order saved and added to customer successfully.',
    order,
    customer,
  });
}));

// Read-only lookup, not a mutation — stays public like the other GET/list endpoints.
app.post('/billing/orderid', asyncHandler(async (req, res) => {
  const { billId } = req.body;
  const existingID = await Order.findOne({ orderID: billId });

  if (existingID) {
    res.status(200).json({ exists: true, orderId: existingID.orderID });
  } else {
    res.status(200).json({ exists: false, orderId: billId });
  }
}));

app.post('/billing/addCustomer', requireAuth, asyncHandler(async (req, res) => {
  let { customerName, mobileNo, emergencyMobile, email, address } = req.body;

  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }

  customerName = customerName.trim().replace(/\s+/g, ' ');
  mobileNo = mobileNo ? mobileNo.trim() : '';
  emergencyMobile = emergencyMobile ? emergencyMobile.trim() : '';
  email = email ? email.trim() : '';
  address = address ? address.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'That email address doesn\'t look right.' });
  }
  if (!isValidPhone(mobileNo) || !isValidPhone(emergencyMobile)) {
    return res.status(400).json({ success: false, message: 'That phone number doesn\'t look right.' });
  }

  const existingCustomer = await Customer.findOne({ customerName });
  if (existingCustomer) {
    return res.status(400).json({ success: false, message: 'Customer already exists' });
  }

  const newCustomer = new Customer({ customerName, mobileNo, emergencyMobile, email, address, orders: [] });
  await newCustomer.save();

  res.status(201).json({ success: true, message: 'Customer added successfully', customer: newCustomer });
}));

// ── Suppliers & purchases (Stage 5) ─────────────────────────
// Mirrors the Customer/Order relationship, but for the other side of the
// ledger: what we owe suppliers instead of what customers owe us.

app.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'supplierName', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
        $or: [
          { supplierName: { $regex: escapeRegex(search), $options: 'i' } },
          { contactPerson: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};

  const suppliers = await Supplier.find(filter);
  const mapped = suppliers.map((s) => ({
    _id: s._id,
    supplierName: s.supplierName,
    contactPerson: s.contactPerson,
    phone: s.phone,
    email: s.email,
    address: s.address,
    purchases: s.purchases,
    purchaseCount: s.purchases.length,
    totalBalanceDue: roundMoney(s.purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0)),
    // Stage 21 credit fix: what this supplier currently owes *us* from a
    // past overpayment, automatically applied to reduce what's owed on
    // their next purchase — see POST /supplier/purchase. Independent of
    // totalBalanceDue above (that's what we owe them; this is the
    // reverse), so a supplier can show both a balance due *and* a credit
    // at the same time if purchases happened in that order.
    creditBalance: roundMoney(s.creditBalance || 0),
  }));

  const { data: withBalance, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, suppliers: withBalance, total, page, limit });
}));

app.post('/api/supplier', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  let { supplierName, contactPerson, phone, email, address } = req.body;

  if (!supplierName || !supplierName.trim()) {
    return res.status(400).json({ success: false, message: 'Supplier name is required.' });
  }
  supplierName = supplierName.trim().replace(/\s+/g, ' ');
  phone = phone ? phone.trim() : '';
  email = email ? email.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'That email address doesn\'t look right.' });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ success: false, message: 'That phone number doesn\'t look right.' });
  }

  const beforeSupplier = await Supplier.findOne({ supplierName });
  const supplier = await Supplier.findOneAndUpdate(
    { supplierName },
    { supplierName, contactPerson: contactPerson || '', phone, email, address: address || '' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await logAudit({
    action: beforeSupplier ? 'supplier.updated' : 'supplier.created',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'supplier',
    targetId: supplierName,
    before: beforeSupplier ? beforeSupplier.toObject() : null,
    after: supplier.toObject(),
  });

  res.status(200).json({ success: true, message: 'Supplier saved successfully', supplier });
}));

app.delete('/supplier/:supplierName', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const deleted = await Supplier.findOneAndDelete({ supplierName: req.params.supplierName });
  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Supplier not found.' });
  }
  // NOTE: unlike products/customers, there's no undo for this (Stage 5
  // scope) — a supplier's own purchase history goes with it. Deleting a
  // supplier does not touch Product.buyingPriceHistory entries that
  // reference it; those stay as a historical record.
  await logAudit({
    action: 'supplier.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'supplier',
    targetId: deleted.supplierName,
    before: deleted.toObject(),
    after: null,
  });
  res.status(200).json({ success: true, message: 'Supplier deleted successfully' });
}));

async function generateUniquePurchaseId() {
  for (let i = 0; i < 20; i++) {
    const candidate = 'PUR-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const exists = await Supplier.exists({ 'purchases.purchaseID': candidate });
    if (!exists) return candidate;
  }
  throw new AppError(500, 'Could not generate a unique purchase ID. Please try again.');
}

// Records a restock: creates the purchase record (with its own payment/
// balance tracking, mirroring Order), increments stock, and appends to
// each product's buyingPriceHistory — all atomically, same transaction
// pattern as POST /billing/orderDetails (Stage 3/4), since this touches
// money and stock together just like a sale does.
//
// Stage 20: `supplierName === NO_SUPPLIER` is the self-purchased/
// "Buy Myself" path — same sentinel-string pattern as WALKIN_CUSTOMER.
// It skips the Supplier lookup and the $push into a Supplier document
// entirely (there's no supplier to owe money to, and Stage 20 explicitly
// says not to invent a fake Supplier record just to complete a
// purchase); stock and buyingPriceHistory still update exactly the same
// as a real-supplier purchase, just with supplierID: null. Because there's
// no Supplier.purchases entry, a self-purchase won't show up in any
// supplier's purchase-history table — it's not attached to one, by design.
//
// Stage 21: each item may *optionally* carry a `sellingPrice` alongside
// its (required) `unitCost` — restocking is now allowed to update what
// customers are charged, not just what the business paid. This is the
// exact same "only record a history entry if the price actually moved"
// rule POST /api/product already uses for sellingPriceHistory (see
// below), so a restock that doesn't touch selling price is a no-op on
// that array, and a restock that does is immediately what Billing/
// Products/receipts see — same array, same getLatestSellingPrice()
// reader, no separate "restock price" concept. buyingPriceHistory is
// updated the same as before regardless; the two histories never touch
// each other.
// Stage 21 credit fix: overpaying a purchase used to just get silently
// capped at the total (`Math.min(paid, totalAmount)`), so the extra
// money vanished from every record instead of being tracked anywhere.
// Now: amountPaid is no longer capped, and if it exceeds what's owed
// (after any existing credit is applied — see below), the excess becomes
// supplier credit (Supplier.creditBalance) that automatically reduces
// what's owed on the *next* purchase from the same supplier. A single
// purchase's own balanceDue still never goes negative — the credit lives
// on the supplier document, not as a negative number on one purchase.
app.post('/supplier/purchase', requireAuth, asyncHandler(async (req, res) => {
  const { supplierName, items, amountPaid } = req.body;
  const isSelfPurchase = supplierName === NO_SUPPLIER;

  if (!supplierName || !supplierName.trim()) {
    return res.status(400).json({ success: false, message: 'Supplier is required.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items in this purchase.' });
  }
  for (const item of items) {
    if (!isValidProductId(item.productID)) {
      return res.status(400).json({ success: false, message: `"${item.productID}" is not a valid product ID.` });
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ success: false, message: `Invalid quantity for ${item.productID}.` });
    }
    if (!Number.isFinite(Number(item.unitCost)) || Number(item.unitCost) < 0) {
      return res.status(400).json({ success: false, message: `Invalid unit cost for ${item.productID}.` });
    }
    // sellingPrice is optional — omit/blank means "don't touch the
    // selling price this restock", not "set it to zero". Only validate
    // when something was actually submitted.
    const hasSellingPrice = item.sellingPrice !== undefined && item.sellingPrice !== null && item.sellingPrice !== '';
    if (hasSellingPrice && (!Number.isFinite(Number(item.sellingPrice)) || Number(item.sellingPrice) < 0)) {
      return res.status(400).json({ success: false, message: `Invalid selling price for ${item.productID}.` });
    }
  }
  // Stage 21 credit fix: amountPaid used to be silently coerced to 0 on
  // anything non-numeric (`Number(amountPaid) || 0`) — garbage input just
  // vanished instead of erroring. Now validated the same way item fields
  // are: blank/omitted means "0 paid" (still valid), anything present
  // must be a real non-negative number.
  const hasAmountPaid = amountPaid !== undefined && amountPaid !== null && amountPaid !== '';
  if (hasAmountPaid && (!Number.isFinite(Number(amountPaid)) || Number(amountPaid) < 0)) {
    return res.status(400).json({ success: false, message: 'Invalid amount paid.' });
  }
  const paidInput = roundMoney(hasAmountPaid ? Number(amountPaid) : 0);

  let supplier = null;
  if (!isSelfPurchase) {
    supplier = await Supplier.findOne({ supplierName: supplierName.trim().replace(/\s+/g, ' ') });
    if (!supplier) {
      return res.status(400).json({ success: false, message: `Supplier "${supplierName}" not found.` });
    }
  }

  const cleanItems = items.map((it) => {
    const hasSellingPrice = it.sellingPrice !== undefined && it.sellingPrice !== null && it.sellingPrice !== '';
    return {
      productID: it.productID,
      quantity: parseInt(it.quantity),
      unitCost: roundMoney(it.unitCost),
      // Kept off the object entirely (not just undefined) when not
      // submitted, so it never gets pushed into Supplier.purchases or the
      // audit log as a spurious "sellingPrice: undefined".
      ...(hasSellingPrice ? { sellingPrice: roundMoney(it.sellingPrice) } : {}),
    };
  });
  const totalAmount = roundMoney(cleanItems.reduce((sum, it) => sum + it.unitCost * it.quantity, 0));
  const purchaseID = await generateUniquePurchaseId();
  // Self-purchase has no supplier to owe money to or receive credit
  // from — these stay at their old fixed values for that path. The real
  // (credit-aware) math happens inside the transaction below, once the
  // supplier's current creditBalance can be read consistently.
  let paid = isSelfPurchase ? totalAmount : null;
  let balanceDue = isSelfPurchase ? 0 : null;
  let creditApplied = 0;
  let creditGenerated = 0;
  let newCreditBalance = 0;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of cleanItems) {
        const product = await Product.findOne({ productID: item.productID }).session(session);
        if (!product) {
          throw new AppError(400, `Product ${item.productID} no longer exists.`);
        }
        product.quantity += item.quantity;
        product.buyingPriceHistory.push({
          price: item.unitCost,
          date: new Date(),
          supplierID: isSelfPurchase ? null : supplier._id,
        });
        // Stage 21: only append a new sellingPriceHistory entry if a
        // selling price was actually submitted for this item AND it
        // differs from the current one — identical to the "did the price
        // move" guard POST /api/product uses. buyingPriceHistory (above)
        // is completely separate and always updates regardless.
        if (item.sellingPrice !== undefined) {
          const currentSellingPrice = roundMoney(getLatestSellingPrice(product));
          if (item.sellingPrice > 0 && item.sellingPrice !== currentSellingPrice) {
            product.sellingPriceHistory.push({ price: item.sellingPrice, date: new Date() });
          }
        }
        await product.save({ session });

        // Stage 22: every restock is its own distinct cost batch —
        // consumed oldest-first by a future sale (lib/costing.js). Self-
        // purchases get a batch too (supplierID: null), same as they
        // already get a buyingPriceHistory entry above.
        await createBatch({
          productID: item.productID,
          supplierID: isSelfPurchase ? null : supplier._id,
          purchaseID,
          quantity: item.quantity,
          unitCost: item.unitCost,
          session,
        });
      }

      if (!isSelfPurchase) {
        // Stage 21 credit fix: re-read the supplier's creditBalance
        // inside the transaction (session-scoped), not from the `supplier`
        // fetched before the transaction started — another purchase could
        // have changed it in between. Any existing credit is applied to
        // *this* purchase's total first; only what's left after that is
        // "owed", and only overpaying *that* remainder creates new credit.
        const supplierDoc = await Supplier.findOne({ _id: supplier._id }).session(session);
        if (!supplierDoc) {
          throw new AppError(400, `Supplier "${supplierName}" no longer exists.`);
        }
        const existingCredit = roundMoney(supplierDoc.creditBalance || 0);
        creditApplied = roundMoney(Math.min(existingCredit, totalAmount));
        const netOwed = roundMoney(totalAmount - creditApplied);
        creditGenerated = roundMoney(Math.max(0, paidInput - netOwed));
        paid = paidInput; // what was actually paid this transaction, recorded as-is (no longer capped)
        balanceDue = roundMoney(Math.max(0, netOwed - paidInput));
        newCreditBalance = roundMoney(existingCredit - creditApplied + creditGenerated);

        // Note: Supplier.purchases' item sub-schema (models/Supplier.js)
        // doesn't declare a `sellingPrice` field, so Mongoose silently
        // strips it here even though cleanItems carries it — intentional,
        // not a bug. A supplier's purchase-history table is a record of
        // what was bought/owed, not a place selling-price changes need to
        // live twice; the actual record of the change is
        // Product.sellingPriceHistory (updated above) and this action's
        // own audit-log entry (below, which does keep it — before Mongo
        // schema stripping applies).
        await Supplier.updateOne(
          { _id: supplier._id },
          {
            $set: { creditBalance: newCreditBalance },
            $push: { purchases: { purchaseID, totalAmount, amountPaid: paid, balanceDue, creditApplied, creditGenerated, items: cleanItems } },
          },
          { session }
        );
      }

      await logAudit(
        {
          action: isSelfPurchase ? 'product.restocked' : 'supplier.purchase',
          actor: { username: req.user.username, role: req.user.role },
          targetType: isSelfPurchase ? 'product' : 'supplier',
          targetId: isSelfPurchase ? NO_SUPPLIER : supplier.supplierName,
          before: null,
          after: isSelfPurchase
            ? { purchaseID, supplierName: NO_SUPPLIER, items: cleanItems, totalAmount }
            : {
                purchaseID,
                supplierName: supplier.supplierName,
                items: cleanItems,
                totalAmount,
                amountPaid: paid,
                balanceDue,
                creditApplied,
                creditGenerated,
                newCreditBalance,
              },
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json(
    isSelfPurchase
      ? { success: true, message: 'Self-purchased stock recorded.', purchaseID, totalAmount, selfPurchase: true }
      : {
          success: true,
          message: 'Purchase recorded and stock updated.',
          purchaseID,
          totalAmount,
          amountPaid: paid,
          balanceDue,
          creditApplied,
          creditGenerated,
          creditBalance: newCreditBalance,
        }
  );
}));
// ── Orders: list/detail (Stage 7) ───────────────────────────

app.get('/api/orders', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'orderDate', sortDir = 'desc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
        $or: [
          { orderID: { $regex: escapeRegex(search), $options: 'i' } },
          { customerName: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }
    : {};

  const data = await Order.find(filter);
  const mapped = data.map((o) => {
    const avgPayment =
      o.payments && o.payments.length > 0
        ? roundMoney(o.payments.reduce((sum, p) => sum + p.amount, 0) / o.payments.length)
        : 0;
    return {
      _id: o._id,
      orderID: o.orderID,
      customerName: o.customerName,
      totalAmount: o.totalAmount,
      amountPaid: o.amountPaid,
      balanceDue: o.balanceDue,
      paymentStatus: o.paymentStatus,
      status: o.status,
      displayStatus: o.status === 'refunded' ? 'refunded' : o.paymentStatus,
      avgPayment,
      cashier: o.cashier,
      orderDate: o.orderDate,
      products: o.products,
      editHistory: o.editHistory,
    };
  });

  const { data: orders, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, orders, total, page, limit });
}));

app.get('/api/orders/:orderID', requireAuth, asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderID: req.params.orderID });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const refunds = await Refund.find({ orderID: req.params.orderID }).sort({ refundDate: -1 });
  res.json({ success: true, order, refunds });
}));

// ── Audit Log (Stage 14) — admin-only, read-only. See lib/auditLog.js
// for how entries get written and how the collection stays bounded.
app.get('/api/audit-log', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'date', sortDir = 'desc', action = '' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = {};
  if (action) filter.action = action;
  if (search) {
    filter.$or = [
      { 'actor.username': { $regex: escapeRegex(search), $options: 'i' } },
      { targetId: { $regex: escapeRegex(search), $options: 'i' } },
      { action: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }

  const data = await AuditLog.find(filter);
  const mapped = data.map((a) => ({
    _id: a._id,
    action: a.action,
    actor: a.actor,
    targetType: a.targetType,
    targetId: a.targetId,
    before: a.before,
    after: a.after,
    date: a.date,
  }));

  const { data: entries, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, entries, total, page, limit });
}));

// ── Admin bill editing & refunds (Stage 7) ──────────────────
// Edit and refund share the same core operation — reduce/remove a line
// item, restore the matching stock atomically, log an audit entry, and
// recompute the order's totals from what's left. Refunds additionally
// write a Refund record and permanently mark the order 'refunded'; edits
// don't, and are time-boxed to ORDER_EDIT_WINDOW_MS. Both are
// requireAdmin — this is the first real use of that middleware beyond
// the manual stock-correction route from Stage 3.

function recomputeOrderTotals(order) {
  order.totalAmount = roundMoney(order.products.reduce((sum, p) => sum + p.amount, 0));
  order.balanceDue = roundMoney(Math.max(0, order.totalAmount - order.amountPaid));
  order.paymentStatus = order.amountPaid <= 0 ? 'unpaid' : order.balanceDue > 0 ? 'partial' : 'paid';
}

// Reduces (or removes, if newQty === 0) one line item's quantity,
// proportionally recomputing its $ amount from what that line was
// *actually sold at* (not today's price — an edit/refund reflects the
// original sale), restores the freed stock atomically, and appends one
// editHistory entry. Returns the quantity restored to stock.
async function applyLineReduction(order, productID, newQty, reason, action, editedBy, session) {
  const line = order.products.find((p) => p.productID === productID);
  if (!line) {
    throw new AppError(400, `Order ${order.orderID} has no line item for ${productID}.`);
  }
  if (!Number.isInteger(newQty) || newQty < 0 || newQty > line.quantity) {
    throw new AppError(400, `Invalid new quantity for ${productID}.`);
  }
  if (newQty === line.quantity) {
    return 0; // nothing changed — don't log a no-op
  }

  const originalQty = line.quantity;
  const restoreQty = originalQty - newQty;
  const unitNetPrice = originalQty > 0 ? line.amount / originalQty : 0;
  const unitDiscountAmount = originalQty > 0 ? (line.discountAmount || 0) / originalQty : 0;

  // Stage 22: give back exactly the batch stock (and cost basis) this
  // reduction undoes, before the line's own fields are mutated below —
  // restoreConsumption needs the line's *original* quantity/consumption
  // to know which batches to credit. This keeps the batches usable for a
  // later sale and keeps the dashboard's profit figure from
  // double-counting a line that's been edited down or refunded.
  const { remainingConsumption, costRestored, knownQtyRestored } = await restoreConsumption(
    line.batchConsumption,
    originalQty,
    restoreQty,
    session
  );

  if (newQty === 0) {
    order.products = order.products.filter((p) => p.productID !== productID);
  } else {
    line.quantity = newQty;
    line.amount = roundMoney(unitNetPrice * newQty);
    line.discountAmount = roundMoney(unitDiscountAmount * newQty);
    line.batchConsumption = remainingConsumption;
    line.costAmount = roundMoney(Math.max(0, (line.costAmount || 0) - costRestored));
    line.costQuantity = Math.max(0, (line.costQuantity || 0) - knownQtyRestored);
    line.costSource = deriveCostSource(line.costQuantity, newQty);
  }

  order.editHistory.push({ editedBy, editedAt: new Date(), productID, originalQty, newQty, reason, action });

  const updated = await Product.findOneAndUpdate(
    { productID },
    { $inc: { quantity: restoreQty } },
    { session, new: true }
  );
  if (!updated) {
    throw new AppError(400, `Product ${productID} no longer exists — stock could not be restored.`);
  }

  return restoreQty;
}

app.post('/api/order/:orderID/edit', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID, newQty, reason } = req.body;
  const { orderID } = req.params;

  if (!isValidOrderId(orderID)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }
  if (!isValidProductId(productID)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required for every edit.' });
  }
  const qty = parseInt(newQty);
  if (!Number.isInteger(qty) || qty < 0) {
    return res.status(400).json({ success: false, message: 'Invalid new quantity.' });
  }

  const session = await mongoose.startSession();
  let updatedOrder;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ orderID }).session(session);
      if (!order) {
        throw new AppError(404, 'Order not found.');
      }
      if (order.status === 'refunded') {
        throw new AppError(400, 'This order has already been refunded and can no longer be edited.');
      }
      const ageMs = Date.now() - new Date(order.orderDate).getTime();
      if (ageMs > ORDER_EDIT_WINDOW_MS) {
        throw new AppError(403, 'The 72-hour edit window for this order has expired.');
      }

      const beforeOrder = order.toObject();
      await applyLineReduction(order, productID, qty, reason.trim(), 'edit', req.user.username, session);
      recomputeOrderTotals(order);
      await order.save({ session });

      // Keep the customer's embedded order summary (Stage 5) in sync.
      await Customer.updateOne(
        { customerName: order.customerName, 'orders.orderNo': order.orderID },
        { $set: { 'orders.$.totalAmount': order.totalAmount, 'orders.$.balanceDue': order.balanceDue } },
        { session }
      );

      await logAudit(
        {
          action: 'order.edited',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: beforeOrder,
          after: order.toObject(),
        },
        session
      );

      updatedOrder = order;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Order updated.', order: updatedOrder });
}));

app.post('/api/order/:orderID/refund', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { items, reason } = req.body;
  const { orderID } = req.params;

  if (!isValidOrderId(orderID)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items selected to refund.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required for every refund.' });
  }
  for (const item of items) {
    if (!isValidProductId(item.productID) || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ success: false, message: 'Invalid refund item.' });
    }
  }

  const session = await mongoose.startSession();
  let refund;
  let updatedOrder;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ orderID }).session(session);
      if (!order) {
        throw new AppError(404, 'Order not found.');
      }
      if (order.status === 'refunded') {
        throw new AppError(400, 'This order has already been refunded.');
      }

      const beforeOrder = order.toObject();
      const refundedItems = [];
      let refundAmount = 0;

      for (const item of items) {
        const line = order.products.find((p) => p.productID === item.productID);
        if (!line) {
          throw new AppError(400, `Order ${orderID} has no line item for ${item.productID}.`);
        }
        if (item.quantity > line.quantity) {
          throw new AppError(400, `Cannot refund more than was ordered for ${item.productID}.`);
        }
        const unitNetPrice = line.quantity > 0 ? line.amount / line.quantity : 0;
        const lineRefundAmount = roundMoney(unitNetPrice * item.quantity);
        refundedItems.push({ productID: item.productID, quantity: item.quantity, amount: lineRefundAmount });
        refundAmount += lineRefundAmount;

        await applyLineReduction(order, item.productID, line.quantity - item.quantity, reason.trim(), 'refund', req.user.username, session);
      }

      refundAmount = roundMoney(refundAmount);
      recomputeOrderTotals(order);

      // Refunding always finalizes the order — no partial-refund status,
      // per spec ("mark order status: refunded, don't delete").
      order.status = 'refunded';
      await order.save({ session });

      const created = await Refund.create(
        [
          {
            orderID,
            customerName: order.customerName,
            refundAmount,
            refundedItems,
            reason: reason.trim(),
            processedBy: req.user.username,
          },
        ],
        { session }
      );
      refund = created[0];

      await Customer.updateOne(
        { customerName: order.customerName, 'orders.orderNo': order.orderID },
        { $set: { 'orders.$.totalAmount': order.totalAmount, 'orders.$.balanceDue': order.balanceDue } },
        { session }
      );

      await logAudit(
        {
          action: 'order.refunded',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: beforeOrder,
          after: order.toObject(),
        },
        session
      );

      updatedOrder = order;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Refund processed.', refund, order: updatedOrder });
}));

// ── Serve the built React frontend (MERN — no server-rendered
//    views anymore; see progress.md "EJS removal") ──────────────
// Registered last, after every real API route, so an unmatched
// /api/* or /auth/* request still 404s as JSON (a typo'd API call
// failing loudly beats it silently getting back an HTML page), while
// every other unmatched GET — the client-side routes React Router
// owns, like /billing or /orders/123 — gets the SPA shell and lets
// the frontend decide what to render.
app.use(['/api', '/auth'], (req, res) => {
  res.status(404).json({ success: false, message: 'Not found.' });
});

const frontendDist = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  logger.warn(
    'frontend/dist not found — run `npm run build` inside /frontend to serve the React app from this server. ' +
      'API routes still work; only the UI is unavailable until it is built.'
  );
}

// ── Centralized error handler — must be registered last ─────
app.use(errorHandler);

// ── Abandoned-draft sweep (Stage 4) ─────────────────────────
// Closes the gap Stage 3 flagged: a cart nobody explicitly cancelled (tab
// killed, laptop died, network dropped before the beforeunload release
// landed) would otherwise hold its reservation forever. This runs
// periodically and releases anything idle past DRAFT_IDLE_TIMEOUT_MS.
async function sweepAbandonedDrafts() {
  if (mongoose.connection.readyState !== 1) return; // not connected yet/anymore — skip this tick

  const cutoff = new Date(Date.now() - DRAFT_IDLE_TIMEOUT_MS);
  const stale = await PendingBill.find({ status: 'active', updatedAt: { $lt: cutoff }, 'items.0': { $exists: true } });

  for (const draft of stale) {
    try {
      await Promise.all(
        draft.items.map((it) =>
          Product.findOneAndUpdate(
            { productID: it.productID, reserved: { $gte: it.quantity } },
            { $inc: { reserved: -it.quantity } }
          )
        )
      );
      draft.status = 'abandoned';
      draft.items = [];
      draft.updatedAt = new Date();
      await draft.save();
      logger.info({ cashier: draft.cashier, billID: draft.billID }, 'Released stock for an abandoned draft bill');
    } catch (err) {
      logger.error({ err: err.message, cashier: draft.cashier }, 'Failed to sweep an abandoned draft');
    }
  }
}

setInterval(() => {
  sweepAbandonedDrafts().catch((err) => logger.error({ err: err.message }, 'Draft sweep tick failed'));
}, DRAFT_SWEEP_INTERVAL_MS);

app.listen(port, () => {
  logger.info(`🚀 Server running at http://localhost:${port}`);
});