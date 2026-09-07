# 通常利用 increment 5 — conversation label識別とbash全出力readback

ステータス: 完了。local実装、focused verification、implementation review、authoritative offline gate、
production retained TUI human gate、ユーザー受入を2026-09-07に完了。

## この文書の位置付け

この文書は通常利用increment 5の確定scopeとreview済み初期実装計画の正本である。ここに定めた利用者動作、
対象外、成功条件を変えず、現行sourceと実行証拠から実装境界と検証方法を具体化している。

## 確定したproduct scope

1. production retained TUIのconversation logで、`tool>` labelをstandard green（SGR 32）として表示する。
2. Host-local noticeの`system>` labelをpink系のstandard magenta（SGR 35）として表示する。
3. `bash` toolが現在のbounded resultを超えるstdoutまたはstderrを切り捨てる場合も、切り捨て前の全出力を
   保持し、modelが後続のtool callで読み返せるようにする。modelは同じcommandを再実行したり、出力範囲を
   変えるためだけに別commandへ組み替えたりせず、保存上限内の結果を最後まで取得できる。Host-owned上限に
   到達した場合はcommandを停止し、完全出力ではないことを明示する。

## 根拠となる通常利用

- increment 4で`user>`をblue、`assistant>`をyellowにした後、無着色の`tool>`も識別色を付けたいという
  利用者要望が得られ、greenが選ばれた。
- `/history export`成功時のHost-local `system>` noticeにも識別色が必要という利用者要望が得られ、pink系の
  standard magentaが選ばれた。
- Forgejo API文書の調査では12回の`bash` call中4回でstdoutが切り捨てられ、modelは範囲を変えた取得commandを
  繰り返した。保存済みの全出力を後続callで読めれば、同じ外部取得や加工を繰り返さず調査を継続できる。
- 無制限の完全出力保存は、`yes`のようなcommandが最大120秒のtimeoutまで高速に出力し、temporary filesystemを
  枯渇させて環境を破壊する具体的な経路になる。利用者判断により、readbackよりHost-owned保存上限を優先する。

## 対象外

- assistant本文のMarkdown renderer。現時点では必要性を強く感じないという利用者判断により保留する。
- `web_search`。increment 6候補として通常利用inboxに残し、increment 5には含めない。
- `web_open`。人間にはbrowserがあるため現時点の候補に含めない。
- package導入制限、sandboxed Deno program tool、permission ceiling、tool componentの自己改訂。
- search provider、外部API、追加credential、外部service契約。

## scope確定時に残した設計事項

- labelだけへ色を適用して本文とlayoutを変えない描画境界、wrap時のlabel断片、SGR resetとframe byte上限。
- `bash`のstdoutとstderrを完全に保持する書込み先、result identity、model向けreadback interface、複数call間の
  対応付け、Session・Worker・processをまたぐlifetime。
- command完了、timeout、cancel、captureまたは保存失敗時に、取得済み出力とreadback可否をmodelへ伝える
  contract。
- 現行の短いTUI tool activity、canonical transcript、history exportへ何を保持し、全出力本体をどこから
  参照するか。

これらは確定scopeを成立させる実装判断であり、以下の計画では現行source、既存state root、Pi・Zotの
参照実装を確認して具体化した。ユーザーが計画を承認した後に実装する。

## 現行実装と参照実装から確認した事実

- conversation entryは`v0/tui/conversation_renderer.ts`でplain textと任意の`labelTone`へ投影され、
  `v0/tui/layout.ts`がwrap後のlabel断片長を保持し、`v0/tui/render.ts`だけがterminal frameへSGRを加える。
  現在は`user>`とsettled `assistant>`だけをtoneへ対応付け、standard blue（SGR 34）とstandard yellow
  （SGR 33）で表示している。Host-local noticeは既に`kind: system`、`label: system>`、tool activityは
  `kind: tool`、`label: tool>`として同じplain projectionを通る。
- 現行`bash`は`v0/agent/work_tools.ts`でstdoutとstderrを別々にdrainするが、各streamの先頭4,096 bytesだけを
  保持する。resultはそのprefix、exit status、timeout、stream別truncation flagをJSONでmodelへ返す。capを
  超えた残りはdrainして捨てるため、後続callから取得するidentityやstorageは存在しない。
