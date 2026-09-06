# 通常利用 increment 2 — 実装結果

ステータス: local実装と機械確認が完了。production TUIでの通常利用確認は未実施。

## 成立した動作

- built-in `default`と`planner`のDefinition既定値を、1 turnあたり64 model stepsへ変更した。
- production TUIの`--max-steps N`を追加した。正のsafe integerだけを受け入れ、root compositionの
  `maxSteps`、resolved limit/resource selection、Manifest、実行時budget、execution artifactへ同じ値を
  反映する。
- root overrideはbuilt-inとexternal Definitionに同じ規則で適用する。`--agent planner`ではplanner rootへ
  適用し、default rootからdelegateされるplannerは自身の標準値64を使う。
- 起動時overrideはSession recordへ保存しない。同じTUI invocation内でSessionを切り替えた場合は、新しい
  Worker generationへ同じ値を渡す。
- Worker turnのmodel request admissionをrootの実効maxStepsへ連動させた。これにより、従来の独立した
  8-request上限で9 step目に停止せず、64までのroot turnを実行できる。delegated planner laneは64を使う。
- 64 stepsまでの失敗を従来と同じdiagnostic fieldで記録できるよう、旧8/16固定のdiagnostic count上限を
  safe integerの範囲へ同期した。
- Presentation Adapterのoutcomeと`turn_end` eventも、turn/runtime provider request countを固定16で
  拒否せず、非負のsafe integerとして受け渡す。
- 96 UTF-8 bytes以内のphysical workspace pathはfull pathを表示し、通常footerへ`cwd <path>`を追加した。
  footer幅が不足する場合は先頭を省略し、repository名を含む末尾を残す。
- 通常footerから`F1 help` hintを削除した。F1 keyとhelp overlayは変更していない。
- fresh-runtime comparisonとreplay envelopeを64対4へ同期し、変更されたManifest/envelope identityを
  実際の再生成結果へ更新した。

## Local verification

- focused Host/Worker test: 34 passed、0 failed。10-step root完遂、root 2 / delegated planner 10-step完遂、
  built-in/external/root planner override、execution artifact、Session navigationを含む。
- review修正後のfocused test: Presentation/TUI 7 passed、current/retained 16 passed、0 failed。
  64 request countのoutcome/event両経路と、実際の長いcompaction cancellation statusを使った40/80列footerを含む。
- fresh-runtime comparison実行: current 64はcompleted、variant 4はstopped。
- authoritative `deno task --config deno.v0.json v0:gate`: 最終treeで成功。
  - type check成功
  - format check成功
  - lint成功
  - 通常test 42 passed、provider互換test 10 passed
- `git diff --check`: 成功。

commit `75c388a`への第三者reviewは、Presentation Adapterに残る16-request上限をP1、長いstatusがworkspace
末尾を切るfooter配置をP2として検出した。両方を修正後、同じreviewerによる変更箇所の再確認はGO、
Blocker/P1/P2各0件だった。上記authoritative gateはこのreview修正後の最終treeへ実行した結果である。

provider request、credential read、real-TTY E2E、production TUIの起動は実施していない。次の通常利用で、
対象repositoryがfooterから識別できることと、8 model stepsを越えるrepository調査が回答まで継続することを
人間が確認する。
