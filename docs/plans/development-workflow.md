# 開発ワークフロー（案）

状態: 案（2026-10-06作成、未採用）。利用者のreview待ちであり、まだ作業ルールではない。
本書はHenjiの開発を進める順序、各段階の入力・手順・成果物・出口条件・承認境界の案である。
採用時は利用者の承認を得て、[`AGENTS.md`](../../AGENTS.md)からの参照と必要な記録更新を行う。
採用までは進行中の作業・increment・他の文書へ本書を適用しない。

作業上の判断基準は[`AGENTS.md`](../../AGENTS.md)を最優先とする。productのWhyは
[構想](../concepts/experience-driven-self-revision.md)、責務と状態所有は
[architecture](../architecture/henji-host-agent-worker.md)、必要機能と実装状態は[roadmap](../roadmap.md)、
個別の要件・計画・結果は[increment文書](../increments/)がそれぞれの担当領域の正本である。
本書とAGENTS.mdまたは利用者の明示指示が食い違う場合は、AGENTS.mdと利用者の指示を優先する。

## 0. 採用の位置づけと確認したい点

- 本書は案であり、進行中の作業の判断・手順を変えるものではない。採用する場合は、変更対象
  （AGENTS.mdからの参照追加、既存記述との整理）を提示して利用者の明示承認を得る。
- 採用までは、進行中のincrementや他の文書へ本書を適用しない。
- 採用前に確認したい点:
  - 段階2（対応案review）を段階4（計画review）へ統合してよいか。
  - §8の「変更の性質ごとの適用の目安」を既定としてよいか。
  - 本書の配置・名称（`docs/plans/development-workflow.md`）と、採用時のAGENTS.mdからの参照でよいか。
  - 段階8（commit・常用配置）と段階9（完了承認・記録・正本反映）の分割でよいか。

## 1. 原則

- 変更対象を決める前に、利用者の操作から結果までの現行経路を確認する。入口（TUI/API/CLI/run）、
  状態の所有者、データの生成・保存・参照先、置き換えで使われなくなる処理を追う。
- 成功条件は、人間がproduction経路で目的の機能を完了できること。offline fixture、test件数、
  review結果、機械的gateの成功をその代替にしない。
- testはproduct動作に従属する。先にproduct動作と確認方法を対応させ、網羅・件数を目的に
  testを足さない。
- 利用者の明示指示がない修正は破壊的変更として扱い、migration、compatibility read、
  dual-read/write、fallbackを推測で追加しない。実データ・既存fileの削除は明示指示を必要とする。
- 指示されていないhardening、permission・入力・状態matrix、上限、拒否条件、cleanupを
  計画・実装・test・reviewへ追加しない。
- 未採用の改善候補は[通常利用メモ](../experience/normal-use-inbox.md)へ記録する。記載は採用・実装を
  意味しない。採用した項目は通常利用メモからincrement文書へ移し、完了史を未採用候補へ残さない。
- 前の段階の出口条件を満たしてから次へ進む。段階の統合・省略は利用者の指示または計画で明示し、
  記録・review・承認のいずれも省略しない。
- 各段階の成果は正本へ記録する。会話や一時artifactだけに残さない。

## 2. 全体像

| 段階 | 名称                                  | 主な入力                     | 主な成果物                           | 出口条件                                                             |
| ---- | ------------------------------------- | ---------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| 1    | 要件・対応案検討（必要に応じてspike） | 利用者指示、通常利用の観測   | 採用範囲・対象外・根拠・spike証拠    | 利用者が方針を採用した                                               |
| 2    | 対応案のreview                        | 対応案、現行source、既存契約 | review結果                           | 方針を妨げる未解消findingがない                                      |
| 3    | 計画（increment文書）                 | 段階1・2の結果               | `docs/increments/increment-N.md`     | 計画の記載が完了し利用者へ提示した                                   |
| 4    | 計画のreview                          | 計画、現行source、関連契約   | increment文書の計画review節          | 実装着手を妨げる未解消findingがない                                  |
| 5    | 実装（スライスごと）                  | 計画                         | 実装、test、focused確認記録          | 各スライスのproduct動作がproduction sourceで成立し、reviewを通過した |
| 6    | 総合確認（必要に応じて）              | 安定候補                     | 確認用binary、実経路の証拠、gate記録 | 計画の成功条件をproduction経路で確認した                             |
| 7    | 最終review                            | 固定したdiff、証拠           | review結果                           | 未解消の採用findingがない                                            |
| 8    | commit・常用配置（承認時）            | 承認済みの成果               | source commit、配置済みbinary        | 配置後の確認まで完了した                                             |
| 9    | 完了承認・記録                        | 利用者の通常利用確認         | 完了記録、handoff、正本反映          | 利用者が完了を承認した                                               |

