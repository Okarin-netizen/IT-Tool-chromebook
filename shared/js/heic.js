// iPhone photos (HEIC/HEIF) cannot be opened by Chrome, so they are turned into JPEG first with
// heic-to (libheif compiled to WebAssembly, the same approach as heic2any, which BentoPDF,
// omni-tools and BrowseryTools use). The 3MB library is only fetched when a HEIC file shows up,
// and kept for offline use after that.
const LIB = new URL("../vendor/heic-to-1.6.6/heic-to.min.js", import.meta.url).href;

export const isHeic = (file) => /^image\/hei[cf]/.test(file.type) || /\.(heic|heif)$/i.test(file.name);
export const isImage = (file) => file.type.startsWith("image/") || isHeic(file);

// The file itself, or a JPEG copy of it when it is a HEIC.
export async function readableImage(file) {
  if (!isHeic(file)) return file;
  const { heicTo } = await import(LIB);
  const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
  return new File([jpeg], (file.name || "photo.heic").replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
}
