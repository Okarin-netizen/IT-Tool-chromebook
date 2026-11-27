#!/usr/bin/env bash
# 判定役。全部通ったら 0 で終わる。
#   bash loop/verify.sh <仕事の名前>
# いつも: 全ツールの決まりごとのテスト。
# そのうえで: tasks.json で "passes": true のタスクの check を全部（前に通ったものが壊れていないかも見る）。
set -e
JOB=${1:?仕事の名前を指定してください}
node tests/consistency.mjs
node tests/vendor-check.mjs
node -e '
const tasks = require("./loop/jobs/" + process.argv[1] + "/tasks.json").tasks;
for (const t of tasks) if (t.passes) console.log(t.check);
' "$JOB" | while IFS= read -r cmd; do
  echo "--- $cmd"
  bash -c "$cmd"
done
echo "判定: すべて通りました"
