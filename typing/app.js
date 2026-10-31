import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { shuffle } from "../shared/js/random.js";
import { createMatcher, normalizeKana, guide } from "./romaji.js";
import { keyOf, addRound, weakKeys, weightWords, drawKeyboard } from "./keys.js";

// Never change a key (or the shape of what is saved) once the tool is in use. Add a new key instead.
const SETTINGS_KEY = "typing-settings-v1"; // { lang, duration, source }
const CUSTOM_KEY = "typing-custom-v1"; // { ja: text, en: text } as typed in the box
const BEST_KEY = "typing-best-v1"; // { "ja-60-builtin": { speed, accuracy, date } }
const KEYS_KEY = "typing-keys-v1"; // { ja: { [key]: { n, miss, ms, timed } }, en: {…} } over all rounds

// [shown, reading]
const WORDS_JA = [
  ["教科書", "きょうかしょ"], ["時間割", "じかんわり"], ["給食", "きゅうしょく"], ["黒板", "こくばん"],
  ["宿題", "しゅくだい"], ["図書館", "としょかん"], ["体育館", "たいいくかん"], ["運動会", "うんどうかい"],
  ["修学旅行", "しゅうがくりょこう"], ["夏休み", "なつやすみ"], ["自由研究", "じゆうけんきゅう"], ["音楽室", "おんがくしつ"],
  ["理科の実験", "りかのじっけん"], ["算数", "さんすう"], ["国語", "こくご"], ["社会科見学", "しゃかいかけんがく"],
  ["消しゴム", "けしごむ"], ["鉛筆", "えんぴつ"], ["定規", "じょうぎ"], ["筆箱", "ふでばこ"],
  ["掃除当番", "そうじとうばん"], ["学級委員", "がっきゅういいん"], ["朝の会", "あさのかい"], ["卒業式", "そつぎょうしき"],
  ["入学式", "にゅうがくしき"], ["友だち", "ともだち"], ["先生", "せんせい"], ["校庭", "こうてい"],
  ["保健室", "ほけんしつ"], ["遠足", "えんそく"], ["文化祭", "ぶんかさい"], ["合唱コンクール", "がっしょうこんくーる"],
  ["パソコン", "ぱそこん"], ["タイピング", "たいぴんぐ"], ["インターネット", "いんたーねっと"], ["天気予報", "てんきよほう"],
  ["春夏秋冬", "しゅんかしゅうとう"], ["一石二鳥", "いっせきにちょう"], ["早起きは三文の徳", "はやおきはさんもんのとく"],
  ["よろしくお願いします", "よろしくおねがいします"], ["地球温暖化", "ちきゅうおんだんか"], ["富士山", "ふじさん"],
  ["新幹線", "しんかんせん"], ["東京スカイツリー", "とうきょうすかいつりー"], ["ちょっと待って", "ちょっとまって"],
  ["チャレンジ", "ちゃれんじ"], ["きょうりゅう", "きょうりゅう"], ["百人一首", "ひゃくにんいっしゅ"],
];
const WORDS_EN = [
  "school", "teacher", "homework", "library", "science", "music", "history", "computer", "keyboard", "practice",
  "friend", "lunch", "notebook", "pencil", "eraser", "classroom", "morning", "afternoon", "English", "Japan",
  "Thank you.", "Good morning!", "How are you?", "I like math.", "See you tomorrow.", "Nice to meet you.",
  "I play soccer every day.", "What time is it?", "My favorite subject is art.", "Let's go to the library.",
  "The quick brown fox jumps over the lazy dog.", "Where do you live?", "I have two brothers.", "It is sunny today.",
];

