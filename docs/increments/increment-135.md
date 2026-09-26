# Increment 135 — Henji内credential登録（S2）

状態: 完了（2026-09-27、利用者の承認によりIncrement 135を完了とした）。
経緯: 2026-09-27、利用者が「入り口だけ作り、キーの保管場所は現状維持」という方針で、
次のincrementとして詳しい計画の作成を依頼した。本文書が要件・対象範囲・計画・結果の正本であり、
実装・確認結果は末尾に記録する。実provider requestでの保存credential受理と実運用credentialの
`/login`登録は利用者が実施する。

## 必要なproduct動作と根拠

- 人間がHenjiのTUIでAPI keyを登録・更新し、そのまま同じSessionの後続requestを実行できる。
  手作業でcredential fileを作る操作をTUIから行えるようにする。
- キーの保管場所・file形式・request時の解決方法は現状維持とする。 SQLite、OS
  keyring、暗号化storageへの移行は今回の目的に含めない。
- credential値とAuthorizationを、通常editor、会話履歴、process argument、Definition、 transport
  package、Session、evidenceへ含めない。登録入力は専用の伏字画面で受け付ける。
- 登録対象は有効なProvider宣言の`authProfile`から得る。built-in二providerへの固定UIを作らない。

根拠は利用者との会話、およびS2の採用前の判断である。
2026-09-12にProvider外部化と登録catalog・request時解決の接続を要求し、2026-09-22に優先度を上げた。
Provider外部化はIncrement 58〜68／101で成立している。2026-09-27の会話では、
参照実装の保管方式とUnixの所有者・0600を確認したうえで、入口追加を先行する方針を選んだ。
S2（F01、F02、F10）の要件と計画を通常利用メモから本文書へ移した。

成功基準は、人間がproduction TUIで対象選択、伏字入力、保存、通常画面への復帰を完了でき、
保存した値を既存のrequest-time resolverが読めることである。
「保存できた」と「providerがキーを受理した」は区別する。登録操作だけではnetwork requestを行わない。

## 現行の利用者操作からrequestまでの経路

1. [`tui_cli.ts`](../../v0/agent/cli/tui_cli.ts)がruntime config rootからexternal
   Provider宣言を読み、 built-in宣言と合成してからWorker SessionとTUIを作る。
2. [`model_catalog.ts`](../../v0/agent/provider/model_catalog.ts)の`providerIdsForSelection()`と
   [`provider_runtime.ts`](../../v0/agent/provider/provider_runtime.ts)の`effectiveDeclarationFor()`が、
   有効なproviderとその`authProfile`を得る経路である。chatとresponsesが同じprofileを共有する場合がある。
3. [`slash_command.ts`](../../v0/tui/slash_command.ts)と
   [`controller.ts`](../../v0/tui/controller.ts)がslash commandを解釈する。
   [`controller_overlay.ts`](../../v0/tui/controller_overlay.ts)がpickerとmodal入力を所有する。
   production controllerは一つのterminal読取経路を持ち、modalへ通常editorより先に入力を渡す。
4. 通常editorは入力履歴、pending input、steering、file reference補完へ接続している。
   ここへキーを入れる実装は採用しない。rendererの`renderChoicePicker()`へ渡した文字列は
   表示stateにも残るため、伏字化はrendererへ渡す前に行う。
5. [`credential_file.ts`](../../v0/agent/provider/credential_file.ts)は、
   [`runtime_paths.ts`](../../v0/agent/runtime/runtime_paths.ts)で決まる
   `<XDG_CONFIG_HOME>/henji-harness/<authProfile>`を読む。XDG未指定時はログインユーザーの
   `$HOME/.config/henji-harness/<authProfile>`になる。
   現行readerは通常file、実行ユーザーの所有、mode 0600、1〜4096 bytesを要求し、
   UTF-8の単一tokenを読む。末尾のLF／CRLFを除去する既存parserがある。保存APIはまだない。
6. [`credential_resolver.ts`](../../v0/agent/provider/credential_resolver.ts)と
   [`worker_physical_io.ts`](../../v0/agent/worker/worker_physical_io.ts)はrequestごとに固定fileを読む。
   更新を適用するためにWorkerを再起動したり、キーをHost→Workerのmessageへ載せたりする必要はない。
