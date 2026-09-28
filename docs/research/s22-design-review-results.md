# S22設計検討文書 — 通常レビュー・批判的レビュー結果

実施日: 2026-09-27

この記録は下記hashの設計検討文書へのreview結果である。
その後に作成した[詳細設計・slice計画](../plans/s22-detailed-design-and-slices.md)は、このreviewの対象ではない。
設計検討文書の冒頭には、詳細設計へ進む利用者指定と新文書へのpointerを後から追記している。

## 結論と採否

利用者指示に基づき、二人のread-only
reviewerが同じ文書snapshotを独立して確認した。
通常レビュー、批判的レビューともに「詳細設計へ進める」と判断し、採用基準を満たすfindingはなかった。
coordinating ownerもこの判定を採用する。

実装着手・設計採用・実経路の検証完了を意味しない。
文書は設計検討段階と未決事項を明示しており、その未決状態自体を欠陥とは扱わなかった。
次の具体化事項を詳細設計への入力とする。対象設計文書の修正やruntime変更はこのreviewでは行っていない。

## 対象と確認条件

- 主対象:
  [S22設計検討](../plans/s22-http-core-and-tui.md)。スキーマ・コア・UIの整合節を追記した版。
- 補助対象: [AI agent参照実装調査](s22-agent-client-server-comparison.md)。
- 主対象SHA-256:
  `b08601236bd4eeb4f7596bc98d7b0b1991eed2fb89b7d2f85a83a8697b582911`。
- 補助対象SHA-256:
  `3751cc40bd92b76bb2527fd9e81cdb75a509ac7814f4e51bf6052d695de9aa02`。
- Henji source: commit `c4da8f7956d5152f739c868c38f6ca25f1903388`。
- 現在段階: 議論の整理。詳細設計・実装は未承認。
- 評価基準:
  明示要件、現行product経路、状態所有、schema／core／UIの整合、CLI／slash、他要件との関係。
- 初回上限:
  各20分。新しい証拠・tool結果・中間結論が10分なければ部分結果を返す条件。
- 対象外: 一般的security
  review、hardening、仮想状態matrix、互換migration、新feature、full gate。

reviewerには会話履歴を継承せず、目的・権限・正本・確認範囲・停止条件をまとめた一時context
packetと、 凍結した対象文書を渡した。主対象への変更はreview中に行っていない。

## 通常レビュー

採用対象のfindingなし。次の主要記述は指定sourceとproduct正本に一致していた。

- 共有スキーマを状態ownerにせず、コア正本、API read model、client
  projection、UI-local stateを区別している。
- follow-upのコア移管、非同期steeringの受付結果待ち、表示切替と旧Host終了の分離は、現行経路の変更として必要な箇所を捉えている。
- 再開時の保存`activeModel`優先、`/new`のselection引継ぎ、invocation
  timeout、TUI専用`--root-provider`の説明は現行sourceと一致している。
- UI detach、execution
  cancel、コアshutdownを分ける方向は、UI終了後も実行を続けたいという希望に対応している。
- S4、A2、A21、E3、P10の未採用機能を、API分離によって自動的に追加する矛盾は確認しなかった。

任意の説明改善として、設計文書119行の依存図について、呼出し方向とimport依存を詳細設計で明確にするとよい。
`コア内部・application service → API adapter・projection`がserviceを呼ぶadapterを示すなら、依存矢印は反転する。
serviceが抽象出力portを呼ぶ構成なら、portと具体adapterを分けて示す。
この図だけから具体的な機能回帰は立証されておらず、必須修正findingには採用しない。

## 批判的レビュー

採用を妨げる文書内の矛盾は確認できず、重大度付きfindingなし。
次の四点は、文書が既に認識している未決事項を、現行sourceから具体化した詳細設計の入力である。

### 1. 受付・commit・清算・次task開始の境界

