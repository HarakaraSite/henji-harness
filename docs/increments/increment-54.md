# Increment 54 — managed Henji Instructionのuninstall

ステータス: **完了**

基準commit: `581354dc`

計画日: 2026-09-17

対象候補: `docs/experience/normal-use-inbox.md` の S7

## 利用者が必要とする動作

- 人間がmanaged storeへinstall済みのexternal Henji Instruction revisionを、resource IDと完全SHA-256
  revisionで指定して削除できる。
- 削除対象が現在activeなexternal revisionである場合は削除せず、先にdeactivateする必要があることをtyped
  failureで示す。active external revisionのresolution failureでbuilt-inへ暗黙fallbackしない現行contractを
  壊さない。
- 削除に成功したら、削除したresource IDとrevisionを確認できるreceiptを返し、対象がlist/inspectから
  消えたことを確認できる。
- 他のrevision、active binding、過去execution attribution、canonical historyを変更しない。

## 計画

### CLI

- `henji instruction uninstall --id <resourceId> --revision sha256:<64 hex>` を追加する。selector形式は既存の
  `inspect`/`activate`と同じ`parseSelector`を使う。
- 既定出力はinstall receiptと同様の短い人間向けreceiptとし、削除したresource IDと完全revisionを表示する。
  JSON output optionは追加しない。
- 対象が存在しない場合は`instruction_not_found`で失敗する。`isExternalHenjiInstructionResourceId`の検証により
  built-in（`builtin/henji-base`）はuninstallできない。
- `list`/`inspect`/`active`/`activate`/`deactivate`/`install`の出力と意味は変更しない。

### store

- `ManagedHenjiInstructionStore.remove(resourceId, digest)`を追加する。既存`inspect`で対象revisionを検証して
  から、そのrevision directory（`<root>/<resourceDirectoryKey>/<digest>`）だけをrecursiveに削除する。
  空になったresource parent directoryと`.staging-*`、他revisionには触れない。
- active binding guardとして、bindingをcontent解決せずに読むexport helper（例
  `readHenjiBaseInstructionBindingRef(configRoot)`）を追加する。対象refがactive external revisionと一致する
  場合は削除前に新しいtyped failure `instruction_active`で拒否する。bindingがinvalidな場合も黙って削除せず、
  既存のbinding errorを返す。
- 削除はrevision directory単位の一回の`Deno.remove`に限定し、途中状態を残さない。

### error code

- `HenjiInstructionErrorCode`に`instruction_active`を追加する。

## 対象外

- Agent Definition moduleのremove/GC、managed revisionの全削除、transport、rollback、workspace scope
- `install`/`list`/`inspect`/`active`/`activate`/`deactivate`の出力・意味の変更
- Session schema、durable history、attribution、instruction compositionの変更
- 構想、architecture、roadmapの変更

## Verification

- focused test（Increment 51のinstruction CLI testへ追加、または同種の新規test）:
  - external revisionをinstall→uninstallでstoreから消え、`list`に出ず、`inspect`が`instruction_not_found`になる。
  - active external revisionのuninstallは`instruction_active`で失敗し、bindingとrevisionが残り、次のWorker
    generationが同じbaseを解決できる。
  - 存在しないrevisionとbuilt-in resource IDのuninstallがtyped failureになる。別revisionは残る。
  - 成功時のreceiptがresource IDと完全revisionを表示する。
- 変更箇所のtype check、format、lint、`git diff --check`を実行する。
- isolated XDG rootsの実CLI processでinstall→deactivate→uninstall→list/inspectを確認する。実provider requestは
  行わない。

## 規模見積り

storeのremoveとbinding guard、CLI command、error code、testの追加に限定される。**1〜2開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. command名`uninstall`とselector `--id <resourceId> --revision sha256:<digest>`。
2. active external revisionは削除せず`instruction_active`で拒否し、先にdeactivateする扱い。
3. revision directoryだけを削除し、空parent directory、staging、他revisionは残す扱い。
4. 実provider requestを行わない検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `ManagedHenjiInstructionStore.remove(resourceId, digest)`を追加した。selectorを検証し、既存`inspect`で
  revisionを確認してからrevision directoryだけをrecursiveに削除する。空になったresource parent directory、
  `.staging-*`、他revisionには触れない。
- bindingをcontent解決せずに読む`readHenjiBaseInstructionBindingRef(configRoot)`を追加し、CLIの`uninstall`は
  対象がactive external revisionと一致する場合に`instruction_active`で拒否する。bindingがinvalidな場合は
  既存のbinding errorを返す。
- `HenjiInstructionErrorCode`へ`instruction_active`を追加した。built-in resource IDはselector検証で
  `instruction_invalid`、存在しないrevisionは`instruction_not_found`になる。
- CLI `henji instruction uninstall --id <resourceId> --revision sha256:<digest>`を追加し、成功時は
  `Uninstalled: "<id>"`と`Revision:    sha256:<digest>`だけの短いreceiptを返す。`parseSelector`を
  `inspect`/`activate`と共有する。
- focused testをIncrement 51のinstruction CLI testへ追加した。inactive revisionの削除、`list`からの消失、
  `inspect`の`instruction_not_found`、active拒否とbinding維持、deactivate後の削除、存在しないrevision、
  built-in id拒否、receiptを確認した。Increment 51/52を含む6 testはpassed。
- 変更対象のtype check、format、lint、`git diff --check`は成功した。
- isolated XDG rootsの実CLI processで`install`→`list`→`activate`→active `uninstall`（`instruction_active`）→
  `deactivate`→`uninstall`（成功receipt）→`list`空→`inspect`（`instruction_not_found`）を確認した。実provider
  requestは行っていない。
- `README.md`のHenji Instruction節へ`uninstall`とactive revisionの扱いを追記した。
- 利用者の明示指示により、実装をcommit `40ce44a9`へ、S6/S8のinbox整理をcommit `7eed3624`へ確定した。その
  clean commitからbuild `67649b5158e76219f7a6ada75d2b40e97abde93aff6beb0409656900ee116236`を生成し、
  `dist/henji`と`~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `fb1c2121f06fb8ecfb40f05ced6126f6e3066a5ef15abd351f0fcd6d7c0ef6fd`で、導入版はsource
  `7eed36240028bf7614d981141148adb370875f70`、`sourceDirty=false`を返した。
- 導入版の`instruction active`はexternal `local/henji-base@sha256:82d67dd2…`を維持し、同revisionへの
  `uninstall`は`instruction_active`で拒否された。tag、release、publishは行っていない。