7. ready画面の`credential missing`は`credentialAvailabilitySnapshot()`を参照する。
   このsnapshotはWorker起動・model切替時に更新されるが、fileを書くだけでは更新されない。
   同じmodelへの`selectModel()`は`unchanged`で返るため、再選択による更新には頼れない。

credentialのlocal登録・保管はHost側、実requestの解決は既存のphysical I/O経路、
入力・結果表示はSurfaceが担当する。保管のauthorityは固定fileのままである。
構想・architecture・roadmapの変更は今回行わない。

## 受入要件

### A — 登録入口と対象catalog

- idle時に`/login`で登録画面を開く。slash候補とhelpにも追加する。
- 有効なProvider宣言を走査し、`authProfile`ごとに一行の登録対象を作る。 各行にprofile
  IDと利用するprovider IDを表示する。共有profileを重複登録させない。
- 現在selectionのprofileを初期選択し、Up／Downで選択、Enterで専用入力へ進む。
  選択が画面外へ消えないように、terminalの表示領域に合わせて行を表示する。
- 対象選択はmodel／providerの切替ではない。Session、model、effort、root既定selectionを変更しない。
- busy時の`/login`は「idle時に登録する」旨を表示し、modelへのtaskやsteeringとして送らない。
  今回はturn途中で登録するflowを追加しない。

### B — 専用入力とsecretの扱い

- 専用dialogのprivate
  stateだけが入力値を保持する。通常editorや汎用PresentationIntentへキーを渡さない。
  rendererへ渡す値はprofile名、操作案内、伏字、値を含まない結果だけとする。
- printable入力とbracketed paste、Backspace、Ctrl-Uによる全消去を受け付ける。
  伏字は入力した文字数相当の`*`とし、実文字の一瞬表示や保存後の再表示をしない。
- Enterで保存する。pasteは入力への追加だけであり、自動保存しない。
  Esc／Ctrl-C／Ctrl-Dは入力を破棄して通常画面へ戻る。fileは更新しない。
- modal中の履歴キー、Tab補完、Alt-Enterのpending投入などは通常editorへ渡さない。
  キー入力のために第二のstdin readerを作らず、既存InputEventを専用dialogへ配送する。
- 保存中もmodalが入力を所有する。同じterminal readでEnterの後に届いた文字を
  通常editorへ落とさず、保存を重複実行しない。
- validation／保存失敗は値を含まない短い理由を表示する。再入力・再試行またはcancelできる。
  生のErrorや入力値をstatus、console、diagnosticへ連結しない。
- dialogを閉じたら入力への参照を解放する。JavaScript heapの完全消去保証は今回の要件にしない。

`/login`にsecret引数を受け取るinterfaceは作らない。画面の案内は専用入力への貼り付けを示す。
`/login ...`を誤入力した場合は、引数を含まない案内を返し、通常のunknown-command表示へ
全文を再表示しない。このcommandに限った扱いであり、通常task入力の一般的なsanitizerは追加しない。

### C — 現行fileへの保存・更新

- 保存pathは`credentialFileFor(authProfile)`から得る。画面から任意pathを受け取らない。
  JSON形式、DB、別registry fileへ移さない。UTF-8のキー単体を保存する。
- 既存`parseCredentialBytes()`と`MAX_CREDENTIAL_BYTES`に合う値を保存する。
  キーprefixの推測、provider別の固定長、networkによる有効性確認は追加しない。
  末尾改行は既存parserの規則で扱い、内部の空白を勝手に除去しない。
- 新規作成時に0600を指定し、公開するfileのmodeを0600にする。
  新規fileの所有者は実行ユーザーになる。sudo、chown、他ユーザーのhomeへの登録は導入しない。
- 既存キーは同じpathへ更新する。書込途中の失敗で既存キーを空にしない。
  下記の同一directory内temporary fileからの置換を使い、別の永続保存先やbackupは増やさない。
- 保存成功は最終pathへの置換完了後に返す。失敗時は既存fileを維持し、 今回の保存処理が作ったtemporary
  fileだけを片付ける。既存dataやfileを整理・削除しない。

### D — 登録結果と後続request

- 成功時は`credential saved: <authProfile>`相当を表示して通常画面へ戻る。
  「認証成功」や「provider確認済み」とは表示しない。
- 現在selectionに対応するcredential presenceを再取得し、既存のavailability snapshotへ反映する。
  登録したprofileが現在selectionと異なる場合、現在の`credential missing`を誤って消さない。
