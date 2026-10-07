# Increment 202 — searchのテキスト検索・出力上限とrun_typescript返却上限

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 完了（2026-10-06、利用者による完了承認済み）。local実装・focused確認・独立reviewを完了し、
利用者指示でsource commit `57484793`へ保存した。後続203の配置でbinary・外部searchも常用反映済み。
pushは未実施。

## 利用者が必要とする動作と根拠

利用者指示: 「上限は設ける blob、dbは対象としない」「run_typescript coreへの返却は上限を
設けられる？切り捨てでいい」「1mbくらい？」「では実装を直そう searchと、run_typescriptを 直して
次のインクリメント」。巨大な実行コード内の値・JSON化が呼出し専用processを失敗させる
ことは許容し、Coreへの巨大返却を抑える。

Session `3a7b754f`のExecution `b01d2e05`では、A34の文書更新前に
`search({mode:"content",pattern:"normal-use-inbox"})`を発行した後、2026-10-06 15:57:12 JSTに
CoreがSIGTRAPで終了した。配置binaryのtrap位置はV8 `OS::Abort`に一致する。
実providerなしの隔離Workerで同じ検索を行うと、現行local-3と拡張前local-2の双方が
`Fatal JavaScript out of memory: Reached heap limit`で終了した。128 fileの1 batchで
検証用SQLite・WALから1,679,156,404 bytesの検索出力が返った。内部の全量capture・連結・
一致record保持が、最後のpage選択より先に起きていた。
調査artifactは`/tmp/henji-disconnect-jpqyif7r/`（一時保存）。

## 現行product経路・状態所有

- search: model tool call → Worker Registry → 外部folderのfactory → Denoでfile列挙・glob選択 →
  Host-owned process executorのrg/grep → Workerでcapture・record化 → page JSON → semantic履歴・
  次のmodel request・Core/TUIのtool outcome。
- run_typescript: model tool call → Worker Registry → Host-owned executorで呼出し専用process → code
  Workerで実行・JSON化 → process内reply file → 呼出し元Workerがreply読取 → tool result。 code
  Workerから最初に結果を送り出す前に切り詰め、Core process内への全量readを防ぐ。
- tool失敗のCore伝達・TUIの`✗`表示、取消・子process終了待ちは既存経路を使う。

## 採用する動作・対象範囲

1. searchのfiles/content/countをテキスト検索とし、DB・blobなどのbinary内容検索をしない。
   隠しfile・ignored file・symlinkの既存探索、regex/literal、rg不在時のgrepは維持する。
   paths/entriesは内容を読まないfile/metadata一覧として維持する。
   `.db`・`.sqlite`・`.sqlite3`・`.blob`と対応する`-wal`/`-shm`を除外し、その他のfileは 64
   KiB単位でNULを調べる。UTF-16 BOM付きtextはencoding中のzero byteでは除外せず、 code
   unitのU+0000をbinaryとして除外する。内容を全量memoryへ保持しない。
2. searchのcaptureはstdout合計8 MiBまで、stderrは64 KiBまで、返却JSONは1 MiBまでとする。
   上限を超えた検索は停止し、取得済み範囲を返す。truncatedで部分結果と明示し、部分結果の
   totalを全scopeの確定件数として案内しない。通常のpage・countは従来どおり。
3. run_typescriptの成功結果は切捨表示を含むUTF-8 1 MiBまで。上限以内のJSON結果は維持し、
   超過時は先頭を残して切捨表示を付ける（結果本文が完全JSONでなくなることは許容済み）。
   子process内でJSON化した直後・postMessage前に実施し、巨大reply fileをCoreに読ませない。
   大量の結果はworkspaceまたは`/tmp`へ保存し、path・件数・sizeのみを返す。保存fileのsizeには
   この返却上限を適用しない。
4. tool description/guidelineで上限、text scope、部分結果を案内する。searchのglobが独自の path
   filterであることと、先頭`!`による除外に未対応であることを明示する。

searchの数値は、上限を設ける利用者方針に基づくlocal実装判断。run_typescriptの1 MiBは会話で合意済み。

対象外: A34の記録更新・続行Sessionのtool定義更新、TUIの表示追加、実行コード内部のmemory制限、
子process stderrの新規収集、既存DB/artifact削除、構想・architecture・roadmapの正本変更、
常用配置・commit/push・公開、実provider call。

## 計画・確認するproduct動作

- searchを修正後、実WorkerでDB/blobを含むworkspaceのcontent/files/countがテキストだけを返すこと、
  rgとgrep双方、通常のpageとcount、上限超過後の後続toolが成立することを確認する。
- run_typescriptを修正後、既存executor実経路で通常JSON、1 MiB超過の切捨、UTF-8境界、
  同じRegistryで後続実行が成立することを確認する。
- 最初に落ちたworkspace全体の検索を隔離provider-free Workerで再確認し、取得可能な通常の
  文書参照とtruncated/outcomeを観測する。返却body全文・credential値・Authorizationは記録しない。