- built-in default Definitionは`tool:bash`を宣言し、Registryが宣言済みtoolをmaterializeする。tool追加は
  `agent_definition.ts`、`registries.ts`、`resource_identity.ts`のbuilt-in topologyを同じ集合へ更新する必要が
  ある。plannerは`bash`を持たず、今回もbash readbackを持たせる根拠はない。
- production TUI launcherはworkspaceとworkspace別state rootへのread/writeを許可するが、`/tmp`は許可して
  いない。一方、work-tool sentinelは既に`/tmp`をtest artifact用に許可している。
- pinned Piのbash toolはbounded tailをmodelへ返し、truncation時だけ完全出力をtemporary fileへ保存して
  pathを案内する。Henjiの`read`はworkspace内fileだけを対象とするため、そのpathをそのまま`read`へ渡す
  方式は採れない。Zotには今回のstdout/stderr完全出力readbackに直接対応する契約は確認できなかった。
- このincrementは外部service contractを変更せず、provider、credential、networkの確認を計画根拠に
  必要としない。

## このincrementで成立させるproduct動作

### 1. conversation label

1. production retained TUIの`tool>` labelをstandard green（SGR 32）、Host-local `system>` labelをstandard
   magenta（SGR 35）で表示する。
2. 色は各label文字だけへ適用し、直後にSGR resetする。tool command preview、notice本文、空白、他label、
   input、footerへ色を漏らさない。
3. `LayoutRow.text`、Presentation event、canonical transcript、history exportはplain textのままとし、既存の
   wrap、cell幅、viewport anchor、frame byte上限を変えない。狭幅でlabelが分割された場合も、そのrowに
   含まれるlabel断片だけを同じtoneで着色する。
4. `assistant~`を含む既存の非対象labelとnon-retained rendererの表示は変更しない。

### 2. bash全出力の保持とreadback

1. 現行`bash`の実行input（`command`必須、`timeoutMs`任意）、4,096-byteのstream別bounded prefix、
   stdout/stderr分離、exit/signal/timeout/cancel semanticsを維持する。
2. stdoutまたはstderrがbounded prefixを超えたcommandだけ、切り捨て前のmodel-visible UTF-8 textをstream別に
   保存する。subprocess pipeは従来どおり同時にdrainし、保存writeをsettleさせてからtool resultを返す。
3. `bash` resultへ一つのopaque `outputId`、保存したstream名と総byte数、後続callがそのまま使える
   `bash_output` readback案内を加える。保存上限到達時にcurrent commandのtextを一byteもstoreへ追加できない
   場合はidentityを偽らず省略する。truncationがない場合もidentityや案内を加えず、現行の短いresultを保つ。
4. built-in default parentへ非terminal tool `bash_output`を追加する。inputは`outputId`、`stream`（`stdout`か
   `stderr`）、任意の`offset`と`limit`とする。`offset`は保存済みUTF-8 textの0-based byte offset、`limit`は
   一callで返す最大byte数である。`limit`は4以上49,152以下の整数、既定49,152 bytesとし、1から3または
   上限超過はinput errorにする。省略時は`offset=0`と既定windowを使う。この下限により、次のUTF-8 scalarが
   4 bytesでも上限内で一つ以上返してoffsetを進められる。
5. `bash_output`はJSONで`outputId`、`stream`、`offset`、text、`nextOffset`、`complete`、総byte数を返す。
   window末尾をUTF-8 scalarの途中にせず、続きがあればexact `nextOffset`を返す。巨大な一行でもline単位の
   拒否をせず、案内されたoffsetを繰り返せば最後まで再構成できる。
6. `outputId`は同じRegistry内の一つの`bash` callだけを指し、異なるcallのstdout/stderrを混同しない。
   存在しないidentity、保存していないstream、範囲外またはUTF-8境界でないoffsetは、commandを実行せず
   明示的なtool input/result errorにする。
7. Registryが所有する一つのstoreを`bash`と`bash_output`で共有する。storeはRegistry全体で一つだけの
   owner-only temporary fileをread/writeでopenし、直後にdirectory entryをunlinkする。全commandの全streamを
   この一つのhandleへappendする。subprocessの小さいchunkをそのままindex化せず、各active streamのtextを
   64 KiB segmentまでmemoryでcoalesceしてからappendし、`outputId + stream`ごとにsegmentのfile offsetとlengthを
   memory indexへ記録する。output identityやstream数が増えてもopen handle数は一つから増やさない。
