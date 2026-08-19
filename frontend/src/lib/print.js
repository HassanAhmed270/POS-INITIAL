// Opens a plain popup window and sends it to the printer with the given
// HTML body. Kept deliberately simple — no framework, no Tailwind (the
// popup is outside the app's normal render tree) — just inline styles.
// Shared by Billing.jsx (receipts) and Orders.jsx (revised/edit-history
// print view, Stage 7).
export function printReceipt(html) {
  const printWindow = window.open('', '', 'width=600,height=800');
  printWindow.document.write(`
    <html>
      <head>
        <title>Print Receipt</title>
        <style>
          body { font-family: ui-monospace, monospace; padding: 16px; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; }
          .totals { display: flex; justify-content: space-between; font-weight: bold; margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd; }
          .edit-history { margin-top: 16px; padding-top: 8px; border-top: 2px dashed #999; }
          .edit-history h3 { margin: 0 0 6px; font-size: 14px; }
          .edit-history table { font-size: 12px; }
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.onload = () => {
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
  };
}