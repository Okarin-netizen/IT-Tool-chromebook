#!/usr/bin/env node
// Checks the move from the old per-tool service workers to the site-wide one: a browser that
// used an older version of the site opens the current one, and afterwards only the root worker
// is left, the old caches are gone, another site's cache and the saved data are kept, and the
// tools still open offline.
//
//   node tests/migration.cjs                 old version = origin/main
//   node tests/migration.cjs --from <ref>    old version = any git ref
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { startServer } = require("./lib/server.cjs");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : "origin/main";
const PAGES = ["", "pdf-text/", "pdf-extract/", "timer/", "todo/"];

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

async function visit(page, url) {
  await page.goto(url);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "itc-migration-"));
  const oldDir = path.join(work, "old");
  git("worktree", "add", "--detach", oldDir, from);
  const problems = [];
  const expect = (ok, message) => ok || problems.push(message);
  let context;
  let server;
  try {
    // 1. A browser that has been using the old version.
    server = await startServer(oldDir);
    const { port } = server;
    context = await chromium.launchPersistentContext(path.join(work, "profile"), { locale: "ja-JP" });
    const page = context.pages()[0] || (await context.newPage());
    await visit(page, `${server.url}README.md`);
    await page.evaluate(() => caches.open("other-repo-v1"));
    for (const p of PAGES) {
      await visit(page, server.url + p);
      if (p) await page.evaluate(() => navigator.serviceWorker.ready);
    }
    await page.fill("#task-title", "移行テストの課題");
    await page.click("#task-form button[type='submit']");
    const before = await page.evaluate(async () => ({
      scopes: (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort(),
      caches: (await caches.keys()).sort(),
    }));
    console.log(`古い版 (${from}):`, before);
    await server.close();

    // 2. The site is updated; the user opens the pages again a few times.
    server = await startServer(ROOT, { port });
    for (let round = 0; round < 3; round++) {
      for (const p of PAGES) await visit(page, server.url + p);
    }
    const after = await page.evaluate(async () => ({
      scopes: (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort(),
      caches: (await caches.keys()).sort(),
    }));
    console.log("新しい版:", after);
    expect(JSON.stringify(after.scopes) === JSON.stringify(["/IT-Tool-chromebook/"]), `サービスワーカーの登録が残っている: ${after.scopes.join(", ")}`);
    expect(JSON.stringify(after.caches) === JSON.stringify(["itc-v1", "other-repo-v1"]), `キャッシュが期待と違う: ${after.caches.join(", ")}`);
    expect(await page.evaluate(() => (localStorage.getItem("todo-tool-v1") || "").includes("移行テストの課題")), "保存した課題が消えた");

    // 3. Everything still opens without a network.
    server.setOffline(true);
    for (const p of PAGES) {
      try {
        await visit(page, server.url + p);
        const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || "");
        expect(controller.endsWith("/IT-Tool-chromebook/sw.js"), `/${p} が全体のサービスワーカーで開かれていない`);
      } catch (err) {
        problems.push(`オフラインで /${p} が開けない: ${err.message.split("\n")[0]}`);
      }
    }
    server.setOffline(false);
  } finally {
    await context?.close();
    await server?.close();
    git("worktree", "remove", "--force", oldDir);
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log("\nNG");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("\n移行の確認が通りました");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
