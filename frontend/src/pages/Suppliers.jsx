import { Fragment, useEffect, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { formatMoney, roundMoney } from '../lib/money';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useAuth } from '../lib/AuthContext';

// Stage 20: the self-purchased/no-supplier sentinel — must match
// NO_SUPPLIER in main.js exactly, same pattern as WALKIN_CUSTOMER
// (Stage 19). Sent straight through as `supplierName`; main.js's
// POST /supplier/purchase special-cases this exact string to skip the
// Supplier lookup/purchase record entirely instead of 404ing.
const NO_SUPPLIER = 'NoSupplier';
const emptySupplierForm = { supplierName: '', contactPerson: '', phone: '', email: '', address: '' };
const emptyPurchaseForm = { supplierName: '', productId: '', quantity: '', unitCost: '', sellingPrice: '', amountPaid: '' };
const PAGE_SIZE = 10;

export default function Suppliers() {
  const { isAdmin } = useAuth();
  const [suppliers, setSuppliers] = useState([]);
  const [total, setTotal] = useState(0);
  // Full, unpaginated lists — used only to populate the dropdowns below,
  // never rendered as a table (the paginated `suppliers`/`products`
  // states above are what the visible list shows). Kept separate so
  // Stage 8's pagination on the main table doesn't cripple these
  // selectors to whatever fits on one page.
  const [allSuppliers, setAllSuppliers] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState('supplierName');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);
  const [expandedName, setExpandedName] = useState(null);

  const [supplierForm, setSupplierForm] = useState(emptySupplierForm);
  const [purchaseForm, setPurchaseForm] = useState(emptyPurchaseForm);

  // Stage 13, admin-only: previous buying price for whichever product is
  // currently selected in the purchase form, so an admin can see what was
  // paid last time next to the new unit-cost input. Derived rather than
  // stored — allProducts already carries costPrice (latest
  // buyingPriceHistory entry) from GET /api/products.
  const selectedPurchaseProduct = allProducts.find((p) => p.productID === purchaseForm.productId);
  const previousBuyingPrice = selectedPurchaseProduct?.costPrice ?? null;
  // Stage 21: previous *selling* price for the same product, shown next
  // to the new optional selling-price input below — deliberately a
  // separate value from previousBuyingPrice above (allProducts.price is
  // getLatestSellingPrice(), allProducts.costPrice is
  // getLatestBuyingPrice() — see GET /api/products in main.js). Keeping
  // these visibly distinct in the UI is the point of Stage 21 item 15.
  const previousSellingPrice = selectedPurchaseProduct?.price ?? null;

  // Credit-fix follow-up: Amount Paid now auto-fills with quantity ×
  // cost (the purchase total) whenever either changes, so the field
  // reflects "pay in full" by default instead of starting blank — but
  // stays fully editable for a deliberate partial payment or an
  // intentional overpayment. `autoFilledPaid` tracks the value *we* last
  // wrote in, so the effect below only overwrites the field when it
  // still matches what we auto-filled (i.e. the admin hasn't typed their
  // own number since) — editing amountPaid by hand always wins.
  const autoFilledPaid = useRef('');
  useEffect(() => {
    const qty = parseInt(purchaseForm.quantity);
    const cost = parseFloat(purchaseForm.unitCost);
    const computedTotal = Number.isInteger(qty) && qty > 0 && Number.isFinite(cost) && cost >= 0 ? roundMoney(qty * cost) : '';
    setPurchaseForm((prev) => {
      if (prev.amountPaid !== '' && prev.amountPaid !== autoFilledPaid.current) {
        // Admin typed their own value — leave it alone.
        return prev;
      }
      autoFilledPaid.current = computedTotal === '' ? '' : String(computedTotal);
      return { ...prev, amountPaid: autoFilledPaid.current };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseForm.quantity, purchaseForm.unitCost]);

  const loadSuppliers = async () => {
    setLoading(true);
    try {
      const data = await api.getSuppliers({ search: debouncedSearch, sortBy, sortDir, page, limit: PAGE_SIZE });
      setSuppliers(data.suppliers || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  };

  const loadDropdownData = async () => {
    try {
      const [s, p] = await Promise.all([api.getSuppliers({ limit: 1000 }), api.getProducts({ limit: 1000 })]);
      setAllSuppliers(s.suppliers || []);
      setAllProducts(p.products || []);
    } catch (err) {
      console.error('Failed to load dropdown data:', err.message);
    }
  };

  useEffect(() => {
    loadDropdownData();
  }, []);

  useEffect(() => {
    loadSuppliers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir, page]);

  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir]);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  const reloadEverything = async () => {
    await Promise.all([loadSuppliers(), loadDropdownData()]);
  };

  const handleAddSupplier = async (e) => {
    e.preventDefault();
    if (!supplierForm.supplierName.trim()) {
      alert('Supplier name is required.');
      return;
    }
    try {
      await api.saveSupplier(supplierForm);
      setSupplierForm(emptySupplierForm);
      await reloadEverything();
    } catch (err) {
      alert('Error saving supplier: ' + err.message);
    }
  };

  const handleDeleteSupplier = async (s) => {
    if (!confirm(`Delete supplier ${s.supplierName}? Its purchase history will be lost.`)) return;
    try {
      await api.deleteSupplier(s.supplierName);
      if (expandedName === s.supplierName) setExpandedName(null);
      await reloadEverything();
    } catch (err) {
      alert('Failed to delete supplier: ' + err.message);
    }
  };

  const handleRecordPurchase = async (e) => {
    e.preventDefault();
    const { supplierName, productId, quantity, unitCost, sellingPrice, amountPaid } = purchaseForm;
    const qty = parseInt(quantity);
    const cost = parseFloat(unitCost);
    if (!supplierName || !productId || isNaN(qty) || qty <= 0 || isNaN(cost) || cost < 0) {
      alert('Please fill in supplier, product, a valid quantity, and a valid unit cost.');
      return;
    }
    // Stage 21: selling price is optional on this form — blank means
    // "leave it alone", so it's only included in the item payload (and
    // therefore only validated) when the admin actually typed something.
    const trimmedSellingPrice = String(sellingPrice ?? '').trim();
    let sp;
    if (trimmedSellingPrice !== '') {
      sp = parseFloat(trimmedSellingPrice);
      if (isNaN(sp) || sp < 0) {
        alert('Selling price must be a valid non-negative number, or left blank to leave it unchanged.');
        return;
      }
    }
    try {
      const data = await api.recordPurchase({
        supplierName,
        items: [{ productID: productId, quantity: qty, unitCost: cost, ...(sp !== undefined ? { sellingPrice: sp } : {}) }],
        amountPaid: parseFloat(amountPaid) || 0,
      });
      if (data.selfPurchase) {
        alert(`Purchase ${data.purchaseID} recorded (self-purchased, no supplier balance).`);
      } else {
        // Stage 21 credit fix: surface both sides plainly — what's still
        // owed on this purchase, and (if this payment covered more than
        // was owed, after any existing credit was already applied) the
        // supplier's new running credit that'll offset their next
        // purchase automatically.
        const lines = [`Purchase ${data.purchaseID} recorded.`];
        if (data.creditApplied > 0) {
          lines.push(`${formatMoney(data.creditApplied)} of existing credit was applied to this purchase.`);
        }
        lines.push(`Balance due to supplier: ${formatMoney(data.balanceDue)}`);
        if (data.creditBalance > 0) {
          lines.push(`Overpayment recorded — supplier now has ${formatMoney(data.creditBalance)} credit, which will reduce their next purchase automatically.`);
        }
        alert(lines.join(' '));
      }
      autoFilledPaid.current = '';
      setPurchaseForm(emptyPurchaseForm);
      await reloadEverything();
    } catch (err) {
      alert('Error recording purchase: ' + err.message);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Supplier Management" />
        <div className="p-4 md:p-6 overflow-y-auto flex-1 space-y-6">
          <input
            type="text"
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded px-3 py-2 w-full sm:w-64"
          />

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="bg-white border rounded-lg w-full">
            <div className="flex flex-col lg:flex-row">
              <div className={`w-full ${isAdmin ? 'lg:w-2/3' : ''} flex flex-col overflow-x-auto`}>
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b bg-gray-100">
                      <SortableHeader label="Supplier" field="supplierName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <th className="py-3 px-2 text-left">Contact</th>
                      <th className="py-3 px-2 text-left">Phone</th>
                      <SortableHeader label="Purchases" field="purchaseCount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <SortableHeader label="We Owe" field="totalBalanceDue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <th className="py-3 px-2 text-left">Credit</th>
                      <th className="py-3 px-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={7} className="py-6 text-center text-gray-400">Loading…</td></tr>
                    ) : suppliers.length === 0 ? (
                      <tr><td colSpan={7} className="py-6 text-center text-gray-400">No suppliers found</td></tr>
                    ) : (
                      suppliers.map((s) => (
                        <Fragment key={s.supplierName}>
                          <tr
                            onClick={() => setExpandedName(expandedName === s.supplierName ? null : s.supplierName)}
                            className={`border-b hover:bg-gray-50 cursor-pointer ${expandedName === s.supplierName ? 'bg-blue-50' : ''}`}
                          >
                            <td className="py-2 px-3">{s.supplierName}</td>
                            <td className="py-2 px-3">{s.contactPerson}</td>
                            <td className="py-2 px-3">{s.phone}</td>
                            <td className="py-2 px-3">{s.purchases.length}</td>
                            <td className={`py-2 px-3 ${s.totalBalanceDue > 0 ? 'text-red-700 font-semibold' : ''}`}>
                              {formatMoney(s.totalBalanceDue)}
                            </td>
                            <td className={`py-2 px-3 ${s.creditBalance > 0 ? 'text-green-700 font-semibold' : ''}`}>
                              {s.creditBalance > 0 ? formatMoney(s.creditBalance) : '—'}
                            </td>
                            <td className="py-2 px-3">
                              {isAdmin ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDeleteSupplier(s); }}
                                  className="text-red-600 hover:text-red-800"
                                  title="Delete"
                                >
                                  🗑️
                                </button>
                              ) : (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                          {expandedName === s.supplierName && (
                            <tr className="bg-gray-50">
                              <td colSpan={7} className="p-4">
                                <h4 className="font-medium text-sm mb-2">Purchase history</h4>
                                {s.purchases.length === 0 ? (
                                  <p className="text-xs text-gray-400">No purchases recorded yet.</p>
                                ) : (
                                  <table className="w-full min-w-[600px] text-xs bg-white border-collapse">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="p-1 text-left border">Purchase ID</th>
                                        <th className="p-1 text-left border">Date</th>
                                        <th className="p-1 text-left border">Items</th>
                                        <th className="p-1 text-left border">Total</th>
                                        <th className="p-1 text-left border">Credit Applied</th>
                                        <th className="p-1 text-left border">Paid</th>
                                        <th className="p-1 text-left border">Balance</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {s.purchases.map((p) => (
                                        <tr key={p.purchaseID}>
                                          <td className="p-1 border">{p.purchaseID}</td>
                                          <td className="p-1 border">{new Date(p.date).toLocaleDateString()}</td>
                                          <td className="p-1 border">{p.items.map((it) => `${it.productID} x${it.quantity}`).join(', ')}</td>
                                          <td className="p-1 border">{formatMoney(p.totalAmount)}</td>
                                          <td className="p-1 border">{p.creditApplied > 0 ? formatMoney(p.creditApplied) : '—'}</td>
                                          <td className="p-1 border">{formatMoney(p.amountPaid)}</td>
                                          <td className={`p-1 border ${p.balanceDue > 0 ? 'text-red-700 font-semibold' : ''}`}>{formatMoney(p.balanceDue)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))
                    )}
                  </tbody>
                </table>
                <Pagination page={page} limit={PAGE_SIZE} total={total} onPageChange={setPage} />
              </div>

              {isAdmin && (
              <div className="w-full lg:w-1/3 p-4 sm:p-6 border-t-4 lg:border-t-0 lg:border-l-4 border-gray-300 lg:overflow-y-auto">
                <h2 className="text-xl flex justify-center text-blue-600 font-bold mb-4">Add Supplier</h2>
                <form onSubmit={handleAddSupplier} className="space-y-3 text-sm">
                  <input
                    type="text"
                    value={supplierForm.supplierName}
                    onChange={(e) => setSupplierForm({ ...supplierForm, supplierName: e.target.value })}
                    placeholder="Supplier name"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <input
                    type="text"
                    value={supplierForm.contactPerson}
                    onChange={(e) => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })}
                    placeholder="Contact person"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <input
                    type="tel"
                    value={supplierForm.phone}
                    onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                    placeholder="Phone"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <input
                    type="email"
                    value={supplierForm.email}
                    onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })}
                    placeholder="Email"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <input
                    type="text"
                    value={supplierForm.address}
                    onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })}
                    placeholder="Address"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
                    Save Supplier
                  </button>
                </form>
              </div>
              )}
            </div>
          </div>

          <div className="bg-white border rounded-lg p-6">
            <h2 className="text-xl text-brand-green font-bold mb-4">Record a Purchase (restocks the product)</h2>
            <form onSubmit={handleRecordPurchase} className="grid grid-cols-1 md:grid-cols-6 gap-3 text-sm items-end">
              <div>
                <label className="block mb-1 font-medium">Supplier</label>
                <select
                  value={purchaseForm.supplierName}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, supplierName: e.target.value })}
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select supplier</option>
                  <option value={NO_SUPPLIER}>🛠 NoSupplier — Buy Myself / Self Purchased</option>
                  {allSuppliers.map((s) => (
                    <option key={s.supplierName} value={s.supplierName}>{s.supplierName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Product</label>
                <select
                  value={purchaseForm.productId}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, productId: e.target.value })}
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select product</option>
                  {allProducts.map((p) => (
                    <option key={p.productID} value={p.productID}>{p.productID} — {p.productName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 font-medium">Quantity</label>
                <input
                  type="number"
                  min="1"
                  value={purchaseForm.quantity}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, quantity: e.target.value })}
                  className="border rounded px-3 py-2 w-full"
                />
              </div>
              <div>
                <label className="block mb-1 font-medium">Cost / Buying Price</label>
                {isAdmin && purchaseForm.productId && (
                  <p className="text-xs text-gray-500 mb-1">
                    Previous cost: <span className="font-medium text-gray-700">{formatMoney(previousBuyingPrice ?? 0)}</span>
                  </p>
                )}
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.unitCost}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, unitCost: e.target.value })}
                  className="border rounded px-3 py-2 w-full"
                />
              </div>
              <div>
                <label className="block mb-1 font-medium">Selling Price (optional)</label>
                {isAdmin && purchaseForm.productId && (
                  <p className="text-xs text-gray-500 mb-1">
                    Previous selling price:{' '}
                    <span className="font-medium text-gray-700">{formatMoney(previousSellingPrice ?? 0)}</span>
                  </p>
                )}
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.sellingPrice}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, sellingPrice: e.target.value })}
                  placeholder="Leave blank to keep unchanged"
                  className="border rounded px-3 py-2 w-full"
                />
              </div>
              {purchaseForm.supplierName !== NO_SUPPLIER && (
                <div>
                  <label className="block mb-1 font-medium">Amount Paid</label>
                  <p className="text-xs text-gray-500 mb-1">Auto-fills as quantity × cost — edit for a partial payment or overpayment.</p>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={purchaseForm.amountPaid}
                    onChange={(e) => setPurchaseForm({ ...purchaseForm, amountPaid: e.target.value })}
                    placeholder="0 = nothing paid yet"
                    className="border rounded px-3 py-2 w-full"
                  />
                </div>
              )}
              <div className="md:col-span-6">
                <button type="submit" className="px-4 py-2 bg-brand-green text-white rounded hover:bg-green-700">
                  Record Purchase
                </button>
                <p className="text-xs text-gray-500 mt-1">
                  Increases the product's stock immediately and logs what we still owe the supplier if not paid in full.
                  Paying more than owed is recorded as supplier credit and applied automatically to their next purchase.
                  Selling price is optional — leave it blank to keep the product's current customer-facing price.
                </p>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}