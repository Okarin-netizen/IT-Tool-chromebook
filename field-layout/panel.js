// The settings column on the right. It shows the place and the figure when nothing is chosen,
// or what can be changed on the chosen items. `api` (from app.js) does the changing.
import { COLORS, PARTS, MARKS, TEXT_SIZES, NUMBER_SIZE, CHAIR_STEP, chairCount, fitsPlace } from "./parts.js";
import { FIELDS, GROUNDS, PLACES, STAGES, STAGE_SHAPES, STAIRS, STAIRS_ACROSS, NORTH_ANGLES, BASE_INDEX, setPlace, isStraight, lineLength, lengthText } from "./drawing.js";

const SIZE_STEPS = { small: 0.7, normal: 1, large: 1.5 };
const SIZE_WORDS = { small: "小", normal: "中", large: "大" };
const LAYOUTS = { row: "横1列", column: "縦1列", circle: "円", grid: "四角" };
const ROTATE_STEP = 15; // degrees per press
const MAX_COUNT = 60;

/* ---------- small builders ---------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

const heading = (text) => el("h3", {}, [text]);
const row = (label, control) => el("div", { className: "row" }, [el("span", {}, [label]), control]);

function segmented(label, options, value, onPick) {
  const buttons = Object.entries(options).map(([key, text]) =>
    el("button", { type: "button", role: "radio", "aria-checked": String(key === value), onclick: () => onPick(key) }, [text]));
  return el("div", { className: "seg", role: "radiogroup", "aria-label": label }, buttons);
}

function swatches(value, onPick) {
  const buttons = COLORS.map(({ color, name }) =>
    el("button", { type: "button", className: "swatch", role: "radio", style: `--c:${color}`, title: name, "aria-label": name, "aria-checked": String(color === value), onclick: () => onPick(color) }));
  return el("div", { className: "swatches", role: "radiogroup", "aria-label": "色" }, buttons);
}

function numberBox(value, { min, max, step, unit, label }, onChange) {
  const input = el("input", { type: "number", value: String(value), min: String(min), max: String(max), step: String(step), "aria-label": label });
  input.addEventListener("change", () => {
    const number = Number(input.value);
    if (!Number.isFinite(number)) return;
    onChange(Math.min(max, Math.max(min, number)));
  });
  return el("span", { className: "unit" }, [input, unit]);
}

function checkbox(text, checked, onChange) {
  const input = el("input", { type: "checkbox", checked, onchange: () => onChange(input.checked) });
  return el("label", { className: "check" }, [input, text]);
}

function button(text, onClick, { wide = false, title = "" } = {}) {
  return el("button", { type: "button", className: wide ? "btn small wide" : "btn small", title, onclick: onClick }, [text]);
}

// A text box that changes the drawing while typing and records one undo step when done.
function textBox(value, { label, placeholder = "", multiline = false, id = "" }, api, onInput) {
  const input = multiline ? el("textarea", { rows: 2 }) : el("input", { type: "text" });
  Object.assign(input, { value, placeholder, maxLength: 80 });
  input.setAttribute("aria-label", label);
  if (id) input.id = id;
  input.addEventListener("input", () => api.live(() => onInput(input.value)));
  input.addEventListener("change", () => api.record());
  return input;
}

/* ---------- nothing chosen: the figure and the yard ---------- */

function figureSection(api) {
  const { doc, figureIndex } = api;
  const figure = doc.figures[figureIndex];
  const section = [heading("この図")];
  if (figureIndex === BASE_INDEX) {
    section.push(el("p", { className: "value" }, ["テント・門・席など、どの図にも出すものをここに置きます。種目ごとの図は、下の「図を足す」で作ります。"]));
  } else {
    section.push(row("名前", textBox(figure.name, { label: "図の名前", id: "figure-name" }, api, (value) => (figure.name = value.trim() || "図"))));
    section.push(checkbox("「全体の配置」を重ねる", figure.showBase, (on) => api.change(() => (figure.showBase = on))));
  }
  const buttons = [button("図を複製", api.duplicateFigure, { title: "この図をもう1つ作る（別の種目のもとに）" })];
  if (figureIndex !== BASE_INDEX) buttons.push(button("図を消す", api.deleteFigure));
  if (api.canPaste) buttons.push(button("貼り付け", api.paste, { wide: true, title: "コピーした部品をこの図に置く (Ctrl+V)" }));
  section.push(el("div", { className: "buttons" }, buttons));
  return section;
}

