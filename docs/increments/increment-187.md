# Increment 187 — searchの出現数集計

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 完了（2026-10-04、利用者による通常利用確認・完了承認済み）。sourceは未commit。

## 必要な動作と根拠

2026-10-04、利用者は通常利用の「henjiという文字列が何個出現するか」という質問で、searchの
content結果が一致行数を返し、同一行の複数出現とは一致しないことを確認した。
検索条件を共用する`mode: "count"`と`matchCount`による出現数を提案し、「では追加しよう」で採用された。

- countは既存のpath/glob、pattern、patternKind、caseSensitiveと共通対象列挙を使う。
- rgを優先し、rg不在時だけgrepへfallbackする。rgの`--count-matches`、grepの`-o`を使い、
  選択対象全体の非重複の一致数を`{mode: "count", backend, matchCount}`で返す。
  正規表現の方言とゼロ幅一致の扱いは各backendのnative動作に従う。
  実行確認ではrgがゼロ幅一致を数え、grep -oは非空一致のみ出力する差を観測した。
- countにoffset/limitによるページングを適用しない。既存modeのtotalはrecord数を維持し、
  descriptionでcontentのtotalが一致行数であることを明示する。新しい検索条件は追加しない。

## 現行経路と対象

Hostのtools.json選択 → Workerの外部ToolFactory読み込み → 同じschema/descriptionをmodelへ提示 →
Registry dispatch → 共通file列挙 → managed process executorによるrg/grep実行 → semantic結果保存、
という現行経路を使う。変更対象は外部searchとその説明、確認fixture、package probeであり、 Core、Agent
JSON、tool API、検索backendの追加、Surface、provider/service契約は変更しない。

前回の常用配置指示に続くsearch改善として、検証後に同じ常用tool folderへ反映する。
既存設定・tools.json mappingと稼働中Coreを保持し、編集済みsource/settingsを上書きしないよう、
現在のsourceとの差分を確認して指定変更だけを反映する。source commit・公開/release・実provider
callは含まない。
architecture/roadmapの追加反映は包括的な実装承認と分け、具体差分を提示して別途承認を得る。

## 実装・確認計画

1. countを既存検索条件とmanaged process/cancel/終了処理へ組み込む。grepの一致出力はstreamで件数へ
   集計し、modelへ大量の一致本文を返さない。revision labelをlocal-2へ更新する。
2. 実Workerと実rg/grepで、同一行の複数出現と一致行数の差、対象fileの合算、path/glob、case/literal/regex、
   no-matchの0とページングに影響されない集計を確認する。旧modeとcancelは既存focused testで確認する。
3. 常用と同じ検証済みbinaryを使って更新folder入りpackageを作り、repository外・隔離HOME/XDGの
   production serve/APIでcountを呼び、schema提示、実rg/grep、semantic readbackを確認する。
   modelとExaはlocalhostの代替serviceを使い、実provider callは行わない。
4. 変更source/testのtype check、format、lintとgit diff
   --checkを確認し、常用folderへ反映してmetadataと
   file内容を確認する。binary/Surface変更がないためfull gate、再compile、tmux確認は行わない。

## 正本反映

2026-10-04、利用者の「反映して」で [具体差分](increment-187-authority-proposal.patch)が承認された。
architectureの検索節とroadmap F02へ、countとmatchCount、一致行数と出現数の区別を反映した。
構想の変更は不要。

## 結果

- 外部searchへ`mode: "count"`を追加し、revisionをlocal-2へ更新した。rgはfileごとの
  `--count-matches`を合算し、grepは`-o`出力をstreamで件数へ集計する。検索条件と対象列挙、 managed
  processのcancel/終了処理は既存経路を共用する。
- 実WorkerHostSessionと実rg/grepのfocused testが成功した。同じfileで一致行数2と出現数3を区別し、
  case-insensitiveでは4、hidden/ignore対象を含むfile合算では7となった。literal/regex、no-matchの0、
  countでのoffset/limit無視、旧modeとcountのcancelも確認した。type check、format、lint、
  `git diff --check`は成功した。
- 常用の検証済みbinaryを再compileせず、更新folder入りpackage
  `henji-0.8.0-x86_64-unknown-linux-gnu-24dae570.tar.gz`を作成した。
  repository外の隔離HOME/XDG・DenoなしPATHでproduction serve/APIを動かし、modelへcountのschemaと
  matchCountの説明が提示され、実rg/grepが一致行数4に対して出現数5を返すことを確認した。
  semantic履歴の読み戻し、web toolとpackage installの既存動作も成功した。
  localhostの代替serviceへのmodel request 11回、Exa request 1回で、実provider callはない。
  証拠はgit管理外の`.tools/increment-187/verification/evidence.json`と`history.ndjson`へ保存した。
- 常用folder `/home/agent/.config/henji-harness/tools/search`のindex.ts/tool.jsonだけを更新した。
  旧sourceとの一致を確認して適用し、settings.ts、tools.json、binaryのhashは前後で一致した。 CLI
  inspectはexternal/local-2を返し、sourceのSHA-256は
  `b0e243a0e053846418d1b5960a83fa6697473f2f68ae5ab536152d6188eba737`でrepositoryと一致した。
  backupと配置記録は`.tools/increment-187/installation-g3sullu4/`に置いた。
  稼働中の旧Core/TUIは再起動していない。更新定義を使うには最新版binaryの新Core/Workerを使う。
- full gate・再compile・tmux確認・commit・公開/releaseは行っていない。

## 通常利用確認と完了判断

2026-10-04、利用者から「おおhenjiが使ってくれた」と通常利用でのsearch使用が報告され、
「インクリメント完了とします」で完了が承認された。
実装・検証・常用配置・正本反映と、この通常利用確認をもってIncrement 187を完了とする。
