#!/usr/bin/env node
// Smoke test for every tool: opens it in Chromium, does one typical action, checks what gets
// saved, and reloads it with the network cut to check that it still works offline.
//
//   node tests/smoke.cjs                 all tools
//   node tests/smoke.cjs pdf-text calc   only these tools
//   node tests/smoke.cjs --ocr           also run OCR in pdf-extract (slow)
//   node tests/smoke.cjs --headed        show the browser
//   node tests/smoke.cjs --narrow        use a narrow 600px window (phone-sized layout)
//   node tests/smoke.cjs --styles <dir>  also save every element's computed style (compare with
//                                        tests/compare-styles.cjs before and after a CSS change)
//
// Screenshots go to tests/output/ (not committed). Needs Node 22+ and Playwright.
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startServer } = require("./lib/server.cjs");
const fixtures = require("./lib/fixtures.cjs");

const OUT_DIR = path.join(__dirname, "output");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const VIEWPORT = flags.has("--narrow") ? { width: 600, height: 900 } : { width: 1280, height: 800 };
const STYLE_DIR = args.includes("--styles") ? path.resolve(args[args.indexOf("--styles") + 1]) : null;
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--styles");

/* ---------- per-tool checks ---------- */

// Each tool: `run` works online after the page has loaded, `offline` runs after an offline reload.
// `query` is added to the page address (`?debug` freezes recorded undo steps, see shared/js/history.js).
const TOOLS = {
  "pdf-text": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("テスト資料.pdf", 3)]);
      await t.until(() => __pdfText.state.pages.length === 3 && __pdfText.state.pages[0].rendered);
      await t.shot("open");
      await t.page.click(".page[data-num='1'] .layer", { position: { x: 120, y: 120 } });
      await t.page.keyboard.type("テスト");
      await t.until(() => __pdfText.state.items.some((i) => i.text === "テスト"));
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "テスト資料_記入済み.pdf");
      await t.expectPdfPages(file, 3);
      // A PDF with fill-in fields shows them as input boxes; what is typed is saved in them.
      await t.setFiles("#file-input", [{ name: "申込書.pdf", mimeType: "application/pdf", buffer: fixtures.formPdf() }]);
      await t.page.locator(".form-layer input[type=text]").waitFor();
      await t.shot("form");
      await t.page.fill(".form-layer input[type=text]", "山田 花子");
      await t.page.check(".form-layer input[type=checkbox]");
      await t.page.click("#save-btn");
      const [filled] = await t.downloads(1);
      t.expectName(filled, "申込書_記入済み.pdf");
      const form = (await fixtures.PDFLib.PDFDocument.load(filled.bytes)).getForm();
      t.expect(form.getTextField("name").getText() === "山田 花子", `入力欄の文字が保存されない: ${form.getTextField("name").getText()}`);
      t.expect(form.getCheckBox("agree").isChecked(), "チェックボックスが保存されない");
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("テスト資料.pdf", 3)]);
      await t.until(() => __pdfText.state.pages[0]?.rendered);
    },
  },

  "pdf-pages": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("資料.pdf", 3)]);
      await t.until(() => __pdfPages.state.pages.length === 3 && __pdfPages.state.pages.every((p) => p.rendered));
      await t.shot("open");
      await t.page.evaluate(() => {
        const { state, rotatePages, removePages } = __pdfPages;
        rotatePages([state.pages[1]], 90);
        removePages([state.pages[0]]);
      });
      await t.until(() => __pdfPages.state.pages.length === 2);
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "資料_編集済み.pdf");
      const doc = await t.expectPdfPages(file, 2);
      t.expect(doc.getPage(0).getRotation().angle === 90, "1ページ目が90°回転していない");

      // Page tools: number ranges, blank page, duplicate, reverse, front/back interleave, 2-in-1.
      const range = await t.page.evaluate(() => JSON.stringify(__pdfPages.parseRange("１－３、5, 9-", 10)));
      t.expect(range === "[0,1,2,4,8,9]", `番号で選ぶの読み取りが違う: ${range}`);
      await t.page.evaluate(async () => {
        const { state, toggleSelect, insertBlank, duplicatePages, reversePages } = __pdfPages;
        toggleSelect(state.pages[0]);
        await insertBlank(); // after page 1 → 3 pages
        duplicatePages(); // page 1 again → 4 pages
        state.pages.forEach((p) => (p.selected = false));
        reversePages();
      });
      const order = await t.page.evaluate(() => __pdfPages.state.pages.map((p) => (p.file.blank ? "白" : p.index + 1)).join(","));
      t.expect(order === "3,白,2,2", `白紙・複製・逆順のあとの並びが違う: ${order}`);
      await t.page.selectOption("#nup", "2");
      await t.page.click("#save-btn");
      const [sheets] = await t.downloads(1);
      t.expectName(sheets, "資料_編集済み_2in1.pdf");
      const sheetDoc = await t.expectPdfPages(sheets, 2);
      const { width, height } = sheetDoc.getPage(0).getSize();
      t.expect(width > height, "2in1の紙が横向きになっていない");
      await t.page.selectOption("#nup", "1");
      await t.page.evaluate(() => __pdfPages.removePages(__pdfPages.state.pages.slice()));
      await t.setFiles("#file-input", [t.pdf("表.pdf", 3), t.pdf("裏.pdf", 2)]);
      await t.until(() => __pdfPages.state.pages.length === 5);
      await t.page.evaluate(() => {
        const [front, back] = __pdfPages.state.pages.map((p) => p.file).filter((f, i, a) => a.indexOf(f) === i);
        __pdfPages.interleave(front, back, true);
      });
      const mixed = await t.page.evaluate(() => __pdfPages.state.pages.map((p) => `${p.file.name[0]}${p.index + 1}`).join(","));
      t.expect(mixed === "表1,裏2,表2,裏1,表3", `表裏の交互の並びが違う: ${mixed}`);
      await t.page.evaluate(() => __pdfPages.removePages(__pdfPages.state.pages.slice()));

      // A PDF locked with a password asks for it; a wrong one asks again.
      await t.setFiles("#file-input", [t.locked("鍵つき.pdf")]);
      await t.enterPassword("0000");
      await t.page.locator(".password-dialog .error").waitFor();
      await t.enterPassword("1234");
      await t.until(() => __pdfPages.state.pages.length === 2 && __pdfPages.state.pages.every((p) => p.rendered));
      await t.page.click("#save-btn");
      await t.expectPdfPages((await t.downloads(1))[0], 2);
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("資料.pdf", 3)]);
      await t.until(() => __pdfPages.state.pages.length === 3 && __pdfPages.state.pages[0].rendered);
    },
  },

  "pdf-sign": {
    query: "?debug",
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("申込書.pdf", 3)]);
      await t.until(() => __pdfSign.state.pages.length === 3 && __pdfSign.state.pages[0].rendered);
      await t.shot("open");
      const ink = t.page.locator(".page").first().locator(".ink");
      await t.drag(ink, [[60, 60], [140, 90], [200, 160]]);
      await t.page.evaluate(() => {
        __pdfSign.state.stamp = "sumi";
        __pdfSign.setTool("stamp");
      });
      await ink.click({ position: { x: 260, y: 220 } });
      await t.until(() => __pdfSign.state.items.length === 2);
      await t.page.evaluate(() => __pdfSign.undo());
      t.expect(await t.page.evaluate(() => __pdfSign.state.items.length) === 1, "元に戻すでハンコが消えない");
      await t.page.evaluate(() => __pdfSign.redo());
      t.expect(await t.page.evaluate(() => __pdfSign.state.items.length) === 2, "やり直しでハンコが戻らない");
      await editAndUndo(t, "__pdfSign", ink, [140, 90], "#1d4ed8");
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "申込書_書き込み済み.pdf");
      await t.expectPdfPages(file, 3);
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("申込書.pdf", 3)]);
      await t.until(() => __pdfSign.state.pages[0]?.rendered);
    },
  },

  "pdf-grade": {
    query: "?debug",
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("生徒A.pdf", 2), t.pdf("生徒B.pdf", 1)]);
      await t.until(() => __pdfGrade.state.files.length === 2);
      await t.page.locator(".page .ink").first().waitFor();
      await t.shot("open");
      const ink = t.page.locator(".page .ink").first();
      await t.drag(ink, [[60, 60], [120, 120], [180, 70]]);
      await t.page.evaluate(() => __pdfGrade.setTool("score"));
      await ink.click({ position: { x: 300, y: 80 } });
      const editor = t.page.locator("input.inline-edit");
      await editor.fill("80");
      await editor.press("Enter");
      await t.until(() => __pdfGrade.state.items.some((i) => i.type === "score" && i.value === "80"));
      await editAndUndo(t, "__pdfGrade", ink, [120, 120], "#1d4ed8");
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, /^採点済_\d{8}\.zip$/);
      const names = fixtures.zipNames(file.bytes);
      t.expect(names.includes("生徒A_採点済.pdf") && names.includes("生徒B_採点済.pdf"), `ZIPの中身が違う: ${names.join(", ")}`);
      t.expect(names.some((n) => n.endsWith(".csv")), `ZIPに点数一覧がない: ${names.join(", ")}`);

      // Work in progress survives closing the tab: reload and carry on.
      const before = await t.page.evaluate(async () => {
        await __pdfGrade.autosave();
        return __pdfGrade.state.items.length;
      });
      await t.page.reload();
      await t.page.locator("#resume:not([hidden])").waitFor();
      await t.page.click("#resume-btn");
      await t.until(() => __pdfGrade.state.files.length === 2 && __pdfGrade.state.items.length > 0);
      const after = await t.page.evaluate(() => __pdfGrade.state.items.length);
      t.expect(after === before, `続きから始めたときの書き込みの数が違う: ${after}（期待: ${before}）`);

      // Two PDFs locked with the same password ask for it only once.
      await t.setFiles("#file-input", [t.locked("生徒C.pdf"), t.locked("生徒D.pdf")]);
      await t.enterPassword("1234");
      await t.until(() => __pdfGrade.state.files.length === 4);
      t.expect(!(await t.page.locator(".password-dialog").evaluate((d) => d.open)), "同じパスワードを2回聞かれた");
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("生徒A.pdf", 2)]);
      await t.until(() => __pdfGrade.state.files.length === 1);
      await t.page.locator(".page .ink").first().waitFor();
    },
  },

  "pdf-compress": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("写真入り.pdf", 2, { image: true })]);
      await t.until(() => !!__pdfCompress.state.file);
      await t.shot("open");
      await t.page.click("#compress-btn");
      await t.until(() => __pdfCompress.state.result && !__pdfCompress.state.busy, 60000);
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "写真入り_圧縮.pdf");
      await t.expectPdfPages(file, 2);
      t.expect(file.bytes.length < t.pdf("写真入り.pdf", 2, { image: true }).buffer.length, "小さくなっていない");
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("写真入り.pdf", 2, { image: true })]);
      await t.until(() => !!__pdfCompress.state.file);
    },
  },

  "pdf-image": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("スライド.pdf", 3)]);
      await t.until(() => __pdfImage.state.pages?.length === 3);
      await t.shot("open");
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "スライド_画像.zip");
      t.expect(fixtures.zipNames(file.bytes).length === 3, "ZIPに画像が3枚ない");
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("スライド.pdf", 3)]);
      await t.until(() => __pdfImage.state.pages?.length === 3);
    },
  },

  "pdf-stamp": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("プリント.pdf", 3)]);
      await t.page.locator(".page canvas").first().waitFor();
      await t.until(() => !document.querySelector("#save-btn").disabled);
      await t.shot("open");
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "プリント_番号入り.pdf");
      await t.expectPdfPages(file, 3);
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("プリント.pdf", 3)]);
      await t.until(() => !document.querySelector("#save-btn").disabled);
    },
  },

  "pdf-extract": {
    async run(t) {
      await t.setFiles("#file-input", [t.pdf("本文.pdf", 2)]);
      await t.until(() => __pdfExtract.state.pages?.length === 2 && __pdfExtract.allText().includes("Smoke test page 2"));
      await t.shot("open");
      await t.page.click("#save-txt");
      const [file] = await t.downloads(1);
      t.expectName(file, "本文.txt");
      t.expect(file.bytes.toString("utf8").includes("Smoke test page 1"), "取り出した文字が保存されていない");
      if (flags.has("--ocr")) {
        t.expect(await ocrFirstPage(t), "OCRで文字が読めない");
      }
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("本文.pdf", 2)]);
      await t.until(() => __pdfExtract.allText().includes("Smoke test page 2"));
      if (flags.has("--ocr")) {
        t.expect(await ocrFirstPage(t), "オフラインでOCRできない");
      }
    },
  },

  "image-pdf": {
    async run(t) {
      await t.setFiles("#file-input", [t.png("写真1.png", 640, 480), t.png("写真2.png", 480, 640)]);
      await t.until(() => __imagePdf.state.images.length === 2);
      await t.shot("open");
      await t.page.fill("#file-name", "アルバム");
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "アルバム.pdf");
      await t.expectPdfPages(file, 2);
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.png("写真1.png", 640, 480)]);
      await t.until(() => __imagePdf.state.images.length === 1);
    },
  },

  "image-resize": {
    async run(t) {
      await t.setFiles("#file-input", [t.png("写真1.png", 1600, 1200), t.png("写真2.png", 1200, 1600)]);
      await t.until(() => __imageResize.state.items.length === 2 && __imageResize.state.items.every((i) => i.result));
      await t.shot("open");
      const small = await t.page.evaluate(() => __imageResize.state.items.map((i) => Math.max(i.result.width, i.result.height)));
      t.expect(small.every((n) => n === 1600), `長い辺1600にならない: ${small}`);
      // "60 KB以下" lowers the quality, then the size, until it fits.
      await t.page.selectOption("#mode", "target");
      await t.page.fill("#target-kb", "60");
      await t.page.dispatchEvent("#target-kb", "change");
      await t.until(() => __imageResize.state.items.every((i) => i.result), 60000);
      const sizes = await t.page.evaluate(() => __imageResize.state.items.map((i) => i.result.blob.size));
      t.expect(sizes.every((n) => n <= 60 * 1024), `60KB以下にならない: ${sizes}`);
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "画像_小.zip");
      const names = fixtures.zipNames(file.bytes);
      t.expect(names.join(",") === "写真1_小.jpg,写真2_小.jpg", `ZIPの中身が違う: ${names.join(", ")}`);
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.png("写真1.png", 640, 480)]);
      await t.until(() => __imageResize.state.items[0]?.result);
    },
  },

  "image-annotate": {
    async run(t) {
      await t.setFiles("#file-input", [t.png("画面.png", 800, 500)]);
      await t.page.locator("#stage").waitFor();
      await t.shot("open");
      await t.page.click("[data-tool='arrow']");
      await t.drag(t.page.locator("#canvas"), [[100, 100], [200, 150], [300, 200]]);
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "画面_書き込み.png");
      t.expect(file.bytes.subarray(1, 4).toString() === "PNG", "PNG画像になっていない");
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.png("画面.png", 800, 500)]);
      await t.page.locator("#stage").waitFor();
    },
  },

  calc: {
    async run(t) {
      await t.page.fill("#expr", "1+2*3");
      await t.page.press("#expr", "Enter");
      await t.until(() => document.querySelector("#result").textContent.includes("7"));
      await t.shot("result");
    },
  },

  timer: {
    async run(t) {
      await t.page.click(".tab[data-mode='stopwatch']");
      await t.page.click("#start-btn");
      await t.until(() => document.querySelector("#display").textContent !== "00:00.0");
      await t.page.click("#start-btn");
      const a = await t.page.textContent("#display");
      await t.page.waitForTimeout(400);
      t.expect(a === await t.page.textContent("#display"), "一時停止しても止まらない");
    },
  },

  todo: {
    async run(t) {
      await t.page.fill("#task-title", "読書感想文");
      await t.page.fill("#task-subject", "国語");
      await t.page.click("#task-form button[type='submit']");
      await t.page.reload();
      await t.until(() => document.querySelector("#task-list").textContent.includes("読書感想文"));
      await t.shot("task");
      await t.page.click("#export-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, /^時間割と課題_\d{4}-\d{2}-\d{2}\.json$/);
      t.expect(JSON.parse(file.bytes.toString("utf8")).tasks[0].title === "読書感想文", "バックアップに課題が入っていない");
    },
  },

  // The starting point for new tools (not on the top page). Checked so it keeps working
  // as the shared files change.
  _template: {
    portal: false,
    async run(t) {
      await t.setFiles("#file-input", [t.png("画面.png", 100, 80)]);
      await t.until(() => !document.querySelector("#save-btn").disabled);
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, "結果.txt");
    },
  },
};

