# Increment 127 — 外部reviewerと組み込みplannerの廃止

状態: 2026-09-25に利用者が計画、architecture・roadmapの変更を承認。実装・配置済み。実providerのreviewerは対象を絞ったレビューを完了。

## 必要なproduct動作と根拠

- 組み込みdefault Agentは単体binaryに残し、未設定時に使える。`agent:default`の外部Definition bindingによる置換も維持する。
- 設定された`agent:<name>`を組み込みdefaultが子Agentとして利用できる。Agent名をdefaultのコードに固定しない。
- reviewerはこの環境の外部Definitionとしてinstallし、`agent:reviewer`へbindする。同梱しない。レビュー対象を調べ、根拠付きの指摘を返し、workspaceは編集しない。
- plannerの実行用Definition・role instruction・専用model/Worker経路をbinaryから除く。必要になれば`agent:planner`を通常の外部Definitionとして定義できる。
- 無名サブエージェントと起動時model指定は今回扱わない。既存Session・履歴dataは削除しない。
- 根拠: 利用者が2026-09-25に上記の役割と配置を明示した。配布形態は単体binaryを維持する。

## 現行の操作経路と変更対象

TUIと`henji run`は明示selector、`agent:default` binding、組み込みdefaultの順でroot Definitionを選ぶ。Hostは`agents.json`の`agent:<name>` bindingと組み込みplannerからasync catalogを作る。現在の組み込みdefaultは`agent:planner`だけを宣言するため、外部reviewerをbindするだけではspawnできない。Workerは宣言された名前を`spawn_subagent`などへmaterializeし、Hostは子ごとに別Worker・Executionを起動する。plannerのexact refだけがmodule、model、roleを専用に選ぶ。

変更では、Hostの解決済みasync catalog名をWorkerのDefinition inputへ渡し、組み込みdefaultがそれを宣言する。外部reviewerがdefaultの役割・tool宣言を引き継がずに構成できる汎用合成経路を加える。plannerの同梱とlive専用分岐を除去し、既存のmanaged child経路を使う。

## 実装計画

1. Definition input／resource topology／Worker startに解決済みAgent名を通し、組み込みdefaultが設定済みの子だけを宣言する。未設定時はspawn toolを出さない。外部`agent:default` bindingの優先順位を保つ。
2. 外部Definition用の合成APIに、独自の役割instruction、tool構成、子Agent宣言を指定できる経路を設ける。reviewerはmanaged parent-role Definitionとし、`read`・`bash`・`bash_output`で調査し、`edit`・`write`は与えない。`bash`には書込み能力が残るため、「編集しない」はinstruction上の動作目標として扱う。
   公開合成APIからplanner用helperを除くため、Agent Definition API contractをv2へ切り替える。既存v1 managed Definitionは再installが必要になる。この環境に登録済みの外部Definitionはない。
3. 組み込みplannerのDefinition・instruction・catalog・CLI selector・build rootと専用module/model/role分岐を除く。保存済みplanner記録のreadbackは残すが、旧planner Sessionの継続はできなくなることを明示する。
4. reviewer sourceをbinaryのimport closure外に置く。新binaryを配置した後、この環境のmanaged storeへinstallし、`agent:reviewer`をbindする。現在の`agents.json`は存在せず、登録済みmoduleもない。将来の外部`agent:planner`は同じ経路を使う。
5. architecture・roadmapを、利用者が承認した意味変更へ更新する。構想文書は変更しない。

## 受入確認

- focused testで組み込みdefault、外部default override、設定済みreviewerのspawn/collect、外部`agent:planner`の通常経路、旧planner記録のreadback、組み込みplanner選択不可を確認する。
- build manifestとcompile closureから実行用planner module・role instructionが消えたことを確認する。
- focused test・type check・format・lint・`git diff --check`を実施し、必要なら安定候補へ`v0:gate`を一回実行する。
- 隔離XDGのproduction TUI／`run`でlocalhost mock providerを用い、reviewerのspawn/collectと表示を確認し、操作・観測をここへ記録する。
- 配置した正確なbinaryでreviewerのinstall・binding・readbackを確認する。mock providerの確認はreview品質の受入とはしない。実providerでのレビュー確認は対象・回数・記録先を提示して利用者の別承認後に行う。

## 計画レビュー

