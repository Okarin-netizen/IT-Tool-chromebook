// あみだくじ: the ladder (vertical lines and rungs) and where each line ends up.
// No screen code here, so it can be checked on its own.
import { randomInt } from "../shared/js/random.js";

export const AMIDA_ROWS = 14; // heights a rung can be at
const RUNG_CHANCE = 0.4; // how often a free spot gets a rung
const MIN_RUNGS_PER_GAP = 2;

// rungs[row][gap] is true when a rung joins line `gap` and line `gap + 1` at that height.
// Two rungs never touch: a rung's neighbours on the same row are always empty.
export function emptyLadder(lines) {
  return Array.from({ length: AMIDA_ROWS }, () => new Array(Math.max(0, lines - 1)).fill(false));
}

export function canAddRung(rungs, row, gap) {
  const line = rungs[row];
  if (!line || gap < 0 || gap >= line.length || line[gap]) return false;
  return !line[gap - 1] && !line[gap + 1];
}

const rungsInGap = (rungs, gap) => rungs.filter((row) => row[gap]).length;

export function makeLadder(lines) {
  const rungs = emptyLadder(lines);
  const gaps = lines - 1;
  for (let row = 0; row < AMIDA_ROWS; row++) {
    for (let gap = 0; gap < gaps; gap++) {
      const lucky = randomInt(1000) < RUNG_CHANCE * 1000;
      if (lucky && canAddRung(rungs, row, gap)) rungs[row][gap] = true;
    }
  }
  // Every gap gets a few rungs, so no line simply goes straight down.
  for (let gap = 0; gap < gaps; gap++) {
    let tries = 0;
    while (rungsInGap(rungs, gap) < MIN_RUNGS_PER_GAP && tries++ < 100) {
      const row = randomInt(AMIDA_ROWS);
      if (canAddRung(rungs, row, gap)) rungs[row][gap] = true;
    }
  }
  return rungs;
}

// The way down from the top of `start`: a list of { x: line, y: row } corners, where y runs
// from 0 (top) to AMIDA_ROWS + 1 (bottom) and rung `row` sits at y = row + 1.
export function tracePath(rungs, start) {
  const points = [{ x: start, y: 0 }];
  let line = start;
  rungs.forEach((row, index) => {
    const y = index + 1;
    let next = line;
    if (row[line]) next = line + 1;
    else if (row[line - 1]) next = line - 1;
    if (next === line) return;
    points.push({ x: line, y }, { x: next, y });
    line = next;
  });
  points.push({ x: line, y: AMIDA_ROWS + 1 });
  return { points, end: line };
}

// Where each top line ends: ends[top] = bottom.
export function ladderEnds(rungs, lines) {
  return Array.from({ length: lines }, (_, start) => tracePath(rungs, start).end);
}

// The words at the bottom: as many as there are lines. Lines typed as "" are skipped; if nothing
// is typed the bottom is numbered 1, 2, 3…; missing ones are filled with "はずれ".
export function bottomLabels(typed, lines) {
  if (!typed.length) return Array.from({ length: lines }, (_, i) => `${i + 1}`);
  const labels = typed.slice(0, lines);
  while (labels.length < lines) labels.push("はずれ");
  return labels;
}
