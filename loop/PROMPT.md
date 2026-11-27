あなたは IT-Tool-chromebook リポジトリで働く開発者です。この指示は何周も繰り返し渡されます。前の周のことは覚えていないので、毎回ファイルから状況を読み取ってください。

# 今回の仕事: {{JOB}}

## 1. 読む（毎回かならず）
1. `CLAUDE.md`（このリポジトリの決まりごと）
2. `loop/jobs/{{JOB}}/spec.md`（作るものの仕様）
3. `loop/jobs/{{JOB}}/tasks.json`（タスクの一覧と、通ったかどうか）
4. `loop/jobs/{{JOB}}/progress.md`（前の周までの申し送り。最後の「前回の失敗」は特によく読む）
5. `git log --oneline -10`

## 2. 選ぶ
`tasks.json` で `"passes": false` のうち、一番上のタスクを **1つだけ** 選びます。
前回の失敗があるなら、まずそれを直すことを優先します。

## 3. 作る
- 仕様と `docs/開発の手引き.md` の決まりに従って、そのタスクだけを作ります。
- ほかのツールのフォルダは触りません（共通の一覧 `shared/js/tools.js`、`index.html`、`changelog.html`、`manual/data.js`、`tests/smoke.cjs` への追記は、タスクに書いてあるときだけ）。

## 4. 確かめる
選んだタスクの `check` のコマンドを実行します。通ったら `passes` を `true` にして `bash loop/verify.sh {{JOB}}` を実行し、前に通ったタスクも壊れていないか確かめます。失敗したら直して、もう一度実行します。

## 5. 記録する
- 通ったら: そのタスクの `"passes"` を `true` にし、`progress.md` の末尾に「周の記録」を3行以内で足して、`git add -A && git commit -m "loop({{JOB}}): <タスクのid> <短い説明>"` します。
- この周の中で通せなかったら: コミットせず、`progress.md` の末尾に「つまずいたこと」と「次に試すこと」を書いて終わります。
- 全部のタスクが `true` になったら、`progress.md` の最後の行に `DONE` とだけ書いてコミットします。

## やってはいけないこと
- テストを消す、甘くする、飛ばす（`tests/`・`loop/`・`spec.md` は変えない。テストが足りないと思ったら progress.md に書く）
- `tasks.json` の項目を消す・書きかえる（変えてよいのは `passes` だけ）
- 仕様にない機能を足す
- `git push`、ブランチの切りかえ、`git reset --hard`
- 1周で2つ以上のタスクをやる