- 同じSessionの次requestは既存resolverで更新後の値を読む。
  Session生成、model変更履歴、Worker再起動、root defaultの書換えを副作用にしない。
- 通常editor、入力履歴、pending／steering、transcript、semantic履歴、request factへ
  登録値やAuthorizationを流さない。登録結果のために新しい永続eventは追加しない。

## 実装方針

### Host-local登録service

`v0/agent/provider/credential_registration.ts`を追加する案とする。 既存Provider
registryからcatalogを作り、固定credential fileへ保存する小さなserviceにする。
概念上のinterfaceは次の二操作で足りる。名称と型の細部は実装時に既存慣習へ合わせる。

```ts
type CredentialRegistrationTarget = {
  authProfile: AuthProfileId;
  providers: readonly ProviderId[];
};

interface CredentialRegistration {
  targets(): readonly CredentialRegistrationTarget[];
  save(authProfile: AuthProfileId, value: string): Promise<void>;
}
```

- catalogはTUI起動時に解決した有効宣言を使用する。新しいProvider loaderやlive reloadを作らない。
- `save()`はbytesを検証し、必要ならconfig directoryを作り、同じdirectory内の 一意なtemporary
  fileを`createNew`・mode 0600で開く。 書込・closeとmode
  0600への設定が終わってから固定pathへrenameする。
  これにより新規と更新を同じ経路で扱い、旧fileのin-place chmodやtruncateを避けられる。
- 4096 bytesの判定はparserだけに頼らず保存前に行う。保存値の実体をErrorへ含めない。
- fsync、crash後のtemporary file掃除、backup世代、lock機構、permissionの組合せmatrixは追加しない。
  通常の単一TUIでの新規・更新操作を成立させる。
- productionのpathは既存resolverと一致させる。テストのinjected config rootを、productionに
  caller-selected credential pathを追加する理由にしない。隔離確認はprocessのXDGで行う。

### TUIへの接続

- `tui_cli.ts`のcompositionでserviceを作り、`TuiControllerOptions`からoverlayへ渡す。
  secretを扱う`save()`はHost内の直接callとし、Worker protocolや汎用intentへ拡張しない。
- `ControllerModal`に対象選択、secret入力、保存中の状態を追加する。 secret
  stateが大きくなる場合は専用moduleへ分けるが、通常の`TuiEditor`は再利用しない。
- `controller.ts`では`/login`のdispatchとbusy時の扱いを追加する。
  modal優先のInputEvent配送を維持し、通常editorのhistory・pending経路へ落ちないことを確認する。
- 既存`renderChoicePicker()`を使える範囲で使い、renderer stateへ実値を載せない。
  対象が多い場合の可視範囲はcredential picker内で扱い、既存picker全体の改修へ広げない。
- save promiseをoverlayが所有し、既存`settle()`から待つ。
  terminal終了後の描画や処理の取り残しを避ける。保存中のEscをrollback成功のように表示しない。
  保存開始後はその操作の完了を待ち、結果を表示する。

### availabilityの更新

キー自体をcacheに追加せず、presenceだけを更新する。
`refreshCredentialAvailability()`相当のHost-local
methodを、既存のSession／adapter経路へ追加する案とする。

1. 保存成功後、controllerから現在Sessionへrefreshを依頼する。
2. `ExecutionCoordinator`が現在selectionの`authProfile`について
   `credentialFilePresenceFor()`を呼び、`WorkerSupervisor.setCredentialAvailability()`へ反映する。
3. `WorkerHostSession`、`WorkerTuiSession`、`TuiPresentationAdapter`はこの非secret操作を転送する。
   refresh結果が現在selectionに対応することを確認してから反映する。
4. controllerは既存`readyStatus()`を再計算する。Worker commandやmodel変更transactionは発生させない。

このmethodは表示snapshotの更新であり、credentialの新しいauthorityではない。 request
resolverは従来どおりfixed fileを読む。保存成功後に表示refreshだけが失敗した場合は、
保存を失敗扱いにしてキーを戻さず、保存済み・表示更新未完了を区別して伝える。

## 実装スライスと担当範囲

Henjiは次の順で実装し、各sliceの確認結果を本文書の末尾へ記録する。
実装を指示された範囲で進め、slice名だけを理由にsubagentを起動しない。

