import { Fragment, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { formatMoney } from '../lib/money';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useAuth } from '../lib/AuthContext';

const emptySupplierForm = { supplierName: '', contactPerson: '', phone: '', email: '', address: '' };
const emptyPurchaseForm = { supplierName: '', productId: '', quantity: '', unitCost: '', amountPaid: '' };
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
    const { supplierName, productId, quantity, unitCost, amountPaid } = purchaseForm;
    const qty = parseInt(quantity);
    const cost = parseFloat(unitCost);
    if (!supplierName || !productId || isNaN(qty) || qty <= 0 || isNaN(cost) || cost < 0) {
      alert('Please fill in supplier, product, a valid quantity, and a valid unit cost.');
      return;
    }
    try {
      const data = await api.recordPurchase({
        supplierName,
        items: [{ productID: productId, quantity: qty, unitCost: cost }],
        amountPaid: parseFloat(amountPaid) || 0,
      });
      alert(`Purchase ${data.purchaseID} recorded. Balance due to supplier: ${formatMoney(data.balanceDue)}`);
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
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <input
            type="text"
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded px-3 py-2 w-64"
          />

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="bg-white border rounded-lg w-full">
            <div className="flex">
              <div className="w-2/3 flex flex-col">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-100">
                      <SortableHeader label="Supplier" field="supplierName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <th className="py-3 px-2 text-left">Contact</th>
                      <th className="py-3 px-2 text-left">Phone</th>
                      <SortableHeader label="Purchases" field="purchaseCount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <SortableHeader label="We Owe" field="totalBalanceDue" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                      <th className="py-3 px-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={6} className="py-6 text-center text-gray-400">Loading…</td></tr>
                    ) : suppliers.length === 0 ? (
                      <tr><td colSpan={6} className="py-6 text-center text-gray-400">No suppliers found</td></tr>
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
                            <td className="py-2 px-3">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteSupplier(s); }}
                                className="text-red-600 hover:text-red-800"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                          {expandedName === s.supplierName && (
                            <tr className="bg-gray-50">
                              <td colSpan={6} className="p-4">
                                <h4 className="font-medium text-sm mb-2">Purchase history</h4>
                                {s.purchases.length === 0 ? (
                                  <p className="text-xs text-gray-400">No purchases recorded yet.</p>
                                ) : (
                                  <table className="w-full text-xs bg-white border-collapse">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="p-1 text-left border">Purchase ID</th>
                                        <th className="p-1 text-left border">Date</th>
                                        <th className="p-1 text-left border">Items</th>
                                        <th className="p-1 text-left border">Total</th>
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

              <div className="w-1/3 p-6 border-l-4 border-gray-300 overflow-y-auto">
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
            </div>
          </div>

          <div className="bg-white border rounded-lg p-6">
            <h2 className="text-xl text-brand-green font-bold mb-4">Record a Purchase (restocks the product)</h2>
            <form onSubmit={handleRecordPurchase} className="grid grid-cols-1 md:grid-cols-5 gap-3 text-sm items-end">
              <div>
                <label className="block mb-1 font-medium">Supplier</label>
                <select
                  value={purchaseForm.supplierName}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, supplierName: e.target.value })}
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select supplier</option>
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
                <label className="block mb-1 font-medium">Unit Cost</label>
                {isAdmin && purchaseForm.productId && (
                  <p className="text-xs text-gray-500 mb-1">
                    Previous: <span className="font-medium text-gray-700">{formatMoney(previousBuyingPrice ?? 0)}</span>
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
                <label className="block mb-1 font-medium">Amount Paid</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.amountPaid}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, amountPaid: e.target.value })}
                  placeholder="0 = full credit"
                  className="border rounded px-3 py-2 w-full"
                />
              </div>
              <div className="md:col-span-5">
                <button type="submit" className="px-4 py-2 bg-brand-green text-white rounded hover:bg-green-700">
                  Record Purchase
                </button>
                <p className="text-xs text-gray-500 mt-1">
                  Increases the product's stock immediately and logs what we still owe the supplier if not paid in full.
                </p>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}