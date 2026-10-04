# Increment 184 — S24 子Agent起動行にtaskの冒頭を表示

状態: 完了（実装・検証、利用者受入、local commit・常用配置）。

## 必要な動作と根拠

人間がTUIの子Agent起動行から、どの依頼を渡したかを把握できるようにする。
2026-10-04の利用者指示「taskの冒頭を入れる runId表示は不要」により、通常利用メモS24から
task断片表示だけを採用した。Increment 136で実装したagent名に、親が`spawn_subagent`の
`task`引数で渡した指示の冒頭を添える。

起動中と完了後、保存履歴からの再表示で同じpreviewを使う。表示例:

```text
tool> spawn_subagent reviewer Review the implementation. …
tool> spawn_subagent reviewer Review the implementation. ✓
```

taskは先頭行を表示し、agent名と合わせて既存のpreview省略方式（96 UTF-8 bytes、超過時は`…`）を
使う。task本文の保存・子への受渡しは表示用の省略とは独立している。
runId表示とstatus／collect／cancel行へのagent名対応は今回の採用対象に含めない。
構想・architecture・roadmapの変更と実provider callは本採用に含めない。
commit・常用配置は下記の追加承認に従う。

## 現行のproduct経路と実装・確認計画

1. 親のtool call引数はsemantic履歴へ保存され、TUIの`state.ts`、Data entityの
   `keyed_conversation_store.ts`、CLI履歴の`history_view.ts`から共通の
   `toolActivityPreview`へ渡される。新しい状態・保存先は増やさず、この共通処理にtask冒頭を添える。
2. 既存testの起動中・完了後・保存entity・Session timelineの期待表示を更新する。
   会話中の日本語例で、長いtaskの省略と改行以降を表示しないことを確認する。
3. 変更経路のfocused test、必要なtype check、format、lint、`git diff --check`を実施する。
4. 隔離HOME/XDGへ以前の実provider確認で保存した履歴のDBをコピーし、production TUIをtmuxで開く。
   起動行へのtask冒頭表示、再接続での復元を確認する。実provider callは行わない。

## 採用元の観測

S24の元観測（2026-09-27、Increment 136計画時）では、runIdはHostの`ChildRunRegistry.spawn`が
発行し、call引数にはなく、起動行表示にはresult解析、操作行のagent名対応にはrunIdとの対応付けが
必要だった。一方、task断片は既存のcall引数`task`から表示できる。本採用は後者だけを扱う。
利用者は2026-10-04にrunId表示を不要としたため、元のS24を未採用候補に残さず本書へ移設した。

## 結果

- `v0/agent/tools/tool_activity.ts`の`spawn_subagent` previewに、agent名とtaskの先頭行を
  結合して表示する処理を追加した。tool引数、保存本文、runId、操作行、Hostのrun管理は変更していない。
- 起動中・完了後・保存entity・Session timelineと、日本語taskの省略・先頭行表示をfocused確認した。
  `tui_tool_preview_test.ts`と`increment_129_assistant_note_history_test.ts`の21件が通過した。
  初回の日本語省略位置の期待値を96-byteの既存仕様に合わせて修正した。
- production CLI入口と変更testのtype check、変更source/testのformat・lint、
  `git diff --check`が通過した。full gateは計画・実行していない。
- 公式build scriptで確認用binaryを`.tools/increment-184/henji`へ作成した。 build
  logは同directoryの`build.log`。常用binaryへは配置していない。
- Increment 182の実provider確認で保存したDBをread-onlyで読み、SQLite backupで隔離XDGへコピーした。
  workspaceはその確認用の一時workspaceを使い、実config・元DBは変更していない。 tmuxでproduction
  TUIを接続し、次の行を確認した。

  ```text
  tool> spawn_subagent generic Read same-provider.txt using read and reply only with its exact content. Do not use any … ✓
  ```

- `Ctrl+D`でdetachし、同じSessionへ再接続して表示の復元を確認した。 production
  `history --connect ... --session ...`にも同じtask冒頭が表示された。 確認用Coreはshutdown
  accepted、exit 0で終了した。コピーDBのexecution増加は0件、 実provider
  requestは0件。証拠は`.tools/increment-184/tui-history.txt`、
  `tui-reconnected.txt`、`history.txt`、`tmux-result.json`と`focused.log`。

通常利用メモのS24を本書へ移設した。構想・architecture・roadmapは変更していない。

## Commit・常用配置の承認（2026-10-04）

利用者の「コミット・常用配置して」により、実装の受入、local commit、公式buildと常用配置、
配置結果の記録commitを承認された。sourceをcommitし、公式buildのsourceDirty=falseと検証済み
candidateとのruntime digest一致を確認する。旧binaryを保存し、`dist/henji`と常用の`henji`へ
atomic配置する。配置後は隔離HOME/XDGのtmuxでtask冒頭表示・再接続・履歴を確認し、実provider
callは行わない。稼働中の常用Coreは維持する。

## 配置結果（2026-10-04）

実装と関連文書をsource commit `442d4cfbfde696598f2cd148b5091154d98199ae`
（`feat: show subagent task head in tool activity`）へ確定した。
公式buildでsourceDirty=false、runtime digest
`f86282b13f60d1de4eb79e6fb03d93bef627a45a39d2f0cd4c652c2e6bd82e74`が実装検証済みcandidateと
一致することを確認した。配置版はhenji 0.8.0／Deno 2.9.7、build ID
`38f7972666ce1386ddbf76fe1e92c9a147eb2dfa29896245141ba9971e4b65f5`。

旧binaryを`.tools/increment-184/deployment/henji.{dist,local}.previous`へ保存し、staging fileから
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。両配置先のversionとbinary SHA-256
`cae02515cbeec67dce1e3e6bf7d62058864383bf897a4511853ed65466e9ec40`が一致した。

常用配置したbinaryを隔離HOME/XDGのtmuxで起動し、保存履歴のtask冒頭表示、detach後の再接続、
CLI履歴のtask冒頭表示を確認した。確認用Coreはshutdown accepted、exit 0で終了した。
コピーDBのexecution増加は0件、実provider requestは0件。実config・元DBは変更していない。
配置前後で常用CoreのID・PIDが同一であることを確認した。稼働中のTUIは維持し、次回TUI起動から
配置版のtask表示を使用する。

証拠は`.tools/increment-184/deployment/`の`build.log`、`deployment.json`、`tmux-result.json`、
`tui-history.txt`、`tui-reconnected.txt`、`history.txt`、`existing-core-check.json`。
runtimeが実装検証済みcandidateと一致するため、focused testとfull gateは繰り返していない。
配置結果と完了状態を記録commitへ保存する。