- 通常レビュー: 現行Host→Worker→child経路で実装可能。mockだけではreview品質を確認できない。`bash`による書込みは技術的には可能なので、read-onlyはinstruction上の目標である。increment文書へtmux観測を記録する。
- 批判的レビュー: 新APIへ依存するreviewerを旧binaryへinstall/bindすると起動に失敗し得る。新binaryの配置を先に行い、そのbinaryで受入確認する。保存済みplanner記録のreadbackと継続不可を区別する。

## 実装・確認記録

- 組み込みdefaultはHostが解決した`agent:<name>` catalogを宣言する。外部Definition向け`createAgentComposition`は役割instruction・tool・子Agentを明示でき、reviewer sourceは`agents/reviewer.ts`に置いた。実行用planner module、role instruction、専用model/Worker分岐、build rootは除去した。履歴codecの旧planner値はreadback用に保持した。
- 新しいDefinition API contractは`henji-agent-definition-v2`。この環境には既存のmanaged Definitionや`agents.json`がなかったため、v1 revisionの再install対象はなかった。
- focused testで、未設定default、外部default binding、外部reviewerのspawn/collect、外部plannerの通常のmanaged child経路、reviewerのtool宣言を確認した。旧async子Agentのlifecycle／durability testは組み込みplanner参照から外部refへ切り替えた。関連143件、`v0:check`、対象lint、`git diff --check`成功。`v0:test`の初回はIncrement 126の128-step変更に追従していなかったproduction CLI E2E fixture（64）だけが失敗した。fixtureを128へ直した後の`v0:test`は全task成功。
- 隔離XDG `/tmp/henji-i127-mock/xdg`に外部reviewerとlocalhost Chat providerをinstall／設定し、source production `henji run --json --max-steps 8`で親の`spawn_subagent(reviewer)`→`collect_subagent`→finalを確認した。collectには`local/reviewer@sha256:b510daaa…`、completed、子の`providerRequestCount:1`が出た。親は3 request、localhostには親3件＋子1件。`henji run`も`default-selection.json`のmodelを使用した。
- 同じ隔離XDGのproduction TUIをtmuxで起動し、`user>`指示後に`tool> spawn_subagent ✓`、`tool> collect_subagent ✓`、`assistant> Parent collected reviewer result.`、footerの`provider:local-chat model:mock-model none`を確認した。captureは`/tmp/henji-i127-mock/tui-start.txt`と`tui-result.txt`、request種別は`server.log`。実configと実providerは使っていない。このmock結果はreviewerの実際の指摘品質を検証しない。
- clean commit `505b8468`からDeno 2.9.7で単体binaryをbuildした。build IDは`15c3827f…`、file SHA-256は`2bdf1063…`、source dirty markerはfalse、Definition APIはv2。runtime manifestの同梱Agentは`builtin/default`のみで、`builtin/planner`はない。`~/.local/bin/henji`へ原子的に配置し、配置前後のSHA-256一致と起動を確認した。`agents/reviewer.ts`を同binaryで`local/reviewer@sha256:b510daaa…`としてinstallし、実configの`agent:reviewer`へbindした。既存のbindingはなかった。
- 利用者承認の実provider確認では、通常の保存Session `e86cca79-e50c-439d-8069-4246b16f9ac4`から`opencode-go-chat / mimo-v2.6-pro`を使用し、外部reviewerを1回spawnしてcollectした。親Execution `12ec38fe-d81e-4354-9bc7-4fa295014793`は4 requestでfinal、子Execution `480201d4-5b1b-461e-b7a0-40eee6c0209b`は4 requestで`max_steps`停止。親子合計8 requestで承認上限内だった。子はreview本文を返さず、review findingは得られなかった。`--max-steps 4`は承認上限8 requestを守るため親子に適用した値であり、通常の既定128 stepによる動作はこの実provider確認からは判断できない。Session/Executionは通常のstate rootに保存され、TUI captureは`/tmp/henji-i127-mock/live-review-capture.txt`。この1件を再実行していない。
- 利用者の別承認で2回目の実provider確認を行い、保存Session `97060778-ec98-4912-b0ee-0342d5117153`から同じreviewerを1回spawn/collectした。親Execution `2a430e60-2e71-4586-84a1-2592e95b6f07`は3 requestでfinal、子Execution `d97876d7-9dea-4da3-b31d-5e9d32d84961`は8 requestで`max_steps`停止し、合計11 requestで承認上限16以内。子の保存messageからincrement文書、reviewer Definition、Worker API等を読み、planner参照を調べていたことは確認できたが、review本文は生成しなかった。TUI captureは`/tmp/henji-i127-mock/live-review2-capture.txt`。両確認とも設定したstep上限で止まっており、通常の既定128 stepでreviewerが結果を返すかは未確認。新たなproduct findingは得られていない。
- 利用者の指示で対象を「設定済み`agent:reviewer`を組み込みdefaultが公開・起動・収集できるか」に絞り、子の上限を16 stepにした3回目の実provider確認を行った。保存Session `26e11580-8096-422f-9679-0a7bfec88f0a`の親Execution `8f0e9754-38cf-4fcb-a52b-4ce0bd9ed373`は7 request、子Execution `05445552-97b6-42aa-a4b3-10c60a4a5fe2`は4 requestでともにfinal。reviewerは`v0/agent/tools/async_agents.ts`と`v0/agent/definitions/agent_slot_binding.ts`を読んで、この限定経路にfindingなしと回答した。defaultのtool assemblyとHost RPCは子のread範囲外と明記したが、この実行自体が公開・起動・収集のproduction経路を通った。TUI captureは`/tmp/henji-i127-mock/live-review3-capture.txt`。
- 標準の`henji history --session 26e11580 --view session`では親の依頼、親のthinking・tool行、親の最終回答が表示された。子のtool・途中経過は親のSession表示には現れない。子のmessageは別Executionとして保存された。`--view detail`には親の`collect_subagent` tool resultのJSONは含まれるが、Session correlationで抽出するため、子Execution自体や子の途中のtool履歴は含まない。

