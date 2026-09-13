# Increment 52 — human-readable instruction install receipt

ステータス: **完了**

基準commit: `0afad72c`

計画日: 2026-09-14

## 利用者が必要とする動作

`henji instruction install`の大量なJSONからrevision
digestを探さず、install直後に人間がexact revisionを確認し、
そのまま`inspect`、`activate`へ進めるようにする。

## 承認済み計画

- `install`の既定出力はresource ID、完全なSHA-256
  revision、copy可能な`inspect`・`activate` commandだけの
  人間向けreceiptにする。
- metadata、origin/custody、physical
  store、instruction本文の詳細表示は`inspect`へ分離する。
- managed revision、install、activation、次Worker
  generationへの反映というproduct contractは変更しない。
- focused test、type
  check、format、lint、READMEを更新する。architectureとroadmapの意味は変更しない。

2026-09-14、利用者はこの計画を承認し、修正を指示した。

## 対象外

- `list`、`inspect`、`active`、`activate`、`deactivate`の出力形式変更
- JSON output option、対話型picker、short digest、alias
- managed revisionのuninstall/remove
- architecture、roadmap、managed resource contractの変更
- commit、push、installed binaryの置換、release

## 実装・検証結果

- `instruction install`はresource IDと完全な`sha256:`
  revisionを先頭に表示し、同じexact selectorを埋め込んだ
  copy可能な`inspect`・`activate`
  commandを続ける短いreceiptだけを返すようにした。
- instruction本文、metadata、origin/custody、physical
  storeはinstall出力から除き、既存の`inspect`出力へ集約した。
- shellへcopyするresource IDとrevisionはsingle-quoted wordとして出力し、resource
  ID内のsingle quoteもshell wordを 壊さない形へencodeする。
- Increment 51のCLI testへexact receipt、本文とdata
  rootを出力しないこと、receiptから得た同じrevisionによる
  inspect/activateを追加した。focused test 5件、対象type
  check、format、lint、`git diff --check`は成功した。
- isolated XDG rootsの実CLI
  processで`/tmp/henji-harness`をinstallし、完全digestと二つのcopy可能なcommandだけが
  stdoutへ出ることを確認した。実provider requestとactive binding変更は行っていない。
- 利用者の明示指示により、managed revisionのuninstall/removeを通常利用メモS7へ未採用候補として記録し、
  実装と文書をcommit `1ee500ab`へ確定した。そのclean commitからbuild
  `0a6fcd9ae0a450d5ba16ccad2e3bbf271fc2f1001f2f76c6cce2819322d0ab99`を生成し、
  `dist/henji`と`~/.local/bin/henji`を同一artifactへatomicに置換した。両方のSHA-256は
  `95ba883b691e67637166ed63f1335956ffa770cf0597a5cd587c3116bb829ee1`である。
- 導入版から新しいinstall receipt、source `1ee500ab150aaf2e14f8e9aa59b2ed60e6398fe5`、
  `sourceDirty=false`をreadbackし、既存のactive external revision
  `local/henji-base@sha256:2e00f40b9d3160f6047eda0a3c7e3f325b3fcfc85766ad16d57549e27b70355f`が
  置換後も維持されることを確認した。tag、release、publishは行っていない。
