// Page ranges typed by hand, shared by the PDF tools.

// "1-3, 5" → page positions 0, 1, 2, 4. Full-width digits and 、 also work; "8-" runs to the
// last page and "-3" starts at the first. Returns null when the text is not a list of numbers
// and ranges.
export function parseRange(text, total) {
  const normal = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー〜～−]/g, "-")
    .replace(/[、，,\s]+/g, ",");
  const picked = new Set();
  for (const part of normal.split(",").filter(Boolean)) {
    const m = part.match(/^(\d*)-(\d*)$|^(\d+)$/);
    if (!m) return null;
    let from;
    let to;
    if (m[3]) from = to = Number(m[3]);
    else {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : total;
    }
    if (from > to) [from, to] = [to, from];
    for (let n = Math.max(1, from); n <= Math.min(total, to); n++) picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}
