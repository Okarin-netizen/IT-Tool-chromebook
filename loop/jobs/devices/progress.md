# 全ツールを3つの端末で: 申し送り

周ごとに、やったこと・つまずいたこと・次の人への一言を下に足していきます。全部終わったら最後の行に DONE。

## 周 0（人が準備）
- tests/smoke.cjs に --device=chromebook / windows / ipad と、横にはみ出さない検査を足した。tests/ipad-pitfalls.mjs を作った。
- 最初に全部回した結果: chromebook で pdf-grade、windows で pdf-pages、ipad で pdf-grade・image-pdf・kaotori が失敗。落とし穴は22件。これを tasks.json にした。
- smoke の失敗のくわしい理由は `SMOKE_DEBUG=1 node tests/smoke.cjs ...` で出る。
- 指のテストの失敗は、アプリのせいかテストの作りのせいか、まだ分からない。テストのせいだと思ったら直さずに書く。