| Slice | product上の結果                                                             | 主な対象                                                                                                                             |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | 有効Providerのprofileを列挙し、既存readerで読めるfileを新規作成・更新できる | `credential_registration.ts`（新規）、必要最小限の`credential_file.ts`再利用／export、focused test                                   |
| 2     | `/login`から専用伏字入力、保存、cancelを完了できる                          | `tui_cli.ts`、`slash_command.ts`、`controller_contract.ts`、`controller.ts`、`controller_overlay.ts`、help表示箇所                   |
| 3     | missing表示更新、同じSessionの後続解決、production TUI操作を確認できる      | `worker_host_coordinator.ts`、`worker_host_session.ts`、`worker_tui_session.ts`、`tui_presentation_adapter.ts`、focused test、本文書 |

`worker_protocol.ts`、Session schema、history DB、Provider宣言schema、Definition
formatの変更は想定しない。 そこへの変更が必要だと分かった場合は、理由と実経路を示して計画へ戻す。

## 検証計画

### 最小限のfocused確認

fixtureはproduct contractの代わりにしない。次の各確認には具体的な受入要件がある。
新しいtestの置き場は`tests/v0/increment_135_credential_registration_test.ts`と
`tests/v0/increment_135_credential_dialog_test.ts`を候補とする。
既存`tests/v0/tui_controller_overlay_test.ts`と`increment_66_provider_picker_test.ts`は
変更した共通経路に対応する部分だけ確認する。

| 対応要件 | 確認するproduct動作                                                          | 確認方法                                                                             |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A        | built-inとexternalを列挙し、共有profileをまとめる。登録選択でmodelを変えない | 宣言を解決したcatalogとcontroller操作のfocused test                                  |
| B        | 入力・pasteは伏字だけになり、Backspace／clear／cancelが働く                  | 既存InputEvent配送でdialogを操作し、renderer state・通常editor・入力履歴を確認       |
| B        | Enter後の入力が通常editorへ漏れず、saveが一回だけ走る                        | save完了を制御した一つの入力batchで確認                                              |
| B        | `/login ...`の案内へ引数を再表示せず、busy中にtask／steeringへ送らない       | commandのcontroller経路で確認                                                        |
| C        | 新規・更新fileを現行readerが読める。更新失敗時は旧値を読める                 | 隔離directoryでwriter→`readCredentialFileFor()`、mode・uid、実際の書込失敗箇所を確認 |
| C        | 現行readerが受け付けない値を保存成功扱いにしない                             | 既存parserの代表的な不適合入力を保存経路で確認。未知のprovider形式matrixは作らない   |
| D        | current profileのmissingが消え、別profileの保存では誤って消えない            | Host-local refresh→snapshot→ready表示を確認                                          |
| D        | 保存・更新後にresolverが新しい値を返し、Session／selectionは変わらない       | 同じresolver instanceによる再解決とSession snapshotを確認                            |

すべてdummy credentialを使う。値の比較はtest process内だけで行い、snapshot
fixtureやログへ実credentialを出さない。
secret非露出はこの登録操作から実際に接続するeditor、renderer、history／pending／steering、intentの境界で確認する。
repository全体の一般security scanや無関係なpermission testは行わない。

実装中はfocused test、必要なtype check、format、lint、`git diff --check`を使う。
`v0:test`／`v0:gate`を途中確認で繰り返さず、review前のfull gateは要求しない。
全sliceが安定した候補ではcoordinating
ownerが`deno task --config deno.v0.json v0:gate`を一回実行する。
失敗時はfocused確認で原因を絞り、再実行の理由を記録する。

### production TUIのtmux確認

隔離HOME／XDGと隔離workspaceでproduction TUIを起動する。
実configのcredentialや`default-selection.json`へ書かない。 既存のproduction起動方法を使い、fake
controllerだけの確認を完了条件にしない。

1. credentialなしで起動し、current routeの`credential missing`を観測する。
2. `/login`の候補・help・対象一覧を確認する。共有profileと、隔離configへ宣言したexternal
   providerを確認する。
3. dummy keyを入力・貼り付けし、画面の伏字、Backspace、Ctrl-U、Escの破棄を確認する。
   cancel後にfileが増えず、通常editorやUpで呼ぶ履歴に値が出ないことを確認する。
