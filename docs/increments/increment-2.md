# 通常利用 increment 2 — step budgetとworkspace表示

ステータス: local実装と機械確認が完了。通常利用での人間による確認待ち。

## この文書の位置付け

この文書は通常利用increment 2の対象、決定、実装順、確認方法の正本である。実装後の事実は
`docs/increments/increment-2-results.md`へ記録する。現在地と次の行動は`.handoff/handoff.md`だけに置き、
`docs/roadmap.md`へこのincrementの作業履歴を追加しない。

対応するroadmap機能はF01、F02、F06、F10である。

## 通常利用で観測したこと

第1回の通常利用では、別repositoryからHenjiを起動してrepositoryのREADMEとcodeを比較した。次を観測した。

- TUIから、現在どのphysical workspaceを対象にしているか常時確認できない。
- 通常footerの`F1 help`表示は不要である。
- parent agentが8 model stepsを使った時点で`max_steps`となり、調査結果を回答する前にturnが終了した。
- Piのagent loopには固定step上限がなく、Zotの対話CLIは既定無制限、Zot SDKは既定50である。

tool選択とtool出力の効率にも改善余地があるが、これはincrement 3以降で扱う。step budgetの不足とtool利用効率を
同じ原因として扱わない。

## このincrementで成立させるproduct動作

1. 標準Henjiのroot agentは、明示指定がなければ1 turnあたり最大64 model stepsを利用できる。
2. TUI起動時に`--max-steps N`を指定すると、そのTUI invocationが起動するroot Worker generationでは
   `N`が標準値64より優先される。
3. 明示指定した値はdelegated plannerへ継承しない。delegated plannerは自身の標準値64を使う。
   `--agent planner`でplannerをroot agentとして起動した場合は、明示指定をrootの値として使う。
4. `--max-steps`はSession設定として永続化しない。同じTUI invocation内でSessionを切り替えて新しいroot
   Worker generationを起動する場合は同じ起動時指定を使い、processを再起動して指定を省略した場合は64へ戻る。
5. root agentの実効`maxSteps`をresolved selection、Manifest、実行時budget、execution artifactへ一貫して残す。
6. 通常footerへ`cwd <physical-workspace-path>`を常時表示する。表示幅が不足する場合はpathの先頭を省略し、
   repository名を含む末尾を残す。
7. 通常footerから`F1 help`というhintを削除する。F1 keyと既存help overlay自体は変更しない。

## 決定済みのinterface

### 標準値

- built-in `default`とbuilt-in `planner`のDefinition既定値をともに64とする。
- generic loopやdirect-test seamが明示的な値を渡している場合は、その値を変更しない。
- `maxSteps`は現在と同じく正のsafe integerとする。0を無制限のsentinelにはしない。

### `--max-steps`

- production TUI入口で、既存のagent/Definition selectorおよびSession selectorと任意の順序で一度だけ指定できる。
- 値の欠落、0、負数、整数でない値、safe integerでない値、重複指定は既存のsanitized
  `invalid_invocation`としてterminal acquisition前に失敗する。
- slash command `/max-steps`は追加しない。
- 起動時のdata-only requestとしてWorkerへ渡し、Definitionが返したroot compositionをWorker内で一度だけ
  finalizationして、明示値をeffective limit、resolved selection、Manifestへ一貫して反映する。
- built-inとexternal Definitionへ同じoverride規則を適用する。Definition sourceとdelegated planner handlerは
  書き換えず、指定がない既存Definitionの動作は変えない。

### workspace表示

- canonical sourceは起動時に解決済みのphysical workspace rootである。footer表示のためにfilesystemを再読しない。
- 現在のdata-only `RuntimeDisplayState`と`PresentationProjection.workspace`を使い、WorkerやSession recordへ
  TUI固有stateを追加しない。
- 96 UTF-8 bytes以内に収まるphysical pathは先頭から表示する。超える場合とfooter幅に収まらない場合だけ
  leading ellipsisを使い、末尾のpath componentを優先する。
- root workspace `/`、control character等に対する既存のbounded display/terminal escapingを維持する。
- workspace segmentは通常footerの必須orientation情報とする。狭い幅ではoptional hintやdetailを先に省略する。

## 実装範囲

### 1. default Definitionと既存identity/evidence

- `DEFAULT_AGENT_MAX_STEPS`を8から64へ変更し、built-in parent/plannerのresolved Definitionとresource
  selectionへ反映する。
- current defaultを8としているfresh-runtime comparison、replay envelope ceiling、fixture、expected manifest、
  identity/evidenceを64へ同期する。`default-max-steps-4` variantは4のまま保持し、比較軸を64対4へ更新する。
- manifest、resource selection、execution artifactのschema fieldは既存の`maxSteps: number`を維持する。
  schema versionや保存済みSessionのmigrationは追加しない。

### 2. TUI argvからroot AgentCompositionまで

