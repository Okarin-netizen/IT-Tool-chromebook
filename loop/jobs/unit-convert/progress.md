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