const $ = (id) => document.getElementById(id);
const els = {
  tabs: document.querySelectorAll(".tab"),
  duration: $("duration"),
  source: $("source"),
  stopBtn: $("stop-btn"),
  start: $("start"),
  startHint: $("start-hint"),
  startBtn: $("start-btn"),
  best: $("best"),
  custom: $("custom"),
  customHint: $("custom-hint"),
  customText: $("custom-text"),
  play: $("play"),
  timeLeft: $("time-left"),
  score: $("score"),
  misses: $("misses"),
  timebarFill: $("timebar-fill"),
  word: $("word"),
  kana: $("kana"),
  typed: $("typed"),
  nextKey: $("next-key"),
  rest: $("rest"),
  imeWarning: $("ime-warning"),
  result: $("result"),
  againBtn: $("again-btn"),
  resultKeyboard: $("r-keyboard"),
  history: $("key-history"),
  historyKeyboard: $("h-keyboard"),
  historyWeak: $("h-weak"),
  historyClear: $("h-clear"),
};

const saved = loadJson(SETTINGS_KEY, {});
const settings = {
  lang: saved.lang === "en" ? "en" : "ja",
  duration: [30, 60, 120].includes(saved.duration) ? saved.duration : 60,
  source: ["custom", "weak"].includes(saved.source) ? saved.source : "builtin",
};
const custom = { ja: "", en: "", ...loadJson(CUSTOM_KEY, {}) };

const game = {
  playing: false,
  words: [], // the order for this round
  index: 0,
  item: null, // { shown, reading }
  matcher: null,
  score: 0,
  misses: 0,
  wordsDone: 0,
  missedKeys: new Map(), // expected key → times missed
  keys: {}, // this round, per key on the keyboard: { n, miss, ms, timed } (see keys.js)
  lastHit: 0, // when the last right key was typed
  firstOfWord: true, // the next key starts a word, so it is not timed
  endsAt: 0,
  timer: 0,
};

/* ---------- words ---------- */

// Own words: Japanese lines are "表示,よみ" (or just the reading); English lines are typed as shown.
function customWords(lang) {
  const lines = custom[lang].split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lang === "en") return lines.map((l) => ({ shown: l, reading: l }));
  return lines.map((l) => {
    const [shown, reading = shown] = l.split(/[,、，]/).map((s) => s.trim());
    return { shown, reading: normalizeKana(reading) };
  }).filter((w) => /^[ぁ-ゖー、。・「」？！　a-z0-9 ,.\-?!]+$/i.test(w.reading));
}

function builtinWords() {
  if (settings.lang === "ja") return WORDS_JA.map(([shown, reading]) => ({ shown, reading }));
  return WORDS_EN.map((w) => ({ shown: w, reading: w }));
}

const keyHistory = () => loadJson(KEYS_KEY, {})[settings.lang] ?? {};
const spelling = (w) => (settings.lang === "ja" ? guide(normalizeKana(w.reading)) : w.reading);

function wordList() {
  if (settings.source === "custom") return customWords(settings.lang);
  // 苦手なキーの練習: the basic words, those with the weak keys several times over.
  if (settings.source === "weak") return weightWords(builtinWords(), weakKeys(keyHistory()), spelling);
  return builtinWords();
}

// English is matched key for key, capitals and punctuation included.
function englishMatcher(text) {
  let pos = 0;
  return {
    type(key) {
      if (key !== text[pos]) return false;
      pos++;
      return true;
    },
    get done() { return pos >= text.length; },
    get typed() { return text.slice(0, pos); },
    get rest() { return text.slice(pos); },
  };
}

/* ---------- screens ---------- */

const bestKey = () => `${settings.lang}-${settings.duration}-${settings.source}`;

function renderStart() {
  for (const t of els.tabs) t.setAttribute("aria-selected", String(t.dataset.lang === settings.lang));
  els.duration.value = String(settings.duration);
  els.source.value = settings.source;
  els.startHint.textContent = settings.lang === "ja"
    ? "出てきたことばを、ローマ字で打ちます。「し」は shi でも si でもOK。いろいろな打ち方に対応しています。"
    : "出てきた英語を、そのとおりに打ちます。大文字は Shift を押しながら打ちます。";
  els.customHint.textContent = settings.lang === "ja"
    ? "1行に1つ。「漢字,よみ」の形で書きます（例: 光合成,こうごうせい）。ひらがなだけなら、よみは書かなくてOK。"
    : "1行に1つ、打つ英語を書きます（例: I am a student.）。";
  els.customText.value = custom[settings.lang];
  els.customText.placeholder = settings.lang === "ja" ? "光合成,こうごうせい\n二酸化炭素,にさんかたんそ\nありがとう" : "I am a student.\nThis is my pen.";
  els.custom.open = settings.source === "custom";
  const best = loadJson(BEST_KEY, {})[bestKey()];
  els.best.textContent = best ? `この設定のベスト記録: 1分あたり ${best.speed} 打（正確さ ${best.accuracy}%）` : "";
  renderHistory();
}

