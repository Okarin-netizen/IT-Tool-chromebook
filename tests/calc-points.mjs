#!/usr/bin/env node
// Checks the points the graph marks (calc/points.js), which needs no browser.
//
//   node tests/calc-points.mjs
import { compile } from "../calc/expr.js";
import { findPoints } from "../calc/points.js";

const problems = [];
const fn = (src) => {
  const f = compile(src);
  return (x) => f({ x });
};
const show = (ps) => ps.map((p) => `${p.kind}${p.of.join("")}(${+p.x.toFixed(6)},${+p.y.toFixed(6)})`).join(" ");
const check = (srcs, range, want, what) => {
  const got = show(findPoints(srcs.map(fn), ...range));
  if (got !== want) problems.push(`${what}\n    実際: ${got}\n    期待: ${want}`);
};

check(["x^2-1"], [-10, 10], "zero0(-1,0) zero0(1,0) min0(0,-1)", "y = x² − 1 と x軸の交点は ±1、頂点は (0, −1)");
check(["x^2-2x-3"], [-10, 10], "zero0(-1,0) zero0(3,0) min0(1,-4)", "y = x² − 2x − 3");
check(["(x-2)^2"], [-10, 10], "zero0(2,0) min0(2,0)", "x軸に接する");
check(["x^3-3x"], [-5, 5], "zero0(-1.732051,0) zero0(0,0) zero0(1.732051,0) max0(-1,2) min0(1,-2)", "3次関数の極大・極小");
check(["x", "x^2"], [-5, 5], "zero0(0,0) zero1(0,0) min1(0,0) cross01(0,0) cross01(1,1)", "y = x と y = x² の交点");
check(["1/x"], [-5, 5], "", "1/x は漸近線で x軸と交わらない");
check(["2"], [-5, 5], "", "定数は点なし");
check(["sin(x)"], [-4, 4], "zero0(-3.141593,0) zero0(0,0) zero0(3.141593,0) min0(-1.570796,-1) max0(1.570796,1)", "sin x（ラジアン）");
check(["√x"], [-5, 5], "zero0(0,0)", "√x は x = 0 から");

if (problems.length) {
  console.log(problems.map((p) => `NG  ${p}`).join("\n"));
  process.exit(1);
}
console.log("グラフの点はすべて通りました");