利用者が示した「要件・対応案検討 > レビュー > 計画 > レビュー > スライス実装/review > 総合テスト >
レビュー」は段階1〜7に対応する。段階2は段階4へ統合してよい。統合する場合も、
対応案（何を・なぜ・どこまで）と計画（どう実装し・どう確認するか）の両方をreviewで確認する。
「必要に応じて」と付けた段階は、実施の要否と理由を計画に明記する。

## 3. 段階別の手順

### 段階1: 要件・対応案検討

開始条件: 利用者が候補の採用・調査・計画作成を指示した、または通常利用で新しい観測が得られた。

1. 利用者の目的、必要な動作、根拠、成功条件、今回の承認境界（調査まで・実装まで・commitまで等）を
   確認する。
2. 現行経路をsourceで確認する。入口、状態所有者、データの生成・保存・参照先、
   置き換え・廃止で使われなくなる処理を列挙する。
3. 採用範囲（今回成立させる動作）と対象外（互換、hardening、未観測variant、別機能）を分けて書く。
4. 不明な外部挙動・性能・メモリはspike/probeで確認する。実DBはコピー、環境は隔離HOME/XDG、
   providerはlocal、process・実行分離の確認は専用harnessを使う。証拠は`.tools/<topic>/`へ置き、
   結論と未確認を区別して記録する。実provider callは事前に利用者へ対象・回数・保存先を提示して
   承認を得る。
5. 対応案（変更する責務・構造、撤去対象、確認方法、依存）をまとめる。方式変更や要件の意味が
   変わる判断は利用者へ戻す。
6. 利用者へ方針を提示し、採用（または計画作成）の指示を受ける。

記録: 会話、必要なら`docs/research/`（調査・比較）、`.tools/<topic>/`（証拠）、
通常利用メモ（未採用の観測）。

出口条件: 採用範囲・対象外・根拠・成功条件・承認境界が決まり、利用者が方針を採用した。

### 段階2: 対応案のreview

対象: 対応案、現行source、既存の契約（architecture、過去incrementのcontract）、根拠となる実行証拠・
公式外部契約、対象外の根拠。観点とfindingの扱いは§6に従う。段階4と統合する場合も同じ観点を
落とさない。

出口条件: 実装方針を妨げる未解消findingがない。採用しなかった指摘は理由を記録する。

### 段階3: 計画（increment文書）

開始条件: 段階1・2の出口条件を満たした。

成果物: `docs/increments/increment-N.md`。採用されたincrementの要件・対象範囲・計画・結果の正本で
ある。計画と結果は同じ文書へ追記し、計画時の記述を後から書き換えて消さない。

記載する内容:

- 状態: 現在の段階（計画案・local実装/検証済み・commit/配置済み・完了）と、承認された境界。
- 必要な動作と採用範囲: 利用者が要求した動作と、会話で確定した解釈・要件。
- 根拠: 実行記録（execution ID、diagnostic ID、測定値とその出典）、公式外部契約、
  関連する過去increment。
- 現行のproduct経路と状態所有: 入口から結果までの経路と、変更・撤去する処理。
- 採用範囲と対象外・撤去: 対象外を明示し、置き換えで不要になる処理を同じ変更に含める。
- 実装・確認計画: product動作ごとに確認方法と根拠を対応させる。確認できないものは未確認と書く。
- スライス（複数の境界にまたがる場合）: 段階5の基準に従い、スライスごとの完成状態・依存順・
  同時に撤去するもの・確認するproduct経路・review対象を定義する。
