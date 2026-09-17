# Increment 56 — instruction install receiptとdeactivateの人間向け出力

ステータス: **完了**

基準commit: `48eb4cd6`

計画日: 2026-09-17

対象: Increment 55で対象外とした`instruction install` receiptと`instruction deactivate`出力

## 利用者が必要とする動作

- `henji instruction install`のreceiptが短縮revision（8桁）を表示し、そのままコピーして実行できる
  `inspect`・`activate`・`uninstall` commandを短縮revisionで示す。完全digestはexact確認用に残す。
- `henji instruction deactivate`がbuilt-inへ戻ったことを示す短い人間向け行を既定で返し、`--json`で
  現行のJSONを返す。
- install、activate/deactivateのproduct意味（active binding、次のWorker generationへの適用、managed
  revisionのcustody）は変更しない。

## 計画

### install receipt

既定のreceiptを次の形にする。`<short>`は完全digestの先頭8文字。

```
Installed: "local/henji-base"
Revision:  sha256:<short>
Full:      sha256:<64>

Inspect:
henji instruction inspect --id 'local/henji-base' --revision '<short>'

Activate:
henji instruction activate --id 'local/henji-base' --revision '<short>'

Uninstall:
henji instruction uninstall --id 'local/henji-base' --revision '<short>'
```

- resource IDは現行どおりsingle-quoted shell wordとして出力する。short/fullはhexのみなのでquoteしない。
- `Uninstall:`blockを追加し、deactivate前の操作順は示さない（active時の拒否はCLIが返す）。
- JSON output optionは追加しない。

### deactivate

- `henji instruction deactivate`の既定出力を
  `deactivated · builtin/henji-base · built-in · sha256:<short>`の1行とする。
- `henji instruction deactivate --json`は現行の`{ok:true, ...selected(builtin)}`を返す。
- bindingが存在しない場合も同じ成功出力とする（現行挙動を維持）。

## 対象外

- install/activate/list/active/inspectのselector・意味・出力（receipt以外）
- authoring packageのscaffold、対話picker
- active revisionの自動deactivate、一括削除、transport、rollback
- 構想、architecture、roadmapの変更

## Verification

- focused test（Increment 51のinstruction CLI testを更新）:
  - `install`receiptが短縮revisionと`Full:`の完全digestを含み、`inspect`/`activate`/`uninstall`blockのselectorが
    短縮revisionで、resource IDのsingle quoteを壊さない。
  - receiptの`activate`selectorをそのまま実行してexternalへ切り替わり、`uninstall`selectorで削除できる。
  - `deactivate`既定が1行の人間向け出力、`deactivate --json`が現行shapeを返す。
- 変更箇所のtype check、format、lint、`git diff --check`を実行する。
- isolated XDG rootsの実CLI processでinstall receipt→activate→deactivateの表示を確認する。実provider requestは
  行わない。
- `README.md`のHenji Instruction節を短縮revision・`deactivate --json`に合わせて更新する。

## 規模見積り

receipt整形とdeactivateの表示分岐、test・README更新に限定される。**1開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. install receiptの行構成（`Installed`/`Revision`短縮/`Full`完全digest/`Inspect`/`Activate`/`Uninstall`）。
2. `deactivate`の既定を`deactivated · builtin/henji-base · built-in · sha256:<short>`の1行、`--json`で現行JSONと
   する扱い。
3. 実provider requestを行わない検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `installReceipt`を、短縮revision（先頭8桁）を`Revision:`へ、完全digestを`Full:`へ示し、`Inspect`/`Activate`/
  `Uninstall`の各commandを短縮revision指定で出力する形へ変更した。resource IDは現行どおりsingle-quoted shell
  wordとして出力する。
- `instruction deactivate`の既定出力を`deactivated · builtin/henji-base · built-in · sha256:<short>`の1行とし、
  `deactivate --json`で現行の`{ok:true, ...selected(builtin)}`を返すようにした。bindingが無い場合も同じ。
- focused testを更新した。Increment 52のreceipt assertionを短縮revision・`Full:`・`Uninstall`blockへ合わせ、
  receiptの短縮selectorで`inspect`/`activate`を実行し、`deactivate`既定の1行と`--json`を確認した。8 testはpassed。
- 変更対象のtype check、format、lint、`git diff --check`は成功した。
- isolated XDG rootsの実CLI processで、install receipt（短縮/Full/Uninstall）、receiptから取り出した短縮
  revisionでの`activate`、`active`、`deactivate`人間向け行、`deactivate --json`、短縮revisionでの`uninstall`を
  確認した。実provider requestは行っていない。
- `README.md`のHenji Instruction節を短縮receiptと`deactivate --json`に合わせて更新した。
- 利用者の明示指示により、実装をcommit `d71c026f`へ確定した。そのclean commitからbuild
  `657b11bd5145b8dd0f1f60f9865da58471595d4bfbd6c429266d5b85a66fb71f`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `982b43be9f03b2a1d7eb12c3fd10d8ce9e6253f44f02bc715ce58fce73ab5bab`で、導入版はsource
  `d71c026f3a7c7dc7e72c74490930b4808c7ce3c6`、`sourceDirty=false`を返した。
- 導入版をisolated XDG rootsで実行し、install receiptの短縮revision・`Full:`・`Uninstall`block、receiptから
  取り出した短縮revisionでの`activate`、`deactivate`人間向け行、`list`人間向け行、短縮revisionでの`uninstall`を
  確認した。実provider requestは行っていない。tag、release、publishは行っていない。
