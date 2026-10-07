# Increment 204 — credential保存先の分離とrun_typescriptのconfig root読み取り

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 実装・検証・独立review・常用配置・実環境移行まで完了（2026-10-06、利用者指示）。source commit
`d1a26f7c`、review対応`2a95f72f`、公式build `7ecf58e9…`を常用配置済み。実configへの
`run-typescript.json`配置と旧credential fileの削除も実施済み。削除直後に旧Coreが旧保存先を参照して
Session `f040537a`の1 executionが失敗したが、利用者がTUIを再起動し（2026-10-06 20:37、配置済みbinary）、
credentialが新rootのみに存在する状態で同Sessionのmodel requestが成立している。利用者は2026-10-06に
実provider経路での確認を完了した。

## 利用者が必要とする動作と根拠

利用者指示（2026-10-06）:

- `run_typescript`からconfig root（`${XDG_CONFIG_HOME}/henji-harness`、既定
  `~/.config/henji-harness`）を読めるようにする。credential情報にはアクセスさせない。
- credentialの場所が悪いので変更する。移動先は`${stateRoot}/credentials/`（案1）。
  `chatgpt/`も同じ場所へ移す。既存credentialの実移動を許可する。
- deny pathは設定に書く。allowも設定に書いてよい。allowはDenoのpermissionで強制し、
  denyはscript監査で行う。完全な強制はできないことを利用者は理解している。
- incrementは204（本件）と205（S34）の2本とする。

実測したDenoの制約（2026-10-06、Deno 2.9.7、このworkspaceで確認）:

- Worker permission descriptorにdenyは無い（`read?: "inherit" | boolean | Array<string|URL>`。
  `{allow, deny}`形式は実行時`TypeError: invalid type: map`）。
- 親processの`--deny-read`pathをWorkerのallowが含むとWorker生成が
  `NotCapable: Can't escalate parent thread permissions`で失敗する（allowとdenyの同居不可）。
- compiled binaryはruntimeの`--deny-read`を受け付けず、script引数として渡るだけ
  （`args: ["--deny-read=…"]`）。
- 許可dir内のsymlink追従は防げない（Increment 191の既知の限界と同じ）。credential契約は
  symlinkを拒否し通常fileのみ（`credential_file.ts`のmetadata検証）。

→ credentialをallow集合の外へ置くのが構造的な解であり、denyはbest-effortの監査として
設定可能にする。

## 現行product経路・状態所有

- credential値: `<configRoot>/<authProfile>`（`openai-api-key`等）と
  `<configRoot>/chatgpt/**`（`accounts/*.json`にidToken/accessToken/refreshToken。
  `chatgpt_auth.ts`がChatGPT sign-inの保存に使用）。宣言metadataは
  `<configRoot>/credentials/*.json`（非secret）。
- credential pathの解決: `credentialPath`（`v0/agent/runtime/runtime_paths.ts`）と
  `credentialFileFor`（`v0/agent/provider/credential_file.ts`）がconfig root基準。利用側は
  `credential_resolver.ts`、`credential_registration.ts`、`chatgpt_auth.ts`、
  `live_model_catalog.ts`、`core_service.ts`、`worker_host_children.ts`、
  `worker_host_coordinator.ts`。
- `run_typescript`: model tool call → Workerのtool factory → Host-owned process executorの
  呼出し専用process（`--internal-run-typescript`）→ executor Worker permission
  `read:[workspace.root, '/tmp']`。実効sandboxはこのWorker permissionのみ（親binary・
  子processは`--allow-read`無制限）。
- config: `agents.json`／`tools.json`／`hooks.json`／`providers/*.json`／
  `credentials/*.json`（宣言）／`model-catalogs/*`／`model-metadata.json`／`instruction.md`。
- `henji diagnostics runtime`は`configRoot`・`dataRoot`・`stateRoot`を表示する。

## 採用設計・対象範囲

1. credential保存先を`${stateRoot}/credentials/`へ移す。構造は現行と同じ
   `credentials/<authProfile>`と`credentials/chatgpt/**`。
   - `RuntimePaths`に`credentialRoot`を追加し、credential path解決をconfig rootから分離する。
   - credential値の保存先を増やす変更では、sandboxのallow集合と設定例を同じ変更で見直す。
2. `run_typescript`の既定allow（read/write）をworkspace + `/tmp` + config rootとする。credential
   rootはどのallowリストにも含めず、read/writeともDenoのpermissionで拒否する。code本文へ
   `henjiConfigRoot`変数を渡し、tool descriptionに読める範囲とcredential値を読めないことを記載する。