- 検証方針: focused範囲、静的check、compiled隔離確認、実DBコピー比較、Surfaceのtmux確認、 実provider
  callの要否、authoritative `v0:gate`を行うか。
- 正本変更の扱い: 構想・architecture・roadmapの変更が必要なら、対象・理由・意味上の変更を提示して
  別承認とする。適用前は変更案（patch等）をincrement文書から参照する。
- 未確認事項: 実装時にsourceで確定する点、証拠がない点。
- 実装・検証の記録（結果を追記する欄）。

注意: 計画の記載は実装・commit・配置の承認を意味しない。利用者の指示ごとに承認範囲を
increment文書の状態または「承認境界」へ追記する。

出口条件: 計画が記載され、利用者へ提示された（利用者確認待ちでよい）。

### 段階4: 計画のreview（通常review・批判的review）

- 通常review: 要件と現行経路の整合、実装可能性、既存契約（例: 170の保存/公開・cut、181の semantic
  authority）との整合、source記載の裏付け、consumer・撤去の抜け、変更対象testの扱い。
- 批判的review: 状態所有と処理の必要性、保持・生成されるデータのconsumer、より単純な案、
  対象外の根拠、無駄な処理の見落とし、計画の不足。
- 結果はincrement文書の「計画review」節へ、指摘・対応・未対応の理由を記録する。
- 計画を修正した場合は、変更箇所に限定した短いre-reviewでよい。

出口条件: 実装着手を妨げる未解消findingがない。

### 段階5: 実装（スライス）

スライスに分ける基準:

- 複数の境界（状態所有、保存、公開、購読、読取、表示）にまたがり、一括では問題の切り分けや
  効果の確認が難しい場合。
- スライスは「動作する完成状態」を持つ。未接続の新APIだけを作る、旧型のためだけのadapterで
  次のスライスへ先送りすることはしない。
- 後続スライスで撤去する現行処理は、残っているものと次の置換先を記録し、完了済みの改善として
  扱わない。

各スライスの手順:

1. 計画の当該スライスのproduct動作、変更境界、撤去対象を確認する。
2. 実装する。承認された動作を最短の実経路で成立させ、指示されていない互換・硬化・上限を足さない。
3. focused testで、計画で対応付けたproduct動作を確認する。変更した動作を要求する既存testは
   期待値を更新し、誤ったtestは修正または削除する。
4. 変更fileのtype check、format、lint、`git diff --check`を行う。
5. 通常reviewを独立reviewerへ依頼する（§6）。対象は差分または固定manifest。Surface変更は
   この時点の実装で隔離tmuxのproduction TUI確認も行う（利用者が省略・代替を明示した場合を除く）。
6. 採用したfindingを解消し、必要なら同じ対象を再確認する。
7. increment文書の「実装・検証の記録」へ、結果・撤去した経路・残る処理・証拠path・未確認を記録する。

やらないこと:

- full gate／`v0:test`の反復。途中確認はfocused testと静的checkに限定する。
- 計画外のproduct bugの独断修正。原因・観測証拠・利用者影響・修正案を報告し、指示を待つ。
- 未観測のprovider variant、仮想的failure、境界値・permission permutationのtest追加。
- 旧内部API・test helperのためだけのadapterの残留。

出口条件: 各スライスで、計画のproduct動作がproduction sourceで成立し、focused確認・静的check・
reviewを通過している。increment文書に記録がある。

### 段階6: 総合確認

目的: スライス単位の確認では見えない、production経路全体の成立と回帰の有無を確認する。

1. 公式build scriptで確認用binaryを作る。
   `deno task --config deno.v0.json henji:compile --output .tools/increment-N/henji`。 build
   ID、source revision、`sourceDirty`、`embeddedRuntimeSha256`、Deno version、targetを記録する。
