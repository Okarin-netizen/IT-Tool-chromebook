// Colours from <input type="color"> ("#rrggbb") for pdf-lib.

// "#2563eb" → rgb(0.15, 0.39, 0.92), using pdf-lib's `rgb` (passed in, since pdf-lib is loaded lazily).
export function hexToRgb(hex, rgb) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
