// Putting the pages of one PDF onto the sheets of another with pdf-lib: several pages on one
// sheet (2in1, 4in1) or the halves of a booklet. Sizes are in PDF points and a cell is
// { x, y, w, h } with the origin at the lower left, as in pdf-lib.

// Embeds every page of `src` in `out`. Returns, for each page, { page, angle, width, height }:
// the embedded page, its /Rotate, and its size as shown (turned). `page` is null for a page
// with nothing on it (no content stream, like an added blank page), which cannot be embedded;
// its place on the sheet is left empty.
export async function embedPages(out, src) {
  const placed = [];
  for (const page of src.getPages()) {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const { width, height } = page.getSize();
    placed.push({
      page: page.node.Contents() ? await out.embedPage(page) : null,
      angle,
      width: angle % 180 ? height : width,
      height: angle % 180 ? width : height,
    });
  }
  return placed;
}

// Where a box of the given size lands in a cell: as large as fits, in the middle.
export function fitInCell(cell, width, height) {
  const k = Math.min(cell.w / width, cell.h / height);
  const w = width * k;
  const h = height * k;
  return { k, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

// Draws one entry from embedPages on `sheet`, as large as fits in `cell`, turned the way the
// page shows it.
export function placePage(sheet, { page, angle, width, height }, cell) {
  if (!page) return;
  const { degrees } = window.PDFLib; // already loaded: it embedded the page
  const { k, x, y, w, h } = fitInCell(cell, width, height);
  // pdf-lib turns the drawing counterclockwise around its lower left corner, so for a page
  // turned clockwise by /Rotate that corner moves.
  const [atX, atY] = { 0: [x, y], 90: [x, y + h], 180: [x + w, y + h], 270: [x + w, y] }[angle];
  sheet.drawPage(page, { x: atX, y: atY, xScale: k, yScale: k, rotate: degrees(-angle) });
}
