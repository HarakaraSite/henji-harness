# Increment 126 — provider deadlineとmodel step既定値の拡張

状態: 実装・focused検証済み。roadmap・architectureの現行値は利用者の別承認を得て更新。binary配置・実provider確認は未実施。

## 必要なproduct動作と根拠

- provider requestの既定deadlineを180,000 msから300,000 msへ延ばす。
- 組み込み`default`・`planner` Agent Definitionの既定`maxSteps`を64から128へ増やす。外部Agent Definitionが指定する既定値は変更しない。
- TUIと`henji run`の双方で、起動時の`--provider-timeout-ms N`と`--max-steps N`を指定できるようにする。明示値はその起動の既定値より優先する。
- 新しい`runtime.json`は作らない。`maxSteps`の所有者はAgent Definitionのままとし、CLI値は既存のroot compositionへの一時的な上書きとする。
- 根拠: 利用者は通常利用でprovider deadlineに達し、64 model stepsでも不足する場合があると報告した。2026-09-24に300秒・128 stepと両Surfaceの引数を明示指定し、この変更を独立incrementとして採用した。provider deadlineの先行観測はIncrement 13・85・100にもある。

## 現行経路と変更範囲

- TUIは`parseTuiInvocation`で両引数を受け取り、Hostのstart commandを経てWorkerに渡す。`maxSteps`はWorkerの`finalizeRootAgentComposition`でrootの実効値・manifestへ反映される。provider deadlineはWorker physical I/Oから通常model request・補助provider requestへ渡る。
- `henji run`は`runtime_cli.ts`でtask・Agent selectorだけを受け付け、`runHeadlessWorker`経由で同じHost/Worker経路を使う。`runHeadlessWorker`はroot maxStepsを渡せるが、provider deadlineの引数は未対応だった。
- `run`の引数parserとheadless runnerへの値の伝達を追加する。組み込みDefinition定数とprovider deadline定数を更新する。Sessionへの保存、外部Definition、tool Definition、CLI以外のconfigは変更しない。

## 実装と確認

- `DEFAULT_PROVIDER_TIMEOUT_MS=300_000`、`DEFAULT_AGENT_MAX_STEPS=128`に変更した。
- `henji run --max-steps N --provider-timeout-ms N`をTUIと同じ正のsafe integerとして受け付け、選択済みrootのWorker起動へ渡す。CLIの既存`--agent`・`--definition-revision`・`--task`・`--json`・`--stream`と併用できる。
- focused testで`run`の引数受付とheadless runnerへの伝達、実Worker起動commandの両値とartifact manifestの実効160 step、組み込みDefinitionの既定128とWorker ready manifest、TUIの明示deadline伝達、provider既定300秒を確認した。`agent_worker_foundation` 32件、`current_code` 17件、Increment 13 5件、Increment 104 7件、Increment 33 11件が成功した。`v0:check`、対象fileのformat・lint、`git diff --check`が成功した。実provider callは行っていない。

## Product正本の更新

- `docs/roadmap.md` F02: 標準root turnの最大64 model stepsを128へ、TUIのみと書かれたdeadline引数の説明をTUI・`run`双方へ、既定180,000 msを300,000 msへ更新する。
- `docs/roadmap.md` F06: 組み込みAgent Definitionの`maxSteps`既定64を128へ更新する。
- `docs/architecture/henji-host-agent-worker.md`: provider request deadlineをTUIだけでなく`run`も指定できると明記し、未指定時180,000 msを300,000 msへ更新する。

2026-09-24、利用者は上記の変更対象・理由・意味を確認して別途承認した。