const keyName = (k) => (k === " " ? "スペース" : k.toUpperCase());

// The keyboard over every round in this language, and which keys the practice will stress.
function renderHistory() {
  const stats = keyHistory();
  const any = Object.keys(stats).length > 0;
  els.history.hidden = !any;
  if (!any) return;
  drawKeyboard(els.historyKeyboard, stats);
  const weak = weakKeys(stats);
  els.historyWeak.textContent = weak.length
    ? `苦手なキー: ${weak.map(keyName).join("・")}。「ことば」を「苦手なキーの練習」にすると、これらのキーを使うことばが多く出ます。`
    : "今のところ、とくに苦手なキーはありません（キーごとに5回以上打つと判定します）。";
}

function show(screen) {
  els.start.hidden = screen !== "start";
  els.play.hidden = screen !== "play";
  els.result.hidden = screen !== "result";
  els.stopBtn.hidden = screen !== "play";
  for (const el of [...els.tabs, els.duration, els.source]) el.disabled = screen === "play";
}

function saveSettings() {
  saveJson(SETTINGS_KEY, settings);
  renderStart();
}

for (const t of els.tabs) {
  t.addEventListener("click", () => {
    settings.lang = t.dataset.lang;
    saveSettings();
    show("start");
  });
}
els.duration.addEventListener("change", () => {
  settings.duration = Number(els.duration.value);
  saveSettings();
});
els.source.addEventListener("change", () => {
  settings.source = els.source.value;
  saveSettings();
});
els.customText.addEventListener("input", () => {
  custom[settings.lang] = els.customText.value;
  saveJson(CUSTOM_KEY, custom);
});

/* ---------- playing ---------- */

function nextWord() {
  if (game.index >= game.words.length) {
    game.words = shuffle(game.words);
    game.index = 0;
  }
  game.item = game.words[game.index++];
  game.firstOfWord = true;
  game.matcher = settings.lang === "ja" ? createMatcher(game.item.reading) : englishMatcher(game.item.reading);
  els.word.textContent = game.item.shown;
  els.kana.textContent = settings.lang === "ja" && game.item.shown !== game.item.reading ? game.item.reading : "";
  renderWord();
}

function renderWord() {
  const rest = game.matcher.rest;
  els.typed.textContent = game.matcher.typed;
  els.nextKey.textContent = rest.slice(0, 1).replace(" ", "␣");
  els.rest.textContent = rest.slice(1);
  els.score.textContent = game.score;
  els.misses.textContent = game.misses;
}

function tick() {
  const left = Math.max(0, game.endsAt - performance.now());
  els.timeLeft.textContent = Math.ceil(left / 1000);
  els.timebarFill.style.transform = `scaleX(${left / (settings.duration * 1000)})`;
  if (left <= 0) finish();
}

function startGame() {
  if (game.playing) return;
  const words = wordList();
  if (!words.length) {
    els.custom.open = true;
    els.customText.focus();
    els.best.textContent = settings.lang === "ja" ? "「自分のことば」に、ひらがなの読みがついたことばを入れてください" : "「自分のことば」に英語を入れてください";
    return;
  }
  if (settings.source === "weak" && !weakKeys(keyHistory()).length) {
    els.best.textContent = "苦手なキーがまだ見つかっていないので、基本のことばをそのまま出します";
  }
  Object.assign(game, {
    playing: true, words: shuffle(words), index: 0, score: 0, misses: 0, wordsDone: 0, missedKeys: new Map(), keys: {},
  });
  game.endsAt = performance.now() + settings.duration * 1000;
  els.imeWarning.hidden = true;
  show("play");
  nextWord();
  tick();
  game.timer = setInterval(tick, 100);
}