// Empties page 1's text and reads it back from the page image.
function ocrFirstPage(t) {
  return t.page.evaluate(async () => {
    const view = __pdfExtract.state.pages[0];
    view.textarea.value = "";
    await __pdfExtract.ocrPages([view]);
    return /Smoke|test/i.test(view.textarea.value);
  });
}

/* ---------- test harness ---------- */

// Tesseract prints its own notes through console.error while OCR runs; they are not problems.
const HARMLESS_CONSOLE = [/^Warning: Parameter not found/, /^Estimating resolution as/];

class ToolTest {
  constructor(name, page, server) {
    this.name = name;
    this.page = page;
    this.server = server;
    this.problems = [];
    page.on("pageerror", (err) => this.problems.push(`ページの例外: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error" || HARMLESS_CONSOLE.some((re) => re.test(msg.text()))) return;
      this.problems.push(`コンソールのエラー: ${msg.text()}`);
    });
    page.on("requestfailed", (req) => this.problems.push(`読み込み失敗: ${req.url()} (${req.failure()?.errorText})`));
    page.on("response", (res) => {
      if (res.status() >= 400) this.problems.push(`読み込み失敗: ${res.url()} (${res.status()})`);
    });
  }

  expect(ok, message) {
    if (!ok) throw new Error(message);
  }

  expectName(file, expected) {
    const ok = expected instanceof RegExp ? expected.test(file.name) : file.name === expected;
    this.expect(ok, `保存したファイル名が違う: ${file.name}（期待: ${expected}）`);
  }

  async expectPdfPages(file, count) {
    const doc = await fixtures.PDFLib.PDFDocument.load(file.bytes);
    this.expect(doc.getPageCount() === count, `PDFのページ数が${doc.getPageCount()}（期待: ${count}）`);
    return doc;
  }

  pdf(name, pages, opts) {
    return { name, mimeType: "application/pdf", buffer: fixtures.pdf(pages, opts) };
  }

  // A 2-page PDF that needs the password "1234" to open.
  locked(name) {
    return { name, mimeType: "application/pdf", buffer: fs.readFileSync(path.join(__dirname, "fixtures", "locked-1234.pdf")) };
  }

  async enterPassword(password) {
    const dialog = this.page.locator(".password-dialog[open]");
    await dialog.waitFor();
    await dialog.locator("input[name=password]").fill(password);
    await dialog.locator("button[value=ok]").click();
  }

  png(name, width, height) {
    return { name, mimeType: "image/png", buffer: fixtures.png(width, height) };
  }

  setFiles(selector, files) {
    return this.page.setInputFiles(selector, files);
  }

  until(fn, timeout = 20000) {
    return this.page.waitForFunction(fn, null, { timeout });
  }

  async drag(locator, points) {
    const box = await locator.boundingBox();
    const [first, ...rest] = points;
    await this.page.mouse.move(box.x + first[0], box.y + first[1]);
    await this.page.mouse.down();
    for (const [x, y] of rest) await this.page.mouse.move(box.x + x, box.y + y, { steps: 5 });
    await this.page.mouse.up();
  }

  // Files the page handed to <a download>, captured by the init script below.
  async downloads(count, timeout = 30000) {
    await this.page.waitForFunction((n) => window.__smokeDownloads.length >= n, count, { timeout });
    const list = await this.page.evaluate(async () => {
      const items = await Promise.all(window.__smokeDownloads.splice(0));
      return Promise.all(items.map(async ({ name, blob }) => {
        const url = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        return { name, base64: url.slice(url.indexOf(",") + 1) };
      }));
    });
    return list.map(({ name, base64 }) => ({ name, bytes: Buffer.from(base64, "base64") }));
  }

  async shot(label) {
    await this.page.screenshot({
      path: path.join(OUT_DIR, `${this.name}-${label}.png`),
      animations: "disabled",
      caret: "hide",
      style: "#status { visibility: hidden !important; }",
    });
    if (STYLE_DIR) {
      fs.writeFileSync(path.join(STYLE_DIR, `${this.name}-${label}.json`), JSON.stringify(await this.page.evaluate(dumpStyles)));
    }
  }
}

// Computed style of every element (and its ::before/::after), keyed by its place in the page.
// Used with --styles to check that a CSS cleanup changes nothing on screen.
function dumpStyles() {
  const where = (el) => {
    const parts = [];
    for (; el && el.parentElement; el = el.parentElement) {
      parts.unshift(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}:${[...el.parentElement.children].indexOf(el)}`);
    }
    return parts.join(">");
  };
  const read = (cs) => Object.fromEntries([...cs].map((p) => [p, cs.getPropertyValue(p)]));
  const out = {};
  for (const el of document.querySelectorAll("body, body *")) {
    out[where(el)] = read(getComputedStyle(el));
    for (const pseudo of ["::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content !== "none" && cs.content !== "normal") out[where(el) + pseudo] = read(cs);
    }
  }
  return out;
}

function captureDownloads() {
  window.__smokeDownloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith("blob:")) {
      const name = this.download;
      window.__smokeDownloads.push(fetch(this.href).then((r) => r.blob()).then((blob) => ({ name, blob })));
    }
    return click.call(this);
  };
}

