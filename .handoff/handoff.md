# Handoff

## Records

### Increment 32以降 — standalone配布とmanaged externalization

- 状態: Increment 32はstandalone配布まで完了済みである。Increment 33は承認済み個別計画のSlice A〜Dを実装し、
  managed Agent Definitionのinstall/list/inspect、exact revision selectionとSession binding、managed closureの共通Worker
  実行、parent/planner、same-identity tool replacement、failure readbackを成立させた。focused test 11件と、一回だけの
  authoritative `v0:gate`（計165 test）が成功した。standalone binaryの隔離production受入では、元source path不在の
  旧revision、編集後の新revision、planner real-TTY turn、別processのexact Session再開、実provider turnとexact
  attribution、破損/API非互換時のno-fallbackを確認した。実装・検証結果はIncrement 33正本へ保存済みであり、
  利用者がIncrement 33の完了を確認した。JSR packageをpre-release `0.1.0-alpha.6`からstable `0.1.0`へ更新し、
  release candidateのauthoritative `v0:gate`一回、clean worktreeでのJSR dry-run、main push、publish、registry metadata、
  exact version importがすべて成功した。JSRのlatestは`@henji/harness@0.1.0`である。利用者は当面の実装順を
  Increment 34 Definition transport、Increment 35 TUI `/new`、Increment 37 外部情報調査時のtool選択instruction改善と
  決めた。Increment 34の承認済みSlice A〜Cは実装・検証済みである。portable transport/store、unified CLIのexact
  export/import、atomic no-clobber artifact publish、未知API contractのcustody readbackと実行時拒否、source不在の
  parent/planner exact実行が成立した。focused test 6件、Increment 33 regression 11件、一回のauthoritative `v0:gate`
  （全171 test）が成功した。compiled binaryのDenoなし・二XDG root production受入では実provider parent turn、real-TTY
  planner turn、Session/execution/evidenceのbuild・exact ref相関、byte-identical re-exportを確認した。利用者が
  Increment 34の完了を確認した。Increment 35は承認済み
  Slice A〜Bの実装・検証が完了した。production TUIの`/new`によるdurable empty Session作成とbinding
  replacement、exact Definitionとroot selectionの継承、busy/no-session/failure時の挙動、provider非介入を確認し、
  authoritative `v0:gate`とstandalone real-TTY受入も成功した。結果はIncrement 35正本へ保存済みで、
  利用者が完了を確認した。Increment 37は利用者が初期計画を承認し、Slice Aのactive `web_search`
  guideline変更とdeterministic verificationが完了した。一回のauthoritative `v0:gate`は全176 test成功済みである。
  Slice Bのproduction retained TUI Human Gateを一回実行したが、配送済みの新guidelineと利用可能な`web_search`が
  ある状態でも、最初に`bash`でworkspace remoteとhandoffを探索し、全10 tool callが`bash`、`web_search`は0だった。
  最終回答は公式Forgejo APIからidentity、取得時刻、並び順、直接linkを提示したが、local target未指定のtaskを
  current remoteへ結び付けており受入条件は未達である。credential値の露出はなかったが、不要なconfig名と環境変数名の
  探索も観測した。利用者はこれをrepository contextの与え方として別途検討し、Human Gate未達を結果として保持したまま
  Increment 37を完了とした。未採用のcontext配送候補は通常利用メモへ分離済みである。Increment 34・35・37の変更は
  local mainへcommit済みであり、未pushである。その後、Increment 32時点のinstalled binaryが同じcheckoutにある後続sourceを
  runtime importし、compile時より新しい`@deno/graph`を解決できず別workspaceから起動失敗する不具合を実測した。runtime
  graphをephemeral staging treeからrelative importしてcompileするよう修正し、focused test 7件、対象type check、format、
  `git diff --check`、別workspaceでのversion/runtime/module readback、隔離XDG stateでのreal-TTY TUI起動が成功した。build ID
  `a0ba65035114e869a451c74a6198ee4e9286211aa6c05614fd29e72e60a6ddb5`のartifactへ`dist/henji`と
  `~/.local/bin/henji`をatomicに置換した。続く通常利用で、tool完了後のfinal assistant responseがstreaming中だけtool行より
  上に表示され、settle時に下へ移る不自然な順序変更を観測した。active tool完了後の最初の`assistant_progress`でassistant
  entryをtool行の後ろへ移すよう修正し、conversation presentation 13件、対象type check、format、lint、
  `git diff --check`が成功した。二つの修正と結果文書はlocal mainのcode commit `91e091b6`へcommit済みである。同commitから
  clean buildしたbuild ID `f8fb18486d0d54e45e936329c1a58de509a07d794324d23e46d19c894bc9ddc8`のartifactへ
  `dist/henji`と`~/.local/bin/henji`を再びatomicに置換済みであり、未pushである。
  利用者は停止したexecutionの観測済み情報を次turnへ明示的に引き継ぐcommand名を`/recall`と決定した。
  Increment 38は承認済みSlice A〜Cの実装、focused検証、一回のauthoritative `v0:gate`（全187 test）、isolated
  standalone real-TTY Human Gate、差分reviewまで完了した。source uncommitted executionの保存情報を次taskだけへ投影し、
  source非commit・no replay・targetだけのatomic commitをproduction経路で確認した。結果はIncrement 38正本へ保存済みで、
  変更は未commitである。受入中に観測したreal provider Esc cancelの
  `cancellation cleanup failed`誤分類は、承認済みIncrement 39で修正した。terminalなread rejectionで二重cancelせず、
  真のcleanup failureはartifact保存後にWorkerをunavailableにする。focused検証と一回のauthoritative `v0:gate`
  （全192 test）が成功し、isolated real-TTY/OpenRouter Human GateでEscが`cancelled`、同じSessionの次turnが
  `committed`になることを確認した。通常利用メモは未採用候補16件の一覧と「観測・候補・再検討条件」へ
  整理し、agent loop/durable stateとexternalizationの長い比較証拠をresearch文書へ分離した。
  その後の利用者との議論とGPT-6 Astra xhighのreviewを受け、自己改訂を支えつつ独立した価値を持つ
  atomic history、canonical/non-canonical execution、human history viewとmodel projection、execution context
  attribution、`/recall`と未実装`/rebuild`の境界を構想・architecture・roadmapへ反映した。詳細な議論と
  SQLite設計前の未決事項はroadmap inputへ分離し、通常利用メモの`/reload`候補を`/rebuild`へ更新した。
  その後、現行source、導入済みDeno/SQLite、Forge/OpenCode/Prime Agentの参照実装を調査し、独立reviewの
  P1 4件・P2 2件を反映した全体programを利用者が採用した。workspace-local SQLiteを正本とし、Increment 40の
  canonical history cutover、41のlive execution journal、42のexact context attribution、43のhuman history viewの
  順で進める。bounded re-reviewに未解決findingはなかった。`/rebuild`は40〜43から分離し、Increment 44以降で
  対象resourceから判断する。architectureは変更していない。全体programは`b41346ab`へcommit済みである。
  利用者はIncrement 40を過去Sessionの移行・変換・互換読込なしの破壊的cutoverと決めた。個別計画は空のSQLite
  authority、旧JSON非表示/no-fallback、post-cutover schema/API、250 ms busy、production受入まで具体化した。
  要件変更後の全体reviewで報告されたexecution FKとpayload contractのP1 2件を反映し、bounded確認で両方の解消と
  新しいBlocker/P1なしを確認した。利用者は個別計画を承認した。Slice A〜CのSQLite history実装、focused・関連検証、
  full test、standalone/isolated XDGによるreal-provider TTY production受入、最終差分reviewを完了した。新規Session、
  exact reopen、model保持、history export、異なる二Sessionの同時turn commit、cancelled executionの`/recall`、
  canonical-only export、SQLite unavailable/unknown schemaのno-fallbackが成立した。実装後reviewで発見したcanonical
  post-commit readback窓とtyped error保持の不具合は修正・回帰確認済みで、未解決のBlocker/P1はない。
  詳細な結果はIncrement 40正本へ保存済みであり、実装差分は`daaef099`へcommit済みである。
  installed binaryは置換していない。Increment 41の計画は`abdb9f4e`へcommit済みで、利用者承認後にschema v2、
  active execution admission、append-only live journal、restart reconciliation、partial evidence、diagnostics、
  `/recall`を実装した。focused 12件、関連回帰、authoritative `v0:gate`、統合後`v0:test`全218件、read-only実装review、
  isolated standalone/real-provider/real-TTY Human Gateが成功した。強制停止後の`interrupted/non_canonical`、
  pending effectの`outcome_unknown`、no replay、次taskだけのrecall、異なる二Sessionの並行commit、schema v1の
  byte不変な`history_invalid`拒否をproduction経路で確認した。未解決Blocker/P1はなく、結果はIncrement 41正本へ
  保存済みである。Increment 42はreview済み個別計画のSlice A〜Dを実装し、破壊的schema v3、content-addressed
  context snapshot、stage別relation、parent/planner/web-searchのexact request attribution、provider evidence相関、
  active/partial/complete/failed diagnosticsを成立させた。focused 26件と関連回帰、check/format/lint、authoritative
  `v0:gate`全243件が成功した。isolated standalone/real-provider/real-TTY Human Gateではskill load/tool observation、
  multi-step ordered request、mutable source変更後の旧snapshot不変と新snapshot分離、強制停止後のpartial context/no replay、
  schema v2のbyte不変な`history_invalid`拒否を確認した。実装reviewで報告されたskill relation重複、原因request ordinal欠落、
  active projection欠落、diagnosticsのwriter lock P1はすべて修正し、最終bounded reviewで新しいBlocker/P1はなかった。
  結果はIncrement 42正本へ保存済みである。非同期・並行subagentは未採用候補として通常利用メモへ記録し、一次資料による
  参照実装比較をresearch文書へ保存した。architectureとroadmapは変更していない。Increment 41・42の変更は未commitである。
