// Which keys a learner misses or is slow on, kept per key across rounds, and the keyboard
// picture that shows them. No page needed except for drawKeyboard.
//
// Stats are { [key]: { n, miss, ms, timed } }: n keys typed right, miss times the key was
// expected but another was pressed, ms the time spent on `timed` of the right ones (the first
// key of each word is not timed: reading the word takes longer than finding a key).

export const ROWS = ["1234567890-", "qwertyuiop[", "asdfghjkl;", "zxcvbnm,./"];
const SHIFTED = { "!": "1", '"': "2", "#": "3", $: "4", "%": "5", "&": "6", "'": "7", "(": "8", ")": "9", "?": "/", "<": ",", ">": ".", "{": "[", "+": ";", "*": ":", "=": "-" };

// The key on the keyboard that types `ch`: "A" and "a" are the A key, "?" is the / key.
export const keyOf = (ch) => (ch === " " ? " " : SHIFTED[ch] ?? ch.toLowerCase());

export function addRound(total, round) {
  const out = { ...total };
  for (const [key, s] of Object.entries(round)) {
    const t = out[key] ?? { n: 0, miss: 0, ms: 0, timed: 0 };
    out[key] = { n: t.n + s.n, miss: t.miss + s.miss, ms: t.ms + s.ms, timed: t.timed + s.timed };
  }
  return out;
}

const MIN_TRIES = 5; // a key needs this many tries before it can count as weak
const missRate = (s) => s.miss / (s.n + s.miss);
const avgMs = (s) => (s.timed ? s.ms / s.timed : 0);

// How long a key takes on average, over every timed key.
function overallMs(stats) {
  let ms = 0;
  let timed = 0;
  for (const s of Object.values(stats)) {
    ms += s.ms;
    timed += s.timed;
  }
  return timed ? ms / timed : 0;
}

// Keys missed often (1 in 10 or more) or slow (30% slower than the learner's average).
export function judge(stats) {
  const avg = overallMs(stats);
  const out = {};
  for (const [key, s] of Object.entries(stats)) {
    const tries = s.n + s.miss;
    out[key] = {
      missed: tries >= MIN_TRIES && missRate(s) >= 0.1,
      slow: s.timed >= MIN_TRIES && avg > 0 && avgMs(s) >= avg * 1.3,
      rate: tries ? missRate(s) : 0,
      ms: avgMs(s),
      tries,
    };
  }
  return out;
}

// Up to `max` weak keys, the worst first: missed ones by how often, then slow ones by how slow.
export function weakKeys(stats, max = 5) {
  const judged = Object.entries(judge(stats)).filter(([k, j]) => (j.missed || j.slow) && k !== " ");
  judged.sort(([, a], [, b]) => (b.missed - a.missed) || (b.rate - a.rate) || (b.ms - a.ms));
  return judged.slice(0, max).map(([k]) => k);
}

// Words with weak keys come up more often: each weak key in a word's spelling adds two more
// copies of it to the list. `spell(word)` is what is typed for it.
export function weightWords(words, weak, spell) {
  if (!weak.length) return words;
  const out = [];
  for (const w of words) {
    const keys = new Set([...spell(w)].map(keyOf));
    const hits = weak.filter((k) => keys.has(k)).length;
    for (let i = 0; i < 1 + hits * 2; i++) out.push(w);
  }
  return out;
}

// The keyboard with each key colored by how often it was missed, and slow keys ringed.
export function drawKeyboard(box, stats) {
  const judged = judge(stats);
  box.replaceChildren(...ROWS.map((row, r) => {
    const line = document.createElement("div");
    line.className = "kb-row";
    line.style.paddingLeft = `${r * 0.5}em`;
    for (const key of row) line.append(keyCap(key, key.toUpperCase(), judged[key]));
    return line;
  }), (() => {
    const line = document.createElement("div");
    line.className = "kb-row";
    line.append(keyCap(" ", "スペース", judged[" "], "space"));
    return line;
  })());
}

function keyCap(key, label, j, extra = "") {
  const cap = document.createElement("span");
  cap.className = `kb-key ${extra}`;
  cap.textContent = label;
  if (!j || !j.tries) {
    cap.classList.add("unused");
    return cap;
  }
  // Red grows with the share of misses: 1 in 4 or more is full red.
  cap.style.setProperty("--heat", `${Math.round(Math.min(1, j.rate * 4) * 100)}%`);
  cap.classList.toggle("missed", j.missed);
  cap.classList.toggle("hot", j.rate >= 0.15); // white letters on the darker reds
  cap.classList.toggle("slow", j.slow);
  const parts = [`${label}: ${j.tries}回中 ${Math.round(j.rate * j.tries)}回ミス`];
  if (j.ms) parts.push(`平均 ${(j.ms / 1000).toFixed(2)}秒`);
  cap.title = parts.join("、");
  return cap;
}
