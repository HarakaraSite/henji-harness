# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

利用者は次の対象として[通常利用メモE6](../docs/experience/normal-use-inbox.md#e6--agent設定tool管理の簡素化とrevisionの履歴利用未採用)を選択した。
検討方向を記録済みで、個別incrementへの移動・具体計画・実装は未実施。
S4は`/reload`へ改名し、E6の機構簡素化とは別の候補として整理済み。

[Increment 177](../docs/increments/increment-177.md)の未使用code・test・export整理、
`v0:test`整備、JSR収録漏れ修正と、[Increment 178](../docs/increments/increment-178.md)の
ChatGPT最新2モデル・公式effort固定記載は、local実装・検証、常用配置と配置先確認が完了した。
実装commit `e76056bab3fb30ccb9661290cb7f84625d1c2f3c`を`origin/main`へpush済み。
関連記録・通常利用メモ・API Worker検討案もこのcommitに含む。
配置、build情報と配置先確認は178を参照する。
起動中の常用Coreと実configは変更しておらず、新しく起動するCoreから配置版が使われる。

APIと`henji run`のCLI adapter分離を[Increment 179](../docs/increments/increment-179.md)へ採用し、
スライスごとの実装・検証・独立review、最終gate、承認済み実provider確認と保存readbackを完了した。
実装・関連記録commit `7dc4f501ea44e450e541fc1f0f84085caa0e6975`を`origin/main`へpush済み。
現在の要件・工程・受入・承認境界は179を参照する。

[Increment 180](../docs/increments/increment-180.md)は2026-10-03の利用者の
「インクリメントを完了とします」により完了確定。
実装・検証・独立review・実provider受入・commit/push・常用配置と追加基本E2Eは完了した。
実装commitは`5fc6c2aa3d784b89952e3962a084eade3443bfc1`。要件・結果・承認境界は180、
追加確認は[基本E2E](../docs/increments/e2e-179-180-2026-10-03.md)を参照する。
新しく起動するCoreから179・180を含む配置版が使われる。

## 次の一手

次SessionではE6を個別incrementへ採用して要件・計画を具体化する。
合意した方向、現行経路、未決事項は通常利用メモE6を参照し、採用時に同項目をincrement文書へ移す。
構想・architecture・roadmapへの変更案は実装計画と分けて提示する。S4の`/reload`実装は今回の対象へ含めない。

179のarchitecture/roadmap反映の文書commitは180のpushで反映済み。常用配置も180で完了。
179の詳細は同increment、B8再発時の調査方針は176、未採用候補は通常利用メモを参照する。

## 承認境界

- 利用者の「じゃあE6を進める セッション作り直したいからコミットして」により、E6への着手と今回の記録の
  local commitを承認。構想・architecture・roadmapの意味変更は別途明示承認が必要。

- 配置版の基本E2Eシナリオ作成と各シナリオの最小限の実provider実行は追加指示により承認済み。
  実行・保存readbackは完了。対象と結果は基本E2E文書を参照する。product実装修正は今回の検証依頼に含まない。

- 180の採用・計画作成と関連記録更新は利用者の「では計画を作って」により承認済み。
  独立reviewと、その指摘の計画修正も追加指示により承認済み・実施済み。
  スライスごとのlocal実装・非破壊的検証・独立reviewと最後の実provider確認は追加指示により承認済み・実施済み。
  180のcommit/push・常用配置は「コミットプッシュ配置をしてください」で追加承認済み・実施済み。
  利用者の「インクリメントを完了とします」で完了承認済み。実利用dataの削除は未承認。
- 177・178のlocal変更・検証、常用配置と配置先確認は承認済み・実施済み。
- 利用者の「コミットプッシュはしよう」で177・178と関連記録のcommit/pushを承認。
  実装のpushは完了した。完了状態の文書更新も同じ送信先へcommit/pushする。
- 178の承認済み直接指定probeは実施済み。結果と資料pointerは178を参照する。 追加の実provider/model
  call、公開、実data削除は未承認。
- API/CLI
  Worker分離の179への採用と計画作成・計画reviewは実施済み。providerなしの事前確認も実施済み。
  スライスごとのlocal実装・非破壊的検証・独立reviewは承認済み。
  179に記載した実providerの対象・回数・保存先を「はい実施してください」で追加承認済み・実施済み。
  179の実装・関連記録のcommit/pushは追加承認済み。常用配置は180の追加指示で承認済み・実施済み。追加推論は未承認。
  入力履歴削除はメモのみで、個別incrementへの採用・実装は未承認。
- 構想・architecture・roadmapの意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)による別途承認が必要。
  179のAPI/CLI分離と関連する170のData配置のarchitecture/roadmap反映は追加承認済み・実施済み。

## 正本への入口

- [通常利用メモE6](../docs/experience/normal-use-inbox.md#e6--agent設定tool管理の簡素化とrevisionの履歴利用未採用):
  次に進める機構簡素化の方向・観測・未決事項。個別incrementへ採用するまではこの項目を参照する。
- [Increment 180](../docs/increments/increment-180.md):
  A28の削除範囲・差分反映計画・受入・承認境界。
- [Increment 179](../docs/increments/increment-179.md): API/CLI Worker分離の要件・計画・受入。
- [Increment 178](../docs/increments/increment-178.md):
  ChatGPT最新2モデルの固定候補と公式effort、probe・TUI確認。
- [Increment 177](../docs/increments/increment-177.md):
  未使用実装と旧testの撤去、通常test入口の整備。
- [Increment 176](../docs/increments/increment-176.md): B8と共通診断拡充、原観測、review・配置結果。
- [Increment 175](../docs/increments/increment-175.md): B7の要件・計画・結果。
- [Increment 174](../docs/increments/increment-174.md): B6の要件・計画・結果。
- [Increment 173](../docs/increments/increment-173.md): 共通credential登録と利用者確認。
- [Increment 172](../docs/increments/increment-172.md): Exa検索とweb_fetch download。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的・Why・人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md):
  責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  provider/account/modelの境界。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [roadmap](../docs/roadmap.md): 機能・実装状態・未実装範囲。
