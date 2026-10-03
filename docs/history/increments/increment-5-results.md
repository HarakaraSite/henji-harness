# 通常利用 increment 5 — 実装結果

ステータス: 完了。local実装、focused verification、authoritative offline gate、独立implementation review、
production retained TUI human gate、ユーザー受入を2026-09-07に完了。

## 成立した動作

- retained TUIの`tool>` labelをstandard green（SGR 32）、Host-local `system>` labelをstandard magenta
  （SGR 35）で表示する。色はlabelだけへ適用し、plain layout、wrap、本文、canonical transcriptを変えない。
- default parentの`bash`が4,096 bytesを超えるstdout/stderrを返す場合、bounded prefixに加えてopaque
  `outputId`、保存stream、`bash_output`によるreadback案内を返す。`bash_output`はUTF-8 byte offsetと
  `nextOffset`で49,152 bytes以下のwindowを返し、multi-byte scalarを分断しない。
- 保存は一つのRegistryで一つの`/tmp` file handleを共有し、open直後にunlinkする。固定上限は1 command
  32 MiB、1 Registry 128 MiB、retained stream 4,096件、segment 64 KiBである。上限到達時はcommandを停止し、
  保存済みprefixのreadbackとincomplete状態を返す。
- cancelled turnの到達不能なoutput identityは保持しない。論理byte・stream slotを戻し、同じhandle上で残存
  extentを詰めてfileをtruncateする。実行中cancelとfinal partial flush中のcancelの両方で、既存identityの
  readbackと後続commandの容量を維持する。
- `bash_output`はbuilt-in default Definitionだけへ追加し、plannerのtool集合は変更しない。有効toolの
  guidelineもdefault compositionだけへ合成する。production launcher/taskにはexact `/tmp` read/write permissionを
  追加した。

## Local verification

- increment 5 bash-output focused suite: 10 passed、0 failed。短いJSON互換、stdout/stderr readback、UTF-8
  window、command/Registry/stream上限、single unlinked handle、persistence failure、実行中とfinal flush中の
  cancellation回収を確認した。
- 関連するTUI、Definition/Registry topology、Worker launcherのfocused testは実装review前に成功した。
- final configured check、format 109 files、lint 106 files、`git diff --check`: 成功。
- authoritative `deno task --config deno.v0.json v0:gate`: 最終stable candidateで成功。
  - 通常test 53 passed
  - provider stream compatibility 10 passed
  - increment 4 filesystem 5 passed
  - increment 5 bash output 10 passed
  - 合計78 passed、0 failed
- 最初のgate試行は、focused整形時にrepository configを付けずquote styleが不一致になったためformat checkで
  停止した。repository設定付きformatterで対象3ファイルを正規化し、同じ具体的原因の解消後に再実行した
  final gateが上記のとおり成功した。

## Independent implementation review

- 初回reviewはP1 1件でNO-GO。truncated `bash`のcancel時にcaptureをfinalize/abandonせず、利用者から読めない
  recordがRegistry quotaとtemporary file extentを占有し続ける問題だった。
- `abandon()`を追加し、cancel settlement後にcommand record、byte、stream slot、物理extentを同一mutex内で
  回収するよう修正した。changed-lines reviewでは、final partial segmentの非同期flush中にcancelが入る競合を
  新しいP1として確認した。
- `finish()`直後にもcancelを再裁定し、結果を組み立てる前に`abandon()`するよう修正した。final-flush seamから
  abortする決定的testを追加し、追加closure reviewはGO、未解決Blocker/P1/P2 0となった。

## Production human gate

2026-09-07の初回attemptでは、modelは60,050 bytesのmulti-byte stdoutを出す`bash`を一回だけ実行し、
`bash_output`をoffset 0と49,150で二回呼んだ。二回目は`complete: true`、総1,201行、最後は
`末尾マーカー: HENJI-BASH-OUTPUT-完了-1200`であり、command再実行や代替取得はなかった。

続く4回目のprovider requestはHTTP 200だったが、modelは正しい行数と末尾をreasoning内で確認しながらvisible
`content`を空のまま`finish_reason: stop`で終了した。Henjiは`empty_terminal_result`として拒否し、turnは
commitされなかった。このため`bash` full-output readbackはproduction経路で成立したが、modelの最終報告を
含むhuman gate全体は未完了である。診断IDは`ad50975f-e366-4c02-878d-a1d762f6b541`。

同じTUI processではrecoverable taskをeditorへ戻すUIが未接続のため再送を拒否した。この別のSurface改善
候補は`docs/experience/normal-use-inbox.md`へ保存した。残っていたprocessを通常のSIGTERM shutdown経路で
終了し、空の未commit Session namespaceが回収された後、新しいproduction TUI processから同じpromptを
turn 0へ一回送った。

再試行はSession `e68a9c50-3611-46f9-994b-bb93112c9653`、provider evidence
`943a5dce-e890-4f72-9246-6a9e2197f948`で成功した。4 requestはすべてHTTP 200、合計26,700 tokens、
USD 0.021609だった。`bash`は一回だけ、`bash_output`はoffset 0と49,150の二回だけで、二回目は
`complete: true`、総60,050 bytesだった。`read`、`cat`、`sed`、`head`、`tail`、command再実行はなく、
modelは総1,201行、最初の行、`行1200`、末尾markerをvisible final answerで正しく報告し、turn 1がcommit
された。

retained TTY frameでは`user>`がSGR 34、`tool>`がSGR 32、`assistant>`がSGR 33、`/history export`の
`system>`がSGR 35で、それぞれlabel直後にSGR resetを持つことを確認した。history exportはprovider requestを
追加せず、TUIは`/exit`でexit 0となった。これによりproduction human gateは完了した。32 MiB/128 MiBの
固定値と同じcode pathの上限動作はlocal testで確認済みのため、human gateでは大量出力を生成していない。

ユーザーは開始時の三つの対応事項とincrement 5中に通常利用inboxへ追加した未採用候補を確認したうえで、
2026-09-07にincrement 5の完了を受け入れた。
