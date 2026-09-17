# Increment 55 — instruction CLIの短縮revisionと人間向けlist/active表示

ステータス: **完了**

基準commit: `bbb82615`

計画日: 2026-09-17

対象候補: `docs/experience/normal-use-inbox.md` の S9、S10

## 利用者が必要とする動作

- 人間がinstruction revisionを指定するとき、完全64桁digestのコピーを要求されない。TUI startupが表示する
  ような短縮digest（例 `82d67dd2`）で対象を指定できる。
- 指定した短縮が複数revisionに一致した場合は、黙って一つを選ばず、一致する完全digestを示して再指定を求める。
- `uninstall`はresource IDだけで対象が一意に決まる場合、`--revision`を省略できる。
- `list`と`active`は、人間がresource ID、revision、selection source、activeかどうかを判別できる短い既定出力を
  返す。machine向けの現行JSONは明示optionで取得できる。
- active external revisionはIncrement 54と同じく削除せず、先にdeactivateを求める。

## 計画

### revision selectorの短縮

- `--revision <value>`のvalueを、`sha256:<64 hex>`（exact）または8〜64桁のhex prefix（例 `82d67dd2`、
  `sha256:82d67dd2`）とする。アルゴリズムはsha256だけなので`sha256:`は省略できる。
- 解決は`--id`で指定したresource IDのinstall済みrevisionに対するprefix一致とする。
  - 一致1件: その完全digestを対象にする。
  - 一致0件: `instruction_not_found`。
  - 一致2件以上: 新しいtyped failure `instruction_ambiguous`とし、一致する完全digestを列挙する。
  - prefixが8桁未満、またはhex以外: `instruction_invalid`。
- 適用範囲は`inspect`、`activate`、`uninstall`。

### uninstallの`--revision`省略

- `henji instruction uninstall --id <resourceId>`を許容する。
  - `--id`一致のinstall済みrevisionが1件: そのrevisionを削除する。
  - 0件: `instruction_not_found`。
  - 2件以上: `instruction_ambiguous`とし完全digestを列挙する。
- `--id <resourceId> --revision <short|exact>`は現行どおりexact revisionを削除する。
- active guardと成功receiptはIncrement 54と同じ。

### list/activeの人間向け表示

- `henji instruction list`の既定出力は、先頭`instructions: <count>`と、revisionごとの1行
  `<resourceId> · sha256:<8桁> · <active|inactive> · <title>`とする。titleはmanifest metadataの`title`を使い、
  未設定は`untitled`とする。0件は`no instructions`。active判定は現在のbinding refとlogicalRefの一致による。
- `henji instruction active`の既定出力は、`<resourceId> · <built-in|external> · sha256:<8桁>`の1行とする。
  built-in選択時は`builtin/henji-base · built-in · sha256:<8桁>`。
- 表示するtitle等は制御文字を除去し、`list`の各行と`active`行を`columns`非依存の固定長としない。
- `--json`を付けた場合は、`list`は現行の`schemaVersion`付きmanifest一覧、`active`は現行のselected JSONを返す。
- `inspect`と`install`のreceipt形式は変更しない。

### error code

- `HenjiInstructionErrorCode`に`instruction_ambiguous`を追加する。

## 対象外

- authoring packageのscaffold、対話picker
- Agent Definition moduleのselector、remove/GC、全削除、transport、rollback
- active revisionの自動deactivate、複数revisionの一括削除
- `inspect`の出力形式、`install` receiptの形式変更
- 構想、architecture、roadmapの変更

## Verification

- focused test（Increment 51のinstruction CLI testへ追加・更新）:
  - 8桁prefixで`inspect`/`activate`/`uninstall`が対象revisionを解決する。完全digest指定も引き続き成功する。
  - 複数revisionへ一致するprefixが`instruction_ambiguous`になり、完全digestを示す。8桁未満は`instruction_invalid`。
  - `uninstall --id`が一意なrevisionを削除し、未install/削除済みは`instruction_not_found`、複数では
    `instruction_ambiguous`になる。
  - active revisionへの`uninstall --id`が`instruction_active`で拒否され、bindingとrevisionが残る。
  - `list`の既定がresource ID・短縮revision・active/inactive・titleを含む行を返し、`list --json`が現行shapeを
    返す。`active`の既定が1行、`active --json`が現行shapeを返す。built-in resource IDは拒否される。