- `session_launcher.sh`と`parseTuiInvocation()`へ`--max-steps N`を追加し、既存selectorとの順序、重複、値を
  terminal、credential、provider、Session storeへ到達する前に検証する。
- parsed invocationから`createWorkerTuiSession()`、Hostのstart command、Worker bootstrapまで、optionalな
  root limit requestをdata-onlyで渡す。
- Worker内にroot compositionのlimit finalizationを一箇所置き、明示値がある場合だけcompositionの
  `maxSteps`、resolved limit/resource selection、Manifestを同じ値へ再構成する。registry内のdelegated planner
  handlerには適用しない。
- Workerはfinalization後のroot compositionの`maxSteps`、resolved selection、Manifestが一致することをready前に
  確認する。
- Session navigationが同じTUI invocation内で新しいWorker generationを作る場合も、同じ起動時requestを渡す。

### 3. footer

- workspace display labelを、短いpathまで常に末尾2 componentへ縮める現在の方式から、96-byte bound内では
  full physical pathを保持する方式へ変更する。
- projectionに既にあるworkspace labelをfooter layoutへ加える。repository名を失わないsuffix clippingを
  footer幅に応じて行う。
- idle時に追加している通常footerの`F1 help` segmentを削除する。help key routing、overlay、その他の
  navigation key bindingは変更しない。

### 4. 文書と結果

- 実装が安定した時点で、roadmapのF01/F02/F06/F10の実装状況に事実上の変更がある場合だけ現在形へ更新する。
  incrementの作業履歴はroadmapへ追記しない。
- 実装内容と確認結果を`docs/increments/increment-2-results.md`へ記録する。
- 採用済み項目を`docs/experience/normal-use-inbox.md`の未振り分け一覧から除く。pending項目は残す。

## 実装順序

1. built-in defaultを64へ変更し、current defaultに結び付くmanifest、replay、comparisonを同期する。
2. `--max-steps`のparseと起動時requestを追加し、root compositionまで接続する。
3. root override、delegated planner 64、Manifest/execution artifactの実効値を確認する。
4. workspace labelとfooterを変更し、通常footerの`F1 help` hintを削除する。
5. focused test、type check、format、lint、diff checkを行う。
6. stable candidateに対してcoordinating ownerがauthoritative `v0:gate`を一回実行する。
7. 結果を記録し、ユーザーが次の通常利用で表示と8 steps超のtask継続を確認できる状態にする。

## 検証

各確認は、このincrementで変更するproduct動作に対応させる。

- Definition/composition: built-in default/plannerが64、root明示値が優先、delegated plannerは64。
- CLI/Worker: 代表的なflag順序が同じ実効値になり、不正値と重複がstartup前に拒否される。
- evidence: rootの明示値がManifest、runtime budget、execution artifactで一致する。
- Session: overrideをSession recordへ設定として保存せず、同一invocation内のnavigationでは維持する。
- footer: physical workspace pathが表示され、狭い幅でもrepository名が残り、通常footerに`F1 help`がない。
- regression: F1 key/help overlay、Session selector、external Definitionのflag未指定時、cancel、terminal restoreを
  変更しない。

実装中は変更箇所のfocused testと、該当する`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を使う。
stable candidateでだけ`deno task --config deno.v0.json v0:gate`を一回実行する。provider request、credential
read、real-TTY E2Eはlocal verificationに含めない。

機械確認は実利用の代替ではない。実装後の通常利用では、対象repositoryがfooterで識別できることと、実際の
repository調査が8 stepsを越えても継続し、64以内で回答へ到達できることを観測する。providerを使う確認は
その時点のユーザー指示に従い、この計画から自動実行しない。

## 対象外

- Markdown renderer、plain text rendererのcomponent抽出、agentによるoutput kind選択
- tool definition metadata、`read`のoffset/limit、bash全出力readback、その他のtool利用効率改善
- `/max-steps`、turn中のlimit変更、Session単位のlimit永続化
- maxStepsの無制限化、adaptive budget、provider cost policy
- F16以降のdurable AgentInstanceまたはself-revision機能
- 一般的なSurface/plugin load、Definition revision transition、protocol version migration
- credential、provider、network、production TUIの実行
- dependency/lockfile、`_refs/*`、sibling repositoryの変更
- commit、push、tag、publish、release

## 停止条件と承認

次の場合は計画内の実装詳細として補わず、ユーザー判断へ戻す。

- rootだけへのoverrideではproduct上の目的を達成できず、delegated plannerへの継承が必要になる。
- `--max-steps`をSessionへ永続化しなければ通常利用を継続できない。
- workspaceをfooterへ表示するためにHost / Worker責務またはcanonical Session schemaを変える必要が生じる。
- Markdown、tool利用効率、self-revisionをincrement 2へ追加する必要が生じる。

ユーザーはこの計画を確認し、increment 2の実装を明示承認した。
