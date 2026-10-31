// Dates as text, in the local time zone.

const pad = (n) => String(n).padStart(2, "0");

// dateText(new Date(), "/") → "2026/10/31"; with "" → "20261031" (for file names).
export function dateText(date = new Date(), separator = "-") {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(separator);
}
