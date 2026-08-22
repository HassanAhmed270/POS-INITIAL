import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { formatMoney } from '../lib/money';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useAuth } from '../lib/AuthContext';

// Stage 20: the self-purchased/no-supplier sentinel — must match
// NO_SUPPLIER in main.js exactly, since this string is sent straight
// through as `supplierId` (main.js's resolveSupplierId() treats it the
// same as an empty value: stored as null, no Supplier record required).
const NO_SUPPLIER = 'NoSupplier';
const emptyForm = { productId: '', productName: '', category: '', price: '', stock: '', supplierId: NO_SUPPLIER, lowStockThreshold: '' };
const PAGE_SIZE = 10;

export default function Products() {
  const { isAdmin } = useAuth();
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Full, unpaginated supplier list — used only to populate the Supplier
  // combobox below (Stage 20), same pattern as Suppliers.jsx's
  // allSuppliers/allProducts dropdown data.
  const [allSuppliers, setAllSuppliers] = useState([]);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState('productID');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState('add'); // 'add' | 'update'
  const [form, setForm] = useState(emptyForm);
  const [already, setAlready] = useState(0);
  // Previous selling price for the product currently being edited (Stage
  // 13, admin-only) — shown next to the new-price input so an admin can
  // see what it was vs. what they're about to set it to. null in 'add'
  // mode since there's no previous price yet.
  const [previousPrice, setPreviousPrice] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [showUndo, setShowUndo] = useState(false);

  const loadProducts = async () => {
    setLoading(true);
    try {
      const data = await api.getProducts({ search: debouncedSearch, sortBy, sortDir, page, limit: PAGE_SIZE });
      setProducts(data.products || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  const loadSuppliers = async () => {
    try {
      const data = await api.getSuppliers({ limit: 1000 });
      setAllSuppliers(data.suppliers || []);
    } catch (err) {
      console.error('Failed to load suppliers:', err.message);
    }
  };

  useEffect(() => {
    loadSuppliers();
  }, []);

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir, page]);

  // A new search or sort invalidates the current page — go back to page 1
  // rather than showing an empty "page 4 of 1" after narrowing results.
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

  const resetForm = () => {
    setForm(emptyForm);
    setAlready(0);
    setPreviousPrice(null);
    setMode('add');
    setSelectedId(null);
  };

  const handleSelectForUpdate = (p) => {
    setSelectedId(p.productID);
    setMode('update');
    setForm({
      productId: p.productID,
      productName: p.productName,
      category: p.category,
      price: p.price ?? '',
      stock: '',
      supplierId: p.supplierId || NO_SUPPLIER,
      lowStockThreshold: p.lowStockThreshold ?? 10,
    });
    setAlready(p.quantity);
    setPreviousPrice(p.price ?? null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.productId || !form.productName) {
      alert('Product ID and Name are required.');
      return;
    }
    try {
      await api.saveProduct({ ...form, already: mode === 'update' ? already : 0 });
      await loadProducts();
      resetForm();
    } catch (err) {
      alert('Error saving product: ' + err.message);
    }
  };

  const handleDelete = async (p) => {
    if (!confirm(`Delete product ${p.productID}?`)) return;
    try {
      await api.deleteProduct(p.productID);
      setUndoStack((s) => [
        ...s,
        {
          productId: p.productID,
          productName: p.productName,
          category: p.category,
          price: p.price ?? 0,
          stock: p.quantity,
          supplierId: p.supplierId || NO_SUPPLIER,
          lowStockThreshold: p.lowStockThreshold ?? 10,
        },
      ]);
      await loadProducts();
      setShowUndo(true);
      setTimeout(() => setShowUndo(false), 5000);
    } catch (err) {
      alert('Failed to delete product: ' + err.message);
    }
  };

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    try {
      await api.undoProduct(last);
      setUndoStack((s) => s.slice(0, -1));
      setShowUndo(false);
      await loadProducts();
    } catch (err) {
      alert('Failed to undo: ' + err.message);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Product Management" />
        <div className="p-4 md:p-6 overflow-y-auto flex-1">
          <div className="flex justify-between items-center mb-6">
            <input
              type="text"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border rounded px-3 py-2 w-full sm:w-64"
            />
          </div>

          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

          <div className="bg-white border rounded-lg w-full">
            <div className="flex flex-col lg:flex-row lg:h-[560px]">
              <div className={`w-full ${isAdmin ? 'lg:w-2/3' : ''} flex flex-col`}>
                <div className="overflow-x-auto lg:overflow-y-auto px-4 flex-1">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b bg-gray-100">
                        <SortableHeader label="Product ID" field="productID" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="Name" field="productName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="Category" field="category" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="Price" field="price" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="Available" field="available" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                        <th className="py-3 px-2 text-left">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr><td colSpan={6} className="py-6 text-center text-gray-400">Loading…</td></tr>
                      ) : products.length === 0 ? (
                        <tr><td colSpan={6} className="py-6 text-center text-gray-400">No products found</td></tr>
                      ) : (
                        products.map((p) => {
                          const available = p.available ?? p.quantity - (p.reserved || 0);
                          const lowStock = p.lowStock ?? available <= (p.lowStockThreshold ?? 10);
                          return (
                            <tr
                              key={p.productID}
                              className={`border-b hover:bg-gray-50 ${selectedId === p.productID ? 'bg-blue-50' : ''} ${lowStock ? 'bg-red-50' : ''}`}
                            >
                              <td className="py-2 px-3">{p.productID}</td>
                              <td className="py-2 px-3">{p.productName}</td>
                              <td className="py-2 px-3">{p.category}</td>
                              <td className="py-2 px-3">{formatMoney(p.price ?? 0)}</td>
                              <td className={`py-2 px-3 ${lowStock ? 'text-red-700 font-semibold' : ''}`}>
                                {available}
                                {p.reserved > 0 && <span className="text-xs text-gray-400"> ({p.reserved} held)</span>}
                                {lowStock && <span className="ml-1 text-xs font-normal">⚠ low</span>}
                              </td>
                              <td className="py-2 px-3 flex gap-2">
                                {isAdmin ? (
                                  <>
                                    <button onClick={() => handleSelectForUpdate(p)} className="text-blue-600 hover:text-blue-800" title="Edit">✏️</button>
                                    <button onClick={() => handleDelete(p)} className="text-red-600 hover:text-red-800" title="Delete">🗑️</button>
                                  </>
                                ) : (
                                  <span className="text-xs text-gray-400">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} limit={PAGE_SIZE} total={total} onPageChange={setPage} />
              </div>

              {isAdmin && (
              <div className="w-full lg:w-1/3 p-4 sm:p-8 border-t-4 lg:border-t-0 lg:border-l-4 border-gray-300 lg:overflow-y-auto">
                <h2 className="text-2xl flex justify-center text-green-600 font-bold mb-4">
                  {mode === 'add' ? 'Add New Product' : 'Update Product'}
                </h2>
                <form onSubmit={handleSubmit} className="space-y-4 w-full">
                  <div>
                    <label className="block mb-1 font-medium">Product ID</label>
                    <input
                      type="text"
                      value={form.productId}
                      disabled={mode === 'update'}
                      onChange={(e) => setForm({ ...form, productId: e.target.value })}
                      placeholder="e.g. #0001"
                      className="border rounded px-3 py-2 bg-gray-100 w-full disabled:opacity-70"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">Product Name</label>
                    <input
                      type="text"
                      value={form.productName}
                      onChange={(e) => setForm({ ...form, productName: e.target.value })}
                      placeholder="Enter product name"
                      className="border rounded px-3 py-2 w-full"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">Category</label>
                    <input
                      type="text"
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      placeholder="Enter category"
                      className="border rounded px-3 py-2 w-full"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">Selling Price</label>
                    {isAdmin && mode === 'update' && (
                      <p className="text-xs text-gray-500 mb-1">
                        Previous selling price: <span className="font-medium text-gray-700">{formatMoney(previousPrice ?? 0)}</span>
                      </p>
                    )}
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                      placeholder="Enter selling price"
                      className="border rounded px-3 py-2 w-full"
                    />
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">{mode === 'add' ? 'Stock' : 'Add Stock'}</label>
                    <input
                      type="number"
                      value={form.stock}
                      onChange={(e) => setForm({ ...form, stock: e.target.value })}
                      placeholder="Enter stock"
                      className="border rounded px-3 py-2 w-full"
                    />
                    {mode === 'update' && (
                      <p className="text-xs text-gray-500 mt-1">Current stock: {already} — this amount will be added to it.</p>
                    )}
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">Supplier</label>
                    <select
                      value={form.supplierId}
                      onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
                      className="border rounded px-3 py-2 w-full"
                    >
                      <option value={NO_SUPPLIER}>🛠 NoSupplier — Buy Myself / Self Purchased</option>
                      {allSuppliers.map((s) => (
                        <option key={s._id} value={s._id}>{s.supplierName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block mb-1 font-medium">Low Stock Alert Threshold</label>
                    <input
                      type="number"
                      min="0"
                      value={form.lowStockThreshold}
                      onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
                      placeholder="10"
                      className="border rounded px-3 py-2 w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">Row highlights red once available stock drops to this number or below.</p>
                  </div>

                  <div className="flex gap-2">
                    <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">
                      {mode === 'add' ? 'Add Product' : 'Update Product'}
                    </button>
                    {mode === 'update' && (
                      <button type="button" onClick={resetForm} className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                        Cancel
                      </button>
                    )}
                  </div>
                </form>
              </div>
              )}
            </div>
          </div>

          {isAdmin && (
          <div className="flex gap-4 mt-4 py-4">
            <button onClick={() => setMode('add')} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Add Product +
            </button>
            {showUndo && (
              <button onClick={handleUndo} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">
                Undo Deleted
              </button>
            )}
          </div>
          )}
        </div>
      </main>
    </div>
  );
}