- 変更箇所のtype check、format、lint、`git diff --check`を実行する。
- isolated XDG rootsの実CLI processで、2 revision install→`list`/`active`既定表示→prefix `inspect`→`activate`→
  active `uninstall`拒否→`deactivate`→`uninstall --id`→`list --json`を確認する。実provider requestは行わない。
- `README.md`のHenji Instruction節で短縮revision、`uninstall --revision`省略、`list`/`active`の`--json`を説明する。

## 規模見積り

CLI selectorのprefix解決、`uninstall`の一意解決、`list`/`active`の表示分岐、error code、testの更新に限定される。
**2〜3開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. `--revision`で8〜64桁のhex prefix（`sha256:`省略可）を受け付け、`--id`のinstall済みrevisionへprefix解決する扱い。
2. 適用範囲を`inspect`/`activate`/`uninstall`とし、`uninstall`は`--revision`省略も許す扱い。
3. `list`/`active`の既定を人間向け行とし、`--json`で現行JSONを返す扱いと、その行形式。
4. 複数一致は自動選択せず`instruction_ambiguous`で完全digestを示す扱い。
5. active revisionは現行どおり削除せずdeactivateを要求する扱い。
6. 実provider requestを行わない検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `--revision`を`sha256:<64 hex>`または1〜64桁hex（`sha256:`省略可）として受け付け、`resolveInstructionRevisionDigest`
  が`--id`のinstall済みrevisionへprefix解決する。一致1件はそのdigest、0件は`instruction_not_found`、複数は
  新しい`instruction_ambiguous`（完全digestを列挙）、8桁未満は`instruction_invalid`となる。適用は`inspect`/
  `activate`/`uninstall`。
- `uninstall`は`--revision`を省略でき、`--id`一致が一意なときだけそのrevisionを削除する。複数なら
  `instruction_ambiguous`、0件なら`instruction_not_found`。active guardとreceiptはIncrement 54と同じ。
- `list`の既定は`instructions: <count>`と`<resourceId> · sha256:<8> · <active|inactive> · <title>`の行、
  `active`の既定は`<resourceId> · <built-in|external> · sha256:<8>`の1行とした。制御文字を除去し長さをboundする。
  `--json`で`list`は現行manifest一覧、`active`は現行selected JSONを返す。`inspect`/`install`は変更しない。
- `HenjiInstructionErrorCode`へ`instruction_ambiguous`を追加した。
- focused testを更新・追加した。Increment 52/54の`list`/`active`呼び出しを`--json`へ変更し、Increment 55で
  prefix解決、ambiguous（純粋関数）、8桁未満invalid、`uninstall --id`の一意削除・ambiguous、list/activeの
  人間向け行、active guard、built-in拒否、receiptを確認した。8 testはpassed。
- 変更対象のtype check、format、lint、`git diff --check`は成功した。
- isolated XDG rootsの実CLI processで、3 revision install→`list`人間向け行→`list --json`→`active`人間向け行→
  prefix`inspect`→prefix`activate`→active`uninstall`拒否→`deactivate`→`uninstall --id`→`uninstall --id`
  ambiguous→prefix`uninstall`→`list`空→`inspect` not_found→4桁prefix`instruction_invalid`を確認した。実provider
  requestは行っていない。
- `README.md`のHenji Instruction節へ短縮revision、`uninstall --revision`省略、`list`/`active`の`--json`を追記した。
- 利用者の明示指示により、実装をcommit `2e8ce3da`へ確定した。そのclean commitからbuild
  `89880f2d173beea78550e9d2bcfb226b91608f71b48971716ccb3458196909fa`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `1c478d8b02a394be4406e373267ec1230cdd85a18996d03a60e1db4bd7cb7386`で、導入版はsource
  `2e8ce3da0a1dfb711aef3ca75dccad9f94754061`、`sourceDirty=false`を返した。
- 導入版で`instruction list`が`local/henji-base`の2 revisionを`inactive`/`active`とtitle付きで表示し、
  `active`が`local/henji-base · external · sha256:82d67dd2`を返すこと、`inspect --revision 82d67dd2`が
  短縮prefixで解決することを確認した。`uninstall --id local/henji-base`は2 revisionがあるため
  `instruction_ambiguous`となり、完全digestを示した。tag、release、publishは行っていない。
