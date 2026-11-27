# ループで作る（ループエンジニアリング）

同じ指示（`PROMPT.md`）で AI を何周も回し、テストが全部通ったら止まる仕組みです。

| ファイル | 役目 |
|---|---|
| `PROMPT.md` | 毎周 AI に渡す指示（どの仕事でも同じ） |
| `run.sh` | 回す台本。1周ごとに確かめ直し、通れば push、通らなければ取り消して失敗を申し送る |
| `verify.sh` | 判定役。決まりごとのテスト＋通ったタスクの `check` を全部 |
| `tasks-guard.mjs` | `tasks.json` で AI が `passes` 以外を変えていないか見る |
| `jobs/<仕事>/spec.md` | 作るものの仕様（人が書く） |
| `jobs/<仕事>/tasks.json` | タスクと合否の印。`check` が合格の条件（人が書く） |
| `jobs/<仕事>/progress.md` | 周ごとの申し送り。最後の行が `DONE` で終わり |

## 回し方

```sh
bash loop/run.sh unit-convert 15          # 最大15周
LOOP_MINUTES=60 bash loop/run.sh unit-convert   # 60分で止める
```

止まる条件: 全部通った（DONE）／最大の周回数／3周つづけて進まない／時間切れ（決まりは110分）。

## 新しい仕事を足すとき（人がやること）
1. `jobs/<仕事>/spec.md` に仕様を書く
2. 合格の条件になるテストを `tests/` に先に書く（AI は `tests/` と `loop/` を変えられない）
3. `jobs/<仕事>/tasks.json` に小さいタスクを並べ、それぞれに `check` を書く
4. `progress.md` を置いて、`run.sh` を回す
