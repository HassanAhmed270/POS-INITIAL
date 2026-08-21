import { Fragment, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { formatMoney } from '../lib/money';
import { printReceipt } from '../lib/print';
import { useDebouncedValue } from '../lib/useDebouncedValue';

const statusBadge = {
  paid: 'bg-green-100 text-green-700',
  partial: 'bg-yellow-100 text-yellow-700',
  unpaid: 'bg-red-100 text-red-700',
  refunded: 'bg-gray-200 text-gray-700',
};

const PAGE_SIZE = 10;

export default function Orders() {
  const { isAdmin } = useAuth();

  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState('orderDate');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  const [expandedID, setExpandedID] = useState(null);
  const [detail, setDetail] = useState(null); // { order, refunds } for the expanded row
  const [detailLoading, setDetailLoading] = useState(false);

  const [editForm, setEditForm] = useState({ productID: '', newQty: '', reason: '' });
  const [refundForm, setRefundForm] = useState({});
  const [refundReason, setRefundReason] = useState('');

  const loadOrders = async () => {
    setLoading(true);
    try {
      const data = await api.getOrders({ search: debouncedSearch, sortBy, sortDir, page, limit: PAGE_SIZE });
      setOrders(data.orders || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
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
      setSortDir(field === 'orderDate' ? 'desc' : 'asc');
    }
  };

  const toggleRow = async (orderID) => {
    if (expandedID === orderID) {
      setExpandedID(null);
      setDetail(null);
      return;
    }
    setExpandedID(orderID);
    setDetail(null);
    setDetailLoading(true);
    setEditForm({ productID: '', newQty: '', reason: '' });
    setRefundForm({});
    setRefundReason('');
    try {
      const data = await api.getOrder(orderID);
      setDetail(data);
    } catch (err) {
      alert('Failed to load order: ' + err.message);
      setExpandedID(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (orderID) => {
    const data = await api.getOrder(orderID);
    setDetail(data);
    await loadOrders(); // list-row totals/status may have changed too
  };

  const editWindowOpen = (order) => Date.now() - new Date(order.orderDate).getTime() <= 72 * 60 * 60 * 1000;

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editForm.productID) return alert('Select a line item to edit.');
    const newQty = parseInt(editForm.newQty);
    if (isNaN(newQty) || newQty < 0) return alert('Enter a valid new quantity.');
    if (!editForm.reason.trim()) return alert('A reason is required.');
    try {
      await api.editOrderItem(expandedID, { productID: editForm.productID, newQty, reason: editForm.reason.trim() });
      alert('Order updated.');
      setEditForm({ productID: '', newQty: '', reason: '' });
      await refreshDetail(expandedID);
    } catch (err) {
      alert('Edit failed: ' + err.message);
    }
  };

  const toggleRefundItem = (productID, maxQty) => {
    setRefundForm((prev) => {
      const next = { ...prev };
      if (next[productID] !== undefined) delete next[productID];
      else next[productID] = maxQty;
      return next;
    });
  };

  const handleRefundSubmit = async (e) => {
    e.preventDefault();
    const items = Object.entries(refundForm)
      .filter(([, qty]) => parseInt(qty) > 0)
      .map(([productID, qty]) => ({ productID, quantity: parseInt(qty) }));
    if (items.length === 0) return alert('Select at least one item to refund.');
    if (!refundReason.trim()) return alert('A reason is required.');
    if (!confirm(`Refund ${items.length} item(s) on ${expandedID}? This marks the whole order as refunded.`)) return;

    try {
      const data = await api.refundOrder(expandedID, {
        items,
        reason: refundReason.trim(),
      });

      console.log('REFUND RESPONSE:', data);

      if (!data?.success || !data?.refund) {
        throw new Error(data?.message || 'Refund completed but no refund details were returned.');
      }

      alert(`Refund processed: ${formatMoney(data.refund.refundAmount)}`);
      setRefundForm({});
      setRefundReason('');
      await refreshDetail(expandedID);
    } catch (err) {
      alert('Refund failed: ' + err.message);
    }
  };

  const handlePrintRevised = () => {
    if (!detail) return;
    const { order, refunds } = detail;
    const rows = order.products
      .map((p) => `<tr><td>${p.productID}</td><td>${p.quantity}</td><td>${formatMoney(p.amount)}</td><td>${p.discount}%</td></tr>`)
      .join('');
    const editRows = (order.editHistory || [])
      .map((e) => `<tr><td>${e.productID}</td><td>${e.originalQty} \u2192 ${e.newQty}</td><td>${e.action}</td><td>${e.editedBy}</td><td>${new Date(e.editedAt).toLocaleString()}</td><td>${e.reason}</td></tr>`)
      .join('');
    const refundRows = (refunds || [])
      .map((r) => `<tr><td>${formatMoney(r.refundAmount)}</td><td>${r.processedBy}</td><td>${new Date(r.refundDate).toLocaleString()}</td><td>${r.reason || ''}</td></tr>`)
      .join('');

    printReceipt(`
      <h2 style="text-align:center;font-weight:bold;font-size:20px;border-bottom:1px solid #ddd;padding-bottom:8px;">
        Revised Receipt ${order.status === 'refunded' ? '(REFUNDED)' : ''}
      </h2>
      <div style="margin:8px 0;font-weight:600;">Order ID: ${order.orderID}</div>
      <div>Customer: ${order.customerName}</div>
      <table><thead><tr><th>Code</th><th>Qty</th><th>Amount</th><th>Discount</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals"><span>Grand Total</span><span>${formatMoney(order.totalAmount)}</span></div>
      <div class="totals"><span>Paid</span><span>${formatMoney(order.amountPaid)}</span></div>
      <div class="totals"><span>Balance Due</span><span>${formatMoney(order.balanceDue)}</span></div>
      ${editRows ? `<div class="edit-history"><h3>Edit History</h3><table><thead><tr><th>Item</th><th>Qty change</th><th>Action</th><th>By</th><th>When</th><th>Reason</th></tr></thead><tbody>${editRows}</tbody></table></div>` : ''}
      ${refundRows ? `<div class="edit-history"><h3>Refunds</h3><table><thead><tr><th>Amount</th><th>By</th><th>When</th><th>Reason</th></tr></thead><tbody>${refundRows}</tbody></table></div>` : ''}
    `);
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Orders" />
        <div className="p-4 md:p-6 overflow-y-auto flex-1">
          <input
            type="text"
            placeholder="Search by order ID or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded px-3 py-2 w-full sm:w-72 mb-4"
          />
          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
          {!isAdmin && <p className="text-xs text-gray-500 mb-4">You're viewing orders read-only — editing and refunds are admin-only.</p>}

          <div className="bg-white border rounded-lg w-full overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b bg-gray-100">
                  <SortableHeader label="Order" field="orderID" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Customer" field="customerName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Total" field="totalAmount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Date" field="orderDate" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Avg Payment" field="avgPayment" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="py-3 px-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="py-6 text-center text-gray-400">Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={6} className="py-6 text-center text-gray-400">No orders found</td></tr>
                ) : (
                  orders.map((o) => (
                    <Fragment key={o.orderID}>
                      <tr
                        onClick={() => toggleRow(o.orderID)}
                        className={`border-b hover:bg-gray-50 cursor-pointer ${expandedID === o.orderID ? 'bg-blue-50' : ''}`}
                      >
                        <td className="py-2 px-3">{o.orderID}</td>
                        <td className="py-2 px-3">{o.customerName}</td>
                        <td className="py-2 px-3">{formatMoney(o.totalAmount)}</td>
                        <td className="py-2 px-3">{new Date(o.orderDate).toLocaleDateString()}</td>
                        <td className="py-2 px-3">{formatMoney(o.avgPayment)}</td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge[o.displayStatus] || ''}`}>
                            {o.displayStatus}
                          </span>
                        </td>
                      </tr>
                      {expandedID === o.orderID && (
                        <tr className="bg-gray-50">
                          <td colSpan={6} className="p-4">
                            {detailLoading ? (
                              <p className="text-gray-400 text-sm">Loading…</p>
                            ) : !detail ? (
                              <p className="text-red-500 text-sm">Could not load this order.</p>
                            ) : (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                                <div className="space-y-3">
                                  <div className="flex justify-between items-center">
                                    <h3 className="font-bold text-brand">Details</h3>
                                    <button onClick={handlePrintRevised} className="text-xs text-blue-600 hover:underline">
                                      Print {detail.order.editHistory?.length ? '(Revised)' : ''}
                                    </button>
                                  </div>
                                  <div>Cashier: {detail.order.cashier}</div>
                                  <div>Date: {new Date(detail.order.orderDate).toLocaleString()}</div>
                                  {detail.order.status === 'refunded' && (
                                    <div className="bg-gray-200 text-gray-700 rounded px-3 py-1 text-xs font-medium">This order has been refunded.</div>
                                  )}
                                  <table className="w-full border-collapse text-xs bg-white">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="p-1 text-left border">Code</th>
                                        <th className="p-1 text-left border">Qty</th>
                                        <th className="p-1 text-left border">Amount</th>
                                        <th className="p-1 text-left border">Discount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.order.products.map((p) => (
                                        <tr key={p.productID}>
                                          <td className="p-1 border">{p.productID}</td>
                                          <td className="p-1 border">{p.quantity}</td>
                                          <td className="p-1 border">{formatMoney(p.amount)}</td>
                                          <td className="p-1 border">{p.discount}% ({p.discountType})</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <div className="flex justify-between font-semibold border-t pt-2">
                                    <span>Total</span><span>{formatMoney(detail.order.totalAmount)}</span>
                                  </div>
                                  <div className="flex justify-between"><span>Paid</span><span>{formatMoney(detail.order.amountPaid)}</span></div>
                                  <div className="flex justify-between"><span>Balance Due</span><span>{formatMoney(detail.order.balanceDue)}</span></div>

                                  {detail.order.editHistory?.length > 0 && (
                                    <div>
                                      <h3 className="font-medium text-brand-green mb-1">Edit History</h3>
                                      <ul className="text-xs space-y-1">
                                        {detail.order.editHistory.map((e, i) => (
                                          <li key={i} className="border-b pb-1">
                                            {e.productID}: {e.originalQty} → {e.newQty} ({e.action}) by {e.editedBy} on {new Date(e.editedAt).toLocaleString()} — "{e.reason}"
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  {detail.refunds?.length > 0 && (
                                    <div>
                                      <h3 className="font-medium text-red-600 mb-1">Refunds</h3>
                                      <ul className="text-xs space-y-1">
                                        {detail.refunds.map((r) => (
                                          <li key={r._id} className="border-b pb-1">
                                            {formatMoney(r.refundAmount)} by {r.processedBy} on {new Date(r.refundDate).toLocaleString()} — "{r.reason}"
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>

                                {isAdmin && detail.order.status !== 'refunded' && (
                                  <div className="space-y-3">
                                    <div className="border border-dashed border-gray-300 rounded-lg p-3 bg-white">
                                      <h3 className="font-medium mb-2">
                                        Edit a line item {!editWindowOpen(detail.order) && <span className="text-red-500 text-xs">(72h window expired)</span>}
                                      </h3>
                                      {editWindowOpen(detail.order) && (
                                        <form onSubmit={handleEditSubmit} className="space-y-2">
                                          <select
                                            value={editForm.productID}
                                            onChange={(e) => setEditForm({ ...editForm, productID: e.target.value })}
                                            className="border rounded px-2 py-1 w-full text-sm"
                                          >
                                            <option value="">Select item</option>
                                            {detail.order.products.map((p) => (
                                              <option key={p.productID} value={p.productID}>{p.productID} (qty {p.quantity})</option>
                                            ))}
                                          </select>
                                          <input
                                            type="number"
                                            min="0"
                                            placeholder="New quantity (0 = remove)"
                                            value={editForm.newQty}
                                            onChange={(e) => setEditForm({ ...editForm, newQty: e.target.value })}
                                            className="border rounded px-2 py-1 w-full text-sm"
                                          />
                                          <input
                                            type="text"
                                            placeholder="Reason (required)"
                                            value={editForm.reason}
                                            onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })}
                                            className="border rounded px-2 py-1 w-full text-sm"
                                          />
                                          <button type="submit" className="w-full bg-brand text-white rounded py-1.5 text-sm hover:bg-brand-dark">
                                            Save Edit
                                          </button>
                                        </form>
                                      )}
                                    </div>

                                    <div className="border border-dashed border-red-300 rounded-lg p-3 bg-white">
                                      <h3 className="font-medium mb-2 text-red-700">Refund items</h3>
                                      <form onSubmit={handleRefundSubmit} className="space-y-2">
                                        {detail.order.products.map((p) => (
                                          <label key={p.productID} className="flex items-center gap-2 text-xs">
                                            <input
                                              type="checkbox"
                                              checked={refundForm[p.productID] !== undefined}
                                              onChange={() => toggleRefundItem(p.productID, p.quantity)}
                                            />
                                            {p.productID} (up to {p.quantity})
                                            {refundForm[p.productID] !== undefined && (
                                              <input
                                                type="number"
                                                min="1"
                                                max={p.quantity}
                                                value={refundForm[p.productID]}
                                                onChange={(e) => setRefundForm({ ...refundForm, [p.productID]: e.target.value })}
                                                className="border rounded px-1 py-0.5 w-16 ml-auto"
                                              />
                                            )}
                                          </label>
                                        ))}
                                        <input
                                          type="text"
                                          placeholder="Reason (required)"
                                          value={refundReason}
                                          onChange={(e) => setRefundReason(e.target.value)}
                                          className="border rounded px-2 py-1 w-full text-sm"
                                        />
                                        <button type="submit" className="w-full bg-red-600 text-white rounded py-1.5 text-sm hover:bg-red-700">
                                          Process Refund
                                        </button>
                                      </form>
                                    </div>
                                  </div>
                                )}
                              </div>
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
        </div>
      </main>
    </div>
  );
}