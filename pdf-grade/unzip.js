// Minimal ZIP reader for the archives Google Drive / Classroom make when you download a folder.
// Handles stored and deflated entries (deflate via the browser's DecompressionStream).

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    // Zips made on Japanese Windows store names in Shift_JIS without saying so.
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns [{ name, bytes }] for the entries whose name passes `accept(name)`.
export async function readZip(buffer, accept = () => true) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  if (p === 0xffffffff) throw new Error("zip64 is not supported");

  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("broken zip directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), flags & 0x800);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || !accept(name) || flags & 1) continue; // folders, unwanted, encrypted
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.push({ name, bytes: data.slice() });
    else if (method === 8) out.push({ name, bytes: await inflate(data) });
  }
  return out;
}