2. 隔離環境（新規HOME/XDG/workspace、専用tmux socket、外部DenoのないPATH）で、compiled productionの
   Core/TUI/CLIを起動し、計画の成功条件を操作する。providerはlocalのHTTP/SSEを使い、 実provider
   requestは0を既定とする。
3. 保存データの同一性確認が必要な場合は、実DBのSQLite backupを隔離stateへ置いて比較する。
   稼働中の実Core/TUI、実DB、実configへは操作・書込みをしない。
4. 実provider callは利用者の承認時のみ。承認範囲（対象・回数・保存先）を守り、結果は短いrequest
   factとsemantic履歴で確認する。raw request/response、SSE断片、credential値、Authorizationを
   記録しない。
5. authoritative `v0:gate`は、承認済み計画が要求する場合に、安定候補でcoordinating ownerが
   一回だけ実行する。失敗時はfocused確認で原因を特定し、再実行には修正等の具体的理由を記録する。

記録: `.tools/increment-N/`のresult JSON・画面記録・log、increment文書の「検証結果」節。

出口条件: 計画の成功条件をproduction経路で確認し、証拠と未確認事項を記録した。

### 段階7: 最終review（通常review・批判的review）

- 対象を差分またはmanifestで固定してreviewerへ渡す。reviewerはread-onlyで、product sourceを
  変更せず、full gate・実provider call・稼働サービス操作を行わない。
- 観点は§6。段階2・4で確認済みの計画内容を再reviewせず、変更された実装と検証結果を対象にする。
- 結果と未確認をincrement文書へ記録する。

出口条件: 未解消の採用findingがない。

### 段階8: commit・常用配置（利用者承認時）

1. `git status`で対象を確認し、無関係な変更（並行作業のfile、一時artifact）をcommitから外す。
   gitは`HOME`を明示して実行する。
2. 実装・test・increment文書・handoffをsource commitへ保存する。commit messageは変更の意味を表す。
3. 公式build scriptでsourceDirty=falseのbinaryを作成する。検証済みcandidateと
   `embeddedRuntimeSha256`の一致を確認する。
4. 旧binaryを`.tools/increment-N/deployment/`へ退避し、staging fileから`dist/henji`と
   `~/.local/bin/henji`へatomic置換する。versionとbinary SHA-256の一致を両配置先で確認する。
   手順の前例は[常用binary 0.9.0配置](../operations/native-0.9.0-deployment.md)。
5. 配置したbinaryで隔離起動確認（Core exit 0、production TUIのready/終了）を行う。実configの
   非credential fileのhash不変、稼働Core/TUIを再起動していないことを確認する。
6. 配置結果をincrement文書へ記録する（build ID、SHA-256、証拠path）。

push、公開/releaseは別承認とする。配置は新しい起動から適用される。

出口条件: 配置後確認まで完了し、記録がある。

### 段階9: 完了承認・記録・正本反映

1. 利用者が通常利用で動作を確認し、完了を承認する。利用者が確認の省略・代替を明示した場合は、
   その内容と確認済み・確認待ちの範囲を記録する。
2. increment文書の状態を完了にし、確認内容・残課題・未確認を記録する。
3. `.handoff/handoff.md`を更新する。現在地、次の一手、正本へのpointer、承認境界だけを保つ。
4. 未解決の残課題・新たな未採用候補は通常利用メモへ戻す。完了史は残さない。
5. 正本（構想・architecture・roadmap）の変更案は、対象・理由・意味上の変更を提示して明示承認を
   得てから適用する。未適用の間はincrement文書から参照できる形で残す。

出口条件: 利用者が完了を承認し、記録とhandoffが更新された。

## 4. 検証の階層と典型コマンド