3. sandbox設定`${configRoot}/run-typescript.json`を追加する。
   - `{ "schemaVersion": 1, "allow": [path…], "deny": [path…] }`（両方optional）。
   - `allow`: 既定allow（workspace・`/tmp`・config root）へ追加するpath（絶対pathまたは`~`始まり）。
     read/write両方に追加する。
   - `deny`: 実行前のcode監査。code本文にdeny entry（記載形または`~`展開後の絶対path）が
     現れたら実行せずtool errorで拒否する（read/writeの別を問わない）。
   - 不在時は既定のみ。不正な設定（schema違い・相対path等）はtool rejectionとして起動時に
     見える（既存のrejection表示経路を使う）。
   - 監査はcode本文の文字列照合であり、`input`経由・path合成・symlink等で回避可能な
     best-effortである。
4. 実data移動は「複製 → 新binary配置 → 新pathで動作確認 → 旧file削除」の順で行う。現行sessionは
   `opencode-go-api-key`を使用中（`default-selection.json`）のため、旧pathを先に消すと
   現行binaryのmodel requestが失敗する。旧fileが残る間はconfig rootが書換可能であることに注意し、
   新binaryの確認後速やかに削除する。
5. 正本更新: architectureのcredential scope記載1行と、READMEの配置例・`/login`・
   declaration・runtime layout。

## 計画・確認するproduct動作

focused（offline）:

- credential: 新rootからのpresence/read/write（registration、resolver、chatgpt auth）。
- `run_typescript`: config root読み取り成功、credential root NotCapable、設定`allow`の追加が
  有効、`deny`該当codeの拒否と非該当codeの実行、不正設定のtool rejection。
- 既存: workspace／`/tmp`の読み書き、1 MiB返却上限、取消の維持。

compiled（実provider callなし）:

- 隔離XDGでcompiled binaryの`--internal-run-typescript`を実行し、config root読み取りと
  credential root拒否を確認する。

production:

- 配置後、隔離XDGのTUIでcredential presence表示を確認する。実requestを伴う確認は別途承認を
  得て行う。
- 実configへ`run-typescript.json`を配置し、credential rootを`deny`に記載する。

## 承認境界

- architecture正本のcredential scope記載の変更は要承認（対象・理由・意味の変更を提示してから
  編集する）。
- 実data移動は利用者承認済み。削除は「複製 → 新pathで動作確認」の後に実施する。
- 実provider callを伴う確認は都度承認を得る。
- 205（S34）は別incrementとして扱う。

## 結果

### 実装

- credential root: `RuntimePaths.credentialRoot`（`${stateRoot}/credentials`）を追加し、`credentialPath`／
  `credentialFileFor`をこのroot基準へ変更。`createChatGPTAuthService`・`createCredentialResolver`・
  `createCredentialRegistration`・`LiveModelCatalog`・`createProductionPhysicalIo`は`credentialRoot`を
  必須引数とし、XDGへの暗黙fallbackを削除した。
- Host/Worker伝播: start command（`worker_protocol`）・`WorkerHostSessionOptions`・supervisor・
  coordinator・children・`worker_bootstrap`・physical IO・`worker_tui_session`・headless runner・
  `core_service`（`stateRoot`から導出）を更新。Host-localのcredential presence確認（coordinator・
  lazy session）はXDG直読みをやめ、そのsessionのcredentialRootを参照する。
- `henji diagnostics runtime`へ`credentialRoot`を追加。README（ja/en）のinstall例・`/login`説明・
declaration説明・runtime配置、architectureのcredential scope記載、
  `v0/eval/live_corpus_credential_launcher.ts`と`deno.v0.json`の固定pathを更新。
- run_typescript: 既定read/writeへconfig rootを追加し、`henjiConfigRoot`変数をcode本文へ渡す。
  新規`v0/agent/tools/run_typescript_sandbox.ts`が`${configRoot}/run-typescript.json`
  （`schemaVersion`・`allow`・`deny`）を検証し、`allow`をread/write permissionへ追加、`deny`は
  実行前のcode監査で拒否する。tool descriptionへ読める範囲とcredential値が読めないことを記載。

### 検証

- `v0:check`・`v0:fmt`・`v0:lint`: error 0。
- focused: `increment_204_run_typescript_sandbox_test.ts`（config rootのread/write、credential rootの
  read/write拒否、deny監査、設定検証）3件、`increment_135`・`increment_173`（credential登録/解決）、
  `increment_163`・`increment_157`・`increment_178`（ChatGPT/catalog）、`increment_133`・
  `increment_138`・`increment_191`・`agent_worker_foundation`、HTTP/Core系
  （137/139/140/141/142/143/144/145/147/159/161/167/170_s3/175/176/180/182）、`increment_32`・
  `increment_203`がpass。
- 実data移動: `~/.config/henji-harness`の`<profile>`4件と`chatgpt/`を`${stateRoot}/credentials/`へ
  複製済み（mode維持）。旧fileの削除は新binaryの配置・確認後に行う。