4. 再度開いて保存する。profile名だけの成功表示、missing更新、通常入力への復帰を確認する。
   固定pathのmode・uidを確認し、既存readerが読めたことを値を出さずに記録する。
5. 同じprofileを別dummy keyへ更新し、既存resolverが更新後の値を読めることをprocess内比較で確認する。
   Session ID、model／effort、root defaultが変わっていないことを確認する。
6. 保存したまま終了・再起動し、固定fileを引き続き読めることを確認する。
   terminalの入力・表示が復帰し、通常taskの入力操作が働くことを確認する。providerへtaskは送信しない。

記録するのは操作、profile
ID、保存成功／失敗、mode・uid一致、presence、Session維持、非露出の観測である。
dummy値であっても本番キーを記録する慣習を作らない。 実provider
callは上記に含めない。通常の人間利用でprovider受理まで確認する段階では、
対象provider／model、回数、保存先を提示して別途明示承認を得る。
未承認の場合は「登録・既存reader／resolverの解決を確認、provider受理は未確認」と結果を区別する。

## 参照実装から採用する点

2026-09-27の調査で確認したsnapshotを判断材料にする。参照実装の全機能を移植しない。

| 実装     | 調査snapshotとsource                                                                                                                                                                                           | 今回の判断に使う点                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Zot      | `_refs/zot`、`f60e492e551892e737d24a7eaf7730f1f60b75af`、`packages/provider/auth/{manager,server,store}.go`                                                                                                    | provider選択→専用入力→保存。mode 0600のtemporary fileからrenameする保存経路                                   |
| Pi       | `_refs/pi`、`08dc60bc52d89d6823a9738cc90b1916e5e446e5`、`packages/coding-agent/src/modes/interactive/interactive-mode.ts`、`packages/coding-agent/src/core/auth-storage.ts`、`packages/ai/src/auth/resolve.ts` | auth catalogと登録入口を接続し、登録後のrequestで保存値を解決する。標準API key登録はnetwork確認を必須にしない |
| OpenCode | `696f41bc8e7586657375d53390925fc54c25d34c`、`packages/tui/src/component/dialog-provider.tsx`、`packages/opencode/src/auth/index.ts`                                                                            | `/connect`の専用flow、保存後のUI更新。file保存は平文JSON・mode 0600                                           |
| Codex    | `b334d5b3f2d9441b95286a8c2af8c2152737d977`、`codex-rs/login/src/auth/storage.rs`、`codex-rs/tui/src/onboarding/auth.rs`                                                                                        | fileとkeyringは別backend。file保管と入口追加を分けて考えられる。保管方式の変更は入口の前提ではない            |

Pi／OpenCode／Codexの調査対象にはAPI keyを通常文字として描画する入力経路もあった。
その表示をHenjiの要件にはしない。Henjiは今回の明示方針に合わせ、専用入力を伏字で描画する。
Zotのbrowser経由入力、providerへの事前probe、OAuth、参照実装固有のJSON storageは移植しない。

## 対象外・承認境界・未確認事項

- 今回作成したのは計画文書である。Henjiへの実装指示後に、指示されたlocal実装と非破壊的な検証を行う。
- OAuth／subscription login、keyring／暗号化／SQLite、logout／キー削除、credential export、 dynamic
  model取得、Provider live reload、provider未宣言の任意profile入力は対象外である。
- 一般的なhardening、所有権の修復、sudo、他ユーザーとの共有、追加の入力制限は設計しない。
  readerが既に持つcontractと今回のAPI credential／Authorization非露出に合わせる。
- 実provider call、実credentialの登録・上書き、既存dataの削除、commit／push、常用binary配置・公開は
  今回の計画作成依頼からは実施しない。必要な段階でそれぞれの指示・承認を確認する。
- 構想・architecture・roadmapの意味上の変更は別途承認を得る。
  実装完了後に機能の実装状態を反映する必要があれば、対象と変更案を提示する。
- command名`/login`と上記dialog操作は計画案。実装時に利用者の追加指定があれば本文書を更新する。
- tmux上の外部provider行の可視性、保存promiseとterminal終了の接続は実装後に確認する。
  現時点で成功済みとしない。

## 実装・確認結果

2026-09-27に実装、focused確認、review、production tmux確認、`v0:gate`まで完了。
配置・公開・commit／pushは未実施。実provider callは未実施。

