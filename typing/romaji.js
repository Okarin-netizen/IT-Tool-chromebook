// Japanese romaji typing: every common way of spelling the reading is accepted (shi / si,
// tsu / tu, kyo / kilyo, ん as n or nn, っ by doubling the next consonant), the way typing
// games such as e-typing do. The reading is cut into units of one or two kana; for each unit
// the acceptable spellings are listed, and the typed keys are matched against them.

const BASE = {
  あ: "a", い: "i,yi", う: "u,wu,whu", え: "e", お: "o",
  か: "ka,ca", き: "ki", く: "ku,cu,qu", け: "ke", こ: "ko,co",
  さ: "sa", し: "shi,si,ci", す: "su", せ: "se,ce", そ: "so",
  た: "ta", ち: "chi,ti", つ: "tsu,tu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu,hu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", を: "wo", ゐ: "wyi", ゑ: "wye",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  ざ: "za", じ: "ji,zi", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "di", づ: "du", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ぁ: "la,xa", ぃ: "li,xi", ぅ: "lu,xu", ぇ: "le,xe", ぉ: "lo,xo",
  ゃ: "lya,xya", ゅ: "lyu,xyu", ょ: "lyo,xyo", ゎ: "lwa,xwa",
  っ: "ltu,xtu,ltsu,xtsu",
  ゔ: "vu",
  ー: "-", "、": ",", "。": ".", "・": "/", "「": "[", "」": "]", "？": "?", "！": "!", "　": " ",
};

// Two-kana units: small ゃゅょ and the like after a kana.
const PAIRS = {
  きゃ: "kya", きぃ: "kyi", きゅ: "kyu", きぇ: "kye", きょ: "kyo",
  しゃ: "sha,sya", しぃ: "syi", しゅ: "shu,syu", しぇ: "she,sye", しょ: "sho,syo",
  ちゃ: "cha,tya,cya", ちぃ: "tyi,cyi", ちゅ: "chu,tyu,cyu", ちぇ: "che,tye,cye", ちょ: "cho,tyo,cyo",
  にゃ: "nya", にぃ: "nyi", にゅ: "nyu", にぇ: "nye", にょ: "nyo",
  ひゃ: "hya", ひぃ: "hyi", ひゅ: "hyu", ひぇ: "hye", ひょ: "hyo",
  みゃ: "mya", みぃ: "myi", みゅ: "myu", みぇ: "mye", みょ: "myo",
  りゃ: "rya", りぃ: "ryi", りゅ: "ryu", りぇ: "rye", りょ: "ryo",
  ぎゃ: "gya", ぎぃ: "gyi", ぎゅ: "gyu", ぎぇ: "gye", ぎょ: "gyo",
  じゃ: "ja,zya,jya", じぃ: "jyi,zyi", じゅ: "ju,zyu,jyu", じぇ: "je,zye,jye", じょ: "jo,zyo,jyo",
  ぢゃ: "dya", ぢぃ: "dyi", ぢゅ: "dyu", ぢぇ: "dye", ぢょ: "dyo",
  びゃ: "bya", びぃ: "byi", びゅ: "byu", びぇ: "bye", びょ: "byo",
  ぴゃ: "pya", ぴぃ: "pyi", ぴゅ: "pyu", ぴぇ: "pye", ぴょ: "pyo",
  ふぁ: "fa,fwa", ふぃ: "fi,fyi", ふぇ: "fe,fye", ふぉ: "fo,fwo", ふゅ: "fyu",
  てぃ: "thi", でぃ: "dhi", てゅ: "thu", でゅ: "dhu", とぅ: "twu", どぅ: "dwu",
  うぃ: "wi,whi", うぇ: "we,whe", うぉ: "who", いぇ: "ye",
  ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo",
  つぁ: "tsa", つぃ: "tsi", つぇ: "tse", つぉ: "tso",
};

const split = (s) => s.split(",");
const TABLE = new Map([...Object.entries(BASE), ...Object.entries(PAIRS)].map(([k, v]) => [k, split(v)]));

// Katakana → hiragana, full-width letters and digits → ASCII.
export function normalizeKana(text) {
  return text
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// The ways to type the unit starting at `pos`: [{ romaji, length (kana used) }].
export function unitOptions(kana, pos) {
  const out = [];
  const pair = kana.slice(pos, pos + 2);
  if (pair.length === 2 && TABLE.has(pair)) for (const r of TABLE.get(pair)) out.push({ romaji: r, length: 2 });
  const ch = kana[pos];
  if (ch === "ん") {
    const next = pos + 1 < kana.length ? unitOptions(kana, pos + 1) : [];
    // A single "n" is fine only when the next sound cannot be read together with it.
    if (next.length && next.every((o) => !/^[aiueony']/.test(o.romaji))) out.push({ romaji: "n", length: 1 });
    for (const r of ["nn", "xn", "n'"]) out.push({ romaji: r, length: 1 });
  } else if (ch === "っ") {
    const next = pos + 1 < kana.length ? unitOptions(kana, pos + 1) : [];
    const doubled = new Set(next.map((o) => o.romaji[0]).filter((c) => /[bcdfghjklmpqrstvwxyz]/.test(c)));
    for (const c of doubled) out.push({ romaji: c, length: 1 });
    for (const r of TABLE.get("っ")) out.push({ romaji: r, length: 1 });
  } else if (TABLE.has(ch)) {
    for (const r of TABLE.get(ch)) out.push({ romaji: r, length: 1 });
  } else if (ch !== undefined) {
    out.push({ romaji: ch.toLowerCase(), length: 1 }); // letters, digits, spaces as they are
  }
  return out;
}

// The usual (Hepburn) spelling of the whole reading from `pos` (for the guide under the word).
export function guide(kana, pos = 0) {
  let s = "";
  while (pos < kana.length) {
    const [first] = unitOptions(kana, pos);
    if (!first) break;
    s += first.romaji;
    pos += first.length;
  }
  return s;
}

// Follows the keys typed for one reading. type(key) returns true when the key fits.
export function createMatcher(reading) {
  const kana = normalizeKana(reading);
  let pos = 0;
  let buffer = ""; // keys typed for the unit at pos
  let typed = ""; // every accepted key

  const commit = (opt) => {
    pos += opt.length;
    buffer = "";
  };

  function type(key) {
    if (pos >= kana.length) return false;
    const opts = unitOptions(kana, pos);
    const next = buffer + key;
    const fits = opts.filter((o) => o.romaji.startsWith(next));
    if (fits.length) {
      buffer = next;
      typed += key;
      const exact = fits.find((o) => o.romaji === next);
      // Done with this unit unless a longer spelling could still follow (n / nn).
      if (exact && fits.every((o) => o.romaji === next)) commit(exact);
      return true;
    }
    // "n" for ん waits for the next key: if that key starts the next unit, ん was just "n".
    const done = opts.find((o) => o.romaji === buffer);
    if (done) {
      const before = { pos, buffer };
      commit(done);
      if (type(key)) return true;
      ({ pos, buffer } = before);
    }
    return false;
  }

  return {
    type,
    get done() {
      return pos >= kana.length;
    },
    get typed() {
      return typed;
    },
    // What is left to type, following the spelling chosen so far.
    get rest() {
      if (pos >= kana.length) return "";
      const opts = unitOptions(kana, pos).filter((o) => o.romaji.startsWith(buffer));
      const opt = opts[0] ?? unitOptions(kana, pos)[0];
      return opt.romaji.slice(buffer.length) + guide(kana, pos + opt.length);
    },
  };
}