8. 保存内容はstdout/stderrのmodel-visible text projectionである。chunk境界をまたぐUTF-8はstreaming decoderで
   一つのscalarとして保存し、不正なbyte列は現行の非fatal `TextDecoder`と同じreplacement textとして扱う。
   raw binary archiveは提供しない。
9. Host-owned保存上限はmodel-visible UTF-8 textで、stdoutとstderrを合算した一commandあたり32 MiB、同じ
   Registry内でactive bufferまたはreadback用spoolへ保持する全command合計128 MiB、retained stream record
   4,096件とする。segmentは64 KiB固定で、最後のpartial segmentだけ短くできる。この組合せにより、memory上の
   extentは最大6,144件（128 MiB分のfull segment 2,048件と各retained streamのpartial segment最大4,096件）に
   収める。上限値はmodelやtool argument、environment variableから変更できない。
10. 既存保持分を自動削除・上書きせず、新しいcommandの出力がcommand byte、Registry byte、retained streamの
    いずれかの残量を超える最初のchunkで、そのchunkの上限内かつUTF-8 scalar境界までのprefixを保存してcurrent
    commandを停止する。storeはstdout/stderr双方の入力前に同じmutex内でcommand残量、Registry残量、stream
    record slotをreserveし、そのcritical sectionでsegment buffer、shared handleへのflush、extent/accountingを
    更新する。同時drainや複数bash callがinterleaveしても各上限を超えない。buffer済みbyteもRegistry 128 MiBへ
    一度だけ算入し、file flush時に二重加算しない。
11. 保存上限到達時は既存のSIGTERM/SIGKILL settlement経路でchildを停止し、`bash` resultへ
    `outputLimitExceeded: true`、`outputComplete: false`、適用したcommand/runtime limit、保存済みstreamと
    byte数、`command_bytes` / `registry_bytes` / `retained_streams`の到達理由、保存recordがある場合だけreadback
    identityを返す。これはtimeoutや通常のexitと区別し、完全出力と偽らず、同じcommandの自動retryも行わない。
    上限まで保存したtextは`bash_output`で最後まで読める。
12. 各streamは最初の4,096-byte bounded prefixだけをmemoryに置き、capを超えた時点でそのprefixと後続textを
    spoolへ移す。command完了時にbounded内へ収まったstreamはspool extentを作らない。timeout後も通常の`bash`
    resultを返せる場合は取得済み完全出力を同じ契約で読める。user cancellationはturn自体がtool resultを
    返さない既存契約を維持し、readback identityを公開しない。
13. truncationが起きたstreamのcreate/write/finalizeに失敗した場合、完全出力を読めると偽らない。既存の
    bounded stdout/stderrとcommand statusを含む明示的な`bash output persistence failed` errorをmodelへ返し、
    commandの再実行を自動では行わない。
14. `bash_output`のdescriptionとactive tool guidelineには、`bash` resultの案内されたidentity、stream、
    `nextOffset`を使うことを記す。provider向けToolDefinitionへ内部pathやstore objectを含めない。

### 3. transcript、TUI、historyとの関係

1. canonical transcriptには従来どおりmodel-visibleなbounded `bash` resultと、modelが実際に要求した
   `bash_output` call/resultだけを保存する。temporary file本体をSession schema、Worker protocol、
   Presentation eventへ複製しない。
2. TUIの短いtool activityは`bash <command head>`と`bash_output`のtool名・settlementだけを表示し、完全出力を
   通常logへ自動展開しない。どちらの`tool>` labelにも同じgreenを使う。
3. history exportはcanonical transcriptを正本とする既存契約を維持するため、bounded `bash` resultと実際に
   読み返したwindowを出力する。未読のtemporary file本体を暗黙に埋め込まない。

## 決定済みの実装境界

- `ConversationLabelTone`へ`tool`と`system`を加え、`projectConversationEntry()`でexact labelをtoneへ対応付ける。
  `renderLayoutRow()`はtone-to-SGR tableを使い、terminal constantにSGR 32と35だけを追加する。layoutのwrap
  algorithmやentry stateは変更しない。
