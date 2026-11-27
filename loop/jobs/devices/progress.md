# 全ツールを3つの端末で: 申し送り

周ごとに、やったこと・つまずいたこと・次の人への一言を下に足していきます。全部終わったら最後の行に DONE。

## 周 0（人が準備）
- tests/smoke.cjs に --device=chromebook / windows / ipad と、横にはみ出さない検査を足した。tests/ipad-pitfalls.mjs を作った。
- 最初に全部回した結果: chromebook で pdf-grade、windows で pdf-pages、ipad で pdf-grade・image-pdf・kaotori が失敗。落とし穴は22件。これを tasks.json にした。
- smoke の失敗のくわしい理由は `SMOKE_DEBUG=1 node tests/smoke.cjs ...` で出る。
- 指のテストの失敗は、アプリのせいかテストの作りのせいか、まだ分からない。テストのせいだと思ったら直さずに書く。

## 周 1: pdf-pages-windows
- 125%（1536幅）だとツールバーが2段になり、「ページの操作」メニューが2段目の保存ボタンを覆っていた。開くときにツールバー全体の下へ出すようにした（pdf-pages/app.js placeMenuBelowToolbar）。
- windows・ふつうの smoke と verify.sh が通った。次は pdf-grade-touch。

## 周 2: pdf-grade-touch（通せなかった・コミットなし）
### つまずいたこと
- 原因1（アプリ・直した）: 高さ650/740だと、ペンを見つけたときの長いお知らせ（#status、7秒）がページの下にかぶり、3本目のペンがお知らせの上に落ちて線にならなかった。pdf-grade/style.css の末尾に `.status { pointer-events: none; }` とコメント1行を足すと、この検査は通る（作業ツリーに残してある。消えていたら足し直す）。
- 原因2（テストの作りだと思う・直していない）: そのあと gradeByQuestion の「囲んだ場所が決まらない: null」で落ちる（chromebook・ipad）。commentBank の `ink.click({position:{x:200,y:320}})` で、Playwright がその点を #viewer のまん中にスクロールする。chromebook（viewer 上端113・高さ537）では ink の上端が y=61 になり、上52pxが viewer の外に出る。次の `ink.scrollIntoViewIfNeeded()` は一部見えていれば動かないので、`t.drag(ink, [[40,40],…])` の y=101 がツールバーの上になる。ふつうの 1280×800 では ink 上端162・viewer 上端165 で、たまたま通っている。アプリで通すには viewer 上端を90px未満にする（ツールバー1段）しかなく、見た目が変わるのでやめた。テスト側で drag の前に `#viewer` の scrollTop を 0 に戻す（penAndFinger の最後と同じ）か、ink の上が見える位置にスクロールすれば通るはず → 人に直してほしい。
- 気づいたこと: ipad（1180幅）では pdf-grade のツールバーが3段（viewer 上端217）になる。base.css には「11.6インチで2段に収める」とある。別タスクにするかは人が決める。
### 次に試すこと
- 人がテストを直すまで pdf-grade-touch は通らない。原因1の直しを入れたまま、人の判断を待つ（次の周はこのタスクを飛ばさない決まりなので、progress を見た人に直してもらう）。

（周 2 はコミットなし）

## 周 3: pdf-grade-touch（通せなかった・コミットなし）
### つまずいたこと
- 周 2 の `.status { pointer-events: none; }` は消えていた（作業ツリーが戻されていた）ので pdf-grade/style.css の末尾に足し直した。そのうえで `SMOKE_DEBUG=1 node tests/smoke.cjs --device=chromebook pdf-grade` を回すと、周 2 と同じく gradeByQuestion の「囲んだ場所が決まらない: null」で落ちる。tests/smoke.cjs は周 2 から変わっていない。
- 周 2 の見立て（commentBank の click でページの上の方が #viewer の外へスクロールされ、`t.drag(ink,[[40,40],…])` の始まりがツールバーの上に落ちる。t.drag は ink の boundingBox からの座標でマウスを動かすだけ）をコードで確かめた。アプリで直すにはツールバーを1段にするしかなく、見た目が変わるのでやらない。
### 次に試すこと
- 人へ: tests/smoke.cjs の gradeByQuestion で、`#focus-btn` を押す前に `#viewer` の scrollTop を 0 に戻してほしい（penAndFinger の最後と同じやり方）。直れば、style.css の1行と合わせて通るはず。
- それまでこのタスクは通らない。ループを止めて人が直すか、このタスクを後回しにしてよいか決めてほしい。

（周 3 はコミットなし）

（周 3 はコミットなし）

## 周 4: pdf-grade-touch（通せなかった・コミットなし）
### つまずいたこと
- tests/smoke.cjs は周 2 から変わっていない（最後に変えたのは d0e20fd）。`.status { pointer-events: none; }` はまた消えていたので pdf-grade/style.css の末尾に足し直した（#status の中にボタンはないので、クリックを受けなくしても困らない）。
- `SMOKE_DEBUG=1 node tests/smoke.cjs --device=chromebook pdf-grade` は、周 2・3 と同じ「囲んだ場所が決まらない: null」で落ちる。アプリ側で「設問ごと」を押したらページの上へスクロールする、なども考えたが、仕様にない動きで先生の邪魔になるのでやめた。
### 次に試すこと
- 人へ（3周つづけて同じ）: tests/smoke.cjs の gradeByQuestion で `#focus-btn` を押す前に `await t.page.$eval("#viewer", (el) => (el.scrollTop = 0));` を入れてほしい。それまでこのタスクは進まないので、ループを止めるか、このタスクを後回しにしてよいと tasks.json に書くか決めてほしい。

（周 4 はコミットなし）

（周 4 はコミットなし）

## 人より（周 4 のあと）
- 見立てどおり、tests/smoke.cjs の gradeByQuestion で #focus-btn の前に #viewer の scrollTop を 0 に戻した。ありがとう。
- テストや仕様のせいで進めないタスクは、tasks.json に "blocked" を書いて次へ進んでよいことにした（PROMPT.md 参照）。
- pdf-grade のツールバーが iPad で3段になる件は、人が後で決める。
