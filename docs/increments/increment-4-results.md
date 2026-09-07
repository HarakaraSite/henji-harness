# 通常利用 increment 4 — 実装結果

ステータス: local実装、focused verification、authoritative gate、独立reviewを2026-09-07に完了。
production TUIでのhuman gateは未完了。

## 成立した動作

- retained TUIの`user>` labelをblue、settledした`assistant>` labelをyellowで表示する。色はlabelだけに
  適用し、plain layout、wrap、cursor、canonical transcriptを変えない。
- assistant本文をHost TUI内のrenderer componentへ分離した。default componentはstreaming・settledの
  textをそのまま返し、現在のplain表示を維持する。
- idle時のexact command `/history export`を追加した。command admission時点のcurrent bindingとcommit済み
  canonical transcriptを同期的にsnapshotし、workspace別state rootの`history-exports/`へ新しいMarkdown
  fileとして保存する。
- exportはturn 0を含むその時点の全commit済みturn、user/steer/assistant、tool call arguments、tool resultを
  順序どおり記録する。durable Session IDと`--no-session`を明示的に区別し、同じturnの再実行も上書きしない。
- export中もdraft編集と描画を継続する一方、通常task、Session切替、重複exportを直列化する。exitはfileの
  write・sync・close settlementを待ち、完了後の古いreceiptを別bindingや閉じたrendererへ表示しない。
- `read`へ1-based `offset`とline数の`limit`を追加した。complete lineだけを64 KiB以内で返し、続きがあれば
  total lineと次offsetを案内する。pathだけのsmall-file callと`edit`のwhole-file 64 KiB契約は維持した。
- active toolの`promptGuidelines` metadataをprovider向けdefinitionから分離して集約し、`read`が有効な
  default parentとplannerのsystem instructionへ、read優先と`offset`・`limit`継続読込みの指針を一回だけ
  合成する。

## Local verification

- focused TUI / composition test: 40 passed、0 failed。plain layout、labelだけのSGR、assistant component、
  exact slash parse、busy時の非steering化、export直列化、shutdown settlement、default/planner guidelineを含む。
- focused filesystem test: 5 passed、0 failed。small-file互換、large-file paging、multibyte text、EOF後、
  giant line、後続invalid UTF-8、turn別export、tool内容、dynamic fence、turn 0、no-session identity、adapterの
  同期snapshot captureを含む。
- type check、format check 107 files、lint 104 files、`git diff --check`: 成功。
- authoritative `deno task --config deno.v0.json v0:gate`: stable candidateへ一回実行して成功。
  - 通常test 52 passed
  - provider stream compatibility test 10 passed
  - increment 4 filesystem test 5 passed
  - 合計67 passed、0 failed

## Independent review

- 初回reviewはBlocker 0、P1 1、P2 1でNO-GO。P1は、history exportをdispatchしてからcontrollerがoperationを
  所有するまでのstatus redrawが失敗すると、開始済みwriterのsettlementを待たずterminalを復元し得る競合だった。
- operation ownershipとsettlement handlerの登録をfallibleなstatus redrawより前へ移動した。描画失敗後も
  writer解決までrunとterminal restoreが進まないfocused regression testを追加し、retained TUI test 11 passed、
  変更箇所のtype checkとlintが成功した。
- changed-lines re-reviewはGO。初回P1解消、新しいBlocker/P1なし。初回P2は唯一の再開状態が実装前のままという
  文書不整合であり、`.handoff/handoff.md`をこの結果とhuman gate待ちへ更新して解消した。

## 未実施のhuman gate

production TUIとproviderを使う確認は、このlocal実装承認には含めず未実施である。次の利用者確認を残す。

- 実際のterminal themeで`user>`のblueと`assistant>`のyellowが見分けやすく、本文へ色が漏れない。
- 二つのturn後にそれぞれ`/history export`を実行し、表示された別々の絶対pathを開くと、その時点までの
  commit済みhistoryだけが読みやすいMarkdownとして入っている。
- Henji自身が64 KiB超のfileを`read`し、continuation案内の次offsetを使って続きを取得する。
