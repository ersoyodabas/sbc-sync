export function paginationDecision({ rowCount, parsedCount, olderCount }) {
  const rows = Math.max(0, Number(rowCount) || 0);
  const parsed = Math.max(0, Number(parsedCount) || 0);
  const older = Math.max(0, Number(olderCount) || 0);
  return {
    older,
    shouldContinue: rows > 0 && parsed > 0 && older === 0,
    reason: rows === 0 ? "empty-page" : parsed === 0 ? "no-valid-rows" : older > 0 ? "older-reached" : "all-in-range"
  };
}

export function lookbackStartDate(endDate, lookbackDays) {
  const [year, month, day] = String(endDate).split("-").map(Number);
  const days = Math.max(1, Math.floor(Number(lookbackDays) || 1));
  return new Date(Date.UTC(year, month - 1, day - (days - 1))).toISOString().slice(0, 10);
}

export function isDateInRange(value, startDate, endDate) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && value >= startDate && value <= endDate;
}

export function isDateBefore(value, startDate) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && value < startDate;
}

export function priceRangeRatio(record = {}) {
  const max = Number(record.max_price_ps ?? record.new_max_price);
  const buyNow = Number(record.price_ps ?? record.priceCross);
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(buyNow) || buyNow <= 0) return null;
  return max / buyNow;
}

export function priceRangeRatioDecision(record, minimumRatio = 3) {
  const ratio = priceRangeRatio(record);
  const threshold = Number(minimumRatio) || 3;
  return {
    ratio,
    qualifies: ratio !== null && ratio >= threshold,
    reason: ratio === null ? "range-max-or-buy-now-missing" : ratio < threshold ? "ratio-below-threshold" : "qualified"
  };
}
