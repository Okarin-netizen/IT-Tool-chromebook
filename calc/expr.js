// Safe math expression parser (no eval). compile("2sin(x)^2") returns a function (vars) => number.
// Supports + - * / ^ ! ( ), implicit multiplication (2x, 3(x+1), 2π), and the functions below.

const FUNCS = {
  sin: (a, d) => (d.deg ? trigDeg(a, 0) : Math.sin(a)),
  cos: (a, d) => (d.deg ? trigDeg(a, 1) : Math.cos(a)),
  tan: (a, d) => (d.deg ? trigDeg(a, 2) : Math.tan(a)),
  asin: (a, d) => d.fromRad(Math.asin(a)),
  acos: (a, d) => d.fromRad(Math.acos(a)),
  atan: (a, d) => d.fromRad(Math.atan(a)),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const CONSTS = { pi: Math.PI, e: Math.E };

// Names typed or shown with symbols are mapped to plain names first.
const ALIASES = { "π": "pi", "√": "sqrt", "∛": "cbrt", "×": "*", "÷": "/", "−": "-", "–": "-", "＊": "*", "／": "/", "＋": "+", "＾": "^" };

export class ExprError extends Error {}

function tokenize(src) {
  let s = "";
  for (const ch of src.normalize("NFKC")) s += ALIASES[ch] ?? ch;
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      tokens.push({ t: "num", v: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[a-z]+/i.exec(s.slice(i));
    if (word) {
      tokens.push(...splitWord(word[0].toLowerCase()));
      i += word[0].length;
      continue;
    }
    if ("+-*/^!(),".includes(ch)) {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    throw new ExprError(`使えない文字があります: ${ch}`);
  }
  return tokens;
}

// "xsin" or "pix" have no spaces, so split a run of letters into known names greedily.
function splitWord(w) {
  const names = [...Object.keys(FUNCS), ...Object.keys(CONSTS), "ans", "x"].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < w.length) {
    const name = names.find((n) => w.startsWith(n, i));
    if (!name) throw new ExprError(`わからない名前です: ${w.slice(i)}`);
    out.push(FUNCS[name] ? { t: "fn", v: name } : { t: "id", v: name });
    i += name.length;
  }
  return out;
}

// Grammar (lowest to highest):
//   sum     := product (("+" | "-") product)*
//   product := unary (("*" | "/") unary | <implicit> power)*
//   unary   := ("+" | "-") unary | power
//   power   := postfix ("^" unary)?        right associative, so -2^2 = -4 and 2^-1 = 0.5
//   postfix := atom "!"*
//   atom    := num | id | fn atom-or-power | "(" sum ")"
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => (peek()?.t === t ? tokens[pos++] : null);
  const startsAtom = (tok) => tok && (tok.t === "num" || tok.t === "id" || tok.t === "fn" || tok.t === "(");

  function sum() {
    let node = product();
    for (;;) {
      if (take("+")) node = { op: "+", a: node, b: product() };
      else if (take("-")) node = { op: "-", a: node, b: product() };
      else return node;
    }
  }
  function product() {
    let node = unary();
    for (;;) {
      if (take("*")) node = { op: "*", a: node, b: unary() };
      else if (take("/")) node = { op: "/", a: node, b: unary() };
      else if (startsAtom(peek())) node = { op: "*", a: node, b: power() };
      else return node;
    }
  }
  function unary() {
    if (take("-")) return { op: "neg", a: unary() };
    if (take("+")) return unary();
    return power();
  }
  function power() {
    const base = postfix();
    if (take("^")) return { op: "^", a: base, b: unary() };
    return base;
  }
  function postfix() {
    let node = atom();
    while (take("!")) node = { op: "!", a: node };
    return node;
  }
  function atom() {
    const tok = tokens[pos++];
    if (!tok) throw new ExprError("式が途中で終わっています");
    if (tok.t === "num") return { op: "num", v: tok.v };
    if (tok.t === "id") return { op: "id", v: tok.v };
    if (tok.t === "(") {
      const node = sum();
      if (!take(")")) throw new ExprError("「)」が足りません");
      return node;
    }
    if (tok.t === "fn") {
      // sin(x), sin x, sin^2 x (= (sin x)^2), sin 2x is read as sin(2x) like a textbook.
      let exp = null;
      if (take("^")) exp = postfix();
      let arg;
      if (peek()?.t === "(") arg = postfix();
      else arg = implicitArg();
      let node = { op: "fn", v: tok.v, a: arg };
      if (exp) node = { op: "^", a: node, b: exp };
      return node;
    }
    throw new ExprError(tok.t === ")" ? "「(」が足りません" : `「${tok.t}」の位置がおかしいです`);
  }
  // Argument without parentheses: a run of implicitly multiplied powers, e.g. "sin 2x".
  function implicitArg() {
    let node = power();
    while (startsAtom(peek()) && peek().t !== "fn") node = { op: "*", a: node, b: power() };
    return node;
  }

  if (!tokens.length) throw new ExprError("式を入力してください");
  const tree = sum();
  if (pos < tokens.length) {
    const tok = tokens[pos];
    throw new ExprError(tok.t === ")" ? "「(」が足りません" : `「${tok.t}」の位置がおかしいです`);
  }
  return tree;
}

// Gamma function (Lanczos), so 0.5! and similar also work.
const G = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = G[0];
  for (let i = 1; i < 9; i++) x += G[i] / (z + i);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * x;
}
function factorial(n) {
  if (Number.isInteger(n)) {
    if (n < 0) return NaN;
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  return gamma(n + 1);
}

function build(node) {
  switch (node.op) {
    case "num": { const v = node.v; return () => v; }
    case "id": {
      const name = node.v;
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      return (env) => {
        const v = env[name];
        if (v === undefined) throw new ExprError(name === "x" ? "電卓では x は使えません（グラフで使えます）" : `${name} はまだありません`);
        return v;
      };
    }
    case "neg": { const a = build(node.a); return (env) => -a(env); }
    case "!": { const a = build(node.a); return (env) => factorial(a(env)); }
    case "fn": { const f = FUNCS[node.v]; const a = build(node.a); return (env) => f(a(env), env); }
    default: {
      const a = build(node.a);
      const b = build(node.b);
      switch (node.op) {
        case "+": return (env) => a(env) + b(env);
        case "-": return (env) => a(env) - b(env);
        case "*": return (env) => a(env) * b(env);
        case "/": return (env) => a(env) / b(env);
        case "^": return (env) => pow(a(env), b(env));
      }
    }
  }
  throw new ExprError("式を読み取れません");
}

// Real odd roots of negatives, e.g. (-8)^(1/3) = -2, which Math.pow returns as NaN.
function pow(a, b) {
  const r = a ** b;
  if (Number.isNaN(r) && a < 0) {
    const inv = 1 / b;
    const n = Math.round(inv);
    if (Math.abs(inv - n) < 1e-9 && n % 2 !== 0) return -((-a) ** b);
  }
  return r;
}

const DEG = Math.PI / 180;
const ANGLES = {
  rad: { deg: false, fromRad: (a) => a },
  deg: { deg: true, fromRad: (a) => a / DEG },
};

// Exact values at multiples of 90° so sin(180) = 0 and tan(90) is an error, not 1.6e16.
const EXACT = [[0, 1, 0], [1, 0, NaN], [0, -1, 0], [-1, 0, NaN]];
function trigDeg(a, kind) {
  const r = ((a % 360) + 360) % 360;
  if (r % 90 === 0) return EXACT[r / 90][kind];
  return [Math.sin, Math.cos, Math.tan][kind](a * DEG);
}

// Returns (vars, angle = "rad") => number.
export function compile(src) {
  const fn = build(parse(tokenize(src)));
  return (vars = {}, angle = "rad") => fn({ ...ANGLES[angle], ...vars });
}

// Rounds away float noise: 0.1+0.2 -> 0.3, sin(180°) -> 0.
export function format(v) {
  if (Number.isNaN(v)) return "計算できません";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
  if (Math.abs(v) < 1e-12) return "0";
  const p = Number(v.toPrecision(12));
  const abs = Math.abs(p);
  if (abs >= 1e12 || abs < 1e-6) return p.toExponential(10).replace(/\.?0+e/, "e").replace("e+", "×10^").replace("e", "×10^");
  return String(p);
}
