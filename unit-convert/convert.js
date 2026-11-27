// 単位の換算の計算。画面なしで使える（tests/unit-convert.mjs で確かめる）。

export class UnitError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnitError";
  }
}

// 種類と単位の一覧（順番は画面のタブ・選択肢の順）
export const CATEGORIES = [
  { id: "length", name: "長さ", units: [
    { id: "mm", name: "mm" }, { id: "cm", name: "cm" }, { id: "m", name: "m" }, { id: "km", name: "km" },
    { id: "in", name: "インチ" }, { id: "ft", name: "フィート" }, { id: "yd", name: "ヤード" }, { id: "mi", name: "マイル" },
  ] },
  { id: "mass", name: "重さ", units: [
    { id: "mg", name: "mg" }, { id: "g", name: "g" }, { id: "kg", name: "kg" }, { id: "t", name: "t" },
    { id: "oz", name: "オンス" }, { id: "lb", name: "ポンド" },
  ] },
  { id: "area", name: "面積", units: [
    { id: "mm2", name: "mm²" }, { id: "cm2", name: "cm²" }, { id: "m2", name: "m²" }, { id: "a", name: "アール" },
    { id: "ha", name: "ヘクタール" }, { id: "km2", name: "km²" }, { id: "tsubo", name: "坪" },
  ] },
  { id: "volume", name: "体積・かさ", units: [
    { id: "ml", name: "mL" }, { id: "cm3", name: "cm³" }, { id: "dl", name: "dL" }, { id: "l", name: "L" },
    { id: "m3", name: "m³" }, { id: "kl", name: "kL" },
  ] },
  { id: "time", name: "時間", units: [
    { id: "s", name: "秒" }, { id: "min", name: "分" }, { id: "h", name: "時間" }, { id: "d", name: "日" }, { id: "wk", name: "週" },
  ] },
  { id: "speed", name: "速さ", units: [
    { id: "mps", name: "m/秒" }, { id: "mpm", name: "m/分" }, { id: "kmph", name: "km/時" },
  ] },
  { id: "temperature", name: "温度", units: [
    { id: "c", name: "℃" }, { id: "f", name: "℉" }, { id: "k", name: "K" },
  ] },
  { id: "data", name: "データ量", units: [
    { id: "bit", name: "ビット" }, { id: "B", name: "バイト" }, { id: "KB", name: "KB" },
    { id: "MB", name: "MB" }, { id: "GB", name: "GB" }, { id: "TB", name: "TB" },
  ] },
];

// かけ算だけで変えられる種類: 基本の単位（m, g, m², mL, 秒, m/秒）にすると何倍か
const FACTORS = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { mg: 0.001, g: 1, kg: 1000, t: 1e6, oz: 28.349523125, lb: 453.59237 },
  area: { mm2: 1e-6, cm2: 1e-4, m2: 1, a: 100, ha: 1e4, km2: 1e6, tsubo: 400 / 121 },
  volume: { ml: 1, cm3: 1, dl: 100, l: 1000, m3: 1e6, kl: 1e6 },
  time: { s: 1, min: 60, h: 3600, d: 86400, wk: 604800 },
  speed: { mps: 1, mpm: 1 / 60, kmph: 1000 / 3600 },
};

function categoryOf(unitId) {
  const category = CATEGORIES.find((c) => c.units.some((u) => u.id === unitId));
  if (!category) throw new UnitError(`知らない単位です（${unitId}）`);
  return category;
}

export function convert(value, from, to, options = {}) {
  const a = categoryOf(from);
  const b = categoryOf(to);
  if (a !== b) throw new UnitError(`${a.name}と${b.name}は変えられません`);
  const factors = FACTORS[a.id];
  if (!factors) throw new UnitError(`${a.name}はまだ変えられません`);
  if (from === to) return value;
  return (value * factors[from]) / factors[to];
}

// 画面に出す文字にする（くわしい形は format のタスクで作る）
export function formatNumber(n) {
  return String(n);
}
