# IT-Tool-chromebook の決まりごと（AI 向けの要約）

中学校の Chromebook（1人1台、11.6インチ 1366×768）と iPad で使う、ブラウザだけで動く道具集です。画面の言葉はすべて日本語で、中学生に分かる言い方にします。

- くわしい決まりは `docs/開発の手引き.md`。新しいツールは「新しいツールの足し方」の手順どおりに `_template/` を写して作る。
- ビルドなし・CDN なし。ライブラリは `shared/vendor/` に同梱し、`shared/js/vendor.js` から読む。オフラインで動くよう `registerOffline([...])` に使うファイルを並べる。
- 共通の部品は `shared/js/`（status, files, storage, buttons など）を使い、同じものを作り直さない。
- アイコンは絵文字を使わず、`<symbol id="i-*">` の線のアイコン。同じ名前のアイコンはほかのツールから写す。
- ツールを足したら: `shared/js/tools.js`、ポータル、`README.md` の表、`changelog.html` に1行、`manual/data.js` に説明書。
- テスト: `node tests/consistency.mjs`（すぐ終わる）、`node tests/smoke.cjs <ツール>`（ブラウザ）。くわしくは `tests/README.md`。
- 日本語の入ったスクショを撮るときは、同梱の Noto Sans JP を fontconfig に入れてから。