| 手段                                 | 目的                             | 使いどころ                          | 条件                                                  |
| ------------------------------------ | -------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| focused test                         | 変更したproduct動作の確認        | 各スライス                          | 計画でproduct動作へ対応付けた範囲                     |
| type check・format・lint・diff check | 変更fileの静的整合               | 各スライス                          | 変更fileと対象test                                    |
| compiled隔離確認（Core/TUI/CLI）     | production経路の表示・操作・保存 | 総合確認。Surface変更はスライスでも | 隔離HOME/XDG、専用tmux、local provider、実provider 0  |
| 実DBコピー比較                       | 保存内容・復元結果の同一性       | 保存・読取・復元の変更              | 実DBはSQLite backupのコピー。稼働Core/TUIを操作しない |
| 実provider call                      | 外部契約下での成立               | 計画が要求し利用者が承認した場合    | 事前に利用者へ対象・回数・保存先を提示                |
| authoritative `v0:gate`              | 全体の整合                       | 計画が要求する場合に安定候補で一回  | coordinating ownerが実行                              |

```sh
# 変更fileのtype check
deno check --config deno.v0.json <files>

# format・lint・空白検査
deno fmt --check <files>
deno lint <files>
git diff --check

# focused test（v0:testと同じ権限で対象fileだけを実行する）
deno test --no-prompt --cached-only --no-check --unstable-worker-options \
  --allow-read --allow-write --allow-run --allow-net=127.0.0.1,localhost \
  --allow-env=HOME,DENO_DIR,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,ZOT_HOME,OPENAI_LOG,OPENAI_CUSTOM_HEADERS,NODE_V8_COVERAGE,HENJI_TEST_PROCESS_RUNNER \
  --allow-sys=uid --config deno.v0.json tests/v0/<test_file>.ts

# 確認用binaryのbuild
deno task --config deno.v0.json henji:compile --output .tools/increment-N/henji

# authoritative gate（安定候補で一回だけ）
deno task --config deno.v0.json v0:gate
```

## 5. 利用者承認が必要な境界

| 対象                    | 承認の内容                                | 記録先                                  |
| ----------------------- | ----------------------------------------- | --------------------------------------- |
| 採用                    | 候補をincrementとして扱い、要件を確定する | increment文書、通常利用メモからの移設   |
| local実装・非破壊的検証 | 実装・検証の範囲                          | increment文書の状態・承認境界           |
| 追加スライス・方式変更  | 計画の意味が変わる変更                    | increment文書の追加承認節               |
| 実provider call         | 対象・回数・保存先                        | increment文書の検証記録                 |
| commit                  | source commitの作成                       | commit、increment文書                   |
| 常用配置                | `dist/henji`・常用binaryの置換            | 配置記録、increment文書                 |
| push・公開/release      | 外部への公開                              | 別承認                                  |
| 正本反映                | 構想・architecture・roadmapの変更         | 正本patch、承認記録                     |
| 実データ削除            | 既存DB・fileの削除                        | 別承認                                  |
| Surface確認の省略       | tmux確認の省略・代替                      | increment文書へ省略内容と確認待ちを記録 |

## 6. reviewの種類・観点・依頼

種類:

- 通常review（既定）: 機能correctness、明示要件、公式外部契約、実利用経路、変更によるregression、
  具体的なtest不足。安全性の一般reviewは利用者が別途明示した場合だけ実施する。
- 批判的review: 構造・処理の変更、利用者依頼、計画で定めた場合に実施する。状態所有、処理の必要性、
  保持・生成されるデータのconsumer、より単純な案、対象外の根拠、無駄な処理の見落とし。

findingの採用条件（3つすべて）:

1. 明示要件・実行証拠・公式契約のいずれかに根拠がある。
2. current sourceから利用者影響までの経路（source-to-impact）を示せる。
3. test追加だけではない、product上のcorrectness問題である。

test不足のfindingは、変更された具体的なproduct動作が未確認であるsource-to-impactを示せる場合だけ
採用する。「testがないこと自体」、未観測variant、将来の仮想的failure、網羅matrix不足はfindingに
しない。

review依頼に含める:

- 目的とreview種別（通常／批判的）。
- 対象（固定したdiff・manifest・file一覧とhash）。
- 確認観点。
- 実行してよいこと（source読取、保存logの読取、focused test実行の可否）。
- 実行しないこと（product source編集、full gate、実provider call、稼働サービス・実DB操作）。
- 時間上限。
- 出力形式（採用条件を満たすfindingは根拠・経路・影響を書く。指摘がない場合は確認した範囲を書く）。
- 結果の保存先（`.tools/increment-N/review*.md`等）。

