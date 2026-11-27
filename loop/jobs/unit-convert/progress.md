# 単位の換算: 申し送り

周ごとに、やったこと・つまずいたこと・次の人への一言を下に足していきます。全部終わったら最後の行に DONE。

## 周 0（人が準備）
- spec.md・tasks.json・tests/unit-convert.mjs・tests/smoke.cjs の unit-convert の確認を用意した。
- テストは仕様そのもの。足りない・おかしいと思ったら、変えずにここに書く。

## 周 1（core）
- unit-convert/convert.js を作成。CATEGORIES は表の8種類すべて、convert は長さ〜速さ（基本単位への倍率 FACTORS）、温度・データ量はまだ UnitError。
- テストが formatNumber も import するので、仮の formatNumber（String(n)）を置いた。format のタスクで作り直すこと。

## 周 2（temperature）
- convert.js に温度を追加。いったん K にしてから変える（TO_KELVIN / FROM_KELVIN）。K が負なら UnitError（-1e-9 までは計算のずれとして許す）。
- データ量（FACTORS に data がない）は、まだ「まだ変えられません」の UnitError のまま。

## 周 3（data）
- convert.js にデータ量を追加。dataFactors(dataBase) でビットにする倍率を作る（Number(dataBase) === 1000 なら 1000、それ以外は 1024）。画面の select の文字 "1000" もそのまま渡せる。
- 次は format（formatNumber はまだ仮の String(n)）。

## 周 4（format）
- formatNumber を作成。toPrecision(10) で丸めてから、|n| が 1e15 以上か 1e-6 未満なら「a × 10^b」、それ以外は toFixed（後ろの 0 を消す）＋3けたごとの「,」。
- 次は scaffold（_template を写して tools.js・ポータル・README・manual などに足す）。

## 周 5（scaffold）
- unit-convert/ に index.html・app.js（convert.js を読み registerOffline と window.__unitConvert だけ）・style.css・icon.svg・manifest を作成。色は #6a4c93。tools.js・ポータル（授業・勉強、日付の計算の次）・README の表と節・manual/data.js に追加。
- manual/shots/unit-convert.webp は空の画面の仮の写真。次は ui（docs のタスクで写真を撮り直す）。

## 周 6（ui）
- 画面を作成: タブは CATEGORIES から app.js で作る。#value は type="text"（"abc" を入れられるように）、全角数字や「,」も読む。答えの単位名は #result の外の #result-unit。
- 種類・種類ごとの単位・dataBase を localStorage「unit-convert-settings-v1」に覚える。左に入力と答え、右に一覧の2列で 1280×800 に収まる。次は docs（changelog と説明書の写真）。

## 周 7（docs）— 通せなかった（コミットなし。作業は作業ツリーに残してある）
- やったこと: shared/js/changelog.js の 2026-11-27 に「単位の換算」を追加の1行。manual/shots/unit-convert.webp を完成した画面（1.5 km → m、1366×768、Noto Sans JP 入り）に撮り直し。manual/data.js の説明を画面に合わせた（「下の一覧」→「右の『ほかの単位では』」、ボタン名「1KB は 1024 / 1000 バイト」）。consistency・smoke portal・smoke unit-convert は通る。
- つまずいたこと: check の `grep -q '単位の換算' changelog.html` が通らない。更新履歴の中身は shared/js/changelog.js にあり、changelog.html は JS で表を描くだけ（ほかのツールの名前も changelog.html には1つも入っていない）。changelog.html に文字を足すのはテストに合わせるためだけの細工になるので、しなかった。
- 次に試すこと（人へ）: tasks.json の docs の check を `grep -q '単位の換算' shared/js/changelog.js && node tests/smoke.cjs portal` に直してほしい（AI は tasks.json の check を変えられない）。直れば、残してある変更のまま passes を true にしてコミットできる。

（周 6 はコミットなし）

## 周 8（docs）— 通せなかった（コミットなし）
- 周 7 で作業ツリーに残したはずの変更は消えていた（新しい作業ツリーで始まったらしい）。同じ作業をやり直した: shared/js/changelog.js の 2026-11-27 に単位の換算の1行、manual/data.js の説明2か所、manual/shots/unit-convert.webp を完成画面（1.5 km → m、1366×768、Noto Sans JP）に撮り直し。consistency・smoke unit-convert は通る。
- つまずいたこと: check は前と同じ `grep -q '単位の換算' changelog.html` のままで通らない（中身は shared/js/changelog.js にある）。changelog.html にテストのためだけの文字を足すのはやめた。
- 次に試すこと（人へ）: docs の check を `grep -q '単位の換算' shared/js/changelog.js && node tests/smoke.cjs portal` に直すまで、この周を回しても同じところで止まる。変更はコミットしないと次の周で消えるので、check を直したらすぐ同じ作業ツリーで回すか、人がこの変更をコミットしてほしい。

（周 7 はコミットなし）

## 周 9（docs）— 通せなかった（コミットなし）
- つまずいたこと: check は今も `grep -q '単位の換算' changelog.html` のまま。更新履歴の中身は shared/js/changelog.js にあり、changelog.html には文字が入らない作りなので、細工なしには通らない。loop/run.sh を読むと、コミットしなかった変更は周の終わりに `git checkout -- . && git clean -fd` で必ず捨てられる。なので周 7・8 と同じ作業（changelog.js の1行・manual/data.js の説明2か所・写真の撮り直し）を今回はやり直さなかった（やっても消えるだけ）。
- 次に試すこと（人へ）: tasks.json の docs の check を `grep -q '単位の換算' shared/js/changelog.js && node tests/smoke.cjs portal` に直してから回せば、1周で終わるはず（作業の中身は周 7 の記録のとおり）。3周つづけて進みなしなので、ループはここで止まる見込み。

（周 8 はコミットなし）

## 人より（周 9 のあと）
- docs の check を shared/js/changelog.js を見るように直した。指摘ありがとう。

## 周 10（docs）
- shared/js/changelog.js の 2026-11-27 に単位の換算の1行、manual/data.js の説明2か所を画面に合わせ、manual/shots/unit-convert.webp を完成画面（1.5 km → m、1366×768、Noto Sans JP）に撮り直した。
- check と verify.sh はすべて通った。全タスク完了。
DONE
