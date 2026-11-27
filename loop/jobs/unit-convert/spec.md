# 単位の換算（unit-convert/）の仕様

## だれが・いつ使う
- 生徒も先生も（先生用ではない）。ポータルのグループは「授業・勉強」。
- 理科・数学・技術の授業中に、単位をさっと変えたいとき。1366×768 の Chromebook で、スクロールなしで1画面に収まること。

## 計算の部分 `unit-convert/convert.js`（ブラウザなしでテストする）
次を `export` する。

- `CATEGORIES`: `[{ id, name, units: [{ id, name }] }]`。順番と id は下の表のとおり。
- `convert(value, from, to, options = {})`: 数を返す。
  - ちがう種類どうし（例: km → kg）や、知らない単位は `UnitError` を投げる。
  - 絶対零度（-273.15℃）より低い温度は `UnitError` を投げる。
  - `options.dataBase` は 1024（決まり）か 1000。データ量だけに効く。
- `formatNumber(n)`: 画面に出す文字にする。
  - 有効数字10けたまで。後ろの 0 と、いらない小数点は消す（`0.1+0.2` → `"0.3"`）。
  - 整数の部分に3けたごとの `,` を入れる（`1234567.5` → `"1,234,567.5"`）。
  - 絶対値が 1e15 以上、または 0 でなく 1e-6 未満なら `"1.5 × 10^-7"` の形。
- `UnitError`（`Error` を継承）。

| 種類 id | 名前 | 単位 id（名前） |
|---|---|---|
| length | 長さ | mm, cm, m, km, in（インチ）, ft（フィート）, yd（ヤード）, mi（マイル） |
| mass | 重さ | mg, g, kg, t, oz（オンス）, lb（ポンド） |
| area | 面積 | mm2（mm²）, cm2, m2, a（アール）, ha（ヘクタール）, km2, tsubo（坪） |
| volume | 体積・かさ | ml（mL）, cm3（cm³）, dl（dL）, l（L）, m3（m³）, kl（kL） |
| time | 時間 | s（秒）, min（分）, h（時間）, d（日）, wk（週） |
| speed | 速さ | mps（m/秒）, mpm（m/分）, kmph（km/時） |
| temperature | 温度 | c（℃）, f（℉）, k（K） |
| data | データ量 | bit（ビット）, B（バイト）, KB, MB, GB, TB |

決まった値: 1 in = 2.54 cm、1 ft = 0.3048 m、1 yd = 0.9144 m、1 mi = 1609.344 m、1 oz = 28.349523125 g、1 lb = 453.59237 g、1坪 = 400/121 m²、1 B = 8 bit。

## 画面 `unit-convert/index.html`
`_template/` を写して作る。見た目・アイコン・決まりは `docs/開発の手引き.md` のとおり。テストが使う要素:

- 種類のタブ: `.tab[data-cat="length"]` など、上の表の順に8つ。選ばれているタブは `aria-selected="true"`（日付の計算のタブと同じ作り）。
- 入力: `#value`（数）、`#from`・`#to`（`<select>`、値は単位 id）、入れかえボタン `#swap`。
- 答え: `#result`（`formatNumber` の文字だけ）、その下に式 `#formula`（例 `1 km = 1,000 m`）。
- 一覧: `#all`（その種類のすべての単位での値。各行 `li[data-unit="m"]` の中に数）。
- データ量のときだけ出る切りかえ `#data-base`（`<select>`、値 `1024` / `1000`）。
- 入力が数でないときは `#result` に `数を入れてください`、`UnitError` のときはその文。
- 最後に選んだ種類と単位を `localStorage` に覚え、開き直すと戻る。
- テスト用のフック: `window.__unitConvert = { convert, formatNumber }`。

## そのほか
- `shared/js/tools.js`、ポータル、`README.md` の表、`changelog.html`（1行）、`manual/data.js`（説明書の項目）に足す。
- ネットワークなしで動くこと（`registerOffline`）。

## 作らないもの
- 通貨（ネットが必要）、単位の追加・編集、履歴。
