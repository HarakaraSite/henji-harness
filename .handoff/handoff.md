# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-06）

[Increment 205](../docs/increments/increment-205.md)はS34（`search`の検索条件・`run_typescript`の
生成コードの抜粋表示）を利用者承認済み計画で実装した。tool行のpreviewへsearchのmode/pattern/glob/pathと
run_typescript先頭の一行`//`コメントを追加し、focused 27件・関連94件pass、type check/fmt/lint/
`git diff --check`、独立review（findingなし）、隔離XDG/workspaceのcompiled production TUI確認
（local provider、実provider 0回、pending→settledと保存Session再表示）まで完了した。
`henji run --stream`のtool行（生JSON）は利用者確認のうえ対象外とした。通常利用メモのS34は採用済みとして
205へ移設し、候補一覧から除いた。source commit `841c9b6c`、公式build（build ID `0bd65834…`、
runtime digest `43d10091…`）、常用配置（`~/.local/bin/henji`、直前binaryは`henji.previous`）と
配置後スモーク、push（`origin/main`）まで完了した。利用者の通常利用での見た目・使い勝手の確認が残る。

[Increment 204](../docs/increments/increment-204.md)は利用者指示でcredential保存先の分離と
run_typescriptのconfig root読み取りを実装し、local検証・独立review・公式build（build ID `7ecf58e9…`）・
常用配置（`~/.local/bin/henji`、旧binaryは`henji.previous`）・実configの`run-typescript.json`配置・
旧credential file削除まで完了した。source commitは`d1a26f7c`、review対応は`2a95f72f`。
要件・検証・review・移行記録・残る範囲は204を参照する。pushは未実施。
旧Coreが削除済みの旧pathを参照してSession `f040537a`の1 executionが失敗したが、利用者がTUIを再起動し
（2026-10-06 20:37、配置済みbinary）、credentialが新rootのみに存在する状態で同Sessionのmodel requestが
成立している。利用者は2026-10-06に実provider経路での確認を完了した。
204の記録はcommit `d1a26f7c`・`2a95f72f`・`6276b2c9`・`34a67faa`・`71a86844`へ保存済み。

利用者は本Session（`f040537a`）を終了する。次の一手は205の利用者による通常利用確認。
pushは205のsource commit・docsまで完了した。
利用者指示で`~/.config/henji-harness/instruction.md`へ3段落を追加した（operation別のtool選択、質問・
状況報告へのtool call前の回答と長いターンの進捗報告、検査・検証結果の再利用）。反映は次のWorker
generation（新SessionまたはCore/TUI再起動）から。

