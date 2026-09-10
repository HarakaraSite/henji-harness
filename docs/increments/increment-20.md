# 通常利用 increment 20 — source準拠instructionと入力前status

ステータス: **完了**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- 翻訳、要約、既存sourceからの派生物作成では、Henjiが指定されたcurrent sourceを実際に読み、指示されて
  いない事実、構造、identifier、command、設定、schema、example、link、product動作を創作または変更しない。
- 完了前にsourceと成果物を照合し、実際に読んだsourceと推定した情報を区別する。temporary成果物のため
  だけに、明示なくtracked fileへ変更を広げない。
- 選択中root providerのfixed credential fileが存在しない場合、provider requestを送る前からfooter第一行で
  分かる。
- editorの先頭から`/`を入力した場合、key入力ごとに一致するbuilt-in slash command候補がfooter第一行に
  現れる。idleでは`ready`の直後、busyでは既存statusと`Esc cancel`の後ろへ置く。

## 根拠と現行product経路

- 通常利用で、原文を直接使わない翻訳による架空command・contract変更、temporary artifactのための
  `.gitignore`変更、未読sourceを読んだとする要約が観測された。sourceとの照合を明示した場合には不整合を
  検出できた。
- built-in instructionは`v0/agent/instructions/`のHenji共通component、role、active tool guideline、
  workspace instruction、skill manifest、runtime factsの順で合成され、defaultとplannerの両方へ同じ
  共通componentを渡している。
- production credentialはroot selectionの非秘密なauth profileからWorker-local fixed fileへ解決されるが、
  変更前は各request直前まで不足が表示されなかった。Host側TUIはfooterを所有し、Workerのdata-only message
  から非秘密なavailabilityだけを受け取れる。
- built-in slash commandはexact-match parserとcontrollerのunknown-command案内に重複して列挙され、入力中の
  候補表示はなかった。footer第一行は`ready` / `busy`をprimary statusとし、busy中は末尾へ
  `Esc cancel`を加える。

## Product動作

### source準拠instruction

- 翻訳や忠実な派生物作成ではcurrent sourceを直接読み、利用者が変更を求めた箇所以外の構造、事実、
  identifier、command、設定、schema、example、link、product動作を維持する。
- 要約では目的に応じた省略を許すが、sourceにない事実やcontractを追加せず、sourceの意味を変更しない。
- 完了前にsourceと成果物を照合し、意図しない追加、欠落、構造変更、contract変更を確認する。意図した差異は
  明示する。
- temporaryまたはuntracked artifactのためだけに、明示依頼なくtracked fileへ変更を広げない。
- 実際にtoolで取得したsourceだけを確認済みとして述べ、推定または未確認のsourceは区別する。

### credential不足の事前表示

- 選択中root routeのauth profileに対応するfixed credential pathをWorker内で確認する。file bytesやtoken値は
  読まず、`present`、`missing`、`unknown`の非秘密な結果だけをHostへ渡す。
- `missing`の場合、idle footer第一行で`ready`の後ろへ独立segmentとして置く。狭幅ではslash候補や
  context詳細より`credential missing`を優先して残す。

```text
> [ready │ credential missing: openai]
```

- 起動、Session resume、新しいprovider選択がWorkerへ反映された時点で再判定する。file watcherや同一routeの
  実行中の自動再読込は行わない。
- `present`をprovider認証済みとは扱わず表示もしない。file metadata・内容の不正やproviderによるkey拒否は、
  現行のrequest-time validationとfailure経路で区別する。
- missingでもtask admissionを新たに拒否せず、retry、fallback、credential登録は追加しない。

### slash command候補表示

- raw editor textの先頭が`/`の場合だけ、built-in command文字列をcase-sensitiveな前方一致で絞り込む。
- `/`では全候補、`/h`では`/help`と`/history export`、`/history`では`/history export`を表示する。
  一致しない場合は候補を表示しない。
- 候補のlabelは`cmds:`とする。idleでは`ready`の直後、busyでは既存statusと`Esc cancel`の後ろへ置く。

```text
> [ready │ cmds: /help, /sessions, /provider, /model, /effort, /history export, /recover, /exit]
> [busy │ pending active_task:44B │ Esc cancel │ cmds: /provider]
```

- busy中も候補を表示する。`Esc cancel`は候補より前に保ち、狭幅ではslash候補を`Esc cancel`より先に省略する。
- 候補表示はeditorを変更しない。Tab補完、候補選択、確定key、modalは追加しない。既存Tab path補完も
  変更しない。
- parser、候補生成、unknown-command案内は同じcommand一覧を使う。

## 実装計画

1. Henji共通instruction componentへsource準拠動作を追加し、defaultとplannerおよび両provider wire mappingで
   同じresolved instructionが使われることを維持する。
2. Worker-local physical I/Oへcredential file presence確認を加え、現在のroot auth profileの結果を`ready`と
   `model_selected`のdata-only messageでHostへ返す。Worker Host sessionとPresentation adapterは値を保持・投影
   するがcredential materialを扱わない。
3. TUIのready statusへ`credential missing`を統合し、起動・resume・provider変更後のroot selectionに追随する。
4. slash command一覧と前方一致関数を一か所へ集約し、controllerからeditor変更時の候補をUI stateへ渡す。
5. footer layoutでidle候補をprimary status直後、busy候補を`Esc cancel`の後ろへ置き、busy時の
   `Esc cancel`を候補より高い表示優先度にする。
6. focused product test、type check、format、lint、`git diff --check`と差分reviewを行い、stable candidateで
   authoritative `v0:gate`を実行する。