現行[ExecutionCoordinator.submit](../../v0/agent/worker/worker_host_coordinator.ts#L1330)は、
execution identity、durable admission、canonical
commit、process清算を扱い、完了後に結果を返す。
`turn_end`配信後にも清算があり、`active=false`になる地点は同fileの1957〜1958行である。
現在のTUI
follow-upは[submit完了後](../../v0/tui/controller.ts#L1228)に開始する。

現在の完了PromiseをHTTPの受付応答へ直接対応付けると、受付通知がturn完了まで遅れる。
逆に、`turn_end`だけで次taskを送ると、Hostがまだbusyの経路へ到達する。
詳細設計では受付確定、結果確定、canonical採用、次taskを開始できる地点を区別し、
follow-upの起動をコアserviceの所有にする必要がある。

設計文書は受付と完了の区別およびfollow-up移管を明示しており、その具体化事項として扱う。

### 2. Session表示切替とWorker lifetime

現行[switchTo](../../v0/agent/worker/worker_tui_session.ts#L804)は旧Hostをcloseし、表示bindingを置き換える。
`createNew`も旧Hostのcloseを行い、closeは子実行の清算、Worker終了、Session
handle終了へ進む。

表示切替をそのまま現行navigationへ写すと、表示を離れただけで旧Sessionの実行が停止する。
初回incrementの稼働Session単位と、表示を離れたHostの保持・終了条件を決める必要がある。
保存履歴を閲覧するだけなら、既存lazy/read-only経路を利用できる。
複数Sessionの同時実行を、このreviewから新たな必須機能として採用することはしない。

設計文書はこの現行closeとの違いを明示しており、次段階のscope判断として扱う。

### 3. liveとsnapshotのtool identity

現行adapterは[turn_startでcall採番をリセット](../../v0/presentation/tui_presentation_adapter.ts#L125)する。
一方、[restored projection](../../v0/presentation/adapter_projection.ts#L418)は復元会話全体で通算採番する。
第2turnのtoolがliveでは`call-1`、復元snapshotでは`call-2`等になる経路がある。

このprojectionをそのまま共有APIへ使うと、再接続で同じtoolのidentityが変わり、
snapshotとeventの照合・二重適用防止には使えない。 共有read modelでtool
occurrenceの識別scopeを定め、表示用採番との対応を揃える必要がある。

文書は現行Presentation
contractをそのまま公開しない方針とsnapshot／event整合を明示している。
現在TUIの修正findingとして扱わず、今回の共有スキーマ詳細化に必要な具体例として採用する。

### 4. attach時の設定scopeと既存CLI

現行[tui_cli](../../v0/agent/cli/tui_cli.ts#L343)はDefinition、provider宣言、timeout、maxSteps等を
一つのfactoryへ渡し、その設定がSession切替先にも適用される。
独立Hostへのattachでは、UIのoptionがどのSession・generation・executionへ効くかを定める必要がある。

各optionの対象と適用時点、コア側configとUI接続設定の所在を詳細設計で決める。
`--no-session`を初回範囲に含める場合は、保存Session一覧に依存せず、継続中のruntime
Sessionへ 再接続する選択方法も同じ判断に含める。
全CLIのHTTP化、`runtime.json`、`run --root-provider`の追加は必須とはしない。

文書は設定scopeとCLI起動UXを未決としており、その具体化事項として扱う。

## Coordinating ownerの整理

両reviewの結論は、設計検討文書の段階に対して妥当である。
上の四点は既存sourceから利用者の期待へつながる具体的な判断であり、
次の詳細設計で共有schema／コアservice／client
projectionの対応を定める材料として採用する。
それを理由に独立Hostの方向を撤回したり、新しい機能や制限を追加したりしない。

詳細設計では、起動UX、workspace／Session稼働scope、設定scopeと併せて、
受付・完了・commit・次task開始、tool
identity、snapshotとeventの接続を具体化する。
実装範囲とarchitecture・roadmapの意味変更は別途採用判断が必要である。

## 確認範囲と限界

通常reviewは、凍結design／research、product正本の該当部分、TUI起動、adapter、Controller／pending、
navigation、selection authority、history本文state、関連候補を静的確認した。
批判的reviewは、受付／commit／清算、follow-up、navigation、CLI設定、Presentation
eventと復元projectionを重点確認した。

HTTP実装、production TUI、provider動作、参照productの実行は確認していない。
通常reviewはupstream sourceの独立再照合も行っていない。
reviewerによるfile変更、test、gate、provider call、外部書込みはない。
対象文書を変更していないため、re-reviewは実施していない。

## 追加の批判的レビュー: gpt-6-astra

利用者の追加指示に基づき、gpt-6-astraが同じ凍結文書を独立してread-onlyで確認した。
既存reviewの判定は入力に含めず、Blocking／P1だけを対象とし、P2以下の検討・提案は対象外とした。
上限は10分。2026-09-27 10:30〜10:32 UTCの間に完了し、延長していない。

**結論: 詳細設計への進行を妨げるBlocking／P1は確認できなかった。** coordinating
ownerもこの判定を採用する。

継続実行を壊す現行のUI依存は設計上の変更対象に含まれており、
状態所有、受付と完了、再接続の提案にも、主要操作を破綻させる具体的な矛盾は確認されなかった。
既知の詳細設計上の未決事項は、未指定であることだけを理由に重大findingへ引き上げていない。

確認範囲は、凍結した設計・調査文書、関連する構想・architecture・要件、
現行sourceの入力受付、follow-up自動実行、Session切替、終了処理、共有contract、履歴保存経路。
HTTP化後の実動作と参照実装の実行結果は未確認であり、実装の成立を保証する判定ではない。
対象文書のhashは追加review後も変わっていない。
