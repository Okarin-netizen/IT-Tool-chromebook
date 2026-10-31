// The parts PDFに手書き・署名 (pdf-sign) and PDF一括採点 (pdf-grade) build alike on top of
// ink.js: their list of stamps, the menus that drop down from the toolbar, and the toolbar
// buttons for the tools, colors and undo.

import { drawStamp, previewCanvas, textWidth, MARKER_FACTOR, SEAL_COLOR, TEXT_FONT } from "./ink.js";

// A tool's stamps. Each entry is { id, label, shape, w, h } plus, as drawStamp needs them,
// seal (always vermilion), text (a string, or a function for one that changes, like the
// date), vertical and fit. A "text" stamp is as wide as what it says.
export function createStamps(list, state) {
  const stampDef = (id) => list.find((s) => s.id === id);

  // A new stamp centred on (cx, cy) of page `page`.
  function newStamp(id, page, cx, cy) {
    const def = stampDef(id);
    const text = (typeof def.text === "function" ? def.text() : def.text) ?? "";
    let { w, h } = def;
    if (def.shape === "text") w = textWidth(text, `${h * 0.85}px ${TEXT_FONT}`) + 2;
    return {
      type: "stamp", page, kind: id, text,
      color: def.seal ? SEAL_COLOR : state.color,
      x: cx - w / 2, y: cy - h / 2, w, h,
    };
  }

  // Fills the stamp menu: `lists` pairs a list element with whether it holds the seals.
  // A stamp for which `wide(def)` is true takes two columns and a preview `wideBox` wide.
  function renderChoices(lists, { wide, wideBox, onPick }) {
    for (const [listEl, seal] of lists) {
      listEl.replaceChildren(...list.filter((def) => !!def.seal === seal).map((def) => {
        const item = newStamp(def.id, 0, 0, 0);
        item.x = item.y = 0;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "stamp-choice";
        btn.title = def.label;
        btn.setAttribute("aria-label", def.label);
        btn.classList.toggle("selected", state.stamp === def.id);
        if (wide(def)) btn.style.gridColumn = "span 2";
        btn.append(previewCanvas((ctx) => drawStamp(ctx, item, def), item.w, item.h, wide(def) ? wideBox : 46));
        btn.addEventListener("click", () => onPick(def));
        return btn;
      }));
    }
  }

  return { stampDef, newStamp, renderChoices };
}

// Menus that drop down from the toolbar; opening one closes the others.
export function createMenus(...menus) {
  const close = () => menus.forEach((menu) => (menu.hidden = true));
  const toggle = (menu) => {
    const show = menu.hidden;
    close();
    menu.hidden = !show;
  };
  return { close, toggle };
}

// Marks the chosen tool and color, and turns undo, redo and delete on or off.
export function syncToolbar({ tools, swatches, undoBtn, redoBtn, deleteBtn }, state, history, open) {
  for (const btn of tools) btn.classList.toggle("selected", btn.dataset.tool === state.tool);
  for (const sw of swatches) sw.classList.toggle("selected", sw.dataset.color === state.color);
  undoBtn.disabled = !open || !history.canUndo;
  redoBtn.disabled = !open || !history.canRedo;
  deleteBtn.disabled = !state.selected;
}

// Connects the toolbar controls both tools have: colors, pen width, undo, redo and delete.
export function bindToolbar(els, state, editor, setColor) {
  for (const sw of els.swatches) sw.addEventListener("click", () => setColor(sw.dataset.color));
  els.width.addEventListener("change", () => {
    state.width = Number(els.width.value);
    editor.changeSelected((item) => item.type === "stroke", (item) => {
      item.width = item.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    });
  });
  els.undoBtn.addEventListener("click", editor.undo);
  els.redoBtn.addEventListener("click", editor.redo);
  els.deleteBtn.addEventListener("click", editor.deleteSelected);
}