function placeSection(api) {
  const { doc } = api;
  const gym = doc.place === "gym";
  const where = PLACES[doc.place].name;
  const places = Object.fromEntries(Object.entries(PLACES).map(([key, { name }]) => [key, name]));
  const pickPlace = (key) => {
    if (key === doc.place) return;
    api.change(() => setPlace(doc, key));
    api.status(`${PLACES[key].name}にしました。置いてあるものはそのままです（「元に戻す」で戻せます）`);
  };
  const shape = el("select", { "aria-label": gym ? "床の線" : "校庭の形", onchange: (e) => api.change(() => (doc.field = e.target.value)) },
    Object.entries(FIELDS).filter(([, field]) => fitsPlace(field, doc.place)).map(([key, { name }]) => new Option(name, key, false, key === doc.field)));
  const min = gym ? 10 : 20;
  const size = el("span", { className: "unit" }, [
    numberBox(doc.width, { min, max: 300, step: 1, unit: "", label: `${where}の横（m）` }, (value) => api.change(() => (doc.width = value))),
    "×",
    numberBox(doc.height, { min, max: 300, step: 1, unit: "m", label: `${where}の縦（m）` }, (value) => api.change(() => (doc.height = value))),
  ]);
  const grounds = Object.fromEntries(Object.entries(GROUNDS).filter(([, ground]) => fitsPlace(ground, doc.place)).map(([key, { name }]) => [key, name]));
  const rows = [
    heading("場所"),
    Object.assign(segmented("場所", places, doc.place, pickPlace), { className: "seg wide" }),
    row(gym ? "床の線" : "形", shape),
    row("大きさ", size),
    row(gym ? "床" : "地面", segmented(gym ? "床の色" : "地面の色", grounds, doc.ground, (key) => api.change(() => (doc.ground = key)))),
  ];
  if (gym) {
    const stage = segmented("ステージの場所", STAGES, doc.stage, (key) => api.change(() => (doc.stage = key)));
    rows.push(el("div", { className: "row stack" }, ["ステージの場所", Object.assign(stage, { className: "seg wide" })]));
    if (doc.stage !== "none") rows.push(...stageRows(api));
  }
  return rows;
}

// The stage's size, shape and stairs. Stairs placed anywhere else are a part (階段).
function stageRows(api) {
  const { doc } = api;
  const across = doc.stage === "left" || doc.stage === "right";
  const wide = (label, options, value, onPick) => Object.assign(segmented(label, options, value, onPick), { className: "seg wide" });
  const size = el("span", { className: "unit" }, [
    numberBox(doc.stageWidth, { min: 3, max: 100, step: 0.5, unit: "", label: "ステージの幅（m）" }, (value) => api.change(() => (doc.stageWidth = value))),
    "×",
    numberBox(doc.stageDepth, { min: 1, max: 30, step: 0.5, unit: "m", label: "ステージの奥行き（m）" }, (value) => api.change(() => (doc.stageDepth = value))),
  ]);
  return [
    el("div", { className: "row stack" }, ["ステージの幅×奥行き", size]),
    el("div", { className: "row stack" }, ["ステージの形", wide("ステージの形", STAGE_SHAPES, doc.stageShape, (key) => api.change(() => (doc.stageShape = key)))]),
    el("div", { className: "row stack" }, ["階段", wide("階段", across ? STAIRS_ACROSS : STAIRS, doc.stairs, (key) => api.change(() => (doc.stairs = key)))]),
  ];
}

function extrasSection(api) {
  const { doc } = api;
  const angle = el("select", { "aria-label": "北の向き", disabled: !doc.north.show, onchange: (e) => api.change(() => (doc.north.angle = Number(e.target.value))) },
    Object.entries(NORTH_ANGLES).map(([value, name]) => new Option(name, value, false, Number(value) === doc.north.angle)));
  return [
    heading("図に入れるもの"),
    checkbox("図の名前（左上）", doc.showTitle, (on) => api.change(() => (doc.showTitle = on))),
    el("div", { className: "row" }, [checkbox("北の印", doc.north.show, (on) => api.change(() => (doc.north.show = on))), angle]),
    checkbox("縮尺（物差し）", doc.scaleBar, (on) => api.change(() => (doc.scaleBar = on))),
    heading("印刷"),
    checkbox("白黒印刷向けにする", doc.bw, (on) => api.change(() => (doc.bw = on))),
  ];
}