### sliceごとの変更

| slice | 変更 |
| --- | --- |
| 1 登録入口・catalog | `v0/tui/slash_command.ts`（`/login`追加）、`v0/tui/startup_render.ts`（help）、`v0/tui/controller.ts`（dispatch・busy応答・Alt-Enter follow-up拒否・`/login`引数usage）、`v0/tui/controller_overlay.ts`（対象一覧・window表示・入力dialog・保存・破棄）、`v0/tui/controller_contract.ts` |
| 2 Host-local登録service | `v0/agent/provider/credential_registration.ts`（新規: effective declarationからのprofile grouping・保存前検証・temporary file 0600→rename・破壊的エラー分類）、`v0/agent/provider/credential_file.ts`（保存API追加） |
| 3 presence更新と接続 | `v0/agent/worker/worker_host_coordinator.ts`／`worker_host_session.ts`／`worker_tui_session.ts`（`refreshCredentialAvailability`・未起動LazySessionのHost-local更新）、`v0/presentation/adapter_contract.ts`／`tui_presentation_adapter.ts`（型接続と転送）、`v0/agent/cli/tui_cli.ts`（registration接続） |
| test・登録 | `tests/v0/increment_135_credential_registration_test.ts`（5）、`tests/v0/increment_135_credential_dialog_test.ts`（9）、`deno.v0.json`（`agent:increment-135-credential-*:test` 2件と`v0:test` chain接続）、`tests/v0/tui_retained_terminal_test.ts`（slash候補10件）、`tests/v0/tui_tool_preview_test.ts` |

### focused確認（tmux確認前）

- `increment_135_credential_registration_test.ts` 5件、`increment_135_credential_dialog_test.ts` 9件 pass。
  共有経路`tui_retained_terminal`＋`tui_tool_preview`＋`tui_controller_overlay` 68件、`increment_66` 3件 pass。
- `deno check`・`deno lint`・`deno fmt --check`・`git diff --check` pass。
- test側の修正3件: provider-free物理I/Oでは起動snapshotが`unknown`となる事実に合わせて
  refresh確認を保存前`missing`→保存後`present`のHost-local経路へ正確化、対象一覧window確認のoff-by-one、
  save呼び出しがmicrotask開始であることへの待機追加。

### review（read-onlyレビュアー、findingsなし）

- 採用条件（根拠・source-to-impact・product correctness）を満たすfindingなし。要件A〜Eすべて適合と判断。
- 不採用borderline: 保存成功〜表示refresh完了の間だけmodalの入力ownershipが一瞬解除されるwindow
  （`controller_overlay.ts`のsave成功handler）。要件Bの明示禁止（保存中のmodal所有・同read内入力遮断）は
  満たしており、変更せず。tmuxの同read入力確認でもeditorへの流入は観測されなかった。
- 外部契約確認: credential永続化はリポジトリ正本（increment-101・operations文書・要件C）と単一token・0600・
  固定pathで一致。「JSON objectキー=authProfile」はfile内容ではなくprofile名→固定fileの対応の話として整理。

### production TUIのtmux確認（隔離XDG・実provider callなし）

`XDG_CONFIG_HOME`／`XDG_DATA_HOME`／`XDG_STATE_HOME`とworkspace/stateを隔離し、外部provider宣言3件
（共有profile 2＋専用profile 1）を隔離configに置いてproduction TUI（`v0/agent/cli/tui_cli.ts`）をtmuxで確認。

1. 初回表示: `credential missing: openrouter-chat`がstatusに表示された（保存前の固定fileなし）。
2. `/log`入力でautocompleteが`cmds: /login`を提示し、missing表示は維持された。Escで補完を閉じても
   `[ready │ credential missing: openrouter-chat]`が復帰。`/login`の対象一覧は4行（built-in 2行＋共有profile集約1行＋
   専用1行）で、現在profileの`openrouter-api-key`が初期選択、一覧表示中もmissing維持。
3. 入力dialogは`key> `伏字のみ。paste 6字→6個、Backspace→5個、Ctrl-U→空、打鍵3字→3個を確認。
   Esc破棄後は固定file未作成、生値はpaneのどこにも現れなかった。
4. 保存: 固定file（隔離config root）が16byte・mode 0600・uid一致で作成された。Enterと同一readで送った
   後続文字列は通常editorへ流れず破棄された。session ID・model・effort・root既定selectionは不変。
