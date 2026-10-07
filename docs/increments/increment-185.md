# Increment 185 — A18 bash timeout説明・引数エラーの具体化

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 実装・検証・利用者受入、local commit・常用配置済み。

## 必要な動作と根拠

2026-10-04の利用者指示「じゃあ対応しようか」により、通常利用メモA18を採用する。
modelがbashのtimeout引数エラーをcommandの失敗と誤解せず、引数を直して作業を続けられるようにする。

- tool説明に`timeoutMs`の整数範囲`1〜120000ms`、既定`30000ms`を明示する。
- 引数エラーではcommandが未実行であり、再試行前にschemaと引数を照合して修正することを説明する。
- timeout検証失敗は、項目名、有効範囲、受け取った数値（数値以外は型、nullはnull）、command未実行を返す。
  観測された値では、例えば次の結果となる。

  ```text
  invalid arguments: timeoutMs must be an integer from 1 to 120000; received 180000. Command was not executed.
  ```

対象は同梱bashのtimeout説明と既存検証のエラー文。timeout上限・既定値・process実行方式を変えず、
他のtoolやbashの別引数のエラー具体化は対象に含めない。 構想・architecture・roadmapの変更、実provider
call、commit・常用配置は今回の採用に含めない。

## 現行のproduct経路と実装・確認計画

1. task受付後、Worker起動時に`worker_configuration.ts`と`worker_tool_loader.ts`が同梱bashを構成する。
   同じToolのdescription/inputSchemaをmodelへ提示し、tool
   callをRegistryから`bash_tool.ts`へdispatchする。
2. `bash_tool.ts`のtimeout検証はoutput capture開始・process起動より前にある。
   この位置で具体的な`ToolInputError`を返し、Registryの既存`invalid arguments`結果を通してmodelへ届ける。
   tool引数と結果は既存のsemantic履歴経路へ流れ、新しい状態・保存先は増やさない。
3. 実Worker–Host–Dataと同梱tool・実processを使うfocused確認で、観測値`180000`と`300000`への
   エラー内容とprocess未起動を確認する。同じSessionで`120000`へ直したcommandが実行されることを確認する。
   既存の正常bash・timeout・cancel・bash_output確認も変更経路のregression確認として実施する。
4. focused test、変更経路のtype check、format・lint、`git diff --check`を実施する。
   Surface変更はなく、tmuxとfull
   gateは計画しない。実modelが通常利用で引数を修正する判断は未確認とし、
   provider-freeの結果から推論能力の改善まで実証したとは扱わない。

## 採用元の観測

2026-09-27、session `51b47299`、execution `6598b5eb-f405-4dbc-b213-eaa0b93bc145`。
`opencode-go-chat / mimo-v2.6-pro / effort=auto`によるIncrement 135のslice 1〜3実装・検証が、
約43分、128 model step、172 tool呼出しで`max_steps`停止した。128回のmodel responseはすべて
tool呼出しで、最終回答はなかった。bash引数エラー29回の内訳は`timeoutMs=180000`が28回、
`300000`が1回で、いずれも上限超過だった。modelはcommandやファイル名、wrapperの不調と
誤解して再試行し、stepを浪費した。これが長時間turnの唯一の原因とは断定しない。

記録当時も説明・schemaは上限`120000`を明示していたが、timeoutの検証失敗は
`invalid arguments: invalid bash arguments`だけだった。2026-09-27はメモ追加のみの指示であり、
2026-10-04に現行sourceでも同じエラーであることを確認して今回採用した。
関連するA11（instruction）、A19（requestごとのcontext）、E3（runtime
tunables）は別候補のままとする。

## 結果

- `v0/agent/tools/bash_tool.ts`のdescriptionに整数範囲・既定値・引数エラー時の未実行と
  再試行前の修正を明記した。既存timeout検証のエラーを具体的な`ToolInputError`へ変更した。 input
  schema、timeout上限・既定値、process実行と保存経路は維持している。
- `increment_133_bash_lifetime_test.ts`へ元観測に対応する実Worker確認を追加した。
  `180000`と`300000`で、modelへ返るtool結果と最終readbackに項目・範囲・値・未実行が含まれること、
  process start要求が0回でmarker fileも未作成であることを確認した。
  同じSessionで`120000`へ直したcommandはprocess start要求1回、stdout=`completed`、exit 0となり、
  実fileに`corrected`を書き込んだ。
- `deno task --config deno.v0.json agent:increment-133-bash-lifetime:test`は8件通過した。
  既存のfresh
  shell/status/output、bash_output、背景process、timeout・cancel・cleanupの動作を確認した。
  初回は追加testのundefined型絞込みが不足してtype
  checkで停止したため、明示guardへ修正して再実行した。
- production CLI入口`v0/agent/cli/henji_cli.ts`のtype check、変更source/testのformat・lint、
  `git diff --check`が通過した。full gateと実provider callは実行していない。
- self-reviewでmodel提示とdispatchが同じ同梱Toolを使う経路、エラーがprocess起動前に返ること、
  Registryが既存のerror結果として配送することを確認した。
  実modelがこの説明を使って自律的に引数を直す通常利用での判断は未確認。

通常利用メモのA18を本書へ移設した。構想・architecture・roadmapは変更していない。
commit・常用配置は下記の追加承認に従う。

## Commit・常用配置の承認（2026-10-04）

利用者の「コミット・常用配置して」により、実装の受入、local commit、公式buildと常用配置、
配置結果の記録commitを承認された。公式buildのsourceDirty=falseとsource commitを確認し、
旧binaryを保存して`dist/henji`と常用の`henji`へatomic配置する。配置先のbinary・build情報の一致と、
稼働中の常用Coreの維持を確認する。既に通過したfocused testは繰り返さず、実provider callは行わない。

## 配置結果（2026-10-04）

実装と関連文書をsource commit `d1d6dfa6ab694d1868724926048861b8142c1202`
（`fix: explain bash timeout argument errors`）へ確定した。公式buildでsourceDirty=falseと このsource
commitを確認した。配置版はhenji 0.8.0／Deno 2.9.7、build ID
`26cd62e67618299ec18c6421684c1cd1145a8ee89b0aff9bdb46d7cb729bbef4`、runtime digest
`35a205d511cc61563518f2c747f62b6147d9670f1e1b26381d02181816c4d68c`。

旧binaryを`.tools/increment-185/deployment/henji.{dist,local}.previous`へ保存し、staging fileから
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。両配置先のversionとbuild manifest、
binary SHA-256 `22cc019d3a739ec1c953202a36f00e3ba088168fc048084dd76dd4f0f46b5856`が一致した。

配置版の`--version`と`diagnostics runtime`は隔離HOME/XDG・workspaceで確認し、実configを変更していない。
常用Coreの配置前後のID・PIDが同一であることを確認した。稼働中のCoreとTUIは維持し、A18は次のCore起動から
配置版を使用する。実provider requestは0件。配置binaryでの実modelによる引数修正は未確認であり、
既存のprovider-free実Worker確認とclean sourceのbuild情報を配置根拠とした。

証拠は`.tools/increment-185/deployment/`の`build.log`、`build-manifest.json`、`deployment.json`、
`cores-before.json`、`cores-after.json`、`existing-core-check.json`。配置結果を記録commitへ保存する。