function hint(api) {
  const where = PLACES[api.doc.place].name;
  return el("div", { className: "hint" }, [
    el("p", {}, [`左の部品を押してから、${where}の置きたい所を押します（部品を${where}まで引っぱっても置けます）。矢印は、始めの所から終わりの所まで引っぱります。`]),
    el("p", {}, ["置いたものは押して選び、引っぱって動かします。Shift を押しながら押すと、いくつも選べます。何もない所を引っぱっても囲んで選べます。"]),
  ]);
}

/* ---------- one item chosen ---------- */

function colorRow(value, api) {
  return el("div", { className: "row stack" }, ["色", swatches(value, (color) => api.edit((target) => (target.color = color)))]);
}

function sizeRow(item, api) {
  if (item.type === "text") {
    const key = Object.keys(TEXT_SIZES).find((name) => Math.abs(TEXT_SIZES[name] * api.ink - item.size) < 0.01);
    return row("大きさ", segmented("文字の大きさ", SIZE_WORDS, key, (name) => api.edit((target) => (target.size = TEXT_SIZES[name] * api.ink))));
  }
  const k = PARTS[item.type]?.real ? 1 : api.ink;
  const base = item.type === "number" ? { w: NUMBER_SIZE * k, h: NUMBER_SIZE * k } : { w: PARTS[item.type].w * k, h: PARTS[item.type].h * k };
  if (item.type === "chairs") return chairRows(item, api);
  if (PARTS[item.type]?.stretch) {
    return row("大きさ", el("span", { className: "unit" }, [
      numberBox(round(item.w), { min: 0.3, max: 200, step: 0.5, unit: "", label: "横（m）" }, (value) => api.edit((target) => (target.w = value))),
      "×",
      numberBox(round(item.h), { min: 0.3, max: 200, step: 0.5, unit: "m", label: "縦（m）" }, (value) => api.edit((target) => (target.h = value))),
    ]));
  }
  const key = Object.keys(SIZE_STEPS).find((name) => Math.abs(base.w * SIZE_STEPS[name] - item.w) < 0.01);
  return row("大きさ", segmented("大きさ", SIZE_WORDS, key, (name) => api.edit((target) => {
    target.w = base.w * SIZE_STEPS[name];
    target.h = base.h * SIZE_STEPS[name];
  })));
}

const round = (value) => Math.round(value * 10) / 10;

// いすの列: the number of chairs across and the number of rows, and how many that makes.
function chairRows(item, api) {
  const { columns, rows } = chairCount(item);
  return el("div", { className: "row stack" }, [
    "いすの数",
    el("span", { className: "unit" }, [
      numberBox(columns, { min: 1, max: 60, step: 1, unit: "", label: "横に並ぶいすの数" }, (value) => api.edit((target) => (target.w = Math.round(value) * CHAIR_STEP.x))),
      "こ ×",
      numberBox(rows, { min: 1, max: 60, step: 1, unit: "", label: "列の数" }, (value) => api.edit((target) => (target.h = Math.round(value) * CHAIR_STEP.y))),
      "列",
    ]),
    el("span", { className: "value", id: "chair-total" }, [`全部で ${columns * rows}きゃく`]),
  ]);
}

function turnRow(api, item) {
  return row("向き", el("span", { className: "unit" }, [
    button("左へ", () => api.rotateBy(-ROTATE_STEP), { title: `左に${ROTATE_STEP}°回す` }),
    el("span", { className: "value" }, [`${Math.round(item.rot ?? 0)}°`]),
    button("右へ", () => api.rotateBy(ROTATE_STEP), { title: `右に${ROTATE_STEP}°回す` }),
  ]));
}

