// Undo and redo. The history is a list of steps, each a record of how things were after a
// change; the current one is steps[pos]. Call record() after every change, and reset() when a
// new document is opened.
//
// By default a step is the items written on the pages (state.items). Each step is a shallow
// copy of the list, so steps share the item objects. An item that is already in the list must
// therefore never be changed in place: call edit(item) first, which puts a copy in its place
// and returns it. With ?debug in the URL the recorded items are frozen, so a missing edit()
// throws (modules run in strict mode) and the tests notice.
//
// A tool that keeps something else passes `take` (returns the current state as a step) and
// `apply` (brings a step back) instead.
const LIMIT = 200; // steps kept; the oldest are dropped
const DEBUG = new URLSearchParams(location.search).has("debug");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export class History {
  constructor(state, { take, apply, limit = LIMIT } = {}) {
    this.state = state;
    this.take = take ?? (() => this.itemsSnapshot());
    this.apply = apply ?? ((step) => (state.items = step.slice()));
    this.limit = limit;
    this.reset();
  }

  // Starts over from the current items.
  reset() {
    this.steps = [this.take()];
    this.pos = 0;
  }

  get canUndo() {
    return this.pos > 0;
  }

  get canRedo() {
    return this.pos < this.steps.length - 1;
  }

  // Records the current items as a new step. `replace` folds a follow-up drag into the last step.
  record(replace = false) {
    if (!replace) {
      this.steps.length = ++this.pos;
      if (this.steps.length >= this.limit) {
        this.steps.shift();
        this.pos--;
      }
    }
    this.steps[this.pos] = this.take();
  }

  // Brings back step `pos`. Returns false when there is no such step.
  go(pos) {
    if (pos < 0 || pos >= this.steps.length) return false;
    this.pos = pos;
    this.apply(this.steps[pos]);
    return true;
  }

  undo() {
    return this.go(this.pos - 1);
  }

  redo() {
    return this.go(this.pos + 1);
  }

  // Swaps `item` for a copy that may be changed, and returns the copy. Items not in the
  // list yet (being drawn or typed) are returned as they are.
  edit(item) {
    const { state } = this;
    const i = state.items.indexOf(item);
    if (i < 0) return item;
    const copy = structuredClone(item);
    state.items[i] = copy;
    if (state.selected === item) state.selected = copy;
    if (state.editing?.item === item) state.editing.item = copy;
    return copy;
  }

  itemsSnapshot() {
    const items = this.state.items.slice();
    if (DEBUG) items.forEach(deepFreeze);
    return items;
  }
}
