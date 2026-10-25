#!/usr/bin/env node
// Smoke test for every tool: opens it in Chromium, does one typical action, checks what gets
// saved, and reloads it with the network cut to check that it still works offline.
//
//   node tests/smoke.cjs                 all tools
//   node tests/smoke.cjs pdf-text calc   only these tools
//   node tests/smoke.cjs --ocr           also run OCR in pdf-extract (slow)
//   node tests/smoke.cjs --headed        show the browser
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
const only = args.filter((a) => !a.startsWith("--"));

/* ---------- per-tool checks ---------- */

// Each tool: `run` works online after the page has loaded, `offline` runs after an offline reload.
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
    },
    async offline(t) {
      await t.setFiles("#file-input", [t.pdf("資料.pdf", 3)]);
      await t.until(() => __pdfPages.state.pages.length === 3 && __pdfPages.state.pages[0].rendered);
    },
  },

  "pdf-sign": {
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
      await t.page.click("#save-btn");
      const [file] = await t.downloads(1);
      t.expectName(file, /^採点済_\d{8}\.zip$/);
      const names = fixtures.zipNames(file.bytes);
      t.expect(names.includes("生徒A_採点済.pdf") && names.includes("生徒B_採点済.pdf"), `ZIPの中身が違う: ${names.join(", ")}`);
      t.expect(names.some((n) => n.endsWith(".csv")), `ZIPに点数一覧がない: ${names.join(", ")}`);
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
  }
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

async function testTool(browser, server, name) {
  const tool = TOOLS[name];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
  await context.addInitScript(captureDownloads);
  const page = await context.newPage();
  const t = new ToolTest(name, page, server);
  try {
    // A cache that belongs to another site on the same domain (okarin-netizen.github.io).
    await page.goto(`${server.url}tests/README.md`);
    await page.evaluate(() => caches.open("other-repo-v1"));
    await page.goto(`${server.url}${name}/`);
    // Second load is controlled by the service worker, like a returning user.
    await page.evaluate(() => navigator.serviceWorker.ready);
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
  const page = await context.newPage();
  const t = new ToolTest("portal", page, server);
  try {
    await page.goto(server.url);
    const links = await page.$$eval(".apps a", (as) => as.map((a) => a.getAttribute("href")));
    for (const name of Object.keys(TOOLS)) {
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
