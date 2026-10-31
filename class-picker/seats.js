// The arithmetic of 席替え and 班分け, apart from the screen so the tests can run it many times.
//
// A classroom is `rows` rows of `cols` seats. Seat i is at row Math.floor(i / cols), counted
// from the front (the teacher's desk), and column i % cols, counted from the left as the
// students see it. A seating plan is an array with a name, or "" for an empty seat, per seat.
import { shuffle } from "../shared/js/random.js";

export const TRIES = 3000; // random plans tried before settling for the best one found

// Reads "前の席にしたい人" (one name per line) into a list of names.
export function parseNames(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Reads "離したい組み合わせ": two names per line, split by spaces, "、", "," or "・".
// Lines with fewer than two names are skipped; a line with more names keeps every pair in it.
export function parsePairs(text) {
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const names = line.split(/[\s、,，・]+/).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);
    }
  }
  return pairs;
}

// Names in `wanted` that are not on the roster `people` (typos, or someone who left).
export const unknownNames = (wanted, people) => [...new Set(wanted.filter((n) => !people.includes(n)))];

// The seats next to seat i: in front, behind, left and right.
export function neighbours(i, cols, rows) {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out = [];
  if (r > 0) out.push(i - cols);
  if (r < rows - 1) out.push(i + cols);
  if (c > 0) out.push(i - 1);
  if (c < cols - 1) out.push(i + 1);
  return out;
}

// What a plan breaks: pairs sitting next to each other, and front people further back than
// `frontRows`. Returns { apart: [[a, b]], front: [name] }.
export function seatProblems(plan, { cols, rows, front = [], apart = [], frontRows = 2 }) {
  const seatOf = new Map();
  plan.forEach((name, i) => name && seatOf.set(name, i));
  const brokenPairs = apart.filter(([a, b]) => {
    const i = seatOf.get(a);
    const j = seatOf.get(b);
    return i !== undefined && j !== undefined && neighbours(i, cols, rows).includes(j);
  });
  const notInFront = front.filter((name) => seatOf.has(name) && Math.floor(seatOf.get(name) / cols) >= frontRows);
  return { apart: brokenPairs, front: notInFront };
}

const countProblems = ({ apart, front }) => apart.length + front.length;

// A new seating plan for `people`. `unused` lists seats no one sits in, and spare seats are
// left at the back. Tries random plans
// (front people drawn into the front rows first) until one breaks nothing, or `tries` ran out;
// then returns the plan that broke the least. Returns { plan, problems, ok } or, when there are
// more people than seats, null.
export function arrangeSeats(people, options, tries = TRIES) {
  const { cols, rows, unused = [], front = [], frontRows = 2 } = options;
  const seats = [];
  for (let i = 0; i < cols * rows; i++) if (!unused.includes(i)) seats.push(i);
  if (people.length > seats.length) return null;
  const wantFront = people.filter((n) => front.includes(n));
  const others = people.filter((n) => !front.includes(n));
  const rowOf = (i) => Math.floor(i / cols);
  let best = null;
  for (let t = 0; t < tries; t++) {
    const plan = Array(cols * rows).fill("");
    // Seats are filled from the front, so the empty ones are at the back.
    const order = shuffle(seats).sort((a, b) => rowOf(a) - rowOf(b)).slice(0, people.length);
    const frontSeats = order.filter((i) => rowOf(i) < frontRows);
    const backSeats = order.filter((i) => rowOf(i) >= frontRows);
    // Front people take front seats first; everyone else fills what is left, in random order.
    const firstPick = frontSeats.slice(0, wantFront.length);
    const rest = shuffle([...frontSeats.slice(wantFront.length), ...backSeats]);
    shuffle(wantFront).forEach((name, k) => (plan[firstPick[k] ?? rest.shift()] = name));
    shuffle(others).forEach((name, k) => (plan[rest[k]] = name));
    const problems = seatProblems(plan, options);
    const count = countProblems(problems);
    if (!best || count < best.count) best = { plan, problems, count };
    if (!count) break;
  }
  return { plan: best.plan, problems: best.problems, ok: best.count === 0 };
}

// Groups whose sizes differ by at most one: `count` groups, or groups of `size` people when
// mode is "size". Pairs in `apart` are kept in different groups when that is possible.
// Returns { groups, broken: [[a, b]] }.
export function splitGroups(people, mode, n, apart = [], tries = TRIES) {
  const count = Math.max(1, Math.min(people.length, mode === "size" ? Math.ceil(people.length / n) : n));
  let best = null;
  for (let t = 0; t < tries; t++) {
    const groups = Array.from({ length: count }, () => []);
    shuffle(people).forEach((p, i) => groups[i % count].push(p));
    const broken = apart.filter(([a, b]) => groups.some((g) => g.includes(a) && g.includes(b)));
    if (!best || broken.length < best.broken.length) best = { groups, broken };
    if (!broken.length) break;
  }
  return best ?? { groups: [], broken: [] };
}
