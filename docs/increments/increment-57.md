# Increment 57 — instruction CLI出力の短縮digest統一

ステータス: **完了**

基準commit: `7cb653d7`

計画日: 2026-09-17

対象: Increment 52/54/56で導入したinstruction CLIの人間向けreceipt

## 利用者が必要とする動作

- instruction CLIの人間向け既定出力が、install/uninstall/deactivate/list/activeで同じ短縮revision（先頭8桁）
  の表記に統一される。installだけが完全digestを併記してuninstallが完全digestだけを出す、といった混在をなくす。
- 完全digestは詳細が必要なとき`instruction inspect`（既定JSON）または`--json`から取得できる。
- selector、active binding、custody、次のWorker generationへの適用などproduct意味は変更しない。

## 計画

- `installReceipt`の`Full:`行を削除し、`Revision:  sha256:<short>`と短縮selectorの`Inspect`/`Activate`/
  `Uninstall` blockだけを表示する。
- `uninstallReceipt`の`Revision:`を`sha256:<short>`に変更する（現行は完全digest）。
- `list`/`active`/`deactivate`の表示はIncrement 55/56の短縮行のまま変更しない。
- `inspect`は現行の詳細JSON（完全digestを含む）のまま変更しない。

## 対象外

- selectorの解決規則、active guard、custody、transport
- `list`/`active`/`deactivate`/`inspect`の形式変更
- `--json`の内容変更
- 構想、architecture、roadmapの変更

## Verification

- focused test（Increment 51のinstruction CLI testを更新）:
  - `install`receiptが`Revision:  sha256:<8>`と短縮selectorを含み、`Full:`行と完全digestを含まない。
  - `uninstall`receiptが`sha256:<8>`を表示し、完全digestを含まない。
  - `inspect`（既定）は完全digestを含む詳細JSONを返す。
- 変更箇所のtype check、format、lint、`git diff --check`を実行する。
- isolated XDG rootsの実CLI processでinstall→uninstall receiptの表示を確認する。実provider requestは行わない。
- `README.md`のHenji Instruction節を短縮統一に合わせて更新する。

## 規模見積り

2つのreceipt整形とtest・README更新に限定される。**0.5〜1開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. 人間向けreceiptをinstall/uninstall/deactivate/list/activeで短縮revision（8桁）に統一し、完全digestは
   `inspect`/`--json`へ委ねる扱い。
2. `install`の`Full:`行を削除する扱い。
3. 実provider requestを行わない検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `installReceipt`から`Full:`行を削除し、`Revision:  sha256:<short>`と短縮selectorの`Inspect`/`Activate`/
  `Uninstall` blockだけを表示するようにした。
- `uninstallReceipt`の`Revision:`を`sha256:<short>`へ変更した。`list`/`active`/`deactivate`は既存の短縮行の
  まま、`inspect`は完全digestを含む詳細JSONのまま変更していない。
- focused testを更新した。`install`receiptが短縮revisionと短縮selectorを含み完全digestを含まないこと、
  `uninstall`receiptが短縮revisionを表示することを確認した。8 testはpassed。
- 変更対象のtype check、format、lint、`git diff --check`は成功した。
- isolated XDG rootsの実CLI processで、`install`receiptに`Full:`が無いこと、`inspect`が完全digestを返すこと、
  `uninstall`receiptが短縮revisionを表示することを確認した。実provider requestは行っていない。
- `README.md`のHenji Instruction節を短縮digest統一に合わせて更新した。
- 利用者の明示指示により、実装をcommit `25325498`へ確定した。そのclean commitからbuild
  `7998365e879c8dcd741d3a2ff3ce107315b19dee74587accccfa9d6a8466cb1b`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `b0823302afb1f025212e031bd4e411273b2a12eeebc881e176351a0a34f94b18`で、導入版はsource
  `25325498b7189ed72974cc307fce32d4c884370e`、`sourceDirty=false`を返した。
- 導入版をisolated XDG rootsで実行し、install/uninstall receiptが短縮revisionのみを表示し`Full:`行を含まない
  こと、`active`/`deactivate`が短縮行を返すことを確認した。実provider requestは行っていない。tag、release、
  publishは行っていない。
