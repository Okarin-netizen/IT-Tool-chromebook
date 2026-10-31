#!/usr/bin/env node
// Checks the calculator's arithmetic (calc/expr.js), which needs no browser.
//
//   node tests/calc-expr.mjs
import { compile, format, formatAs, toFraction, primeFactors, ExprError } from "../calc/expr.js";

const problems = [];
const calc = (src, angle = "deg") => format(compile(src)({}, angle));
const same = (got, want, what) => got === want || problems.push(`${what}: ${got}（${want} のはず）`);

// What there was before still works.
same(calc("1+2*3"), "7", "1+2*3");
same(calc("0.1+0.2"), "0.3", "0.1+0.2");
same(calc("2sin(30)+√(9)"), "4", "2sin(30)+√9");
same(calc("-2^2"), "-4", "-2^2");
same(calc("5!"), "120", "5!");
same(calc("(-8)^(1/3)"), "-2", "(-8)^(1/3)");

// Combinations, permutations, gcd and lcm.
same(calc("nCr(5,2)"), "10", "nCr(5,2)");
same(calc("ncr(52, 5)"), "2598960", "nCr(52,5)");
same(calc("nPr(5,2)"), "20", "nPr(5,2)");
same(calc("nCr(3,5)"), "計算できません", "nCr(3,5)");
same(calc("gcd(12, 18)"), "6", "gcd(12,18)");
same(calc("gcd(12, 18, 8)"), "2", "gcd(12,18,8)");
same(calc("lcm(4, 6)"), "12", "lcm(4,6)");
same(calc("lcm(4, 6, 10)"), "60", "lcm(4,6,10)");
same(calc("2nCr(4,2)+1"), "13", "2nCr(4,2)+1");

// Statistics (variance divides by n).
same(calc("mean(70, 85, 90)"), "81.6666666667", "mean");
same(calc("median(3, 1, 2)"), "2", "median odd");
same(calc("median(4, 1, 3, 2)"), "2.5", "median even");
same(calc("mode(1, 2, 2, 3, 3)"), "2", "mode tie → smallest");
same(calc("var(2, 4, 4, 4, 5, 5, 7, 9)"), "4", "var");
same(calc("sd(2, 4, 4, 4, 5, 5, 7, 9)"), "2", "sd");

// Binary and hexadecimal.
same(calc("0b1010 + 0x1F"), "41", "0b1010+0x1F");
same(formatAs(255, "bin").text, "0b11111111", "255 in binary");
same(formatAs(255, "hex").text, "0xFF", "255 in hex");
same(formatAs(-10, "hex").text, "-0xA", "-10 in hex");
same(formatAs(2.5, "bin").note, "整数のときだけ表せます", "2.5 in binary");

// Fractions and prime factors.
same(formatAs(0.75, "frac").text, "3/4", "0.75 as a fraction");
same(formatAs(compile("1/3+1/6")(), "frac").text, "1/2", "1/3+1/6");
same(formatAs(-1.25, "frac").text, "-5/4", "-1.25 as a fraction");
same(formatAs(Math.PI, "frac").note, "分数で表せません", "π as a fraction");
same(String(toFraction(0.1 + 0.2)?.d), "10", "0.1+0.2 = 3/10");
same(formatAs(360, "factor").text, "2³ × 3² × 5", "360 factorised");
same(formatAs(97, "factor").text, "97（素数）", "97 is prime");
same(JSON.stringify(primeFactors(600851475143)), "[[71,1],[839,1],[1471,1],[6857,1]]", "large number");
same(formatAs(1, "factor").note, "2以上の整数のときだけ表せます", "1 factorised");

// Mistakes give a message, not a crash.
for (const [src, want] of [["nCr(5)", "nCr には数を2つ"], ["1,2", "「,」は"], ["mean 3", "mean( のあとに"]]) {
  try {
    compile(src)();
    problems.push(`${src}: エラーにならない`);
  } catch (err) {
    if (!(err instanceof ExprError) || !err.message.startsWith(want)) problems.push(`${src}: ${err.message}`);
  }
}

if (problems.length) {
  console.log(problems.map((p) => `NG  ${p}`).join("\n"));
  process.exit(1);
}
console.log("電卓の計算はすべて通りました");