function stopGame() {
  clearInterval(game.timer);
  game.playing = false;
}

function finish() {
  stopGame();
  const total = game.score + game.misses;
  const accuracy = total ? Math.round((game.score / total) * 1000) / 10 : 0;
  const speed = Math.round((game.score / settings.duration) * 60);
  $("r-speed").textContent = speed;
  $("r-accuracy").textContent = accuracy;
  $("r-score").textContent = game.score;
  $("r-misses").textContent = game.misses;
  $("r-words").textContent = game.wordsDone;
  const weak = [...game.missedKeys].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("r-keys").textContent = weak.length
    ? `まちがえやすいキー: ${weak.map(([k, n]) => `${k === " " ? "スペース" : k}（${n}回）`).join("、")}`
    : "ミスなし！";
  drawKeyboard(els.resultKeyboard, game.keys);
  const all = loadJson(KEYS_KEY, {});
  all[settings.lang] = addRound(all[settings.lang] ?? {}, game.keys);
  saveJson(KEYS_KEY, all);

  const bests = loadJson(BEST_KEY, {});
  const old = bests[bestKey()];
  if (game.score && (!old || speed > old.speed)) {
    bests[bestKey()] = { speed, accuracy, date: new Date().toISOString().slice(0, 10) };
    saveJson(BEST_KEY, bests);
    $("r-best").textContent = old ? `ベスト記録を更新しました（前回まで ${old.speed} 打）` : "はじめての記録です";
  } else {
    $("r-best").textContent = old ? `ベスト記録: 1分あたり ${old.speed} 打` : "";
  }
  show("result");
  renderStart();
}

// This round's numbers for the key on the keyboard that types `ch`.
function keyStat(ch) {
  const key = keyOf(ch);
  game.keys[key] ??= { n: 0, miss: 0, ms: 0, timed: 0 };
  return game.keys[key];
}

function onKey(e) {
  if (e.isComposing || e.key === "Process") {
    els.imeWarning.hidden = false;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    stopGame();
    show("start");
    return;
  }
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  const key = settings.lang === "ja" ? e.key.toLowerCase() : e.key;
  const expected = game.matcher.rest[0];
  const now = performance.now();
  if (game.matcher.type(key)) {
    game.score++;
    const s = keyStat(key);
    s.n++;
    if (!game.firstOfWord) {
      s.ms += now - game.lastHit;
      s.timed++;
    }
    game.firstOfWord = false;
    game.lastHit = now;
    els.play.classList.remove("miss");
    if (game.matcher.done) {
      game.wordsDone++;
      nextWord();
      return;
    }
  } else {
    game.misses++;
    game.missedKeys.set(expected, (game.missedKeys.get(expected) ?? 0) + 1);
    if (expected !== undefined) keyStat(expected).miss++;
    els.play.classList.add("miss");
  }
  renderWord();
}

document.addEventListener("keydown", (e) => {
  if (game.playing) {
    onKey(e);
    return;
  }
  if (e.key === " " && !e.target.matches("input, textarea, select, button, summary")) {
    e.preventDefault();
    startGame();
  }
});
els.startBtn.addEventListener("click", startGame);
els.againBtn.addEventListener("click", startGame);
els.historyClear.addEventListener("click", () => {
  if (!confirm("これまでのキーの記録を消しますか？")) return;
  const all = loadJson(KEYS_KEY, {});
  delete all[settings.lang];
  saveJson(KEYS_KEY, all);
  renderStart();
});
els.stopBtn.addEventListener("click", () => {
  stopGame();
  show("start");
});

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "romaji.js", "keys.js", "icon.svg", "manifest.webmanifest"]);

renderStart();
show("start");

// Hook for automated tests.
window.__typing = { game, settings, startGame, finish, wordList };