5. 更新: 同一targetへ2回目の保存で固定fileが上書きされ、現行reader（`readCredentialFileFor`）が更新値を読んだ。
6. 再起動: missing表示なし（`[ready]`）で起動し、保存値が読取・反映された。最終値を現行readerで読取確認。

実運用の`~/.config/henji-harness/openrouter-api-key`は実credentialが既存のため上書きせず、読取確認のみ
（presence `present`・現行readerが読取可能・mode 0600・uid一致）。保存・更新・再起動確認は隔離config rootで行った。
検証用の隔離環境とtest値は確認後に削除した。

### tmux確認で発見した不具合と修正

- 現象: 保存後の`credential saved: <profile>`がproduction footerで表示されず`[ready]`のみになった。
  footer表示（`v0/tui/layout.ts`の`footerStatusParts`）は`ready` segment以降しか描画せず、
  `<message> · <readyStatus>`形式の先頭messageが捨てられていた。要件Dの保存完了表示が実経路で届いていない。
- 修正: `v0/tui/controller_overlay.ts`の保存成功表示を`${readyStatus()} · credential saved: ${authProfile}`へ
  並べ替え（既存のmissing notice・model選択表示と同じ順序規約）。表示更新失败時の
  `credential saved: <profile> · display refresh incomplete`はfooterで元から可視のため不変。
- 回帰test: `increment_135_credential_dialog_test.ts`のsave一回性testでstatus全文を固定し順序を縛った。
- tmux再確認: 保存後にfooterが`[ready │ credential saved: openrouter-api-key]`を継続表示することを確認。

### tmux発覚不具合の検出漏れ理由と教訓

**testで検出できなかった理由**

- testは`OverlayRecorder`（setStatus/renderChoicePickerを記録するstub renderer）で止まり、
  `lastStatus.includes('credential saved: …')`を確認していた。これは「rendererに渡した文字列に
  messageが含まれる」ことの確認であり、「利用者の画面に表示される」ことの確認ではない。
  表示を決める`v0/tui/layout.ts`の`footerStatus`→`footerStatusParts`→segment合成は、
  新しいmessage構成と組み合わせて一度も実行されていなかった。
- `footerStatusParts`が`ready` segment以前のpartを捨てる性質から生じる暗黙の順序規約
  （messageはreadyStatusの後ろに置く）を縛るtest・contractが存在せず、
  `includes`系assertionは順序非依存のため規約違反を検出できなかった。
- `v0:gate`全chainが不具合ありのままpassした事実が、この構成をproduction footerまで通す
  testがsuite全体に存在しないことの実証である。test件数はこの盲点を埋めなかった。

**reviewで検出できなかった理由**

- reviewは「保存messageの文字列が作られtestがpassしている」ことをsource levelで確認したが、
  要件Dの「表示にする」を「表示文字列を作る」と読み、その文字列がfooter parserで消えるところまで
  traceしていなかった。source-to-impactのtraceがrenderer境界で途切れた。
- 一方、reviewは「保存後の`credential saved:`表示」を未確認のproduct動作としてtmux確認項目に
  正しく先送りしており、計画も表示観測をtmux確認に割り当てていた。発見タイミングとしては計画どおりで、
  失敗はstub testだけで完了を判断した点にある。

**教訓（本文書の確認方針として記録）**

1. 「表示する」という要件のtestは、rendererへの渡し値（`lastStatus`等）ではなく
   `v0/tui/layout.ts`のfooter描画結果（最終テキスト）に対してassertする。
2. reviewでは表示要件について、renderer境界を越えてfooter／描画までのtraceを通す。
3. status messageの順序規約（readyStatus構造の後ろに置く）は回帰testで縛る。
   今回追加したsave一回性testのstatus全文assertionが該当する。ただし正直には、
   これも文字列levelのassertionであり、画面levelの保証はtmux観測が根拠である。
4. 体系的な背景はAGENTS.mdのSurface change verificationが指摘する既知パターン
   （offline testだけでは表示・操作の実経路を保証できない）であり、
   test helperの都合で確認をrenderer境界で止めない。

### busy応答・shutdown接続のtmux観測（2026-09-27追加確認）

