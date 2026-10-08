# Increment索引

更新日: 2026-10-08。文書が存在する全215件（通常117件、アーカイブ98件）を番号順に掲載する。

更新運用: incrementがまとまった数だけ溜まったときに一括更新する。新規incrementの作成・完了ごとの
随時更新は行わない。掲載範囲・件数は上記更新日時点のものである。

217までの既存incrementは2026-10-08の利用者判断で一律完了。208以前の2026-10-07完了記録は保持する。
各文書冒頭の「現在の状態」を参照する。
当時の実施・未実施記録は保持しており、現在の機能・仕様は構想、architecture、roadmapの各正本を参照する。
この索引は文書への入口であり、実装・検証の再確認や欠番の状態判定は行わない。

- [Increment 2-50](#increment-2-50)
- [Increment 51-100](#increment-51-100)
- [Increment 101-150](#increment-101-150)
- [Increment 151-217](#increment-151-217)
- [合同検証・配置等の記録](#合同検証配置等の記録)

アーカイブは[docs/history/increments](../history/increments/)に置く。
10〜50の移動判断は[文書整理調査](../history/increments-10-50-inventory.md)を参照する。

## Increment 2-50

| 番号 | 題名 | 保存先 | 補助記録 |
| --- | --- | --- | --- |
| [2](../history/increments/increment-2.md) | step budgetとworkspace表示 | アーカイブ | [increment-2-results.md](../history/increments/increment-2-results.md) |
| [3](../history/increments/increment-3.md) | 履歴からの復帰と画面の視覚的境界 | アーカイブ | [increment-3-results.md](../history/increments/increment-3-results.md) |
| [4](../history/increments/increment-4.md) | conversation識別、history export、read継続読込み | アーカイブ | [increment-4-results.md](../history/increments/increment-4-results.md) |
| [5](../history/increments/increment-5.md) | conversation label識別とbash全出力readback | アーカイブ | [increment-5-results.md](../history/increments/increment-5-results.md) |
| [6](../history/increments/increment-6.md) | recoverable inputとwork tool component化 | アーカイブ | [increment-6-results.md](../history/increments/increment-6-results.md) |
| [7](../history/increments/increment-7.md) | Henji-owned Web search | アーカイブ | [increment-7-results.md](../history/increments/increment-7-results.md) |
| [8](../history/increments/increment-8.md) | Web search grounding | アーカイブ | [increment-8-results.md](../history/increments/increment-8-results.md) |
| [9](../history/increments/increment-9.md) | Web search citation links | アーカイブ | [increment-9-results.md](../history/increments/increment-9-results.md) |
| [10](../history/increments/increment-10.md) | 非対話CLIのheadless Host / Worker統合 | アーカイブ | — |
| [11](../history/increments/increment-11.md) | ユーザー起動型production CLI基本E2E | アーカイブ | — |
| [12](../history/increments/increment-12.md) | 同一Session内のOpenRouter model/effort切替 | アーカイブ | — |
| [13](../history/increments/increment-13.md) | provider deadlineと固定Session footer | アーカイブ | — |
| [14](../history/increments/increment-14.md) | generic provider routeとOpenAI direct API | アーカイブ | — |
| [15](../history/increments/increment-15.md) | 同一Session内のroot provider切替 | アーカイブ | — |
| [16](../history/increments/increment-16.md) | built-in instruction component | アーカイブ | — |
| [17](../history/increments/increment-17.md) | ChatGPT subscription root provider feasibility | アーカイブ | — |
| [18](../history/increments/increment-18.md) | tool activityの意味的preview | アーカイブ | — |
| [19](../history/increments/increment-19.md) | busy activity indicator | アーカイブ | — |
| [20](../history/increments/increment-20.md) | source準拠instructionと入力前status | アーカイブ | — |
| [21](../history/increments/increment-21.md) | OpenRouter mixed text/tool-call互換性 | アーカイブ | — |
| [22](../history/increments/increment-22.md) | production SSE継続とlimit正本化 | アーカイブ | — |
| [23](../history/increments/increment-23.md) | 取得済み結果の再利用、調査終了、tool実行境界 | アーカイブ | — |
| [24](../history/increments/increment-24.md) | OpenRouter provider request retry | アーカイブ | — |
| [25](../history/increments/increment-25.md) | Bash workspace開始directoryの明示 | アーカイブ | — |
| [26](../history/increments/increment-26.md) | Compaction provider failure diagnostic | アーカイブ | — |
| [27](../history/increments/increment-27.md) | Retained TUI描画への一本化 | アーカイブ | — |
| [28](../history/increments/increment-28.md) | Busy経過時間とSession識別情報 | アーカイブ | — |
| [29](../history/increments/increment-29.md) | 自動context変換の停止 | アーカイブ | — |
| [30](../history/increments/increment-30.md) | 履歴表示の一貫性と検索試行の取り下げ | アーカイブ | — |
| [31](../history/increments/increment-31.md) | セッション開始時のヘッダー充実 | アーカイブ | — |
| [32](../history/increments/increment-32.md) | standalone executableとexternalization共通境界 | アーカイブ | — |
| [33](../history/increments/increment-33.md) | local managed Agent Definition revision | アーカイブ | — |
| [34](../history/increments/increment-34.md) | Definition revision transport | アーカイブ | — |
| [35](../history/increments/increment-35.md) | TUI `/new` Session creation | アーカイブ | — |
| [37](../history/increments/increment-37.md) | 外部情報調査のtool・source選択instruction | アーカイブ | — |
| [38](../history/increments/increment-38.md) | stopped execution recall | アーカイブ | — |
| [39](../history/increments/increment-39.md) | cancellation stream settlement | アーカイブ | — |
| [40](../history/increments/increment-40.md) | destructive SQLite canonical history cutover | アーカイブ | — |
| [41](../history/increments/increment-41.md) | durable active execution and live journal | アーカイブ | — |
| [42](../history/increments/increment-42.md) | exact context attribution | アーカイブ | — |
| [43](../history/increments/increment-43.md) | human history view | アーカイブ | — |
| [44](../history/increments/increment-44.md) | post-SQLite consistency and obsolete-code cleanup | アーカイブ | — |
| [45](../history/increments/increment-45.md) | native Skill description acceptance | アーカイブ | — |
| [46](../history/increments/increment-46.md) | TUI build version header | アーカイブ | — |
| [47](../history/increments/increment-47.md) | Temporary `/new` Session binding | アーカイブ | — |
| [48](../history/increments/increment-48.md) | Sole slash command completion | アーカイブ | — |
| [49](../history/increments/increment-49.md) | durable history storage amplification investigation | アーカイブ | — |
| [50](../history/increments/increment-50.md) | normalized history authority and active Session projection | アーカイブ | — |

## Increment 51-100

| 番号 | 題名 | 保存先 | 補助記録 |
| --- | --- | --- | --- |
| [51](../history/increments/increment-51.md) | managed Henji base instruction | アーカイブ | — |
| [52](../history/increments/increment-52.md) | human-readable instruction install receipt | アーカイブ | — |
| [53](../history/increments/increment-53.md) | TUI startupのactive base表示とsession pickerのlocal time・1行化 | アーカイブ | — |
| [54](../history/increments/increment-54.md) | managed Henji Instructionのuninstall | アーカイブ | — |
| [55](../history/increments/increment-55.md) | instruction CLIの短縮revisionと人間向けlist/active表示 | アーカイブ | — |
| [56](../history/increments/increment-56.md) | instruction install receiptとdeactivateの人間向け出力 | アーカイブ | — |
| [57](../history/increments/increment-57.md) | instruction CLI出力の短縮digest統一 | アーカイブ | — |
| [58](../history/increments/increment-58.md) | OpenRouter Responses API経路（built-in） | アーカイブ | — |
| [59](../history/increments/increment-59.md) | Provider宣言seam（data-only）とOpenRouter Responsesのexternal化 | アーカイブ | — |
| [60](../history/increments/increment-60.md) | 宣言catalog/defaultsの動的選択への反映 | アーカイブ | — |
| [61](../history/increments/increment-61.md) | provider identityの一般化と新しいprovider id（Responses先行） | アーカイブ | — |
| [62](../history/increments/increment-62.md) | Responses replayのprovider identity一般化 | アーカイブ | — |
| [63](../history/increments/increment-63.md) | 既定selectionの外部化とbuilt-in providerのoverride-aware解決 | アーカイブ | — |
| [64](../history/increments/increment-64.md) | 同梱default declarationsと宣言chat completions provider | アーカイブ | — |
| [65](../history/increments/increment-65.md) | activation-level subagent slot binding | アーカイブ | — |
| [66](../history/increments/increment-66.md) | provider切替UIの修正 | アーカイブ | — |
| [67](../history/increments/increment-67.md) | Responses APIの`auto` effort修正 | アーカイブ | — |
| [68](../history/increments/increment-68.md) | provider id整列とbuilt-in id移行 | アーカイブ | — |
| [69](../history/increments/increment-69.md) | tool Definition資源kindとweb_searchの外部化 | アーカイブ | — |
| [70](../history/increments/increment-70.md) | tool宣言のDefinition統一とweb_fetch | アーカイブ | — |
| [71](../history/increments/increment-71.md) | 組み込みwork toolのtool Definition統一 | アーカイブ | — |
| [72](../history/increments/increment-72.md) | named subagentの一般化 | アーカイブ | — |
| [73](../history/increments/increment-73.md) | busy表示を`working`＋spinnerへ変更 | アーカイブ | — |
| [74](../history/increments/increment-74.md) | terminal出力の同期writeによる表示凍結の修正（TUI進捗） | アーカイブ | — |
| [75](../history/increments/increment-75.md) | `/sessions`一覧の耐性（不正recordによる全件失敗の解消） | アーカイブ | — |
| [76](../history/increments/increment-76.md) | 保存Sessionの閲覧と現行Definitionでの継続 | アーカイブ | — |
| [77](../history/increments/increment-77.md) | builtin resource revisionをclosure内容で識別する | アーカイブ | — |
| [78](../history/increments/increment-78.md) | build provenanceと未使用コードの整合 | アーカイブ | — |
| [79](../history/increments/increment-79.md) | product正本とdelegation契約の整合 | アーカイブ | — |
| [80](../history/increments/increment-80.md) | `web_fetch`取得URLのtool activity表示（S7） | アーカイブ | — |
| [81](../history/increments/increment-81.md) | フッターを3行化（Session情報行とmodel行の分離） | アーカイブ | — |
| [82](../history/increments/increment-82.md) | startup headerのbase instruction表記・skills複数行・時刻のタイムゾーン追従 | アーカイブ | — |
| [83](../history/increments/increment-83.md) | streaming中のassistantラベルを完了後の色に揃える | アーカイブ | — |
| [84](../history/increments/increment-84.md) | assistant本文の読みやすいレイアウトとMarkdownタグ着色 | アーカイブ | — |
| [85](../history/increments/increment-85.md) | recoverable stopの可視化とprovider deadline延長 | アーカイブ | — |
| [86](../history/increments/increment-86.md) | observation journalingの非ブロッキング化（バッチINSERT） | アーカイブ | — |
| [87](../history/increments/increment-87.md) | journalingのper-insert走査除去（worker_sequence index） | アーカイブ | — |
| [88](../history/increments/increment-88.md) | B6表示凍結の現象と原因（調査記録） | アーカイブ | — |
| [89](../history/increments/increment-89.md) | context履歴の増分revision化 | アーカイブ | — |
| [90](../history/increments/increment-90.md) | 追跡可能な履歴authorityとsegment storeの再設計 | アーカイブ | — |
| [91](../history/increments/increment-91.md) | bounded Worker cancellation and generation recovery | アーカイブ | — |
| [92](../history/increments/increment-92.md) | auxiliary provider開始停止の直接原因特定 | アーカイブ | — |
| [93](../history/increments/increment-93.md) | terminal ledger後のprotocol観測分離 | アーカイブ | — |
| [94](../history/increments/increment-94.md) | 目的別history authorityの再設計（history v7） | アーカイブ | — |
| [95](../history/increments/increment-95.md) | 会話ログのPageDownがassistant本文で停止する修正 | アーカイブ | — |
| [96](../history/increments/increment-96.md) | assistant Markdownの見出し全行着色と強調（`*`/`**`/`***`）の緑化 | アーカイブ | — |
| [97](../history/increments/increment-97.md) | recovery laneの削除（S9採用） | アーカイブ | — |
| [98](../history/increments/increment-98.md) | コードの無着色化とPageUpのoldest到達修正 | アーカイブ | — |
| [99](../history/increments/increment-99.md) | `/history`廃止と`henji history` CLIへの統一（S11/S12統合） | アーカイブ | — |
| [100](../history/increments/increment-100.md) | provider request deadlineが実streamで発火しない問題の調査と修正 | アーカイブ | — |

## Increment 101-150

| 番号 | 題名 | 保存先 | 補助記録 |
| --- | --- | --- | --- |
| [101](increment-101.md) | auth profile一般化と宣言request header（OpenCode Go対応） | 通常 | — |
| [102](increment-102.md) | 外部integration依頼の調査順序方針（A9） | 通常 | — |
| [103](increment-103.md) | built-in base instructionの最小化と外部instructionの直接読み込み（E4） | 通常 | — |
| [104](increment-104.md) | `henji run`の構造化出力（P1） | 通常 | — |
| [105](increment-105.md) | 置換済みv5/v6 history実装の除去 | 通常 | — |
| [106](increment-106.md) | 同期subagentの削除（計画上のIncrement A） | 通常 | — |
| [107](increment-107.md) | async run contractの確定（計画上のIncrement B0） | 通常 | — |
| [108](increment-108.md) | Host責務の分割（計画上のIncrement B） | 通常 | — |
| [109](increment-109.md) | 非同期subagentの実装（計画上のIncrement C） | 通常 | — |
| [110](increment-110.md) | async child run contractの収束 | 通常 | — |
| [111](increment-111.md) | async child evidence／diagnostic parity | 通常 | — |
| [112](increment-112.md) | async child構造の単純化 | 通常 | — |
| [113](increment-113.md) | codebase構造の単純化review | 通常 | — |
| [114](increment-114.md) | 現行コードベースの重大セキュリティ経路review | 通常 | — |
| [115](increment-115.md) | headless既定rootのagent binding適用 | 通常 | — |
| [116](increment-116.md) | Chat provider応答と切替後のprivate state | 通常 | — |
| [117](increment-117.md) | 未使用の履歴処理と旧UI経路の除去 | 通常 | — |
| [118](increment-118.md) | キャンセル後のTUI表示ID衝突の修正 | 通常 | — |
| [119](increment-119.md) | reasoningの継続リクエストへの再送 | 通常 | — |
| [120](increment-120.md) | 読めるthinkingを通常履歴に表示 | 通常 | — |
| [121](increment-121.md) | 通常実行の診断記録を短い手掛かりへ縮小 | 通常 | — |
| [122](increment-122.md) | 失敗行の赤字表示とSession種別ごとの`/recall`案内 | 通常 | — |
| [123](increment-123.md) | thinking本文の段落と折り返し | 通常 | — |
| [124](increment-124.md) | 保存Sessionのthinking復元と全履歴の閲覧 | 通常 | — |
| [125](increment-125.md) | 失敗行のExecution ID表示 | 通常 | — |
| [126](increment-126.md) | provider deadlineとmodel step既定値の拡張 | 通常 | — |
| [127](increment-127.md) | 外部reviewerと組み込みplannerの廃止 | 通常 | — |
| [128](increment-128.md) | ターン実行中のPageUp／PageDown履歴参照 | 通常 | — |
| [129](increment-129.md) | ツール呼び出しに添えたassistant本文の履歴表示（S14） | 通常 | — |
| [130](increment-130.md) | PageUpで履歴の真の先頭へ到達する | 通常 | — |
| [131](increment-131.md) | 誰でもないサブエージェント（agent:generic）と起動時モデル指定 | 通常 | — |
| [132](increment-132.md) | 通常実行中の逐次表示（S16）と長時間利用時の入力応答 | 通常 | — |
| [133](increment-133.md) | ツール資源の所有と終了処理、端末入力の競合防止 | 通常 | — |
| [134](increment-134.md) | assistant途中本文の保存粒度（A12） | 通常 | — |
| [135](increment-135.md) | Henji内credential登録（S2） | 通常 | — |
| [136](increment-136.md) | subagent起動時のagent名表示（S21） | 通常 | — |
| [137](increment-137.md) | Responsesの本文・tool call併存時の表示順と履歴本文欠落の修正（S23） | 通常 | — |
| [138](increment-138.md) | 子Agentの作業状況取得とrequest factの保存・readback（A20・A22） | 通常 | — |
| [139](increment-139.md) | S22 Slice 1: 共通read modelとコアqueryの分離 | 通常 | — |
| [140](increment-140.md) | S22 Slice 2: 独立serveと読み取り接続TUI | 通常 | — |
| [141](increment-141.md) | S22 Slice 3: submit・cancel・途中実行の再接続 | 通常 | — |
| [142](increment-142.md) | S22 Slice 4: steering・follow-upのコア所有 | 通常 | — |
| [143](increment-143.md) | S22 Slice 5: Session操作とactivation設定 | 通常 | — |
| [144](increment-144.md) | S22 Slice 6: catalog・credential・pathをCoreへ移す | 通常 | — |
| [145](increment-145.md) | S22 Slice 7: Coreの発見・自動起動・独立lifetime・明示停止 | 通常 | — |
| [146](increment-146.md) | S22 Slice 8: 通常入口切替・配布・旧経路整理 | 通常 | — |
| [147](increment-147.md) | none Sessionの継続taskと会話表示 | 通常 | — |
| [148](increment-148.md) | HTTP接続TUIの起動ヘッダ・実行状態・入力クリア | 通常 | — |
| [149](increment-149.md) | A25 Slice 1・初回DB作成とread-only起動の同期 | 通常 | — |
| [150](increment-150.md) | A25 Slice 2・共有DBの発見・write待機・recovery | 通常 | — |

## Increment 151-217

| 番号 | 題名 | 保存先 | 補助記録 |
| --- | --- | --- | --- |
| [151](increment-151.md) | A25 Slice 3・Core別discoveryと新規起動 | 通常 | — |
| [152](increment-152.md) | A25 Slice 4・Core一覧・ID解決・個別管理 | 通常 | — |
| [153](increment-153.md) | A25 Slice 5・TUIでのCore指定・識別と通常利用の完成 | 通常 | — |
| [154](increment-154.md) | S17・S18・S19統合: TUIの文字幅・更新合流・行差分・同期出力 | 通常 | [increment-154-measurements.json](increment-154-measurements.json) |
| [155](increment-155.md) | S25: TUIからCoreを停止する操作とスラッシュ案内 | 通常 | — |
| [156](increment-156.md) | S15: 履歴閲覧中のEscで最新表示へ戻る | 通常 | — |
| [157](increment-157.md) | E6: providerの現行モデル一覧とお気に入り | 通常 | — |
| [158](increment-158.md) | フッター2・3行目の区切りとラベル省略 | 通常 | — |
| [159](increment-159.md) | フッター・操作案内・コマンドピッカーの整理 | 通常 | [increment-159-plan-review.md](increment-159-plan-review.md)、[increment-159-slice-reviews.md](increment-159-slice-reviews.md) |
| [160](increment-160.md) | ミニマルなフッターデザイン | 通常 | — |
| [161](increment-161.md) | セッションピッカーからの個別削除 | 通常 | — |
| [162](increment-162.md) | コマンドピッカーの英語表記 | 通常 | — |
| [163](increment-163.md) | Sign in with ChatGPTによるChatGPT契約枠の利用 | 通常 | — |
| [164](increment-164.md) | Markdown見出しをcyanで表示 | 通常 | — |
| [165](increment-165.md) | Responsesで表示用reasoning summaryを要求する | 通常 | — |
| [166](increment-166.md) | system通知を対象executionの表示位置へ置く | 通常 | — |
| [167](increment-167.md) | Session表示履歴の整合性 | 通常 | — |
| [168](increment-168.md) | シアンとグリーンの表示色を交換 | 通常 | — |
| [169](increment-169.md) | provider failureへのrecall案内 | 通常 | — |
| [170](increment-170.md) | 共通逐次更新による会話表示と操作経路 | 通常 | — |
| [171](increment-171.md) | 256色最低ラインのuser行パネルと見出し色 | 通常 | — |
| [172](increment-172.md) | Exa検索への置き換えとweb_fetchのダウンロード | 通常 | — |
| [173](increment-173.md) | 外部toolを含む共通APIキー登録 | 通常 | — |
| [174](increment-174.md) | ChatGPT未登録時もprovider一覧と選択を使えるようにする | 通常 | — |
| [175](increment-175.md) | 最終回答時にも受け付けた追加指示を取り込む | 通常 | — |
| [176](increment-176.md) | 失敗の分類と短い診断情報の拡充 | 通常 | — |
| [177](increment-177.md) | 未使用実装・旧経路テストの撤去と通常test入口の整備 | 通常 | — |
| [178](increment-178.md) | ChatGPTの最新モデルを固定候補へ追加 | 通常 | — |
| [179](increment-179.md) | HTTP/SSEとhenji runの入出力adapterをWorkerへ分離 | 通常 | — |
| [180](increment-180.md) | Coreの実行状態全件転記とtask受付後の重複再投影を削除 | 通常 | — |
| [181](increment-181.md) | E6: JSON Agent設定・tool読込・履歴DBの簡素化 | 通常 | [increment-181-contract.md](increment-181-contract.md) |
| [182](increment-182.md) | B10: ChatGPT子Agentへの認証登録ID継承 | 通常 | — |
| [183](increment-183.md) | S26 CLIエラーの理由・使い方案内 | 通常 | — |
| [184](increment-184.md) | S24 子Agent起動行にtaskの冒頭を表示 | 通常 | — |
| [185](increment-185.md) | A18 bash timeout説明・引数エラーの具体化 | 通常 | — |
| [186](increment-186.md) | A15 外部searchとweb toolのpackage配布 | 通常 | [increment-186-authority-proposal.patch](increment-186-authority-proposal.patch) |
| [187](increment-187.md) | searchの出現数集計 | 通常 | [increment-187-authority-proposal.patch](increment-187-authority-proposal.patch) |
| [188](increment-188.md) | editの対象ファイル上限を1 MiBへ拡張 | 通常 | — |
| [189](increment-189.md) | A26 最小hook機構とruntime開始日時の外部定義 | 通常 | [increment-189-authority-proposal.patch](increment-189-authority-proposal.patch) |
| [190](increment-190.md) | openai-chatのモデル一覧からgpt-6.1-solを除外 | 通常 | — |
| [191](increment-191.md) | 標準run_typescriptと実行時std import | 通常 | [increment-191-authority-proposal.patch](increment-191-authority-proposal.patch) |
| [192](increment-192.md) | openai-chat同梱routeの廃止 | 通常 | [increment-192-authority-proposal.patch](increment-192-authority-proposal.patch) |
| [193](increment-193.md) | Solarized Darkを活かすTUI配色 | 通常 | — |
| [194](increment-194.md) | TUI待機ループの古いフレーム保持を解消する | 通常 | — |
| [195](increment-195.md) | Coreの保存会話復元で累積本文を一括保持しない | 通常 | — |
| [196](increment-196.md) | Session metadata取得で不要な履歴本文を展開しない | 通常 | — |
| [197](increment-197.md) | tool名とthinking系ラベルの緑dim | 通常 | — |
| [198](increment-198.md) | alternate screenの更新依存と可視範囲加工 | 通常 | — |
| [199](increment-199.md) | Data Workerの必要な仕事から状態・保存・公開・読取を再構成する | 通常 | [increment-199-a28-observations.md](increment-199-a28-observations.md) |
| [200](increment-200.md) | 専用toolをbashより優先し、出力の扱いを指定する案内 | 通常 | — |
| [201](increment-201.md) | 読み取り専用のinspection tool（git_inspect新設・search entries拡張） | 通常 | — |
| [202](increment-202.md) | searchのテキスト検索・出力上限とrun_typescript返却上限 | 通常 | — |
| [203](increment-203.md) | B12: binary更新後のprocess runner起動と早期終了の原因表示 | 通常 | — |
| [204](increment-204.md) | credential保存先の分離とrun_typescriptのconfig root読み取り | 通常 | — |
| [205](increment-205.md) | S34: `search`の検索条件・`run_typescript`の生成コードの抜粋表示 | 通常 | — |
| [206](increment-206.md) | A36・A37: file集計と専用toolの選択案内 | 通常 | — |
| [207](increment-207.md) | TUI入力: Shift+Enterで改行（tmux経路の拡張キー） | 通常 | — |
| [208](increment-208.md) | TUI: マウススクロールで会話履歴を参照する | 通常 | — |
| [209](increment-209.md) | HTTP APIの不要な処理を整理する | 通常 | — |
| [210](increment-210.md) | Coreの重複照会・再投影を整理する | 通常 | — |
| [211](increment-211.md) | S32・S37: 入力履歴の削除とキャンセル・Session一覧キーの変更 | 通常 | — |
| [212](increment-212.md) | S36: TUIの会話履歴表示を端末scrollbackへ任せる | 通常 | — |
| [213](increment-213.md) | tool共通のファイルアクセス設定 | 通常 | — |
| [214](increment-214.md) | モデル入力の未使用サイズ計測と重複コピーを整理する | 通常 | — |
| [215](increment-215.md) | CoreからData保存実装への不要な実行時依存を除く | 通常 | — |
| [216](increment-216.md) | 選択したCLIコマンドの入口を読み込む | 通常 | — |
| [217](increment-217.md) | 選択protocolに応じたprovider adapterの読み込み | 通常 | — |

## 合同検証・配置等の記録

- [A25・Increment149〜153 — 完了・commit・push・常用配置](a25-deployment-2026-09-29.md)
- [Increment 1〜132 — 配置binary・実providerの基本E2E計画と結果](e2e-001-132-2026-09-27.md)
- [1〜132 E2E追加確認 — Agentによる参照、stream修正、Go原因調査](e2e-001-132-followup-2026-09-27.md)
- [Increment 133〜138 — 配置済みbinaryの基本E2E（2026-09-27）](e2e-133-138-2026-09-27.md)
- [Increment 179と180 配置版の基本E2E](e2e-179-180-2026-10-03.md)
- [Increment 181 最終実provider E2E計画](e2e-181-plan.md)
- [S22・Increment 147 — commit・push・常用配置](s22-deployment-2026-09-28.md)