## v0.6.0公開

利用者指示により、Increment 117〜127までのsourceを`@henji/harness@0.6.0`としてJSRへ公開した。
0.5.0以降のDefinition composition APIには互換性破壊（planner roleと`plannerAgentDefinition`の除去、
`PhysicalIoBindings`のrole縮小）と追加（`roleInstruction`／`tools`／`asyncAgents`）があるため、
versionは`0.6.0`とした。`jsr.json`、`README.md`、`README.ja.md`、`mod.ts`のversion表記を更新した。

- release source commit: `b274be9d2155469db480216447168693e323b57c`。publish前に`origin/main`へpushし、
  localとremoteが同じcommitであることを確認した。
- release準備のcommitで`jsr.json`のpublish includeを修正した。JSR dry-runで
  `v0/agent/core/readable_thinking.ts`がpackage module graphにあるのにincludeから漏れている
  `excluded-module`を検出したため追加し、削除済みmoduleのまま残っていた
  `v0/agent/instructions/roles/planner.ts`と`v0/agent/provider/provider_evidence_store.ts`を除いた。
  `505b8468`でformat崩れた`v0/agent/README.md`は`deno fmt`で折り返し整形した（語列は同じ）。
- release候補の`v0:gate`を実行した。1回目はこの実行環境の`HOME`が空で
  `increment_101_provider_headers_test`のcredential path testが`invalid HOME`になり、focused再確認
  （17件成功）でrelease候補起因でないと特定した。`HOME`を設定した再実行は44 taskすべて成功。
- clean worktree `/tmp/henji-harness-jsr-0.6.0.5ZKJST`（detached `b274be9d`）で`deno publish --dry-run`を
  実行し、`@henji/harness@0.6.0`の84 fileが`publish.include`と`jsr.json`だけで構成され、slow type
  diagnosticがないことを確認した。`--allow-slow-types`と`--allow-dirty`は使っていない。
- 利用者がauth pageでpackage名とversionを確認してApproveし、`@henji/harness@0.6.0`のpublishに成功した。
  registry metadataのlatest／exact versionと、公開packageからのexact-version importでexport 8件が
  解決することを確認した。dry-runとpublishのログは`/tmp/jsr_dryrun.log`と`/tmp/jsr_publish_pty.log`。
- release固有の追加testは追加していない。実provider callとproduction CLI E2Eは未実施。Git tagと
  Forgejo Releaseは作成していない。構想・architecture・roadmapは変更していない。
- 運用手順の観測: headless環境では`deno publish`のinteractive authがTTYなしでは
  `No means to authenticate`で止まるため、pty上で起動した。`docs/operations/jsr-publish.md`へ
  この前提を追記するかは利用者判断待ち。