- bash captureとreadback storageは`v0/agent/bash_output.ts`へ分離し、store interface、Deno temporary-file
  implementation、UTF-8 window projectionを置く。`v0/agent/work_tools.ts`はprocess execution、bounded prefix、
  result組立てを所有する。
- `createWorkTools()`と宣言型Registry materializationは、一つのstore instanceから`bash`と`bash_output`を
  pairで作る。planner registryには両方を追加しない。`createBashTool()`を直接使う既存test seamは明示storeを
  注入できる形にし、production defaultとtestが別contractにならないようにする。
- production one-shot、TUI、Worker、work-tool sentinelが同じtemporary storeを作れるよう、既存launcher/taskの
  Deno read/write permissionへexact temporary rootを追加する。workspace write、state root、provider、credential
  permissionは変更しない。Registry storeは一つのtemporary fileをopen直後にunlinkし、単一handle、mutex、
  64 KiB segment buffer、opaque identityごとのbounded extent index、command/runtime byte・stream record使用量を
  所有する。readbackも同じmutex内でextentをseek/readし、appendのfile positionやaccountingと競合させない。
- built-in defaultのcapability resourceへ`tool:bash_output`を追加し、Definition declaration、materializer、
  topology validator、resolved manifest期待値を一致させる。既存`tool:bash`のidentityとinput schemaは変更
  しない。
- temporary outputのprocess終了後の列挙、再接続、manual cleanup UI、上限値の設定化、rotation、Session
  delete連動は対象外とする。identityは現在のagent runtime中の後続callに有効とし、process再起動、Session
  resume、別Worker generationをまたぐdurabilityは契約しない。

## 実装対象

1. TUI label:
   `v0/tui/conversation_renderer.ts`、`v0/tui/render.ts`、`v0/tui/terminal.ts`、
   `tests/v0/tui_conversation_presentation_test.ts`。
2. bash storeとtools:
   new `v0/agent/bash_output.ts`、`v0/agent/work_tools.ts`、`v0/agent/registries.ts`、
   `v0/agent/tools.ts`（active guidelineを置く場合だけ）、new `tests/v0/increment_5_bash_output_test.ts`。
3. capability topologyとproduction wiring:
   `v0/agent/agent_definition.ts`、`v0/agent/resource_identity.ts`、必要な`worker_agent_api.ts`または
   `runtime.ts`のstore注入、`deno.v0.json`、`v0/agent/session_launcher.sh`、関連するcurrent/Worker/sentinel test。
