#!/usr/bin/env node
// Checks the unit converter's arithmetic (unit-convert/convert.js), which needs no browser.
// This file is the specification: the loop must make it pass without changing it.
//
//   node tests/unit-convert.mjs                 # every group
//   node tests/unit-convert.mjs core format     # only these groups
import { CATEGORIES, convert, formatNumber, UnitError } from "../unit-convert/convert.js";

const only = process.argv.slice(2);
const problems = [];
const near = (got, want, what, tolerance = 1e-9) =>
  Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want)) || problems.push(`${what}: ${got}（${want} のはず）`);
const same = (got, want, what) => got === want || problems.push(`${what}: ${JSON.stringify(got)}（${JSON.stringify(want)} のはず）`);
const throws = (fn, what) => {
  try { fn(); problems.push(`${what}: UnitError にならない`); }
  catch (error) { error instanceof UnitError || problems.push(`${what}: UnitError でなく ${error}`); }
};
const group = (name, fn) => { if (!only.length || only.includes(name)) fn(); };

group("core", () => {
  same(CATEGORIES.map((c) => c.id).join(), "length,mass,area,volume,time,speed,temperature,data", "種類の順番");
  const units = (id) => CATEGORIES.find((c) => c.id === id)?.units.map((u) => u.id).join();
  same(units("length"), "mm,cm,m,km,in,ft,yd,mi", "長さの単位");
  same(units("mass"), "mg,g,kg,t,oz,lb", "重さの単位");
  same(units("area"), "mm2,cm2,m2,a,ha,km2,tsubo", "面積の単位");
  same(units("volume"), "ml,cm3,dl,l,m3,kl", "体積の単位");
  same(units("time"), "s,min,h,d,wk", "時間の単位");
  same(units("speed"), "mps,mpm,kmph", "速さの単位");
  for (const c of CATEGORIES) for (const u of c.units) same(typeof u.name, "string", `${c.id}/${u.id} の名前`);

  near(convert(1, "km", "m"), 1000, "1 km → m");
  near(convert(12.5, "cm", "mm"), 125, "12.5 cm → mm");
  near(convert(1, "mi", "km"), 1.609344, "1 mi → km");
  near(convert(1, "ft", "cm"), 30.48, "1 ft → cm");
  near(convert(1, "in", "cm"), 2.54, "1 in → cm");
  near(convert(1, "yd", "ft"), 3, "1 yd → ft");
  near(convert(1, "kg", "g"), 1000, "1 kg → g");
  near(convert(1, "t", "kg"), 1000, "1 t → kg");
  near(convert(1, "lb", "g"), 453.59237, "1 lb → g");
  near(convert(16, "oz", "lb"), 1, "16 oz → lb");
  near(convert(250, "mg", "g"), 0.25, "250 mg → g");
  near(convert(1, "ha", "m2"), 10000, "1 ha → m²");
  near(convert(1, "a", "m2"), 100, "1 a → m²");
  near(convert(1, "km2", "ha"), 100, "1 km² → ha");
  near(convert(1, "m2", "cm2"), 10000, "1 m² → cm²");
  near(convert(1, "tsubo", "m2"), 400 / 121, "1 坪 → m²");
  near(convert(1, "l", "ml"), 1000, "1 L → mL");
  near(convert(1, "dl", "ml"), 100, "1 dL → mL");
  near(convert(1, "cm3", "ml"), 1, "1 cm³ → mL");
  near(convert(1, "m3", "l"), 1000, "1 m³ → L");
  near(convert(1, "kl", "m3"), 1, "1 kL → m³");
  near(convert(1, "h", "s"), 3600, "1 時間 → 秒");
  near(convert(1, "d", "min"), 1440, "1 日 → 分");
  near(convert(1, "wk", "h"), 168, "1 週 → 時間");
  near(convert(36, "kmph", "mps"), 10, "36 km/時 → m/秒");
  near(convert(1, "mps", "mpm"), 60, "1 m/秒 → m/分");
  near(convert(0, "m", "km"), 0, "0 m → km");
  near(convert(-3, "m", "cm"), -300, "-3 m → cm");

  throws(() => convert(1, "km", "kg"), "km → kg");
  throws(() => convert(1, "km", "parsec"), "知らない単位");
  // Every unit goes there and back again.
  for (const c of CATEGORIES.filter((c) => !["temperature", "data"].includes(c.id))) {
    for (const a of c.units) for (const b of c.units) near(convert(convert(7.3, a.id, b.id), b.id, a.id), 7.3, `${a.id} → ${b.id} → ${a.id}`);
  }
});

group("temperature", () => {
  const units = CATEGORIES.find((c) => c.id === "temperature")?.units.map((u) => u.id).join();
  same(units, "c,f,k", "温度の単位");
  near(convert(100, "c", "f"), 212, "100℃ → ℉");
  near(convert(32, "f", "c"), 0, "32℉ → ℃");
  near(convert(0, "c", "k"), 273.15, "0℃ → K");
  near(convert(-40, "c", "f"), -40, "-40℃ → ℉");
  near(convert(300, "k", "f"), 80.33, "300 K → ℉");
  near(convert(25, "c", "c"), 25, "25℃ → ℃");
  throws(() => convert(-300, "c", "k"), "-300℃");
  throws(() => convert(-1, "k", "c"), "-1 K");
});

group("data", () => {
  const units = CATEGORIES.find((c) => c.id === "data")?.units.map((u) => u.id).join();
  same(units, "bit,B,KB,MB,GB,TB", "データ量の単位");
  near(convert(1, "B", "bit"), 8, "1 B → bit");
  near(convert(1, "KB", "B"), 1024, "1 KB → B（決まりは 1024）");
  near(convert(1, "GB", "MB"), 1024, "1 GB → MB");
  near(convert(2, "TB", "GB"), 2048, "2 TB → GB");
  near(convert(1, "KB", "B", { dataBase: 1000 }), 1000, "1 KB → B（1000）");
  near(convert(1, "TB", "GB", { dataBase: 1000 }), 1000, "1 TB → GB（1000）");
  near(convert(1, "MB", "bit", { dataBase: 1000 }), 8e6, "1 MB → bit（1000）");
  near(convert(1, "km", "m", { dataBase: 1000 }), 1000, "dataBase はデータ量以外に効かない");
});

group("format", () => {
  same(formatNumber(0), "0", "0");
  same(formatNumber(1000), "1,000", "1000");
  same(formatNumber(1234567.5), "1,234,567.5", "1234567.5");
  same(formatNumber(0.1 + 0.2), "0.3", "0.1+0.2");
  same(formatNumber(1 / 3), "0.3333333333", "1/3");
  same(formatNumber(2e6 / 3), "666,666.6667", "2e6/3");
  same(formatNumber(-40), "-40", "-40");
  same(formatNumber(-1234.5), "-1,234.5", "-1234.5");
  same(formatNumber(0.000123), "0.000123", "0.000123");
  same(formatNumber(1e15), "1 × 10^15", "1e15");
  same(formatNumber(1.5e-7), "1.5 × 10^-7", "1.5e-7");
  same(formatNumber(-2.5e20), "-2.5 × 10^20", "-2.5e20");
});

if (problems.length) {
  console.log(problems.map((p) => `NG ${p}`).join("\n"));
  process.exit(1);
}
console.log("すべて通りました");