前Session終了時に利用者指示でA6・A28を完了とし、通常利用メモから除いた。
A6の判断・観測は[172](../docs/increments/increment-172.md)・[200](../docs/increments/increment-200.md)、
A28の判断と原観測の移設先は[199](../docs/increments/increment-199.md)を参照する。
この文書整理はhandoff・通常利用メモを204のdocs commit、172・194〜196・198〜200と新規
`docs/increments/increment-199-a28-observations.md`をそれぞれのdocs commitへ保存した。runtime変更・追加配置はない。
既存の未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`はどちらにも含めない。
B5は再発時の原因調査待ち。原観測・未特定事項・再検討条件は
[通常利用メモのB5](../docs/experience/normal-use-inbox.md#b5--commit-proposal-invalidの具体的な検証不合格理由を特定できない)を参照する。

[Increment 203](../docs/increments/increment-203.md)は利用者指示でB12を採用し、local実装・
focused/compiled確認・独立reviewを完了した。要件・調査根拠・結果・承認境界は203を参照する。
利用者の「コミット配置してください」でsource commit `34032880`・公式build（build ID `69a26b8d…`）・
常用配置・配置後の隔離production確認を完了した。202の修正もbinaryとsearch local-4へ反映済み。
pushは未実施/未承認。

[Increment 202](../docs/increments/increment-202.md)は利用者指示でsearchのDB/blob除外・出力上限と
run_typescriptのCore返却1 MiB上限を実装し、source commit `57484793`へ保存した。
利用者の「このインクリメントは完了とします」により完了。要件・結果・承認境界は202を参照する。
常用配置は203と同時に完了。pushは未実施。

[Increment 200](../docs/increments/increment-200.md)と[201](../docs/increments/increment-201.md)は利用者指示
「コミット、配置して」「プッシュして」により完了した。source commit `6f6f9a6a`（200・201合同）、
公式build（build ID `5bfcdbaa…`）、常用配置（`~/.local/bin/henji`、旧binaryは`henji.previous`）、
push（最新`70b22376`まで）済み。200は専用tool優先・出力の扱い・reviewerからbashを外す案内、
201は外部tool
`git_inspect`（read-onlyなstatus/diff/log/show、親・generic・reviewerで選択）と`search`の `entries`
mode追加。常用config rootへ`tools/git_inspect`・`tools.json`binding・search更新（`local-3`）・
reviewer（revision 3）を反映済み。`agent inspect`はdefault／reviewerともrejections `[]`。
配置binaryは親commitの199も含む。

Core `c6afea6d`はworkspace全体のsearch実行後にSIGTRAPで終了した。
元のCore/TUIのPIDは203配置前に不在を確認し、実Core/TUIの再起動は行っていない。
原因と修正後の再実行結果は202を参照する。新しい起動から202・203の配置済み修正が適用される。
続行Sessionのtool定義問題は[通常利用メモ](../docs/experience/normal-use-inbox.md)のA34に残る。
利用者指示でA34の追加調査は行わず、202では切断原因とその修正を扱った。

**次の一手**: 205（S34: search・run_typescriptの抜粋表示）はsource commit・公式build・常用配置・pushまで
完了し、利用者による通常利用確認待ち。
204は実装・検証・review・配置・実環境移行・利用者の実provider確認まで完了した。
pushは未承認。 B5の追加調査は再発または利用者の明示採用まで行わない。

[Increment 200](../docs/increments/increment-200.md)は「agentがtool>
bashを使いがち」という利用者指示を受け、第1段としてread/write/edit/search/run_typescriptをbashより
優先する`promptGuidelines`を、第2段として出力の扱い（要約pipeを避けてfile化→`run_typescript`、
末尾は`bash_output`のoffset、readはwindow利用、`web_search`は`contents`を限定、pipe時は
`set -o pipefail`）の案内を、第3段としてreviewerのtool構成変更（`bash`・`bash_output`を外し
`read`・`search`・`skill`、instructionをshell非依存へ、revision
2）を追加した。local実装・focused確認（current_code 16件、foundation 25件、increment_127
6件、関連12件）・type check/format/lint/diff check・provider-free headless Workerでのinstruction
readback（guideline 18行、reviewerはread/searchでbashなし） まで完了。reviewer JSONは常用config
rootへ反映済み（backupは`.tools/increment-200/reviewer.json.prev`、
`henji agent inspect --name reviewer`でrejectionsなしを確認）。commit/push・公式build・
常用配置（binary）・外部tool folder（search・web_search）の更新・実provider
callは未実施で、いずれも利用者指示を必要とする。詳細は200を参照する。

[Increment 199](../docs/increments/increment-199.md)はData
Workerの処理最適化の承認済みSlice1〜6を完了。 同一入力の返値一致・独立review対応・隔離compiled
Core/TUI/CLI・authoritative gate（672 pass/0 fail）済みで、
local実装・検証にpendingなし。wireはfullを採用し、条件付き4bは実施しない。
隔離メモリ比較後、利用者の完了承認・source commit指示を受け、本commitへ保存した。
常用配置は未実施/未承認。要件・採否・全結果・承認境界は199を参照する。

[Increment 198](../docs/increments/increment-198.md)は実装・検証・source
commit・公式build・常用配置・配置後確認を完了した。
同じ保存入力での新版実測を確認した利用者が「今回の対応は完了とする」と完了承認した。198のpendingなし。
常用binaryのsourceは
`a3312284`。採用要件・結果・実測・利用者の判断は198、前段の根拠は[処理案](../docs/research/a28-alternate-screen-viewport-plan.md)。
新しい実provider call、構想・architecture・roadmapの正本反映は未承認。

[Increment 197](../docs/increments/increment-197.md)は利用者指定の配色追加調整として、
tool>＋ツール名とthinking系ラベルを緑＋dim（SGR 32;2）にした。local実装・focused確認70件pass・
独立review（findingなし）・隔離compiled production TUI確認（実provider 0）・source commit・
公式build・常用配置を完了し、利用者によるGhosttyでの見た目確認・完了承認を取得した。完了。

[Increment 196](../docs/increments/increment-196.md)はA28の最新request・request件数のmetadata読取を
採用し、local修正・focused確認・実DBコピー比較・compiled production Core／TUI確認済み。
通常・批判的reviewでも未解消findingはない。194・195と合同でsource commit・公式build・常用配置済み。
常用binaryのsourceは`da251e56`。配置後の隔離Core／TUI起動・終了も確認済み。結果と証拠は196を参照する。

[Increment 195](../docs/increments/increment-195.md)はA28のCore保存会話復元の一括本文保持を採用し、
local修正・focused確認・実DBコピー比較・compiled production Core／TUI確認済み。
通常・批判的reviewでも未解消findingはない。
復元単体のピークは減ったがCore全体の常駐PSSに残る課題は当時A28へ残した。A28全体は利用者指示で
完了とし、判断と原観測の移設先は199を参照する。196との合同source
commit・常用配置済み。結果と証拠は195・196を参照する。

[Increment 194](../docs/increments/increment-194.md)はA28のTUI待機loopの保持問題を採用し、
local修正・focused確認・compiled production TUI確認済み。結果と証拠は194を参照する。
196との合同source
commit・常用配置済み。新しい起動から適用される。既存の実Core／TUIは再起動していない。

[Increment 193](../docs/increments/increment-193.md)の追加指定の配色はCodexへの引継ぎを完了した。
local実装・focused確認・独立review・source commit・公式build・常用配置済み。193配置時のsource
commitは`fa258148`。現在の常用binaryは194・195・196の合同配置を含む`da251e56`。
詳細は193の「追加指定の配色・引継ぎ結果」を参照する。利用者の見た目確認・完了承認は残る。

[Increment 192](../docs/increments/increment-192.md)は利用者による確認・完了承認済み。
利用者はこの後セッションを終了する。実装・検証・配置・完了の記録は192を参照する。

[Increment 191](../docs/increments/increment-191.md)は利用者による通常利用確認・完了承認済み。
192時点の常用binaryはsource commit `4312d81e`からbuildした0.9.0。
前回の[0.9.0配置記録](../docs/operations/native-0.9.0-deployment.md)と191の機能・利用者確認は191を参照する。
JSR `@henji/harness@0.9.0`は公開・両entrypointの実import・公開型の確認済み。
公開結果は[公開手順](../docs/operations/jsr-publish.md)を参照する。

[開発ワークフロー案](../docs/plans/development-workflow.md)（未採用・利用者review待ち）を source
commit `42eb0da9`・`d301bf08`へ保存した。段階1〜9の手順と承認境界に加え、§10にhookによる
段階ゲートの検討記録（判定処理は拡張側、coreは通知配送、配送はturn間、topic状態変化時のみ、gate発火は
bash結果のexitCodeで捕捉、Jev等のAI判定は実provider承認が前提）を記録した。採用判断とincrement計画は
未実施。採用時はAGENTS.mdからの参照追加を提案する。設計検討のみでproduct sourceは未変更。

## 次の一手と承認境界

199は利用者による完了承認済みで、source commitまで完了。採用範囲にpendingなし。
常用配置・push・公開/release・実provider call・構想/architecture/roadmap正本変更は未承認。
最初のgateの容量不足/obsolete fixture切分けと再実行理由・全結果は199に記録した。

198は利用者による完了承認済み。継続的な処理最適化についての利用者の判断は198末尾を参照する。
198の未実施作業・確認待ちはない。未採用候補は通常利用メモを参照する。

197は利用者による見た目確認・完了承認済みで完了した。 色調整のpendingなし。
193の追加指定の配色は197の追加調整で現行配色が上書きされ、193以来の見た目確認も197の
現行表示に対する利用者確認で確認済みの扱い。S33は193へ採用・移設した。
その他の未採用候補は通常利用メモを参照する。
push、公開/release、構想・architecture・roadmap変更、新しい実provider callは未承認のまま。

194・195・196のlocal修正・非破壊的検証、source commit・常用配置は承認済みで完了した。
push、公開、新しい実provider call、構想・architecture・roadmap変更は未承認。
A28は利用者の「A28も完了でいい」により完了とし、通常利用メモから除いた。
完了判断と原観測・旧候補の移設先は199を参照する。195後のmetadata読取候補は196へ採用・移設した。
類似問題reviewで見つかったcontext読取・終了後artifact更新・recall/診断読取の候補は、199の計画対象へ移設した。

192のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
192の追加指示はarchitecture/roadmap正本変更、push、公開/release、
旧実データの削除・移行の承認を含まない。実provider callを計画上の必須確認にしない。
191のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
その他の未採用候補は通常利用メモを参照し、個別採用前に実装しない。
architecture/roadmapの189案は未適用patchに留め、正本反映は別承認対象。 今回のJSR公開と手順内のsource
pushは承認済み。後続指示でnative binaryのbuild・常用配置も承認済み。
必要最小限の実provider利用は承認済み。使用前に対象・回数・保存先を提示する。
旧実データの削除・移行は未承認。S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 205](../docs/increments/increment-205.md):
  S34の採用要件・表示契約、現行経路のsource確認、実装・focused確認・独立review・
  隔離production TUI確認、通常利用メモからの移設原記録、承認境界。

- [Increment 199](../docs/increments/increment-199.md): Data
  Workerの処理最適化の要件・調査根拠・承認済みスライス計画・実装/検証/review結果・承認境界。

- [Increment 198](../docs/increments/increment-198.md): alternate
  screenの採用要件、本文位置からの可視範囲加工、更新依存・Page/resizeの実装、
  focused確認・独立review・隔離production TUI結果、commit・常用配置と配置後確認、承認境界。

- [Increment 197](../docs/increments/increment-197.md):
  tool名とthinking系ラベルの緑dimの採用要件・解釈、実装・focused確認・独立review、 隔離production
  TUI確認の結果、commit・build・常用配置記録、承認境界。

- [Increment 196](../docs/increments/increment-196.md):
  最新request・request件数の採用要件、必要な記録だけの読取、focused確認、実DBコピーの一致と compiled
  Coreのメモリ比較、Core／TUI／履歴CLI確認、残る課題と承認境界。

- [Increment 195](../docs/increments/increment-195.md):
  A28のCore保存会話復元の採用要件、逐次復元の修正、同一snapshot・読取順の確認、
  実DBコピーの復元一致とメモリ比較、compiled Core／TUI／履歴CLI確認、残る課題と承認境界。

- [Increment 194](../docs/increments/increment-194.md):
  A28のTUI保持問題の採用要件、event待機修正、変更前後のGC後heap比較、focused確認、 隔離compiled
  production TUIの操作・保存結果と承認境界。

- [Increment 193](../docs/increments/increment-193.md):
  S33の採用要件・計画・実装・focused確認・独立review・compiled TUI／最小実provider結果、 source
  commit・常用配置・配置後確認結果、見た目確認待ちと承認境界。

- [Increment 192](../docs/increments/increment-192.md):
  `openai-chat`廃止の採用要件、実行記録・公式契約、 現行利用経路、実装・gate・compiled
  TUI確認・commit・常用配置結果、利用者確認・完了承認、承認境界。
  [正本変更案](../docs/increments/increment-192-authority-proposal.patch)は未適用。

- [Increment 191](../docs/increments/increment-191.md): A23の要件、各スライスの実装・確認結果、645
  testのgate通過、commit・常用配置結果、承認境界。
  [実Agent・スパイク記録](../docs/research/a23-agent-generated-code-probe-2026-10-05.md)、
  [正本変更案](../docs/increments/increment-191-authority-proposal.patch)。

- [Increment 190](../docs/increments/increment-190.md): B11の採用範囲、一覧フィルタと確認結果。

- [Increment 189](../docs/increments/increment-189.md):
  A26の要件、6スライス結果、最終compiled/実provider証拠、完了判定と未適用正本変更案。

- [Increment 188](../docs/increments/increment-188.md): edit対象file 1
  MiB拡張、実装・確認結果と承認境界。

- [Increment 187](../docs/increments/increment-187.md): searchの出現数集計、実行証拠と正本変更案。

- [Increment 186](../docs/increments/increment-186.md):
  外部search、web外部化とpackage配布の採用要件・実装・確認。

- [Increment 185](../docs/increments/increment-185.md): A18の採用要件、実装・確認結果と未確認範囲。

- [Increment 184](../docs/increments/increment-184.md): S24の採用要件、実装・確認計画と結果。

- [Increment 183](../docs/increments/increment-183.md): S26の採用要件、実装・確認計画と結果。

- [Increment 182](../docs/increments/increment-182.md): B10の採用要件、実装・確認計画。

- [Increment 181](../docs/increments/increment-181.md):
  合意要件、全スライス結果、完了判定、承認境界。
- [181具体contract](../docs/increments/increment-181-contract.md): JSON/tool/new DBの契約。
- [181最終E2E](../docs/increments/e2e-181-plan.md): 操作・実証拠・request集計・最終候補確認。
- [Increment 180](../docs/increments/increment-180.md): 前回常用配置の結果。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): S4等の未採用候補。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md): 責務と状態所有。
- [roadmap](../docs/roadmap.md): 必要機能と実装状態。