隔離XDG・外部provider宣言（endpointはlocalhost無応答listener `127.0.0.1:8123`、dummy
credential、`--provider-timeout-ms 60000`）で安定したbusy windowを作り、外部provider・実credentialを
使わずに観測した。endpointへの応答は存在せず、実provider requestは発生していない。

1. busy表示: `[working … │ pending active_task:26B │ Esc cancel]`。
2. busy中の`/login` Enterはstatus`/login registers credentials when idle`応答のみで、
   task・steeringともに登録されない。
3. busy中のliteral `/login` Alt-Enterも同じstatus応答のみで、follow_up laneは登録されない。
   controlとして非slash文字列のAlt-Enterでは`follow_up:17B`が登録されることを確認済みで、
   lane表示自体が機能している中での非登録である。
4. editorに残った`/login`と連結した`/login/login`（12B）はguard対象外の別文字列としてfollow_up登録された。
   `/login/login`はidle時もunknown command扱いであり、要件「「/login」をAlt-Enterの後続task登録にも
   流さない」は満たす。`/login`入力後に続きを打つ場合の連結表示は既知の観測事項。
5. busy中Escはcancelとしてsettleし、`cancelled`とrecoverable input維持を確認。
6. 保存直後のEscはsave完了後に到着して通常の`input ignored`status上書きになり、rollback風表示には
   ならない。保存中Escそのものはsave完了がミリ秒単位のため実terminalではwindowに到達できず、
   `credential-saving` modalが入力を所有するguardはfocused testの担保範囲とする。
7. 保存直後のterminal強制終了（tmux kill-session／SIGHUP）を3回実施し、credential fileは毎回
   mode 0600・uid一致・現行reader読取可能な完全な値で、部分書き込み・temporary file残渣がなく、
   最終値は最後の保存とsha256一致した。temporary file→renameの整合性は実terminal強制終了でも保たれる。

### gate結果

- coordinating ownerによるauthoritative `v0:gate`（v0:check＋v0:fmt＋v0:lint＋v0:test）を1回実行し、
  全chain pass。increment 135の5件＋9件を含む全test pass、失敗なし。

### 未確認事項

- 実provider requestでの保存credential受理は利用者が実施する。登録・既存reader・resolverの解決は確認済み。
- SIGTERM経路のshutdown settle詳細はfocused test・code確認の範囲。実terminalでの強制終了整合性はSIGHUPで確認済み（上記7）。
- 保存成功〜表示refresh完了のwindow（review borderline）はtmuxでeditor流入を観測せず、変更していない。
- 隔離config rootでの確認であり、実`HOME`運用での同経路は読取確認のみ。
- busy応答・terminal終了接続のtmux観測は完了済み（上記「busy応答・shutdown接続のtmux観測」参照）。

### Commit・push・常用binary配置（2026-09-27）

- 実装・test・本文書をcommit `52e84069ea3d440edd38b82e4c14e6cf3418b114`へまとめ、
  `origin/main`へpushした。fetch後のlocal／remote一致を確認した。
- cleanな上記commitからDeno 2.9.7で`dist/henji`をbuildした。product versionは0.7.0、source
  `52e84069…`（dirtyなし）、buildは`426d89176e764872a6374407a2412b743778a1dbb21d22e664cc4e867eeee0ef`。
- 配置対象binaryをtmux上のproduction TUIで起動し、隔離XDGで`credential missing`表示、
  `/login`対象一覧、伏字入力、保存、footerの`[ready │ credential saved: openrouter-api-key]`、
  固定file 0600を確認した。今回の確認で実provider requestは行っていない。
- 常用先`~/.local/bin/henji`へ原子的に配置し、候補と配置先のSHA-256一致
  （`7bd86e8f5c23f773b730053ff7256735b47578f2c05c515d6cfb92bdd3956aa9`）、
  version／source／buildの一致を確認した。配置binaryで隔離workspaceのread-only
  `history --latest --view session`を実行し、exit 0・no historyを確認した。
- 稼働中のHenji切替は行っていない。JSR公開は今回も対象外であり、JSR 0.7.0の内容は
  Increment 133時点のままである。
- `docs/operations/base-instruction-template.md`の外部変更（本作業中にworking treeへ現れた
  long-task方針paragraph）は、利用者判断により別commitで記録した。build provenanceのためstashで
  一時退避し、clean commitからbuildしたうえで復帰済み。
