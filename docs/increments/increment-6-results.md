# 通常利用 increment 6 — 実装結果

ステータス: local実装、focused verification、bounded implementation review、authoritative offline gateを
2026-09-07に完了。production retained TUI human gateとユーザー受入は未実施。

## 成立した動作

- `cancelled`、`contract_failure`、`max_steps`のrecoverable settlement後、editorが空なら未commitの
  active taskを同じTUI processのeditorへ戻し、cursorを末尾に置く。自動再送はせず、人間が
  編集するかEnterで再送できる。
- settlement時に別draftがある場合は上書きせず、recoverable laneを保持する。idle専用の
  Host-local `/recover`でactive task → steering → follow-upの既存順に一件を戻す。tool call後の
  workspace effect warningも維持する。
- idle Ctrl-Cは一行・複数行draftとinput-history navigationをclearし、process・Session・turnを
  終了しない。空editorのCtrl-Cもexitせず、Ctrl-Dと`/exit`は従来の明示exitとして残した。
  busy Esc、busy Ctrl-C、compaction、外部signalの既存遷移は維持した。
- `read`、`write`、`edit`、`bash`、`bash_output`にWorker-local `ToolComponentCatalog`を導入し、既存factoryを
  薄くmaterializeする。既存Definitionのtool identity、provider向けdefinition、Registry dispatch/resultは変更
  しない。`bash`と`bash_output`は一つのRegistryで同じoutput storeを共有する。
- 公開`@henji/agent`のroot composition optionから、Definitionで選択済みの同一`tool:*` identityに対し、
  tool nameを保ったreplacement componentを明示できる。代替description、schema、guideline、executorは
  rootだけに反映し、delegated plannerの`read`はbuilt-in componentのままである。functionはdata-only
  manifestやWorker protocolへ入らない。

## Local verification

- recovery・Ctrl-C・slashのTUI focused suite: 21 passed、0 failed。最終focused rerunはcurrent-codeを含む35 passed、
  0 failed。cancel後の日本語翻訳prompt復元と同一Session再送、occupied editorの`/recover`、effect
  warning、複数行とhistory navigationのidle Ctrl-C clearを確認した。
- Worker foundation focused suite: 34 passed、0 failed。built-in/external Definitionの同一Worker経路とdata-only
  protocolの回帰を確認した。
- filesystem focused suite: 6 passed、0 failed。component経路でwrite → edit → readを実workspaceへ実行した。
- bash-output focused suite: 11 passed、0 failed。component経路の`bash`が保存したtruncated stdoutを同じ
  Registryの`bash_output`で末尾まで読み戻した。
- final `v0:check`、format 110 files、lint 107 files、`git diff --check`: 成功。
- authoritative `deno task --config deno.v0.json v0:gate`: stable candidateへ一回実行し成功。
  - 通常suite 57 passed
  - provider stream compatibility 10 passed
  - increment 4 filesystem 6 passed
  - increment 5 bash output 11 passed
  - 合計84 passed、0 failed

## Bounded implementation review

- 初回reviewはBlocker 0、P1 1、P2 1でNO-GOだった。P1はkeyboard Ctrl-Cの共通handler変更が、対象外の
  外部SIGINTのidle遷移も変えていたことである。keyboardとsignalを別handlerにし、SIGINTの従来遷移を
  戻した。
- P2はroot replacement optionが、Definitionで選択していないbuilt-in work identityへの指定を
  受け入れていたことである。replacementを当該Definitionの`capabilities.tools`に存在するidentityだけへ
  限定した。
- changed-lines re-reviewはGO。未解決Blocker/P1/P2は0。recoverable input、exit/cancel境界、component
  identity・materialization・planner分離、既存work tool contractは実装から利用者影響まで再確認済み。

## Production human gate

provider request、credential、networkを使う確認は実施していない。次はユーザーの別の明示承認後、
`docs/increments/increment-6.md`のproduction retained TUI human gateに従い、cancel後のeditor復元・再送と
idle Ctrl-Cを一回のproduction TUI processで確認する。tool component置換はlocal Definitionのprovider-free
focused testで確認済みであり、human gateで任意の外部componentを追加しない。
