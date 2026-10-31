// Safe math expression parser (no eval). compile("2sin(x)^2") returns a function (vars) => number.
// Supports + - * / ^ ! ( ), implicit multiplication (2x, 3(x+1), 2π), the functions below,
// functions of a list such as mean(70, 85, 90), and 0b1010 / 0x1F for binary and hexadecimal.
// It never touches the page, so `node tests/calc-expr.mjs` can check it.

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

// Functions of several numbers, written with "," between them: nCr(5, 2), mean(1, 2, 3).
// Each takes the array of values.
const LIST_FUNCS = {
  ncr: ([n, r, ...rest]) => (rest.length || r === undefined ? arity("nCr", 2) : choose(n, r)),
  npr: ([n, r, ...rest]) => (rest.length || r === undefined ? arity("nPr", 2) : permutations(n, r)),
  gcd: (xs) => integers(xs).reduce(gcd2),
  lcm: (xs) => integers(xs).reduce((a, b) => (a && b ? (a / gcd2(a, b)) * b : 0)),
  mean: (xs) => sumOf(xs) / xs.length,
  median: (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },
  mode: (xs) => {
    // The value seen most often; when several tie, the smallest of them.
    const counts = new Map();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    let best = NaN;
    let most = 0;
    for (const [x, n] of counts) if (n > most || (n === most && x < best)) [best, most] = [x, n];
    return best;
  },
  // Variance and standard deviation divide by n (the 分散 of the 数学I textbook).
  var: (xs) => variance(xs),
  sd: (xs) => Math.sqrt(variance(xs)),
};

const CONSTS = { pi: Math.PI, e: Math.E };

// Names typed or shown with symbols are mapped to plain names first.
const ALIASES = {
  "π": "pi", "√": "sqrt", "∛": "cbrt",
  "×": "*", "÷": "/", "−": "-", "–": "-",
  "＊": "*", "／": "/", "＋": "+", "＾": "^",
};

export class ExprError extends Error {}

const arity = (name, n) => {
  throw new ExprError(`${name} には数を${n}つ、「,」で区切って入れます`);
};
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);
function variance(xs) {
  const m = sumOf(xs) / xs.length;
  return sumOf(xs.map((x) => (x - m) ** 2)) / xs.length;
}
// Whole numbers, allowing for float noise (gcd(0.1*30, 6) is gcd(3, 6)); others make NaN.
function integers(xs) {
  return xs.map((x) => (Math.abs(x - Math.round(x)) < 1e-9 ? Math.abs(Math.round(x)) : NaN));
}
function gcd2(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  while (b) [a, b] = [b, a % b];
  return a;
}
// nCr and nPr for whole numbers 0 <= r <= n; anything else is NaN.
function choose(n, r) {
  [n, r] = integers([n, r]);
  if (!(r <= n)) return NaN;
  r = Math.min(r, n - r);
  let v = 1;
  for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
  return Math.round(v);
}
function permutations(n, r) {
  [n, r] = integers([n, r]);
  if (!(r <= n)) return NaN;
  let v = 1;
  for (let i = 0; i < r; i++) v *= n - i;
  return v;
}

function tokenize(src) {
  let s = "";
  for (const ch of src.normalize("NFKC")) s += ALIASES[ch] ?? ch;
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const based = /^0(b[01]+|x[0-9a-f]+)/i.exec(s.slice(i));
    if (based) {
      tokens.push({ t: "num", v: parseInt(based[1].slice(1), /b/i.test(based[1][0]) ? 2 : 16) });
      i += based[0].length;
      continue;
    }
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
  const names = [...Object.keys(FUNCS), ...Object.keys(LIST_FUNCS), ...Object.keys(CONSTS), "ans", "x"]
    .sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < w.length) {
    const name = names.find((n) => w.startsWith(n, i));
    if (!name) throw new ExprError(`わからない名前です: ${w.slice(i)}`);
    if (LIST_FUNCS[name]) out.push({ t: "list", v: name });
    else out.push(FUNCS[name] ? { t: "fn", v: name } : { t: "id", v: name });
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
//   atom    := num | id | fn atom-or-power | list "(" sum ("," sum)* ")" | "(" sum ")"
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => (peek()?.t === t ? tokens[pos++] : null);
  const startsAtom = (tok) => tok && ["num", "id", "fn", "list", "("].includes(tok.t);

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
    if (tok.t === "list") {
      if (!take("(")) throw new ExprError(`${tok.v}( のあとに数を「,」で区切って入れます`);
      const args = [sum()];
      while (take(",")) args.push(sum());
      if (!take(")")) throw new ExprError("「)」が足りません");
      return { op: "list", v: tok.v, args };
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
    throw unexpected(tok);
  }
  // Argument without parentheses: a run of implicitly multiplied powers, e.g. "sin 2x".
  function implicitArg() {
    let node = power();
    while (startsAtom(peek()) && peek().t !== "fn") node = { op: "*", a: node, b: power() };
    return node;
  }

  if (!tokens.length) throw new ExprError("式を入力してください");
  const tree = sum();
  if (pos < tokens.length) throw unexpected(tokens[pos]);
  return tree;
}

