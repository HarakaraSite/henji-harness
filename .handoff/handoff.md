# Handoff

## Records

### Increment 51/52 — managed Henji base instructionとinstall receipt

- 状態: Increment 52は完了。`instruction install`をresource ID・完全SHA-256 revision・copy可能な
  `inspect`/`activate` commandだけの人間向けreceiptに変更し、metadata/本文詳細は`inspect`へ分離した。
  実装commit `1ee500ab`、配置記録commit `56276f49`（現在のHEAD、`main` == `origin/main`）。
  そのclean commitからbuild `0a6fcd9ae0a450d5ba16ccad2e3bbf271fc2f1001f2f76c6cce2819322d0ab99`を生成し、
  `dist/henji`と`~/.local/bin/henji`を同一artifactへatomic置換（両方SHA-256
  `95ba883b691e67637166ed63f1335956ffa770cf0597a5cd587c3116bb829ee1`、source
  `1ee500ab150aaf2e14f8e9aa59b2ed60e6398fe5`、`sourceDirty=false`）。active external revision
  `local/henji-base@sha256:2e00f40b9d3160f6047eda0a3c7e3f325b3fcfc85766ad16d57549e27b70355f`は置換後も維持。
  前段のIncrement 51（`henji-instruction-v1`、built-in/external base、install/activate分離、Worker-core
  finalizer、context attribution）も完了・配置済み（commit `e709b100`、配置記録`0afad72c`）。
  未解決: なし（作業ツリーはclean）。`normal-use-inbox.md`のS8はcommit `6b0b3566`、構想・architecture・
  roadmap・inboxと`v0/agent/README.md`の実装追随はcommit `56375021`へ確定した。
  Increment 51/52ともtag・Forgejo Release・JSR publishは未実施（JSR latestは0.1.3）。
- 次: 現在のHEAD `56375021`（`main`は`origin/main`より`56375021`、`039df82c`、`6b0b3566`の3commit先行・未push）を
  pushするか、`docs/experience/normal-use-inbox.md`から次Increment候補を選ぶかを利用者が判断する。
- 正本: `docs/increments/increment-51.md`、`docs/increments/increment-52.md`、`docs/experience/normal-use-inbox.md`。
- 注意: このhandoffはIncrement 51のcommit `e709b100`で空化され、51/52の再開情報が未記録だったため、
  increment文書・git logから復元した。配置binaryの現物readback（`--version`、SHA-256一致）で復元内容を確認済み。
  `docs/architecture/multi-provider-routing-and-auth.md`のSession schema記述はIncrement 14〜16採用設計時の計画で
  あり現在状態の主張ではないため、実装追随の対象に含めていない。