- focused test、対象type check・format・lint、git diff --check。full gateとTUI変更確認は要求しない。
- 親agentが最終差分・検証・increment結果・handoffを更新する。

## 結果

### 実装

- 外部searchを`local-4`へ更新。DB/blob除外、stdout/stderrの限定capture・超過時のprocess停止、
  不完全recordの除外、返却JSON予算、matching textのprefix化を実装した。
  `truncated:true`で切捨を表示し、capture超過時は`totalIsExact:false`で取得済み件数とする。
  countの`truncated:true`も部分集計を意味する。続き情報は取得済みrecord内のpagingに限る。
- run_typescriptは呼出し専用processのcode Workerで、JSON化直後にUTF-8のcode point単位で
  prefixを選び、`[truncated: result exceeded 1 MiB]`を付けてからpostMessageする。
  UTF-8全量encodeは行わず、1 MiB超過を検出した時点で走査を止める。
- tool description/guidelineにもscope、上限、部分結果、file保存の使い方を反映した。

### 検証

- `increment_186_search_test.ts`: 実WorkerHostSessionでrg/grep双方の通常page・count・取消、
  DB/blob除外、通常UTF-16 BOM text、encoded-NUL blob除外、1 MiB JSON切捨、8 MiB capture停止と
  後続tool成立を確認。修正後の最終実行は1 pass / 0 fail（4秒）。
- `increment_191_executor_test.ts`: 通常JSONの維持、1 MiB超過のUTF-8切捨と後続実行、 **2
  MiBのfileを保存してpathとsizeだけ返す実経路**、既存のruntime error・取消等を確認。
  searchとの合同focused実行は2 pass / 0 fail（9秒）。
- `increment_201_inspection_tools_test.ts`: 既存entries等の確認は2 pass / 0 fail。
- 変更TSのtype check・format・lintと`git diff --check`を確認。full gateは実施していない。
- 最初に失敗したworkspace全体の`normal-use-inbox`検索を、修正source・Deno 2.9.7の
  provider-free隔離Workerで再実行。exit 0、backendは上限到達でSIGTERM、Workerのclosedまで到達、
  stderrなし。取得済み1,336 recordから100 recordを50,716 bytesで返し、
  `truncated:true / totalIsExact:false / nextOffset:100`を確認した。 1秒ごとのRSS観測の最大は129.5
  MiB、監視時間12秒（絶対peakの測定ではない）。
  修正前は現行local-3・拡張前local-2の双方でheap不足・SIGTRAPを再現した。
  最終artifactは`/tmp/henji-disconnect-jpqyif7r/final.summary.json`・
  `final.stdout.jsonl`・`final.stderr.txt`。結果本文の全量は保存していない。

### review

取得上限・parser・process終了とrun_typescriptのprocess境界を対象に、初回20分上限の独立reviewを
実施した。通常UTF-16 BOM textを維持するfilterと、上限停止で終了したstreamの解放について
具体的なP2を2件採用した。encoded U+0000を検査し、capture超過時はreaderをcancelしてから
lock/releaseを解放する修正を行った。上記focused確認は修正後に通過。変更箇所だけを対象とする
15分上限の限定re-reviewで2件とも解消を確認し、残る指摘はない。 現在sourceのreadLimitedとproduction
WorkerProcessExecutor・WorkerProcessOwner・LinuxProcessExecutor による実process probeでは、capture
8,388,608 bytes・`truncated:true`・release後のHost保有operation 0件・exit
0を確認した（修正前は終了済みoperationが1件残留）。reviewerのprobeはread-onlyで、
artifactは保存せずtool transcriptで結果を受領した。

### 未確認範囲・正本変更案

local確認時点では常用binaryと常用configのsearchは未更新だった。compiled binary・実provider・
production TUIからのmodel call確認は本incrementのlocal実装では未実施。 後続203の配置と隔離production
Core確認は下段を参照する。変更はTUI Surfaceを含まず、実provider callは0回。
元のA34の文書更新・続行Sessionのtool定義問題は今回扱っていない。

architectureの「完全なrecord単位」「対象全体のmatchCount」には、text scope・capture超過時の
部分集計・返却textのprefix化の条件を追記する必要がある。roadmapには本incrementの実装状態を
反映する案がある。いずれも別途の明示承認が必要な正本変更案としてここに留め、正本は変更しない。

## 承認境界

利用者の「このインクリメントは完了とします」により本incrementを完了とした。
後続203の「コミット配置してください」により、203のbinaryへ本修正を含め、常用search folderをlocal-4へ
更新した。隔離production CoreでもDB/blob除外、返却1 MiBの切捨、2 MiBのfile保存を確認済み。
配置と証拠の詳細は[Increment 203](increment-203.md#commit常用配置結果2026-10-06)を参照する。

local実装と非破壊的な検証は今回の利用者指示で承認済み。後続指示「コミットして」によりsource
commitも承認された。常用配置、push、公開、実provider call、Product正本の変更、実data/artifact削除は
本incrementの実装・commit許可に含めない。