// Same-site files the page has loaded that are not in the offline cache. The service worker
// stores the precache list in the background, so this waits a little for it to finish.
async function uncachedFiles(page) {
  for (let i = 0; ; i++) {
    const missing = await page.evaluate(async () => {
      const cache = await caches.open("itc-v1");
      const urls = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)];
      const out = [];
      for (const url of new Set(urls)) {
        if (url.startsWith(location.origin) && !(await cache.match(url, { ignoreSearch: true }))) out.push(new URL(url).pathname);
      }
      return out;
    });
    if (!missing.length || i >= 20) return missing;
    await page.waitForTimeout(250);
  }
}

// Moves the first item (a stroke through `on`), recolors it, then undoes and redoes both
// steps, checking the item after each one.
async function editAndUndo(t, hook, ink, on, color) {
  const first = () => t.page.evaluate((h) => {
    const item = window[h].state.items[0];
    return { at: item.points[0].join(","), color: item.color, count: window[h].state.items.length };
  }, hook);
  await t.page.evaluate((h) => window[h].setTool("select", { hint: false }), hook);
  const start = await first();
  await t.drag(ink, [on, [on[0] + 30, on[1] + 20]]);
  const moved = await first();
  t.expect(moved.at !== start.at, "選んだ線をドラッグで動かせない");
  await t.page.click(`.toolbar .swatch[data-color="${color}"]`);
  const recolored = await first();
  t.expect(recolored.color === color && recolored.at === moved.at, "選んだ線の色が変わらない");
  const step = async (fn, want, message) => {
    await t.page.evaluate(([h, f]) => window[h][f](), [hook, fn]);
    const now = await first();
    t.expect(now.at === want.at && now.color === want.color && now.count === start.count, message);
  };
  await step("undo", moved, "元に戻すで色が戻らない");
  await step("undo", start, "元に戻すで位置が戻らない");
  await step("redo", moved, "やり直しで位置が戻らない");
  await step("redo", recolored, "やり直しで色が戻らない");
}