- 次: 利用者判断によりIncrement 41・42の変更をcommitし、Increment 43の調査・計画へ進む。
- 正本:
  `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`のIncrement 32〜34、
  `docs/increments/increment-21.md`、`docs/increments/increment-32.md`、`docs/increments/increment-33.md`、
  `docs/increments/increment-34.md`、
  `docs/increments/increment-35.md`、`docs/increments/increment-37.md`、`docs/increments/increment-38.md`、
  `docs/increments/increment-39.md`、`docs/increments/increment-40.md`、`docs/increments/increment-41.md`、
  `docs/increments/increment-42.md`、
  `docs/experience/normal-use-inbox.md`、
  `docs/research/agent-loop-and-durable-state-comparison.md`、
  `docs/research/externalization-reference-comparison.md`、
  `docs/research/async-parallel-subagent-reference-comparison.md`。現行の採用済み全体programは
  `docs/roadmap-inputs/durable-history-and-context-rebuild.md`、
  `docs/roadmap-inputs/increment-32-34-externalization-concept-plan.md`。当初案と初回reviewの履歴は
  `docs/roadmap-inputs/increment-32-33-initial-plan-review.md`。
- 注意: Increment 32はstandalone binaryとresource共通identity・配置境界、Increment 33は最初のmanaged kindで
  あるAgent Definition、Increment 34はDefinition transportである。tool等の他resource kindは33のlocal基盤後に
  個別Incrementで扱い、34を必須前提にしない。`--definition <path>`はIncrement 32で廃止し、外部sourceを
  Increment 33以降のinstall inputに限定する。自然言語resourceのnative discoveryにinstallを要求しない。MCPは
  32〜34の実装範囲外であり、managed化の採否とclient等の物理配置は後続Integration Incrementで決める。Increment 32の
  installed binary置換と、Increment 33実装・stable `0.1.0` release準備のcommit/pushは実施済みである。
  `@henji/harness@0.1.0`はJSRへpublish済みである。architecture・roadmap実装状態更新とGit tagは未承認・未実施である。
  slash補完は当面の順序から外し、Provider外部化を採用するときはexternal
  Providerのauth profile declarationとHost-owned credential registryを接続し、credential登録を同時または直後に扱う。
  Increment 33 production受入の一時証拠は`/tmp/henji-increment-33-acceptance-XbeQE3`、Increment 34は
  `/tmp/henji-increment-34-acceptance-MGN78b`、Increment 35は`/tmp/henji-increment-35-acceptance-a6qHOF`に保持している。
  Increment 37 Slice Bの一時証拠は`/tmp/henji-increment-37-acceptance-b3kQMl`に保持している。
  standalone shadowing修正のproduction artifactは`/tmp/henji-standalone-fix-HSqJ6U/henji`、TUI順序修正を含む現行の
  clean artifactは`/tmp/henji-post-commit-build-eNk6hK/henji`に保持している。
  Increment 38 Human Gateの一時binaryとisolated stateは`/tmp/henji-increment-38-acceptance-nL6Ufc`に保持している。
  Increment 39 Human Gateの一時binaryとisolated stateは`/tmp/henji-increment-39-acceptance-xA5Jxs`に保持している。
  Increment 40最終working treeの一時binaryは`/tmp/henji-i40-candidate`（build
  `709539b66e829e21c2f6dfde82adcb3c7fad660835f75f8884cfcaff9b926ee6`）、isolated stateは
  `/tmp/henji-i40-human-gate`に保持している。
  durable historyの全体programと破壊的cutover方針、Increment 40〜42の個別計画は承認済みである。過去Sessionの
  migration、conversion、compatibility readは実装しない。Increment 40のrepository内実装はcommit済みで、
  Increment 41・42の実装・結果文書は未commitである。architecture・roadmap・構想の変更、installed binary置換、
  commit、push、tag、publishは承認されていない。