4. 現在形の文書:
   `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、
   new `docs/increments/increment-5-results.md`、`.handoff/handoff.md`。

実装時のsource inspectionで上記以外の既存consumerに機械的なtool集合期待値が見つかった場合は、確定した
tool集合との整合だけを同じscopeで更新する。新しいproduct動作や外部contractが必要なら計画変更として
ユーザーへ戻す。

## 実装順序

1. label toneとterminal SGR mappingを拡張し、plain layoutと既存色を保ったままgreen/magentaを接続する。
2. single-handle temporary-file storeとUTF-8 byte windowのpure/read-only境界を作り、64 KiB segmentのbounded
   extent列から同一streamを複数windowで完全に再構成できるようにする。open直後のunlink、mutex、command・
   Registry byteとretained stream slotのreservationもこの境界で実装する。
3. `bash` captureをstoreへspoolし、truncation時のbounded resultへopaque identityとreadback案内を加える。
   保存上限到達はchild停止へ接続し、partial readbackと不完全状態を明示する。
4. `bash_output` toolを同じstoreへ接続し、built-in default Definition、Registry、resource topologyへ追加する。
5. production launcher/taskのtemporary root permissionと、影響を受けるtool集合・permission期待値を更新する。
6. 変更したproduct動作に対応するfocused test、type check、format、lint、`git diff --check`を実行する。
7. stable candidateを独立reviewへ渡し、accepted findingがあれば一回の局所修正とchanged-lines re-reviewを
   行う。その後、coordinating ownerがauthoritative `v0:gate`を一回だけ実行する。
8. results、architecture、roadmap、handoffを実測した現在形へ更新し、production TUI human gateへ渡す。

## 検証と受入れ

各確認は次の具体的なproduct動作に対応させる。test件数自体は完了条件にしない。

- label projection: layout snapshotはESCを含まず、retained frameでは`tool>`だけがSGR 32、`system>`だけが
  SGR 35で囲まれ、直後にresetされる。本文、他label、狭幅wrap、frame byte admissionは既存semanticsを保つ。
- bounded compatibility: 4,096 bytes以内のstdout/stderr、nonzero exit、signalなしの通常完了は、余分な
  output identityなしで現行JSON fieldと値を保つ。
- full readback: stdoutのみ、stderrのみ、両方がcapを超えるcommandについて、最初の`bash` resultはboundedで、
  案内された`bash_output` callを`nextOffset`がnullになるまで行うと保存前のmodel-visible textと一致する。
  ASCII、multi-byte Unicode、改行なしの長い一行を含める。4-byte scalarを先頭に置いた`limit=4`は一つ以上
  返して進み、`limit=1`から`3`と49,153以上はcommandを実行せずinput errorになる。
- identity: 二つのcommand resultを交互に読む場合も内容が混ざらず、unknown identityや保存対象外streamで
  commandが再実行されない。
- lifecycle: timeout後に取得済みtruncated streamを読める。cancelled turnは既存どおりtool resultをcommitせず、
  subprocess、pipe、temporary writerのsettlement後に終了する。
- storage bound: stdout/stderr合計が32 MiBを1 byte超えるcommandは一回だけ停止され、resultが32 MiB limitと
  incomplete状態を示し、保存済みtextを末尾まで読める。複数commandを交互に保持して128 MiBへ到達した場合も
  既存identityを壊さずcurrent commandを停止する。command/runtime上限はtool argumentやenvironmentから変更
  できない。stdout/stderr chunkと複数bash callを意図的にinterleaveしてもexact合算上限を超えず、保存順と
  stream内容を保つ。temporary pathは作成直後からnamespaceに存在せず、handle closeまたはprocess終了で容量を
  回収する。
- storage handle: 4,096 bytesを少し超える異なるoutput identityを多数保持しても、storeのopen file handle数は
  一つのまま増えず、各identity/streamのwindowが正しいextentだけを読む。
- storage index: 1-byte程度のstdout/stderr chunkを大量にinterleaveしても64 KiB segmentへcoalesceされ、
  retained stream 4,096件到達時はcurrent commandを明示停止する。memory上のextent数は計画上限6,144を超えず、
  bufferとspoolの合計byte accounting、各streamの再構成結果が一致する。
- persistence failure: injected store failureで完全出力を利用可能と報告せず、bounded出力とstatusを伴う
  明示errorになり、暗黙retryや二回目のsubprocess実行がない。
- composition: default parentのprovider tool definitionsとresource manifestは`bash`と`bash_output`を一度ずつ
  含み、plannerはどちらも含まない。active guidelineは有効toolがあるcompositionだけへ一度合成される。
- production permission: exact launcher commandのreadbackでtemporary rootだけが追加され、workspace、state、
  credential、network、run permissionの既存値が変わらない。

focused verificationは新しいbash-output suite、TUI conversation suite、tool/Definition topologyの直接testを
先に使い、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。review前に`v0:test`や`v0:gate`を
繰り返さず、review後のstable candidateへ`v0:gate`を一回だけ実行する。

機械確認とimplementation reviewがGOになった後も、production/provider/credentialを使うhuman gateは自動で
実行しない。ユーザーの別の明示承認後、production retained TUIで次を一回確認する。

1. `user>` blue、`assistant>` yellowに加え、`tool>`がgreen、`system>`がmagentaで、各本文が無着色である。
2. 4,096 bytesを超えるstdoutとmulti-byte textを出す一つの`bash` taskを依頼し、modelがresultの案内から
   `bash_output`を必要回数呼んで末尾まで読み、既知の末尾markerと形式を正しく報告する。
3. 同じcommandの再実行や、`sed`、`tail`など出力範囲を変える代替commandが増えていないことをcanonical
   Session transcriptで確認する。

32 MiB/128 MiB上限とunlink済みfileの回収はproviderを使わないfocused testで確認し、production human gateで
大量出力を実際に生成しない。

## Review contractとHuman Gate

初期計画reviewはこの文書、確定scope、上記の現行sourceとpinned Pi/Zotの関連箇所だけを対象にする。目的は、
三つの利用者動作をproduction経路で成立させる計画として、実装境界、既存contractとの整合、回帰経路、
検証可能性に具体的な欠落がないか確認することである。一般的なsecurity hardening、未観測variant、将来の
F24、Web search、Markdownはreview対象外とする。

- initial review: read-only、30分以内。10分間新しい証拠・tool結果・中間結論がなければ確認済み範囲を返す。
- severity: Blocker / P1 / P2。findingは明示scopeまたは確認済みsourceから利用者影響までの経路を示す。
- findingを反映した場合のre-review: changed linesと既存finding closureだけ、15分以内、最大一回。
- plan GO: 未解決Blocker/P1/P2がなく、scope、実装対象、依存順、product test、human gate、対象外が一意である。

計画review GO後は初期implementation Human Gateで停止する。この計画に対するユーザーの明示承認前に、
product source/test/configの変更、test実行、production/provider/credential操作を行わない。承認後はlocal実装、
focused verification、bounded implementation review、authoritative offline gate、results/architecture/roadmap/handoff
更新までを継続できる。production human gate、commit、push、tag、publish、releaseは別の明示指示を必要とする。

## Plan review結果

- 初回review対象のSHA-256は
  `14311bf1079a18628dde54b3d19f94d2131383831efa00e214d24419df7804c5`。DispositionはNO-GO、Blocker 0、
  P1 0、P2 1だった。
- P2は、`bash_output.limit=1`から`3`と次の2から4-byte UTF-8 scalarについて、byte上限、scalar非分断、
  `nextOffset`による前進を同時に満たせない契約だった。`limit`を4以上49,152以下、既定49,152 bytesとし、
  範囲外をinput errorにする計画へ修正した。
- 修正後のreview対象SHA-256は
  `bff602ffc1058a032bdbf0e69d91ed22a5d6b0c5f8710e6a914deb1d268ae752`。一回のchanged-lines re-reviewはGOで、
  既存P2はClosed、未解決Blocker/P1/P2は0だった。
- reviewerはread-onlyで、test、full gate、product source/config変更を行っていない。
- その後、利用者が無制限保存の環境破壊riskを指摘し、Host-owned上限の追加を承認した。1 command 64 MiB、
  1 Registry 256 MiB、上限到達時のcurrent command停止とpartial readback、open直後にunlinkするtemporary file
  lifecycleをplan deltaとして追加した。focused delta reviewは、streamごとのfile handleをRegistry lifetime中
  保持すると約1,000件、約4 MiBでこのVMのopen-file上限1024へ達し、byte上限より先に`bash`を利用不能にする
  P1を検出した。Registry-wide single spool handleへ修正してhandle P1は閉じたが、chunkごとのextentがbyte上限
  より先にmemoryを枯渇させ得る新しいP1がre-reviewで見つかった。64 KiB segment coalescing、retained stream
  4,096件、extent最大8,192件、mutex内のatomic reservationへ修正し、この新P1のclosureを確認してから
  implementation Human Gateへ戻ることとした。
- 保存上限deltaの最終review対象SHA-256は
  `490161380c23c1b92fe6b34340873cb1bc8f7edb21fc5b86c7d0faf503253594`。追加closure reviewはGOで、handle
  P1とextent-index P1はClosed、未解決Blocker/P1/P2は0だった。reviewerはfileを変更せず、test/gateも
  実行していない。
- その後、保存対象は元fileの複製ではなく、一過性のstdout/stderrをcontinuationで読み返すための
  snapshotであることをユーザーと確認した。この利用目的に対して64 MiB/256 MiBは余裕が大きいと判断し、
  ユーザー決定で1 command 32 MiB、1 Registry 128 MiBへ変更した。これに伴い64 KiB segmentの
  full segment最大数は2,048件、partial segmentを合わせたextent最大数は6,144件となる。
- 上限値変更後のfocused delta review対象SHA-256は
  `32cb90b58fbebf6aa662a03262515d045311381553c7318ca9c618b7446a99e2`。reviewはGOで、算術、mutex/accounting、
  first-excess stop、partial readback、result semantics、storage-bound verificationの整合を確認し、
  未解決Blocker/P1/P2は0だった。reviewerはfileを変更せず、test/gateも実行していない。
