// Japanese font for writing text into PDFs. pdf-lib's built-in subsetting drops glyphs from
// Noto Sans JP, so the font is cut down to the characters used with HarfBuzz (wasm) and then
// embedded with `subset: false`.
import { LIB, vendorUrl } from "./vendor.js";

const FONT_URL = vendorUrl(`${LIB.notoSansJp}/NotoSansJP-Regular.ttf`);
const SUBSET_WASM_URL = vendorUrl(`${LIB.harfbuzz}/harfbuzz-subset.wasm`);

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("フォントを読み込めませんでした");
  return res.arrayBuffer();
}

// Each is downloaded once. A failed download (no network yet) is tried again next time,
// instead of failing until the page is reloaded.
let fontBytesPromise = null;
function loadFontBytes() {
  fontBytesPromise ??= fetchBytes(FONT_URL).catch((err) => {
    fontBytesPromise = null;
    throw err;
  });
  return fontBytesPromise;
}

let subsetterPromise = null;
function loadSubsetter() {
  subsetterPromise ??= fetchBytes(SUBSET_WASM_URL)
    .then((buf) => WebAssembly.instantiate(buf))
    .then(({ instance }) => instance.exports)
    .catch((err) => {
      subsetterPromise = null;
      throw err;
    });
  return subsetterPromise;
}

// Options for pdf-lib's embedFont with a font from subsetFont(). pdf-lib only writes widths for
// the glyphs the font maps characters to, but in a Latin run fontkit's "locl" swaps the digits
// for other glyphs, which then got the default width: "2026" came out as "2 0 2 6".
export const EMBED_OPTIONS = { subset: false, features: { locl: false } };

// Starts downloading the font early so saving is quick.
export function preloadFont() {
  loadFontBytes().catch(() => {});
  loadSubsetter().catch(() => {});
}

// Font file bytes holding only the characters in `text`.
export async function subsetFont(text) {
  const [hb, fontBytes] = await Promise.all([loadSubsetter(), loadFontBytes()]);
  const ptr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer).set(new Uint8Array(fontBytes), ptr);
  const blob = hb.hb_blob_create(ptr, fontBytes.byteLength, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0));
  const sub = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  try {
    if (!sub) throw new Error("フォントの準備に失敗しました");
    const out = hb.hb_face_reference_blob(sub);
    const data = hb.hb_blob_get_data(out, 0);
    const bytes = new Uint8Array(hb.memory.buffer).slice(data, data + hb.hb_blob_get_length(out));
    hb.hb_blob_destroy(out);
    return bytes;
  } finally {
    if (sub) hb.hb_face_destroy(sub);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}