7. 実装結果を本書へ記録し、承認済み範囲でroadmap F01・F06の実装状態を更新する。

## Product確認

| 動作 | 確認方法 |
| --- | --- |
| current sourceに準拠する共通instruction | default/plannerのresolved instructionとOpenRouter/OpenAI wire mappingを確認 |
| request前にroot credential不足が分かる | Workerのpresence結果と起動・route変更後のfooter statusを確認 |
| credentialを認証済みと誤表示しない | `present`ではstatusを出さず、内容やprovider responseをprobeしないことを確認 |
| slash候補が逐次絞り込まれる | `/`、`/h`、`/history`、不一致、通常textをcontroller経路で確認 |
| busy中も候補とcancelを読める | `busy │ pending active_task:44B │ Esc cancel │ cmds: /provider`と狭幅でcancelが先に残ることを確認 |
| 入力を補完しない | 候補表示前後でeditor textとcursorが変化しないことを確認 |

## 実装結果

- Henji共通instructionへsource準拠の変換・要約・照合・tracked file境界・確認済みsourceの区別を追加した。
  defaultとplannerは同じcomponentを受け、OpenRouter system messageとOpenAI Responses instructionsへ同じ
  resolved本文を渡す。
- Worker-local credential presence probeを追加した。tokenをopenまたはdecodeせず、root auth profileと
  `present` / `missing` / `unknown`だけをcurrent `ready`・`model_selected` messageでHostへ渡す。
  Host session、Presentation adapter、TUIはこのsnapshotを引き継ぎ、`missing`だけをfooterへ表示する。
- startup表示は、file presenceを起動時に確認し、credential値はprovider request直前に検証する区別へ更新した。
- slash commandの文字列とsemantic commandを一つの定義一覧へ集約した。controllerはeditor変更後にraw prefixの
  候補をUI-local stateへ渡し、layoutがidleでは`ready`直後、busyでは`Esc cancel`の後ろへ`cmds:`として表示する。
  候補表示による入力変更はない。
- footerはslash候補、credential警告、既存status詳細を別segmentとして扱う。busy時は候補を先に省略して
  `Esc cancel`を残し、長いSession/context statusでは候補やcontext詳細よりcredential警告を優先する。
- 通常利用メモから採用済みのsource準拠instruction、credential不足表示、slash候補表示を移した。
  未採用のslash候補選択・補完とHenji内credential登録は通常利用メモに残した。
- 承認済み範囲でroadmap F01・F06へ実装状態を追記した。構想とarchitectureは変更していない。

## 検証結果

- focused testは、instruction composition/provider mapping、credential presenceのno-open判定、
  Worker `ready`・`model_selected` propagation、起動・provider変更後のcredential status、slash prefix、
  idle/busy footer、狭幅優先度、no-completionを確認して成功した。
- focused Worker foundation 40 testが成功した。
- type check、format 195 files、lint 192 files、`git diff --check`が成功した。
- authoritative `v0:gate`は、初回に旧shapeのIncrement 13 mock Workerを検出した。current
  `ready` contractへmockを更新してfocused testを通した後、具体的理由による再実行で全133 testが成功した。
- その後、利用者指定でfooter区切りを`│`へ変更し、busy候補を`Esc cancel`の後ろへ移してlabelを`cmds:`へ
  短縮した。希望された完全表示を含むretained TUI focused 17 testが成功した。production codeのpost-gate変更を
  具体的理由としてauthoritative `v0:gate`を再実行し、check、format 195 files、lint 192 files、全133 testが
  成功した。
- automated verificationではprovider request、credential値のread、real-TTY E2Eを実行していない。
  production retained TUIの表示は利用者のHuman Gateで確認した。

## 対象外

- slash commandのTab補完、候補選択、確定key、modal、fuzzy match
- providerへの認証probe、API keyの有効性判定、credential登録・更新・削除command
- credential file watcher、background polling、別routeへのfallback
- plannerや`web_search`等、現在選択中root route以外のcredential一覧表示
- `/reload`、Session title、assistant本文renderingの変更
- instruction componentのrevision化、候補生成、自己改定、rollback
- 構想またはarchitecture正本の変更

## Human Gate

利用者は2026-09-10、source準拠のHenji共通instruction、選択中providerのcredential file不足の事前表示、
slash command候補のfooter第一行への表示をIncrement 20として同時に実装する方針を選んだ。slash commandの
補完はまだ不要とし、候補表示だけに限定した。候補は`ready`または`busy`の直後、busy時の`Esc cancel`は
候補の後ろへ表示し、狭幅では候補よりcancelを優先する修正版の初期計画と、roadmapへの実装状態追記を
明示承認した。

local実装とauthoritative gateの完了後、利用者がproduction retained TUIでcredential不足表示、idle/busy中の
slash候補、busy時の`Esc cancel`を目視確認した。

利用者は同日、footer第一行のsegment区切りにMIDDLE DOTではなく`│`を使うことを選択した。OpenAI credential
fileを一時退避したproduction retained TUIで`[ready │ credential missing: openai]`が表示されることを確認した。

利用者は同日、busy footerの候補を`busy`直後ではなく既存statusと`Esc cancel`の後ろへ置き、labelを
`commands:`から`cmds:`へ短縮するよう変更した。目視確認例は
`[busy │ pending active_task:44B │ Esc cancel │ cmds: /provider]`である。

利用者は同日、production retained TUIでidle/busy中のslash候補、busy時のpending statusと`Esc cancel`、
末尾の`cmds: /provider`を目視確認し、Increment 20を完了と判断した。
