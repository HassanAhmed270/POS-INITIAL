// Mirrors backend/lib/money.js — same rounding rule on both sides so a
// number computed in the browser and the same number recomputed by the
// server always agree (within the tiny epsilon the server allows for
// floating-point noise). Always parseFloat, never parseInt, for money.
export function roundMoney(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value) {
  return `$${roundMoney(value).toFixed(2)}`;
}