async function testTool(browser, server, name) {
  const tool = TOOLS[name];
  const context = await browser.newContext({ viewport: VIEWPORT, locale: "ja-JP" });
  await context.addInitScript(captureDownloads);
  const page = await context.newPage();
  const t = new ToolTest(name, page, server);
  try {
    // A cache that belongs to another site on the same domain (okarin-netizen.github.io).
    await page.goto(`${server.url}tests/README.md`);
    await page.evaluate(() => caches.open("other-repo-v1"));
    await page.goto(`${server.url}${name}/${tool.query ?? ""}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first visit is not yet controlled by the service worker, so everything it loaded
    // has to be kept by the precache list for the tool to open offline after one visit.
    const missing = await uncachedFiles(page);
    t.expect(!missing.length, `オフライン用に保存されないファイルがある: ${missing.join(", ")}`);
    // Second load is controlled by the service worker, like a returning user.
    await page.reload();
    t.expect(await page.evaluate(() => !!navigator.serviceWorker.controller), "サービスワーカーが有効になっていない");
    t.expect(await page.evaluate(() => caches.has("other-repo-v1")), "ほかのサイトのキャッシュを消してしまった");
    await t.shot("start");
    await tool.run(t);

    server.setOffline(true);
    await page.reload();
    await tool.offline?.(t);
    server.setOffline(false);
  } catch (err) {
    t.problems.push(err.message.split("\n")[0]);
  } finally {
    server.setOffline(false);
    await context.close();
  }
  return t.problems;
}

async function testPortal(browser, server) {
  const context = await browser.newContext({ viewport: VIEWPORT, locale: "ja-JP" });
  const page = await context.newPage();
  const t = new ToolTest("portal", page, server);
  try {
    await page.goto(server.url);
    const links = await page.$$eval(".apps a", (as) => as.map((a) => a.getAttribute("href")));
    for (const name of Object.keys(TOOLS).filter((n) => TOOLS[n].portal !== false)) {
      t.expect(links.some((href) => href.replace(/\/$/, "") === name), `トップページに ${name} へのリンクがない`);
    }
    await t.shot("start");

    // The top page (and the tool icons on it) also opens without a network.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    server.setOffline(true);
    await page.reload();
    t.expect(await page.$$eval(".apps img", (imgs) => imgs.length > 0 && imgs.every((img) => img.naturalWidth > 0)), "オフラインでアイコンが表示されない");
  } catch (err) {
    t.problems.push(err.message.split("\n")[0]);
  } finally {
    server.setOffline(false);
    await context.close();
  }
  return t.problems;
}

async function main() {
  const unknown = only.filter((n) => n !== "portal" && !TOOLS[n]);
  if (unknown.length) {
    console.error(`知らないツール: ${unknown.join(", ")}`);
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (STYLE_DIR) fs.mkdirSync(STYLE_DIR, { recursive: true });
  await fixtures.prepare();
  const server = await startServer(path.resolve(__dirname, ".."));
  const browser = await chromium.launch({ headless: !flags.has("--headed") });
  const names = only.length ? only : ["portal", ...Object.keys(TOOLS)];
  let failed = 0;
  for (const name of names) {
    const started = Date.now();
    const problems = name === "portal" ? await testPortal(browser, server) : await testTool(browser, server, name);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (problems.length) {
      failed++;
      console.log(`NG  ${name} (${secs}s)`);
      for (const p of problems) console.log(`    - ${p}`);
    } else {
      console.log(`OK  ${name} (${secs}s)`);
    }
  }
  await browser.close();
  await server.close();
  console.log(failed ? `\n${failed}件が失敗しました` : "\nすべて通りました");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
