# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-04）

[Increment 182](../docs/increments/increment-182.md)は利用者受入・commit/push・常用配置まで完了。
親execution開始時にChatGPTの実効認証登録IDを解決し、model省略childへ継承する。
181は実装・検証・常用配置と、利用者による再認証後の通常利用確認まで完了済み。

## 次の一手と承認境界

182のfocused 16件、type/fmt/lint/diff、compiled buildが通過した。
同一provider継承と異なるprovider両方向を実Worker＋localhostで確認済み。
承認済みの実provider三フローは六execution・15requestで全て完了。停止DB照合もpassed=true。
証拠は`.tools/increment-182/real-provider/`。
実装commitは`417e2af4`。常用配置版は受入済みruntimeと一致し、隔離Core/TUI起動・DB保存確認も完了。
配置証拠は`.tools/increment-182/deployment/`。稼働中Coreは維持し、次回Core起動から配置版を使用する。
次の採用判断を待つ。 構想・Host/Worker architecture・provider/auth
architecture・roadmapは、2026-10-04の個別承認により source `a78c2076`・Increment
182までの現行方式へ照合・反映済み。181 §8の未反映境界は解消した。
旧実データの削除・移行は未承認。S4の`/reload`も別候補として残る。

## 正本への入口

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