// The error for a token that cannot stand where it is.
function unexpected(tok) {
  if (tok.t === ")") return new ExprError("「(」が足りません");
  if (tok.t === ",") return new ExprError("「,」は mean(1, 2, 3) のような、数を並べる関数の中だけで使えます");
  return new ExprError(`「${tok.t}」の位置がおかしいです`);
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
    case "list": {
      const f = LIST_FUNCS[node.v];
      const args = node.args.map(build);
      return (env) => f(args.map((a) => a(env)));
    }
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

/* ---------- other ways to show an answer ---------- */

const isWhole = (v) => Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9;

// v as a fraction n/d with d <= maxDen, found by continued fractions, or null when v is not
// (close enough to) one: 0.75 → { n: 3, d: 4 }, 1/3 → { n: 1, d: 3 }, π → null.
export function toFraction(v, maxDen = 10000) {
  if (!Number.isFinite(v)) return null;
  const sign = v < 0 ? -1 : 1;
  const x = Math.abs(v);
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let rest = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(rest);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (k1 > maxDen) return null;
    if (Math.abs(x - h1 / k1) <= 1e-9 * Math.max(1, x)) return { n: sign * h1, d: k1 };
    rest = 1 / (rest - a);
    if (!Number.isFinite(rest)) break;
  }
  return null;
}

// Prime factors of a whole number from 2 up to 10^12, as [[prime, power]], or null.
export function primeFactors(v) {
  if (!isWhole(v)) return null;
  let n = Math.round(v);
  if (n < 2 || n > 1e12) return null;
  const out = [];
  for (let p = 2; p * p <= n; p += p === 2 ? 1 : 2) {
    let k = 0;
    while (n % p === 0) {
      n /= p;
      k++;
    }
    if (k) out.push([p, k]);
  }
  if (n > 1) out.push([n, 1]);
  return out;
}

const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };

// The answer shown as `view`: "dec" (as usual), "frac", "bin", "hex" or "factor".
// Returns { text } or, when that view does not fit the number, { text, note } with the usual
// text and why it is shown that way.
export function formatAs(v, view = "dec") {
  const plain = format(v);
  if (view === "frac") {
    if (isWhole(v)) return { text: plain };
    const f = toFraction(v);
    return f ? { text: `${f.n}/${f.d}` } : { text: plain, note: "分数で表せません" };
  }
  if (view === "bin" || view === "hex") {
    if (!isWhole(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) return { text: plain, note: "整数のときだけ表せます" };
    const n = Math.round(v);
    const digits = Math.abs(n).toString(view === "bin" ? 2 : 16).toUpperCase();
    return { text: `${n < 0 ? "-" : ""}${view === "bin" ? "0b" : "0x"}${digits}` };
  }
  if (view === "factor") {
    const factors = primeFactors(v);
    if (!factors) return { text: plain, note: "2以上の整数のときだけ表せます" };
    const text = factors
      .map(([p, k]) => (k > 1 ? p + [...String(k)].map((c) => SUPERSCRIPT[c]).join("") : String(p)))
      .join(" × ");
    return { text: factors.length === 1 && factors[0][1] === 1 ? `${text}（素数）` : text };
  }
  return { text: plain };
}