reviewerは対象のhashを確認し、自分が実行した確認と実行しなかった確認を報告する。

## 7. 記録先の逆引き

| 内容                          | 記録先                                                 |
| ----------------------------- | ------------------------------------------------------ |
| productのWhy・採用境界        | `docs/concepts/`                                       |
| 責務・状態所有・component境界 | `docs/architecture/`                                   |
| 必要機能・実装状態            | `docs/roadmap.md`                                      |
| 個別の要件・計画・結果        | `docs/increments/increment-N.md`                       |
| 調査・比較・採用前の検討      | `docs/research/`                                       |
| 通常利用の観測・未採用候補    | `docs/experience/normal-use-inbox.md`                  |
| 現在地・次の一手・承認境界    | `.handoff/handoff.md`                                  |
| 作業ルール                    | `AGENTS.md`                                            |
| 開発手順                      | `docs/plans/development-workflow.md`                   |
| 操作・配置の記録              | `docs/operations/`                                     |
| 実行証拠（git管理外）         | `.tools/<topic>/`、`.tools/increment-N/`               |
| 正本変更案（未適用）          | `docs/increments/increment-N-authority-proposal.patch` |

## 8. 変更の性質ごとの適用の目安

| 変更の性質                       | 例                              | 計画                            | review                                                 | 確認                                                  |
| -------------------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 局所的な表示・文言・分岐         | TUI配色、tool表示               | 簡潔なincrement（スライス不要） | 実装の通常review（計画reviewは計画次第）               | focused、Surfaceはtmux                                |
| 機能追加・経路変更               | 新しいtool、route整理、表示方式 | incrementと確認計画             | 計画review、実装の通常review                           | focused、compiled隔離、必要なら実provider             |
| 構造・状態所有・保存・購読・読取 | 199のようなData/状態再構成      | incrementとスライス定義         | 計画review（通常＋批判的）、スライスreview、最終review | focused、compiled隔離、実DBコピー、gate（計画時一回） |

review・gateの範囲は利用者の指示と計画で決める。この表は既定の目安であり、件数や工程数を
完了条件にしない。

## 9. 中断と再開

- 中断・セッション終了・別agentへの引継ぎがあり得る。各段階の終わりと各スライスの区切りで、
  increment文書へ「完了した範囲・残り・次の一手・再開に必要な証拠path」を書く。
- handoffは再開入口であり、現在地・次の一手・正本へのpointer・承認境界だけを保つ。
- 引継ぎ時は、現在のsource差分（`git status`・`git diff`）、未commitの成果、実行済み確認と
  未実行確認を引き継ぐ。同じ確認を繰り返さない。

## 10. 付録

### increment文書の骨子

```md
# Increment N — <題名>

状態: <計画案 / local実装・検証済み / commit・常用配置済み / 完了（日付）と承認境界>

## 必要な動作と採用範囲

## 根拠

## 現行のproduct経路と状態所有

## 採用範囲と対象外・撤去

## 実装・確認計画

## スライス（複数の境界にまたがる場合）

## 検証方針

## 正本変更の扱い

## 未確認事項

## 実装・検証の記録（追記）

## 計画review

## Commit・常用配置

## 利用者確認・完了承認
```

### 段階チェックリスト

- 段階1: 要件確認／現行経路／採用範囲・対象外／spike／方針提示
- 段階2: 対応案review／finding対応
- 段階3: increment文書／スライス／検証方針／正本変更の扱い／未確認
- 段階4: 通常review／批判的review／finding反映
- 段階5（各スライス）: 実装／focused test／type check／format／lint／diff check／通常review／
  Surface tmux／記録
- 段階6: 公式build／隔離production確認／実DBコピー（必要時）／実provider（承認時）／ gate（計画時）
- 段階7: 最終review（通常＋批判的）／記録
- 段階8: commit／build（sourceDirty=false）／旧binary退避／atomic配置／配置後確認／記録
- 段階9: 利用者確認／完了記録／handoff／残課題の戻し／正本反映（承認時）
