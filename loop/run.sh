#!/usr/bin/env bash
# ループを回す台本（ハーネス）。
#   bash loop/run.sh <仕事の名前> [最大の周回数]
#   例: bash loop/run.sh unit-convert 20
#
# 1周ごとに:
#   AI に PROMPT.md を渡す → 台本が自分で確かめ直す
#   （守るファイルを変えていないか / tasks.json は passes だけか / loop/verify.sh が通るか）
#   → 通れば push。通らなければその周のコミットを取り消して、失敗を progress.md に書く。
# 止まる条件: progress.md の最後が DONE / 最大の周回数 / 3周つづけて進まない / 時間切れ。
set -u
JOB=${1:?仕事の名前を指定してください（例: unit-convert）}
MAX=${2:-20}
MAX_FAILS=3
DEADLINE=$(( $(date +%s) + ${LOOP_MINUTES:-110} * 60 ))
DIR=loop/jobs/$JOB
PROGRESS=$DIR/progress.md
LOG=${LOOP_LOG:-/tmp/loop-log/$JOB}   # 記録はリポジトリの外に置く
BRANCH=$(git branch --show-current)
mkdir -p "$LOG"

# AI に変えさせない場所。loop/ の中でも progress.md と tasks.json だけは変えてよい（tasks.json は下で別に見る）
PROTECTED=(tests/ loop/ ":(exclude)$PROGRESS" ":(exclude)$DIR/tasks.json")

done_yet() { tail -n 1 "$PROGRESS" 2>/dev/null | grep -qx DONE; }

note() { # 申し送りを progress.md に足してコミット。$1 = 見出しと理由, $2 = 出力のファイル（なくてもよい）
  { echo; echo "$1"; [ -n "${2:-}" ] && { echo '```'; tail -n 40 "$2"; echo '```'; }; } >> "$PROGRESS"
  git add "$PROGRESS" && git commit -qm "loop($JOB): 申し送り"
}

fails=0
for i in $(seq 1 "$MAX"); do
  done_yet && { echo "全部のタスクが通りました（DONE）"; break; }
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "時間切れで止めます"; break; }

  before=$(git rev-parse HEAD)
  echo "=== 周 $i / $MAX（$(date '+%H:%M')） ==="
  sed "s/{{JOB}}/$JOB/g" loop/PROMPT.md | timeout 30m claude -p \
      --dangerously-skip-permissions \
      --disallowedTools "Bash(git push:*)" "Bash(git reset:*)" "Bash(git checkout:*)" "Bash(git switch:*)" "Write(/tmp/claude/**)" "Edit(/tmp/claude/**)" \
      --max-turns 80 --output-format json > "$LOG/$i.json" 2> "$LOG/$i.err"

  # AI がコミットせずに残したものは捨てる。ただし progress.md の申し送りは取っておく
  cp "$PROGRESS" "$LOG/$i.progress" 2>/dev/null
  git checkout -q -- . && git clean -fdq

  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    fails=$((fails + 1)); echo "進みなし（$fails 回つづけて）"
    cmp -s "$LOG/$i.progress" "$PROGRESS" || { cp "$LOG/$i.progress" "$PROGRESS"; note "（周 $i はコミットなし）"; }
  elif git diff --name-only "$before" HEAD -- "${PROTECTED[@]}" > "$LOG/$i.protected" && [ -s "$LOG/$i.protected" ]; then
    git reset -q --hard "$before"
    note "## 前回の失敗（周 $i）"$'\n'"変えてはいけないファイルを変えたので、この周を取り消しました。" "$LOG/$i.protected"
    fails=$((fails + 1))
  elif ! node loop/tasks-guard.mjs "$before" "$JOB" > "$LOG/$i.guard" 2>&1; then
    git reset -q --hard "$before"
    note "## 前回の失敗（周 $i）"$'\n'"tasks.json の passes 以外を変えたので、この周を取り消しました。" "$LOG/$i.guard"
    fails=$((fails + 1))
  elif ! bash loop/verify.sh "$JOB" > "$LOG/$i.verify" 2>&1; then
    git reset -q --hard "$before"
    note "## 前回の失敗（周 $i）"$'\n'"台本が確かめ直したら loop/verify.sh が通らなかったので、この周を取り消しました。" "$LOG/$i.verify"
    fails=$((fails + 1))
  else
    fails=0
    echo "通過: $(git log -1 --format=%s)"
    git push -q -u origin "$BRANCH" || echo "push に失敗（次の周でもう一度）"
  fi

  [ "$fails" -ge "$MAX_FAILS" ] && { echo "$MAX_FAILS 周つづけて進まなかったので止めます"; break; }
done

git push -q -u origin "$BRANCH" 2>/dev/null
echo "おわり。申し送りは $PROGRESS、各周の記録は $LOG/ にあります。"