- compiled binary（`dist/henji`、build ID `4ada81cda5e0ebcb17cde7745d2972ca9a55b507f05e35b23941dec3438d6acd`）の
  `--internal-run-typescript`を実走し、config rootのread/write成功、credential rootのread/writeが
  `NotCapable`、deny entry参照codeが監査で拒否されることを確認した。
- 隔離XDG production probe（配置済みbinary build ID `7ecf58e9…`、localhost模擬provider、実provider
  call 0回）: config rootのread/write成功、credential rootのread/write `NotCapable`、設定`allow`
  pathの読取成功、`deny`監査の拒否、credential presenceが新root=present／旧locationのみ=missing、
  provider requestのAuthorizationが新root値（旧locationの別値は不使用）、Core exit 0を確認。
  証跡: `.tools/increment-204/deployment/production-probe.json`。

### 独立review

reviewerによるsource・test reviewを実施（2026-10-06）。product correctnessの欠陥は無し。findingと
対応は次のとおり。

- F1（test-gap）: 新規fixtureが`/tmp`配下にrootを置いていたため、`/tmp`が常に許可される現行sandbox
  ではconfig root／`allow` pathの許可を証明できなかった。fixtureのrootを`/var/tmp`へ移し、
  config root・allow path・credential rootがすべて`/tmp`外になるよう修正した。config rootのallow配線を
  一時的に外す変異チェックで、fixtureがこのregressionを検出する（failする）ことを確認した。
- F2（前提の明示）: credential rootがworkspace・config root・`/tmp`と重ならないことが要件2の前提で
  あり、記録が無かった。下記「前提」に明記した。code側の変更は行わない。
- F3（記録の不整合）: 「未確認・残る範囲」が同一commitで修正済みのincrement 189 test失敗を残存失敗と
  して記載していた。本節を実態に合わせて修正した。

### 前提（要件2の成立条件）

- credential root（`${stateRoot}/credentials`）はworkspace・config root・`/tmp`のいずれとも重ならな
  いこと。重なる場合はそれらが許可対象であるため、credential値がrun_typescriptから見える。
  配置済み環境では`/home/agent/.local/state/henji-harness/v1/credentials`で重複しない。
- 実configでは`run-typescript.json`の`deny`にcredential rootを記載し、監査層を有効にする（配置項目）。

### 実環境の移行と旧Coreの認証失敗（2026-10-06）

- 利用者の「1を実施して」により、常用config rootへ`run-typescript.json`を作成した。
  `schemaVersion: 1`、`deny: ["~/.local/state/henji-harness/v1/credentials"]`を配置済み。
- 旧locationと新credential rootの比較はAPI key 4件・ChatGPT配下7ファイルの全11件で
  `IDENTICAL`、`MISMATCH`は0件だった。その後、旧config rootのAPI key 4件と`chatgpt/`を削除した。
- 削除直後、Session `f040537a-e9c6-415e-a265-3c45f1d38f66`のexecution
  `380c49ed-16f3-4ecd-8052-ee568d989f89`は`credential_resolution`／`missing_credential`で終了した
  （2026-10-06 20:29:39 JST）。配置済みbinaryは新root対応済みだが、稼働中のTUI／Core （PID
  161597／161603）は置換前binaryを実行していた。両processの実行fileは`(deleted)`で、
  digestは`henji.previous`と一致し、配置済みbinaryとは異なることを確認した。
- 利用者の「あと始末して」と「今のコアは古いから終了する」を受け、記録を整理した。 新rootにはAPI key
  4件とChatGPT配下7ファイルが残っており、旧locationへの復元は行っていない。 現行sourceのproduction
  credential resolverでAPI key 4件の`present`と読取り成功、
  ChatGPTの`present`を確認した。credential値・Authorizationは出力せず、実provider callは0回。
- 利用者は2026-10-06 20:37に`henji tui --continue`を起動した。Core（pid 218238）は配置済みbinary
  （`/proc/<pid>/exe`が現行file、build ID `7ecf58e9…`）で稼働し、旧Core（161603）は終了済み。
  credentialが新rootのみに存在する状態で同Session `f040537a`のmodel requestが成立している。
  利用者は2026-10-06に実provider経路での確認を完了した。
- review対応後のfull test結果は保存Sessionの報告で680 pass／0 failと記録されている。
  今回のあと始末ではruntime sourceを変更せず、full suiteの再実行は行っていない。

### 未確認・残る範囲

- 実provider経路の確認は利用者が完了した（2026-10-06。配置済みbinaryの新Coreで同Sessionのmodel
  requestも成立済み）。
- config rootへの書込みを伴う実利用（model生成codeによるinstruction/tool設定の書換え）は未確認。
- 204の記録・handoff・通常利用メモの更新は本項のcommitへ保存した。205（S34）は未着手。
- `run_typescript`のsandbox境界は同toolの実行のみを対象とし、`bash`等を含むAgent全体の制限ではない
  （Increment 191と同じ。production probeでも`bash`はcredential fileを読めることを記録）。
