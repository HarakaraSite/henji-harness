# S22・Increment 147 — commit・push・常用配置

更新日: 2026-09-28 ステータス: commit・push・常用配置・配置後確認完了。

## 対象と承認

利用者はセッション終了に向け、関連文書の更新とcommit・push・配置を明示指示した。
対象はS22の全8slice（Increment 139〜146）と、全体reviewのP1／B6および周辺reviewのP2を修正した
[Increment 147](increment-147.md)。未commitのS22実装・test・設計／結果・操作文書をまとめる。
構想・architecture・roadmapの意味変更、JSR公開、実config／既存data変更は含めない。

各sliceの実装・focused／production確認・独立reviewは個別incrementを参照する。
全体reviewはBlockingゼロ・P1一件を報告し、147で修正した。周辺追加reviewのP2も修正し、一回の限定再reviewで
確認範囲に未解決Blocking／P1／P2はない。元のS22固定artifactのsource／test等324fileは一致し、三つのproduction
変更は147のreview済み修正だけだった。147の最終四file artifactも一致した。

## 配置手順と確認

文書とhandoffを更新して実装をcommitし、origin/mainへpushする。そのcleanな実装commitからDeno 2.9.7の
公式build scriptでcompiled binaryを作る。147の確認済み最終候補とruntime digestの一致を確認し、
従来の常用binaryを保持して原子的に置き換える。

配置binaryのversion／source／build／SHA-256を照合し、隔離XDG・workspace・tmuxで通常CLIのCore自動起動、
none Session表示、UI detach後のCore保持、再接続と同Session維持、明示Core stopを確認する。
今回の配置確認で実provider requestは追加しない。full gateも再実行しない。
配置結果と終了時点のhandoffを文書commitとしてpushし、remote/mainとlocalの一致を確認する。

## 実施結果

実装・test・関連文書をcommit
`76ba82ec8a65deac21ce4be99e470ba861bc6125`へまとめ、`origin/main`へpushした。
全109fileの変更で、code／testはreview済みartifactと一致する。構想・architecture・roadmapの正本は変更していない。
配置後の文書記録はこの実装commitに続くdocs commitへまとめる。

Deno 2.9.7の公式build
scriptをcleanな実装commitから実行し、`/home/agent/.local/bin/henji`へ原子的に配置した。

- version: `henji 0.7.0`、sourceは上記実装commit、dirtyなし。
- build ID: `4adab9c28ef966a258ace7c2276587877d9615d99bc06fca05b84fdda63fc07b`。
- runtime SHA-256: `5d5a1ad83ffa4bd5ad6a21e5669b3f9bcf27adbaeac843ee7264881b937dadda`。 Increment
  147の最終確認済み候補と一致する。
- binary SHA-256: `d5b2057f5ce0f2ebad68ec019c0a7c0cdd2e1201f51d0bd561a6b843b3df1856`。
  clean候補と常用先のhash・version・source・buildが一致した。
- 旧binaryは`/tmp/henji-s22-deploy-2026-09-28/henji.previous`へ保持した。
  旧sourceは`1d7e0bb6…`、旧buildは`41d37741…`。

配置binaryそのものを、隔離XDG・新規workspace・専用tmuxから通常CLI `--no-session`で起動した。
Coreの自動起動、none Sessionの画面表示、Ctrl-D
detach後のCore保持、`tui`で同Session・同epochへの再接続、
明示`core stop`と`core status`の非稼働を確認した。実行開始はゼロ、追加provider requestもゼロ。
`--help`とbuild情報も確認した。確認用Core・tmuxは停止済み。 隔離済み147 probe
configを再利用し、実config・既存Session dataへ書いていない。

証拠は `/tmp/henji-s22-deploy-2026-09-28/evidence` のbuild.log、deployment.json、help.txt、
deployed-core-ready.json、deployed-snapshot.json、deployed-initial.txt、deployed-reattached.txt、
deployed-smoke-summary.json、deployed-stop.txt、deployed-stopped.json。
保存証拠のcredential値一致はゼロ。JSR公開と実provider再実行は行っていない。

各incrementの冒頭を配置完了へ更新し、handoffを次セッションの入口へ更新した。
各increment本文中の「未配置／未承認」は、そのlocal確認時点のscope・履歴として残す。
現在のcommit・push・配置状態は本記録と各文書の冒頭を参照する。
