# 通常利用 increment 5 — 実装結果

ステータス: local実装、focused verification、authoritative offline gate、独立implementation reviewを
2026-09-07に完了。production retained TUIでのhuman gateとユーザー受入は未実施。

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

## 残るhuman gate

production/provider/credentialは使用していない。別の明示承認後、production retained TUIでlabel四色と、
4,096 bytes超のmulti-byte `bash`出力をmodelが`bash_output`で末尾まで読み、同じcommandを再実行しないことを
一回確認する。32 MiB/128 MiBの固定値と同じcode pathの上限動作はlocal testで確認済みのため、human gateでは
大量出力を生成しない。
