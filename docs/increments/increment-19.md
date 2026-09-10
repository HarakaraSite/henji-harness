# 通常利用 increment 19 — busy activity indicator

ステータス: **local実装・gate完了、production目視確認待ち**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- task送信後、provider responseやtool resultを待って表示eventがしばらく増えない場合も、Henjiがbusyで
  動作中だと一目で分かる。
- busy中の一時status、follow-up、steering、cancel等の操作案内を失わず、activity indicatorと同時に読める。
- busy中に、その場で使えるcancel操作が`Esc cancel`だと分かる。
- turnがready、recoverable error、fatal、終了のいずれかへ移ったら、点滅が直ちに止まる。

## 根拠と現行product経路

- production retained TUIのfooter第一行は現在`[busy]`を表示するが、provider/toolのeventが到着しない間は
  静止したままであり、利用者が処理継続中かを視覚的に判断しにくい。
- retained TUIは`UiState.lifecycle === 'busy'`としてactive turnを所有し、event、resize、editor、status変更時に
  full frameを再描画する。
- 利用環境のGhosttyが公開するterminfoは、SGR 5のblink sequenceを`blink=\\E[5m`として通知している。
  現行rendererは最終terminal frameで既にSGR color/resetを扱うため、timerや周期的なfull-frame redrawなしに
  同じ境界でblinkを適用できる。実際の点滅可否はterminal設定にも依存するため、production目視確認を残す。
- activity indicatorはHost-localなSurface stateだけで決定できる。Worker、provider、Session、canonical transcript、
  Presentation eventの変更は不要である。

## 表示contract

production retained TUIのfooter第一行で、busy lifecycle中だけprimary statusをANSI SGR 5で点滅表示する。

```text
[busy · Esc cancel]
[cancelling · Esc cancel]
```

- 点滅対象はbracket内のprimary status tokenだけとする。`busy · steer applied`、
  `busy; /provider waits for ready`等の詳細status、`Esc cancel`、footer第二行は点滅させない。
- cancelling中はprimary status tokenの`cancelling`を点滅させる。
- busy lifecycle中はfooter第一行に`Esc cancel`を常時表示する。狭幅時は既存footerの優先度・truncation規則に従い、
  primary statusを残して操作案内を先に省略する。
- lifecycleがbusy以外へ移ったframeではblink sequenceを出力しない。blink対象の直後にSGR resetを置き、
  続く詳細・操作案内や他行へstyleを漏らさない。
- stylingはproduction retained terminal frameだけに適用する。plain layout snapshot、canonical transcript、
  Presentation stateへANSI sequenceを混入させない。

## 実装計画

1. footer構成でbusy lifecycle中だけ`Esc cancel`を低優先度の操作案内として加え、primary statusと既存詳細を
   保持する。
2. retained terminal frameのfooter第一行を描画するとき、busy lifecycle中のprimary status範囲だけをSGR 5と
   SGR resetで囲む。layout textとPresentation stateは変更しない。
3. focused product testで、busy/cancellingのprimary statusだけが点滅すること、詳細と`Esc cancel`が通常styleで
   読めること、ready/errorではblink sequenceを出さないこと、plain snapshotにANSIがないことを確認する。
4. roadmap、architecture、increment文書、handoffを実装結果へ合わせる。
5. focused test、該当type check、format、lint、`git diff --check`、差分reviewを行い、安定候補で
   authoritative `v0:gate`を一回実行する。

## Product確認

| 動作                                  | 確認方法                                                               |
| ------------------------------------- | ---------------------------------------------------------------------- |
| eventが来ないbusy中も動作中だと分かる | retained frameのprimary status範囲にSGR 5があることを確認              |
| busyのstatusと操作案内を維持する      | follow-up、steering、wait、cancelling statusと`Esc cancel`を同時に確認 |
| 点滅を他の表示へ漏らさない            | primary status直後のSGR resetと、詳細・第二footer行の通常styleを確認   |
| settlement後は点滅しない              | ready/recoverable/fatal frameにSGR 5がないことを確認                   |
| stateへANSIを混入させない             | layout snapshotのfooter textがplain textであることを確認               |

local実装とauthoritative gate後、利用者がproduction retained TUIの通常taskで、待機中の点滅とsettlement後の
通常表示を目視確認する。Codex側から実provider taskまたはreal-TTY E2Eを自動実行しない。

## 実装結果

- `v0/tui/layout.ts`はbusy lifecycle中のfooterへ低優先度の`Esc cancel`を加え、`busy`または
  `cancelling`のprimary status範囲をHost-localなstyle metadataとして返す。狭幅では既存規則どおり
  optionalな詳細と操作案内を省略し、primary statusを残す。
- `v0/tui/tui_renderer.ts`はretained frame生成時だけ、その範囲をSGR 5とSGR resetで囲む。layout text、
  Presentation state、canonical transcript、direct renderer出力はplain textのままである。
- timer、周期的redraw、Worker event、Session変更は追加していない。cancel実経路はturn settlementまで既存のbusy
  lifecycleを維持するため、EscapeまたはCtrl-C後の`cancelling`にも同じstyleが適用される。

## 検証結果

- focused product test: retained TUIとconversation presentationの26 testが成功した。busy、steering、
  provider command wait、cancelling、狭幅、ready、recoverable settlement、direct rendererを確認した。
- type check、対象format、対象lint、`git diff --check`は成功した。
- 差分reviewはBlocker/P1/P2なし。blinkはprimary status直後でresetされ、他表示へstyleを漏らさない。
- stable candidateへauthoritative `v0:gate`を一回実行し、type check、format 195 files、lint 192 files、
  全130 testが成功した。
- provider request、credential read、real-TTY E2Eは実行していない。利用者のproduction retained TUIで、
  実terminal設定下の点滅とsettlement後の通常表示を目視確認するhuman gateが残る。
- 後続の利用者判断により、構想、architecture、roadmapの修正は個別の事前承認を必要とする運用へ明確化した。
  Increment 18・19の詳細をこれらの正本へ追記した未承認差分は破棄し、個別increment文書へ留めた。

## 対象外

- provider/tool単位の進捗率、残り時間、elapsed time、request countの常時表示
- tool activity各行、assistant streaming本文、footer第二行のanimation
- 色theme、spinner、terminal capability detectionまたはanimation設定UI
- busy以外のhistory export、Session切替、startup、idle editorのanimation
- Worker、provider、Session、canonical transcript、Presentation contractの変更
- background処理一般の統一progress framework

## Human Gate

利用者は2026-09-10、busy中に点滅または分かりやすい動きを表示する改善をIncrement 19として採用した。
同日、spinnerより単純なblinkを選び、busy/cancellingのprimary statusだけのblinkとbusy中の`Esc cancel`表示に
絞った上記初期実装計画を明示承認した。local実装とauthoritative gateは完了しており、Increment 19の完了判断は
production目視確認後に利用者が行う。
