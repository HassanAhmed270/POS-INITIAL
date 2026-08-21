import { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from '../components/Sidebar';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { roundMoney, formatMoney } from '../lib/money';
import { printReceipt } from '../lib/print';
import { isOfflineSyncEnabled, enqueueSale } from '../lib/offlineQueue';
import { isNetworkError, flushQueue } from '../lib/offlineSync';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyCustomerForm = { customerName: '', mobileNo: '', emergencyMobile: '', email: '', address: '' };
// Stage 19: sentinel customerName for an untracked walk-in sale — must
// match WALKIN_CUSTOMER in main.js exactly, since this string is sent
// straight through as the order's customerName (same as any real
// customer's name is today) and the backend special-cases this one value
// to skip the Customer lookup/record entirely.
const WALKIN_CUSTOMER = 'Walk-in / Unknown';


export default function Billing() {
  const { username } = useAuth();

  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  // Stage 17 — Special Bill needs more than the bare name the dropdown
  // uses (mobile/address/email), but that data already exists on the
  // Customer document (GET /api/customers already returns it) — this is
  // just a lookup kept alongside the name list, not a new field or a new
  // request. Keyed by customerName.
  const [customerDirectory, setCustomerDirectory] = useState({});
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState(null);

  const [customer, setCustomer] = useState('unknown');
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [customerForm, setCustomerForm] = useState(emptyCustomerForm);

  const [itemForm, setItemForm] = useState({ productId: '', productName: '', unitPrice: '', quantity: '', discount: '', discountType: 'none' });
  const [showDiscount, setShowDiscount] = useState(false);
  const [billingItems, setBillingItems] = useState({}); // { itemNo: {...} }
  const [itemNo, setItemNo] = useState(0);

  const [view, setView] = useState('add'); // 'add' | 'preview'
  const [billId, setBillId] = useState(null);
  const [paid, setPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  // Stage 17 — Special Bill (catering-invoice-style layout). Purely a
  // second presentation of the exact same draft/order data — no new
  // fields, no separate commit path. `false` = closed, `true` = preview
  // open (nothing committed yet).
  const [showSpecialPreview, setShowSpecialPreview] = useState(false);

  // Stage 11 — offline sync. `isOnline` mirrors the browser's own signal;
  // it's the fast/local half of "are we connected" (an actual failed
  // request is still the real source of truth — see handleAddToBill/
  // handleGenerateBill below, which fall back on a genuine network error
  // even if isOnline was stale). Only ever consulted when the module is
  // enabled (VITE_ENABLE_OFFLINE_SYNC=true) — otherwise Billing behaves
  // exactly as it did before Stage 11.
  const offlineSyncEnabled = isOfflineSyncEnabled();
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    if (!offlineSyncEnabled) return;
    const goOnline = () => {
      setIsOnline(true);
      flushQueue(); // don't wait for the next 15s tick — try immediately on reconnect
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [offlineSyncEnabled]);


  const loadProducts = () =>
    api
      .getProducts({ limit: 1000 })
      .then((p) => setProducts(p.products || []))
      .catch((err) => setError(err.message || 'Failed to load products'));

  // Force-save the draft right now, bypassing the debounce below. Used at
  // the two points where the server absolutely needs to be caught up
  // before the next thing happens: right after a bill ID is reserved
  // (Preview) and right before discarding (Cancel). Everywhere else, the
  // debounced autosave is enough — see CLAUDE.md Stage 4.
  const saveDraftNow = async (itemsOverride, custOverride, billIdOverride) => {
    const source = itemsOverride ?? billingItems;
    const itemsArr = Object.values(source).map((it) => ({
      productID: `#${it.productCode}`,
      productName: it.itemName,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      discount: it.discount,
      discountType: it.discountType || 'manual',   // ← add this line
    }));
    try {
      await api.saveDraft({
        billID: billIdOverride !== undefined ? billIdOverride : billId,
        customerName: custOverride !== undefined ? custOverride : customer,
        items: itemsArr,
        // Carried in the draft, same as everything else committed from it
        // (Stage 5) — the server reads this at commit time instead of
        // trusting a value sent only with the commit request.
        paidInput: parseFloat(paid) || 0,
        paymentMethod,
      });
    } catch (err) {
      console.error('Draft save failed:', err.message);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([
          loadProducts(),
          api.getCustomers().then((c) => {
            const rows = c.customers || [];
            setCustomers(rows.map((row) => row.customerName));
            setCustomerDirectory(
              Object.fromEntries(rows.map((row) => [row.customerName, {
                mobileNo: row.mobileNo || '',
                email: row.email || '',
                address: row.address || '',
              }]))
            );
          }),
        ]);
      } catch (err) {
        setError(err.message || 'Failed to load billing data');
      }

      // Offer to resume an unfinished bill from a previous session/crash.
      // The stock for these items is already reserved server-side (it was
      // held when they were originally added) — resuming just rehydrates
      // local state to match, it doesn't reserve anything new.
      try {
        const data = await api.getDraft();
        if (data.draft && data.draft.items?.length > 0) {
          const resume = confirm(`You have an unfinished bill with ${data.draft.items.length} item(s) from earlier. Resume it?`);
          if (resume) {
            const restored = {};
            data.draft.items.forEach((it, idx) => {
              restored[idx + 1] = {
                productCode: it.productID.replace('#', ''),
                itemName: it.productName,
                unitPrice: it.unitPrice,
                quantity: it.quantity,
                discount: it.discount,
                discountType: it.discountType || 'manual',   // ← add this line
              };
            });
            setBillingItems(restored);
            setItemNo(data.draft.items.length);
            setCustomer(data.draft.customerName || 'unknown');
            setBillId(data.draft.billID || null);
            setPaid(data.draft.paidInput ? String(data.draft.paidInput) : '');
            setPaymentMethod(data.draft.paymentMethod || 'cash');
          } else {
            await api.discardDraft();
            await loadProducts(); // released stock changed availability — resync
          }
        }
      } catch (err) {
        console.error('Failed to check for a draft bill:', err.message);
      }
    })();
  }, []);

  // Debounced autosave: fires ~7s after the cart, customer, or bill ID last
  // changed (spec range was 5-10s). Skips while the cart is empty so we
  // don't overwrite a not-yet-resumed draft with nothing before the person
  // has answered the resume prompt above.
  const draftSaveTimeout = useRef(null);
  useEffect(() => {
    if (Object.keys(billingItems).length === 0) return;
    if (draftSaveTimeout.current) clearTimeout(draftSaveTimeout.current);
    draftSaveTimeout.current = setTimeout(() => {
      saveDraftNow();
    }, 7000);
    return () => clearTimeout(draftSaveTimeout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingItems, customer, billId, paid, paymentMethod]);

  // Best-effort release of any still-held reservations when the person
  // navigates away without checking out — a real tab close/reload (which
  // React's own unmount cleanup can't reliably catch) is handled via
  // `beforeunload` + `fetch(..., { keepalive: true })` below. This is a
  // safety net, not a guarantee: if neither event fires (e.g. the OS kills
  // the browser), the reservation stays held until someone manually
  // corrects it — there's no server-side expiry in this stage. See
  // CLAUDE.md Stage 3 "still open".
  const billingItemsRef = useRef(billingItems);
  useEffect(() => {
    billingItemsRef.current = billingItems;
  }, [billingItems]);

  useEffect(() => {
    const releaseAllHeld = () => {
      const token = localStorage.getItem('pos.token');
      Object.values(billingItemsRef.current).forEach((item) => {
        fetch('/billing/release', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ productId: `#${item.productCode}`, quantity: item.quantity }),
        }).catch(() => { });
      });
    };
    window.addEventListener('beforeunload', releaseAllHeld);
    return () => {
      window.removeEventListener('beforeunload', releaseAllHeld);
      releaseAllHeld(); // leaving the Billing page within the SPA
    };
  }, []);

  const filteredProducts = useMemo(() => {
    if (!search) return products;
    const q = search.toLowerCase();
    return products.filter((p) => p.productName.toLowerCase().startsWith(q));
  }, [products, search]);

  const grandTotal = useMemo(() => {
    const total = Object.values(billingItems).reduce((sum, item) => {
      const subtotal = item.unitPrice * item.quantity;
      const net = subtotal - subtotal * (item.discount / 100);
      return sum + net;
    }, 0);
    return roundMoney(total);
  }, [billingItems]);

  const balance = useMemo(() => {
    const paidNum = parseFloat(paid) || 0;
    return roundMoney(paidNum - grandTotal);
  }, [paid, grandTotal]);

  const handleSelectProduct = (p) => {
    setSelectedProductId(p.productID);
    setItemForm({
      productId: p.productID,
      productName: p.productName,
      unitPrice: p.price ?? 0,
      quantity: '',
      discount: '',
      discountType: 'none',   // ← add this line
    });
    setShowDiscount(false);   // ← add this line
  };

  const handleAddToBill = async () => {
    if (!selectedProductId) {
      alert('Please select a product from the table first!');
      return;
    }
    const quantity = parseInt(itemForm.quantity);
    const discount = parseFloat(itemForm.discount) || 0;
    const unitPrice = roundMoney(itemForm.unitPrice);

    if (!itemForm.productName || isNaN(unitPrice) || isNaN(quantity) || quantity <= 0) {
      alert('Please enter valid item details!');
      return;
    }
    if (discount < 0 || discount > 100) {
      alert('Discount must be between 0 and 100.');
      return;
    }

    const product = products.find((p) => p.productID === selectedProductId);
    if (!product) {
      alert('Invalid product selection!');
      return;
    }

    // Server-side atomic reserve — this is the actual stock guard. The
    // client-side `available` check above is just for a snappy error
    // message; if two cashiers race for the last unit, this call is what
    // decides who actually gets it (see CLAUDE.md Stage 3).
    let reserved;
    try {
      reserved = await api.reserveStock(selectedProductId, quantity);
    } catch (err) {
      // Stage 11: a genuine network failure (not "stock unavailable" —
      // that's a normal rejected response, not a thrown network error)
      // while the module is enabled means we can't reserve, but the sale
      // can still be captured provisionally and re-validated at sync
      // time (see lib/offlineSync.js, routes/sync.js). Anything else
      // (insufficient stock, invalid product) behaves exactly as before.
      if (offlineSyncEnabled && isNetworkError(err)) {
        const alreadyInCart = Object.values(billingItems)
          .filter((it) => it.productCode === selectedProductId.replace('#', ''))
          .reduce((sum, it) => sum + it.quantity, 0);
        const softAvailable = (product.available ?? product.quantity - (product.reserved || 0)) - alreadyInCart;
        if (softAvailable < quantity) {
          alert(`Offline — based on the last known stock, only ${Math.max(softAvailable, 0)} unit(s) of this item look available. Add fewer, or confirm with the customer.`);
          return;
        }
        const nextItemNo = itemNo + 1;
        setItemNo(nextItemNo);
        setBillingItems((prev) => ({
          ...prev,
          [nextItemNo]: {
            productCode: selectedProductId.replace('#', ''),
            itemName: itemForm.productName,
            unitPrice,
            quantity,
            discount: roundMoney(discount),
            discountType: discount > 0 ? itemForm.discountType : 'none',
            offline: true, // never reserved server-side — re-validated at sync time
          },
        }));
        setItemForm({ productId: '', productName: '', unitPrice: '', quantity: '', discount: '', discountType: 'none' });
        setShowDiscount(false);
        setSelectedProductId(null);
        return;
      }
      alert(err.message || 'Could not reserve stock for this item.');
      await loadProducts(); // someone else's sale likely just changed availability — resync
      return;
    }

    setProducts((prev) =>
      prev.map((p) =>
        p.productID === selectedProductId
          ? { ...p, quantity: reserved.quantity, reserved: reserved.reserved, available: reserved.available, lowStock: reserved.available <= (p.lowStockThreshold ?? 10) }
          : p
      )
    );

    const nextItemNo = itemNo + 1;
    setItemNo(nextItemNo);
    setBillingItems((prev) => ({
      ...prev,
      [nextItemNo]: {
        productCode: selectedProductId.replace('#', ''),
        itemName: itemForm.productName,
        unitPrice,
        quantity,
        discount: roundMoney(discount),
        discountType: discount > 0 ? itemForm.discountType : 'none',   // ← add this line
      },
    }));

    setItemForm({ productId: '', productName: '', unitPrice: '', quantity: '', discount: '', discountType: 'none' }); // ← add discountType here
    setShowDiscount(false);   // ← add this line
    setSelectedProductId(null);
  };

  const handlePreview = async () => {
    if (billId) {
      // Already have one — either from earlier this session, or restored
      // from a resumed draft. Don't burn a second order ID.
      setView('preview');
      return;
    }
    try {
      let candidate = '#' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      // Ask the server for a free order id, same retry loop as the original app.
      // (kept small since this is a low-volume single-shop system)
      for (let i = 0; i < 20; i++) {
        try {
          const data = await api.getUniqueOrderId(candidate);
          if (!data.exists) break;
          const num = (parseInt(candidate.slice(1)) + 1) % 10000;
          candidate = '#' + num.toString().padStart(4, '0');
        } catch (err) {
          // Stage 11: can't ask the server offline — use this candidate
          // as a local placeholder. It's informational only; the real ID
          // gets allocated server-side at sync time (see
          // lib/offlineSync.js's allocateOrderId), so a collision here
          // just means the synced order ends up with a different number.
          if (offlineSyncEnabled && isNetworkError(err)) break;
          throw err;
        }
      }
      setBillId(candidate);
      if (offlineSyncEnabled && !isOnline) {
        // No server draft to persist to while offline — the whole cart
        // stays client-side until Generate Bill queues it (see
        // handleGenerateBill).
        setView('preview');
        return;
      }
      // Persist the reserved ID immediately rather than waiting for the
      // debounce — if the person clicks Generate Bill in the next second,
      // the server needs to already know this bill's ID. (saveDraftNow
      // already swallows its own errors — see its definition above — so
      // a network hiccup here just means the debounced autosave picks it
      // up later instead.)
      await saveDraftNow(undefined, undefined, candidate);
      setView('preview');
    } catch (err) {
      alert('Error generating bill id: ' + err.message);
    }
  };

  const removeItem = async (key) => {
    if (!confirm('Do you want to remove this item?')) return;
    const item = billingItems[key];

    // Remove from the cart immediately for responsiveness; the release
    // call runs after, and if it fails we just log it — worst case the
    // reservation lingers until the beforeunload/unmount safety net or a
    // manual admin correction clears it (see CLAUDE.md Stage 3).
    setBillingItems((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      // Offline-added items were never reserved server-side (Stage 11) —
      // nothing to release.
      if (item.offline) {
        return;
      }
      const released = await api.releaseStock(`#${item.productCode}`, item.quantity);
      setProducts((prev) =>
        prev.map((p) =>
          p.productID === `#${item.productCode}`
            ? { ...p, quantity: released.quantity ?? p.quantity, reserved: released.reserved ?? p.reserved, available: released.available ?? p.available }
            : p
        )
      );
    } catch (err) {
      console.error('Failed to release reserved stock:', err.message);
    }
  };

  const resetBill = () => {
    setBillingItems({});
    setItemNo(0);
    setBillId(null);
    setPaid('');
    setPaymentMethod('cash');
    setView('add');
  };

  const handleCancel = async () => {
    // Make sure the server's draft reflects exactly what we're about to
    // discard — anything added in the last few seconds might not have
    // hit the debounced autosave yet.
    await saveDraftNow();
    resetBill();
    try {
      await api.discardDraft(); // releases every reserved item in one call
    } catch (err) {
      console.error('Failed to discard draft:', err.message);
    }
    await loadProducts();
  };

  // Extracted from the original inline receipt-building so both the
  // normal (online) success path and the Stage 11 offline-queued path
  // can share it — `offline` just adds a visible marker so the printed
  // slip is honest about not being a confirmed sale yet.
  const printReceiptFor = (total, paidNum, offline = false) => {
    const rows = Object.entries(billingItems)
      .map(([key, item]) => {
        const subtotal = item.unitPrice * item.quantity;
        const net = roundMoney(subtotal - subtotal * (item.discount / 100));
        return `<tr><td>${key}</td><td>${item.productCode}</td><td>${item.itemName}</td><td>${formatMoney(item.unitPrice)}</td><td>${item.quantity}</td><td>${formatMoney(subtotal)}</td><td>${item.discount}%</td><td>${formatMoney(net)}</td></tr>`;
      })
      .join('');

    const html = `
      <h2 style="text-align:center;font-weight:bold;font-size:20px;border-bottom:1px solid #ddd;padding-bottom:8px;">Receipt</h2>
      <div style="margin:8px 0;font-weight:600;">Bill ID: ${billId}</div>
      ${offline ? '<div style="margin:8px 0;font-weight:700;color:#b45309;">OFFLINE — PENDING SYNC (not yet confirmed)</div>' : ''}

      <table>
        <thead><tr><th>S.no</th><th>Code</th><th>Product</th><th>Price</th><th>Qty</th><th>Total</th><th>Save</th><th>Net</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="totals"><span>Grand Total</span><span>${formatMoney(total)}</span></div>
      <div class="totals"><span>Paid</span><span>${formatMoney(paidNum)}</span></div>
      <div class="totals"><span>${paidNum >= total ? 'Change' : 'Balance Due (Credit)'}</span><span>${formatMoney(Math.abs(paidNum - total))}</span></div>
      <div style="margin-top:8px;">Customer: ${customer}</div>
    `;
    printReceipt(html);
  };

  // Stage 17 — Special Bill: same data as printReceiptFor, laid out to
  // match the catering-invoice-style pattern provided for this stage
  // (title block, Billed To box, Order Info box, a plainer Qty/
  // Description/Price/Amount table, grand total, thank-you footer).
  // Deliberately drops nothing from the DB it doesn't have — no
  // company/logo/ship-to/delivery-time fields exist anywhere in this
  // app, so those boxes from the reference template are simply omitted
  // rather than faked.
  const printSpecialReceiptFor = (total, paidNum, offline = false) => {
    const details = customerDirectory[customer] || {};
    const rows = Object.entries(billingItems)
      .map(([, item]) => {
        const subtotal = item.unitPrice * item.quantity;
        const net = roundMoney(subtotal - subtotal * (item.discount / 100));
        return `<tr><td>${item.quantity}</td><td>${item.itemName} (${item.productCode})</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(net)}</td></tr>`;
      })
      .join('');

    const html = `
      <div style="border:3px double #0f6674;padding:18px;">
        <img src="${window.location.origin}/logo.png" alt="" style="display:block;margin:0 auto 8px;max-height:60px;" onerror="this.style.display='none'" />
        <h1 style="text-align:center;color:#0f6674;font-size:22px;letter-spacing:1px;margin:0 0 16px;">INVOICE</h1>
        ${offline ? '<div style="margin:0 0 12px;font-weight:700;color:#b45309;text-align:center;">OFFLINE — PENDING SYNC (not yet confirmed)</div>' : ''}

        <table style="margin-bottom:0;">
          <tr>
            <td style="width:50%;background:#f6dede;font-weight:700;color:#0f6674;">BILLED TO</td>
            <td style="width:50%;background:#f6dede;font-weight:700;color:#0f6674;">ORDER INFO</td>
          </tr>
          <tr>
            <td style="vertical-align:top;">
              ${customer}<br/>
              ${details.mobileNo ? details.mobileNo + '<br/>' : ''}
              ${details.address ? details.address + '<br/>' : ''}
              ${details.email ? details.email : ''}
            </td>
            <td style="vertical-align:top;">
              Invoice No: ${billId}<br/>
              Date: ${new Date().toLocaleString()}<br/>
              Served by: ${username}<br/>
              Payment: ${paymentMethod}
            </td>
          </tr>
        </table>

        <table style="margin-top:12px;">
          <thead><tr style="background:#f6dede;color:#0f6674;"><th>Quantity</th><th>Description</th><th>Price of Each Item</th><th>Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <div class="totals"><span>Grand Total</span><span>${formatMoney(total)}</span></div>
        <div class="totals"><span>Paid</span><span>${formatMoney(paidNum)}</span></div>
        <div class="totals"><span>${paidNum >= total ? 'Change' : 'Balance Due (Credit)'}</span><span>${formatMoney(Math.abs(paidNum - total))}</span></div>

        <p style="text-align:center;color:#0f6674;font-style:italic;margin-top:18px;">"Thanks"</p>
      </div>
    `;
    printReceipt(html);
  };

  const handleGenerateBill = async (special = false) => {
    const total = grandTotal;
    const paidNum = parseFloat(paid) || 0;
    if (paidNum < 0) {
      alert('Payment amount can\'t be negative.');
      return;
    }
    if (customer === 'unknown') {
      alert('Please select a customer before generating the bill.');
      return;
    }
    // Underpayment is now allowed — the shortfall becomes customer credit
    // (Stage 5) — but it's still worth a confirmation so nobody generates
    // a bill on $0 paid by mistake.
    if (paidNum < total) {
      const shortfall = roundMoney(total - paidNum);
      const proceed = confirm(
        `Customer is paying ${formatMoney(paidNum)} of ${formatMoney(total)}. ` +
        `${formatMoney(shortfall)} will be recorded as a balance owed on their account. Continue?`
      );
      if (!proceed) return;
    }

    try {
      // Make sure the server's draft is exactly what's on screen before
      // asking it to commit — it's what the server treats as the source
      // of truth for what's being sold (see CLAUDE.md Stage 4).
      await saveDraftNow();

      // No payload: the server reads the cashier's persisted draft rather
      // than trusting anything sent here. It re-verifies price/discount
      // against the draft (Stage 2/4), commits stock atomically, computes
      // amountPaid/balanceDue/paymentStatus from draft.paidInput (Stage
      // 5), and clears the draft on success (Stage 3/4) — nothing further
      // to send or persist from this side.
      const data = await api.saveOrder();
      if (!data.success) {
        alert(data.message || 'Order failed. Try again.');
        return;
      }

      (special ? printSpecialReceiptFor : printReceiptFor)(total, paidNum);
      alert('Order saved successfully.');
      resetBill();
      setCustomer('unknown');
      setShowSpecialPreview(false);
      await loadProducts();
    } catch (err) {
      // Stage 11: a genuine network failure — not a rejected order — is
      // the one case where we don't just show an error. The whole cart
      // gets queued as one offline sale (durable in IndexedDB) instead of
      // lost, and re-validated against live stock/prices when the queue
      // flushes (see lib/offlineSync.js, routes/sync.js). Any other
      // failure (validation, stock conflict while actually online, etc.)
      // behaves exactly as before Stage 11.
      if (offlineSyncEnabled && isNetworkError(err)) {
        try {
          await enqueueSale({
            idempotencyKey: crypto.randomUUID(),
            clientBillID: billId,
            customerName: customer,
            items: Object.values(billingItems).map((it) => ({
              productID: `#${it.productCode}`,
              productName: it.itemName,
              unitPrice: it.unitPrice,
              quantity: it.quantity,
              discount: it.discount,
              discountType: it.discountType || 'manual',
            })),
            paidInput: paidNum,
            paymentMethod,
            createdOfflineAt: new Date().toISOString(),
          });
          (special ? printSpecialReceiptFor : printReceiptFor)(total, paidNum, true);
          alert('No connection — this bill has been saved on this device and will sync automatically once you\'re back online.');
          resetBill();
          setCustomer('unknown');
          setShowSpecialPreview(false);
        } catch (queueErr) {
          alert('Could not save this bill, even offline: ' + queueErr.message);
        }
        return;
      }
      alert('Error saving order: ' + err.message);
    }
  };

  const handleCustomerSelect = (value) => {
    if (value === 'New Customer') {
      setShowCustomerForm(true);
      setCustomer('unknown');
    } else {
      setCustomer(value);
    }
  };

  const handleAddNewCustomer = async (e) => {
    e.preventDefault();
    const { customerName, mobileNo, emergencyMobile, email, address } = customerForm;
    if (!customerName && !mobileNo && !emergencyMobile && !email && !address) {
      setShowCustomerForm(false);
      return;
    }
    if (email && !emailPattern.test(email)) {
      alert('Please enter a valid email address.');
      return;
    }
    const cleanName = customerName.trim().replace(/\s+/g, ' ');
    try {
      const data = await api.addCustomer({ customerName: cleanName, mobileNo, emergencyMobile, email, address });
      if (data.success) {
        setCustomers((prev) => [...prev, cleanName]);
        setCustomerDirectory((prev) => ({ ...prev, [cleanName]: { mobileNo, email, address } }));
        setCustomer(cleanName);
        alert('New customer added successfully!');
      } else {
        alert(data.message || 'Failed to add new customer.');
      }
    } catch (err) {
      alert('Error adding customer: ' + err.message);
    } finally {
      setShowCustomerForm(false);
      setCustomerForm(emptyCustomerForm);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 pl-14 pr-4 py-4 md:p-6 overflow-y-auto relative">
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-brand">Creating Invoice</h1>
            <select
              value={showCustomerForm ? 'New Customer' : customer}
              onChange={(e) => handleCustomerSelect(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 w-full sm:w-52 focus:ring-2 focus:ring-brand focus:outline-none"
            >
              <option value="unknown">Select Customer</option>
              <option value={WALKIN_CUSTOMER}>🚶 Walk-in / Unknown</option>
              {customers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value="New Customer">+ New customer</option>
            </select>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          {offlineSyncEnabled && !isOnline && (
            <div className="bg-amber-50 border border-amber-300 text-amber-800 text-sm rounded-lg px-4 py-2">
              You're offline. Bills can still be created — they'll be saved on this device and synced automatically
              once you're back online. Stock and prices will be re-checked at that point.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:h-[600px]">
            <div className="md:col-span-2 bg-white rounded-lg shadow p-4 md:overflow-y-auto">
              <input
                type="text"
                placeholder="Search Products"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 w-full mb-3 focus:ring-2 focus:ring-brand focus:outline-none"
              />
              <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead className="bg-brand text-white">
                  <tr>
                    <th className="text-left p-2">Code</th>
                    <th className="text-left p-2">Name</th>
                    <th className="text-left p-2">In Stock</th>
                    <th className="text-left p-2">Unit Price</th>
                    <th className="text-left p-2">Stock's Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.length === 0 ? (
                    <tr><td colSpan={5} className="p-2 text-center text-gray-500">No products available</td></tr>
                  ) : (
                    filteredProducts.map((p) => {
                      const available = p.available ?? p.quantity - (p.reserved || 0);
                      const lowStock = p.lowStock ?? available <= (p.lowStockThreshold ?? 10);
                      return (
                        <tr
                          key={p.productID}
                          onClick={() => handleSelectProduct(p)}
                          className={`cursor-pointer hover:bg-blue-50 ${selectedProductId === p.productID ? 'bg-blue-100' : ''} ${lowStock ? 'bg-red-50' : ''}`}
                        >
                          <td className="p-2">{p.productID}</td>
                          <td className="p-2">{p.productName}</td>
                          <td className={`p-2 ${lowStock ? 'text-red-700 font-semibold' : ''}`}>
                            {available}
                            {lowStock && <span className="ml-1 text-xs font-normal">⚠ low</span>}
                          </td>
                          <td className="p-2">{formatMoney(p.price ?? 0)}</td>
                          <td className="p-2">{formatMoney((p.price ?? 0) * available)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {view === 'add' ? (
              <div className="md:overflow-y-auto bg-white rounded-lg shadow p-4 space-y-3">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-medium text-lg text-brand">Add Product</h3>
                  {billId && <h3><b className="text-brand-green">Bill ID:</b> <span className="font-semibold text-lg">{billId}</span></h3>}
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Product ID</label>
                    <input type="text" value={itemForm.productId} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Product Name</label>
                    <input type="text" value={itemForm.productName} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Unit Price</label>
                    <input type="number" value={itemForm.unitPrice} disabled className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 bg-gray-100" />
                  </div>
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium">Quantity</label>
                    <input
                      type="number"
                      value={itemForm.quantity}
                      onChange={(e) => setItemForm({ ...itemForm, quantity: e.target.value })}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-2/3 focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  {!showDiscount ? (
                    <button
                      type="button"
                      onClick={() => setShowDiscount(true)}
                      className="text-sm text-brand-green font-medium hover:underline"
                    >
                      + Add Discount
                    </button>
                  ) : (
                    <div className="border border-dashed border-gray-300 rounded-lg p-3 space-y-2">
                      <div className="flex justify-between items-center">
                        <label className="text-sm font-medium">Discount</label>
                        <button
                          type="button"
                          onClick={() => setItemForm({ ...itemForm, discount: '', discountType: 'none' })}
                          className="text-xs text-gray-400 hover:text-red-600"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="flex gap-2">
                        {[10, 15, 20].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => setItemForm({ ...itemForm, discount: String(pct), discountType: 'preset' })}
                            className={`flex-1 py-1.5 rounded-lg text-sm border ${itemForm.discountType === 'preset' && Number(itemForm.discount) === pct
                                ? 'bg-brand-green text-white border-brand-green'
                                : 'bg-white text-gray-700 border-gray-300 hover:border-brand-green'
                              }`}
                          >
                            {pct}%
                          </button>
                        ))}
                      </div>
                      <div className="flex justify-between items-center">
                        <label className="text-xs text-gray-500">Or manual %</label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={itemForm.discount}
                          onChange={(e) => setItemForm({ ...itemForm, discount: e.target.value, discountType: 'manual' })}
                          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-2/3 focus:ring-2 focus:ring-brand-green"
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between pt-4">
                    <button onClick={handleAddToBill} className="bg-brand-green text-white px-4 py-2 rounded-lg shadow hover:bg-green-700">
                      Add to Bill
                    </button>
                    <button
                      onClick={handlePreview}
                      disabled={Object.keys(billingItems).length === 0}
                      className="bg-brand text-white px-4 py-2 rounded-lg shadow hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Preview
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="md:overflow-y-auto bg-white rounded-lg shadow p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-medium text-lg text-brand">Bill Summary</h3>
                  <h3><b className="text-brand-green">Cashier:</b> <span className="font-semibold text-lg text-brand">{username}</span></h3>
                </div>

                <div className="max-w-md mx-auto bg-white border rounded-lg p-4 font-mono shadow text-sm space-y-2">
                  <h2 className="text-center font-bold text-lg border-b pb-2">Receipt</h2>
                  <div className="font-semibold">Bill ID: {billId}</div>
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-gray-100 text-gray-700">
                      <tr>
                        <th className="p-1 text-left border">#</th>
                        <th className="p-1 text-left border">Code</th>
                        <th className="p-1 text-left border">Product</th>
                        <th className="p-1 text-left border">Price</th>
                        <th className="p-1 text-left border">Qty</th>
                        <th className="p-1 text-left border">Total</th>
                        <th className="p-1 text-left border">Save</th>
                        <th className="p-1 text-left border">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(billingItems).map(([key, item]) => {
                        const subtotal = item.unitPrice * item.quantity;
                        const net = roundMoney(subtotal - subtotal * (item.discount / 100));
                        return (
                          <tr key={key} className="cursor-pointer hover:bg-red-50" onClick={() => removeItem(key)} title="Click to remove">
                            <td className="border text-center py-1">{key}</td>
                            <td className="border py-1">{item.productCode}</td>
                            <td className="border py-1">{item.itemName}</td>
                            <td className="border py-1">{formatMoney(item.unitPrice)}</td>
                            <td className="border py-1">{item.quantity}</td>
                            <td className="border py-1">{formatMoney(subtotal)}</td>
                            <td className="border py-1">{item.discount}%</td>
                            <td className="border py-1">{formatMoney(net)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
                    <span>Grand Total</span>
                    <span>{formatMoney(grandTotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Paid</span>
                    <input
                      type="number"
                      step="0.01"
                      value={paid}
                      onChange={(e) => setPaid(e.target.value)}
                      className="border px-2 w-24 text-right rounded"
                    />
                  </div>
                  <div className="flex justify-between text-sm mt-1 items-center">
                    <span>Method</span>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="border px-2 py-1 rounded text-sm"
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className={`flex justify-between text-sm font-semibold mt-1 ${balance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    <span>{balance < 0 ? 'Balance Due (Credit)' : 'Change'}</span>
                    <span>{formatMoney(Math.abs(balance))}</span>
                  </div>
                </div>

                <button onClick={() => handleGenerateBill(false)} className="w-full py-2 bg-brand text-white rounded-lg shadow hover:bg-blue-700">
                  Generate Bill
                </button>
                <button
                  onClick={() => {
                    if (customer === 'unknown') {
                      alert('Please select a customer before previewing the Special Bill.');
                      return;
                    }
                    if (Object.keys(billingItems).length === 0) {
                      alert('Add at least one item before previewing the Special Bill.');
                      return;
                    }
                    setShowSpecialPreview(true);
                  }}
                  className="w-full py-2 border-2 border-brand text-brand rounded-lg hover:bg-brand hover:text-white"
                >
                  🧾 Special Bill
                </button>

                <div className="flex space-x-2">
                  <button onClick={() => setView('add')} className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand hover:text-white">
                    Add More
                  </button>
                  <button onClick={handleCancel} className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-brand-green hover:text-white">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {showCustomerForm && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-xl w-80">
              <h2 className="text-2xl font-bold mb-4 text-center">Add Customer</h2>
              <form onSubmit={handleAddNewCustomer} className="space-y-2">
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={customerForm.customerName}
                    onChange={(e) => setCustomerForm({ ...customerForm, customerName: e.target.value })}
                    placeholder="Customer Name"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Mobile</label>
                  <input
                    type="tel"
                    value={customerForm.mobileNo}
                    onChange={(e) => setCustomerForm({ ...customerForm, mobileNo: e.target.value })}
                    placeholder="Primary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Second No</label>
                  <input
                    type="tel"
                    value={customerForm.emergencyMobile}
                    onChange={(e) => setCustomerForm({ ...customerForm, emergencyMobile: e.target.value })}
                    placeholder="Secondary Mobile"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Email</label>
                  <input
                    type="email"
                    value={customerForm.email}
                    onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })}
                    placeholder="Email Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">Address</label>
                  <textarea
                    value={customerForm.address}
                    onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })}
                    placeholder="Customer Address"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div className="text-center pt-2 flex gap-2 justify-center">
                  <button type="submit" className="bg-brand text-white px-6 py-1.5 rounded hover:bg-brand-dark transition">
                    Add Customer
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCustomerForm(false); setCustomerForm(emptyCustomerForm); }}
                    className="bg-gray-200 text-gray-700 px-4 py-1.5 rounded hover:bg-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showSpecialPreview && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="border-4 border-double border-[#0f6674] m-4 p-5">
                <img src="/logo.png" alt="" className="block mx-auto mb-2 max-h-14" onError={(e) => { e.target.style.display = 'none'; }} />
                <h1 className="text-center text-[#0f6674] text-2xl font-bold tracking-wide mb-4">INVOICE</h1>

                <table className="w-full text-sm border-collapse">
                  <tbody>
                    <tr>
                      <td className="bg-[#f6dede] font-bold text-[#0f6674] p-2 border w-1/2">BILLED TO</td>
                      <td className="bg-[#f6dede] font-bold text-[#0f6674] p-2 border w-1/2">ORDER INFO</td>
                    </tr>
                    <tr>
                      <td className="align-top p-2 border">
                        {customer}<br />
                        {customerDirectory[customer]?.mobileNo && <>{customerDirectory[customer].mobileNo}<br /></>}
                        {customerDirectory[customer]?.address && <>{customerDirectory[customer].address}<br /></>}
                        {customerDirectory[customer]?.email}
                      </td>
                      <td className="align-top p-2 border">
                        Invoice No: {billId}<br />
                        Date: {new Date().toLocaleString()}<br />
                        Served by: {username}<br />
                        Payment: {paymentMethod}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <table className="w-full text-sm border-collapse mt-3">
                  <thead>
                    <tr className="bg-[#f6dede] text-[#0f6674]">
                      <th className="p-2 border text-left">Quantity</th>
                      <th className="p-2 border text-left">Description</th>
                      <th className="p-2 border text-left">Price of Each Item</th>
                      <th className="p-2 border text-left">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(billingItems).map(([key, item]) => {
                      const subtotal = item.unitPrice * item.quantity;
                      const net = roundMoney(subtotal - subtotal * (item.discount / 100));
                      return (
                        <tr key={key}>
                          <td className="p-2 border">{item.quantity}</td>
                          <td className="p-2 border">{item.itemName} ({item.productCode})</td>
                          <td className="p-2 border">{formatMoney(item.unitPrice)}</td>
                          <td className="p-2 border">{formatMoney(net)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="flex justify-between font-bold text-sm mt-3 pt-2 border-t">
                  <span>Grand Total</span><span>{formatMoney(grandTotal)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span>Paid</span><span>{formatMoney(parseFloat(paid) || 0)}</span>
                </div>
                <div className={`flex justify-between text-sm font-semibold mt-1 ${balance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  <span>{balance < 0 ? 'Balance Due (Credit)' : 'Change'}</span>
                  <span>{formatMoney(Math.abs(balance))}</span>
                </div>

                <p className="text-center text-[#0f6674] italic mt-4">"Thanks"</p>
              </div>

              <div className="flex gap-2 p-4 pt-0">
                <button
                  onClick={() => handleGenerateBill(true)}
                  className="w-1/2 py-2 bg-brand text-white rounded-lg shadow hover:bg-blue-700"
                >
                  Generate Bill
                </button>
                <button
                  onClick={() => setShowSpecialPreview(false)}
                  className="w-1/2 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}