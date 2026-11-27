#!/usr/bin/env node
// tasks.json で AI が変えてよいのは "passes" だけ。ほかを変えたら失敗にする。
//   node loop/tasks-guard.mjs <前のコミット> <仕事の名前>
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [before, job] = process.argv.slice(2);
const path = `loop/jobs/${job}/tasks.json`;
const strip = (j) => JSON.stringify(JSON.parse(j).tasks.map(({ passes, ...rest }) => rest));
const old = strip(execSync(`git show ${before}:${path}`, { encoding: "utf8" }));
const now = strip(readFileSync(path, "utf8"));
if (old !== now) { console.error("tasks.json の passes 以外が変わっています"); process.exit(1); }