function lineRows(item, api) {
  const rows = [];
  if (item.kind !== "measure") {
    rows.push(row("線", segmented("線の形", { solid: "実線", dash: "点線" }, item.dash ? "dash" : "solid", (key) => api.edit((target) => (target.dash = key === "dash")))));
    rows.push(row("矢じり", segmented("矢じり", { end: "先", both: "両方", none: "なし" }, item.head, (key) => api.edit((target) => (target.head = key)))));
  }
  rows.push(row("太さ", segmented("線の太さ", { thin: "細い", normal: "ふつう", thick: "太い" }, item.width, (key) => api.edit((target) => (target.width = key)))));
  if (item.kind === "measure") rows.push(row("長さ", el("span", { className: "value" }, [lengthText(lineLength(item))])));
  const placeholder = item.kind === "measure" ? "長さの代わりに書く" : "例: 入場";
  rows.push(row("ことば", textBox(item.label ?? "", { label: "線に書くことば", placeholder }, api, (value) => api.editLive((target) => (target.label = value)))));
  if (item.kind !== "measure" && !isStraight(item)) rows.push(el("div", { className: "buttons" }, [button("まっすぐにする", api.straighten, { wide: true })]));
  return rows;
}

function arrangeSection(api) {
  const { arrange } = api.settings;
  return [
    heading("まとめて置く"),
    row("並べ方", segmented("並べ方", LAYOUTS, arrange.layout, (key) => api.setArrange({ layout: key }))),
    row("数", numberBox(arrange.count, { min: 2, max: MAX_COUNT, step: 1, unit: "こ", label: "数" }, (value) => api.setArrange({ count: Math.round(value) }))),
    row("間かく", numberBox(arrange.gap, { min: 0.5, max: 50, step: 0.5, unit: "m", label: "間かく（m）" }, (value) => api.setArrange({ gap: value }))),
    el("div", { className: "buttons" }, [button("並べる", api.arrange, { wide: true, title: "選んでいるものを、この数と間かくで並べる" })]),
  ];
}

function itemName(item) {
  if (item.type === "line") return MARKS[{ arrow: "arrow", white: "white", measure: "measure" }[item.kind]].name;
  return (PARTS[item.type] ?? MARKS[item.type]).name;
}

function itemSection(item, api) {
  const rows = [heading(`選んでいるもの：${itemName(item)}`), colorRow(item.color, api)];
  if (item.type === "line") return rows.concat(lineRows(item, api));
  if (item.type === "text") rows.push(el("div", { className: "row stack" }, ["文字", textBox(item.text, { label: "文字", multiline: true, id: "text-input" }, api, (value) => api.editLive((target) => (target.text = value || " ")))]));
  if (item.type === "number") rows.push(row("番号", numberBox(item.n, { min: 0, max: 999, step: 1, unit: "", label: "番号" }, (value) => api.edit((target) => (target.n = Math.round(value))))));
  rows.push(sizeRow(item, api));
  if (PARTS[item.type]) rows.push(row("名前", textBox(item.label ?? "", { label: "名前", placeholder: "例: 本部", id: "label-input" }, api, (value) => api.editLive((target) => (target.label = value)))));
  if (item.type !== "number") rows.push(turnRow(api, item));
  return rows;
}

function actionButtons(api, many) {
  const buttons = [
    button("ふやす", api.duplicate, { title: "同じものをもう1つ (Ctrl+D)" }),
    button("消す", api.remove, { title: "消す (Delete)" }),
    button("コピー", api.copy, { title: "ほかの図に貼り付けるためにコピー (Ctrl+C)" }),
  ];
  if (!many) buttons.push(button("前に出す", api.toFront), button("後ろへ", api.toBack));
  return el("div", { className: "buttons" }, buttons);
}

/* ---------- putting it together ---------- */

export function renderPanel(container, api) {
  const items = api.selectedItems();
  let content;
  if (items.length === 0) {
    content = [...figureSection(api), ...placeSection(api), ...extrasSection(api), hint(api)];
  } else if (items.length === 1) {
    const [item] = items;
    content = [...itemSection(item, api), actionButtons(api, false)];
    if (PARTS[item.type] || item.type === "number") content.push(...arrangeSection(api));
  } else {
    content = [
      heading(`${items.length}こ 選んでいます`),
      colorRow(null, api),
      actionButtons(api, true),
      el("p", { className: "value" }, ["引っぱると、まとめて動きます。"]),
    ];
  }
  container.replaceChildren(...content);
}
