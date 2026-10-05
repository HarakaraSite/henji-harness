# Increment 192 — openai-chat同梱routeの廃止

状態: local実装・検証済み（2026-10-05）。常用配置と利用者の通常利用による完了確認は未実施。

## 利用者が必要とする動作

OpenAIのreasoningとtoolsを使う通常利用を、既存の`openai-responses`または`openai-chatgpt`へ寄せる。
同梱の`openai-chat` routeを廃止し、provider選択画面だけのフィルタには留めない。

利用者は「後方互換性は維持しなくていい」と明示し、OpenRouter・外部provider用の共有Chat Completions
adapterを残す方針に同意した後、「では次のインクリメントはそれにする」と採用した。
本書を今回の要件・対象範囲・計画・結果の正本とする。

## 根拠となる実行記録と公式契約

- 2026-10-05 12:10 JST、Session `1ced5e54`のexecution `ebb58d88-4912-4112-8917-1108d3170e28`は、
  `openai-chat`／`openai-chat-completions`／`gpt-5.6-sol`／`high`の最初のrequestでHTTP 400になった。
  paramは`reasoning_effort`、tool実行は0回。APIはfunction toolsとreasoning
  effortの併用を受け付けず、 Responsesまたはeffort `none`を案内した。保存済みdiagnostic
  `b1b4879f-75f4-4314-8023-7989236da1e2`とruntime outcomeをread-onlyで確認した。
- 同日11:18 JSTのexecution `60c346bf-f085-4637-be27-be965adc8b4d`は、同じprovider/modelの effort
  `none`でcompletedし、toolを1回実行した。model単体の利用不能ではなく、APIとeffortの組合せによる制約である。
- [Increment 68](increment-68.md)でもこの制約を実APIで観測し、`openai-chat`の既定effortを`none`にしていた。
  [Increment 190](increment-190.md)では6.1-solだけをmodel一覧から除外したが、今回はroute全体を廃止する。
- 2026-10-05の[OpenAI公式移行ガイド](https://developers.openai.com/api/docs/guides/migrate-to-responses)の
  調査で、Chat Completionsのサポート継続、新規projectへのResponses推奨、GPT-5.4以降はChat
  Completionsでeffort `none`以外のtool callingをサポートしないことを確認した。
- [GPT-6.1 Sol公式仕様](https://developers.openai.com/api/docs/models/gpt-6.1-sol)はtool callingに
  Responsesが必要で、effort `none`も非対応とする。5.6-solの`none`による回避を6.1-solへ一般化しない。

## 現行の利用経路と状態所有

同梱IDは`model_selection.ts`、同梱declarationと既定model/effortは
`defaults/provider-defaults.json`が供給する。外部declarationと合わせたregistryをHostとWorkerへ渡す。

TUI `/provider`はCore `catalog.read(kind=providers)`の一覧を表示し、選択を
`selection.change`へ渡す。Core/Workerが選択を反映し、DataがSessionのactive modelと変更史を保存する。
新規Sessionの既定はHost-owned `default-selection.json`、既存Sessionの再開は保存済みselectionを使う。
CLI
`--root-provider`も同じregistryを使い、子agentのprovider候補は`providerIdsForSelection()`から提示する。

request時は`worker_physical_io.ts`がdeclarationとAPIに対応したmodel adapterを作る。
`openai-chat`は共有のChat Completions adapterを使う。OpenRouterと外部のChat Completions
providerもこのadapterを使うため、route廃止とadapter廃止を分ける。 OpenAI API
keyは`openai-responses`も使うため、credential profileは残す。

## 採用範囲と対象外

- 同梱ID・declaration・既定設定から`openai-chat`を除き、TUI、CLI、子agentの同梱候補から外す。
- `openai-chat`専用のselection分岐、metadata対応、190のmodelフィルタなど、廃止後に不要になる処理を除く。
- READMEと現行利用案内をResponses経路に合わせ、廃止されたproduct動作を要求するtestを修正または削除する。
  68・190等の過去increment文書は当時の記録として保持する。
- `openrouter-chat`、外部Chat Completions provider、共有protocol/adapter、OpenAI API
  key登録を維持する。
- 旧routeからの自動切替、alias、migration、compatibility read、専用fallbackを追加しない。
  既存の履歴DB、Session、catalog、default selection、credentialを削除・書換えしない。
  同梱route廃止のために外部declarationへの新しい禁止規則を追加しない。
- 新しい保存先、raw収集、一般的hardening、API response制限、effort送信の抑制を追加しない。

## 実装と確認の計画

1. registry・selection・catalogの`openai-chat`専用処理と、CLI・子agent・credential案内への参照を整理する。
   専用modelフィルタは除去し、共有Chat Completions経路を残す。
2. 既存testを変更後のproduct動作へ合わせる。focused確認は、Coreのprovider一覧・選択、
   CLIのconfigured provider解決、子agent候補、Responsesのselection、共有credential登録、
   OpenRouterと外部Chat Completionsのrequest経路に対応させる。
   旧routeの互換利用を受入条件にせず、historical
   selectionの一般的な保存・参照契約とruntimeのroute解決を混同しない。
3. 変更箇所のtype check、format、lint、`git diff --check`を行う。途中のfull gateは行わない。
   registry変更が複数の利用入口に及ぶため、安定候補でcoordinating ownerが`v0:gate`を一回実行する。
4. 隔離HOME/XDGのproduction TUIをtmuxで開き、`/provider`から旧routeが消え、
   `openai-responses`と`openai-chatgpt`を選べることを確認する。
   共有経路の確認には隔離configと必要ならlocal providerを使い、実provider
   callは本計画では要求しない。 操作・観測・証拠の保存先を本書へ記録する。

既存Session・default selection・外部overrideが旧routeを参照したときの表示・解決経路を、
現行sourceと隔離環境で確認した。結果は下記に記録する。互換回復は追加していない。
通常利用による完了確認は、利用者が残るResponses経路を選び、目的のtool付きturnを完了できることである。

## 正本変更案と承認境界

architectureの同梱五routeの説明とprovider/auth文書から`openai-chat`を除き、同梱四routeとする。
roadmapのF02にも192の結果と共有adapter維持を反映する案を
[未適用patch](increment-192-authority-proposal.patch)へ保存した。`git apply --check`は通過した。
構想のWhyは変更しない。
architecture・roadmapの正本反映は、対象・理由・意味上の変更を別途提示して明示承認を得てから行う。

採用後の「実装して」によりlocal実装と非破壊的な検証を実施した。commit/push、常用binary配置、
公開/release、実provider callは実施していない。旧実データの削除・移行は採用範囲に含めない。

続く「コミットと配置をお願いします」により、192のsource
commitと常用binaryのbuild・配置を承認された。 配置後は隔離XDGのproduction TUIとlocal
providerで確認し、実provider callは行わない。
push、JSR公開/release、architecture・roadmap正本反映はこの指示に含めない。

## 実装結果

- `BUILTIN_PROVIDER_IDS`と同梱declarationから`openai-chat`を除いた。Core provider catalog、CLIの
  configured provider解決、子agentの候補提示、credential登録先表示は既存registry経路から変更が届く。
- `isStoredModelSelection`の専用分岐、models.devへの専用対応、190の専用modelフィルタを除いた。
  保存selectionは既存の一般的なprovider/API構造として読む。旧route専用の互換処理は追加していない。
- READMEとAgent利用案内をResponsesへ合わせた。旧routeのAPI実行を要求したtestはregistry・CLIの
  廃止確認に更新し、190の廃止されたフィルタ動作を要求するtestを削除した。
- OpenRouter・外部Chat Completionsの共有adapterとprotocol、Responses adapter、OpenAI API keyの
  credential profileは維持した。外部declarationへの禁止規則、effortの抑制、data
  migrationは追加していない。

## 検証結果

- focused testは43件pass。registry・CLI、Core HTTP provider一覧、ResponsesとChatGPTのselection、
  子agent候補、credential登録先、model catalog、OpenRouter・外部Chat Completionsのrequest、
  Responsesのtool continuationとHost/Worker保存・再開を確認した。
- production CLI入口と変更testのtype
  check、変更source/testのlint、format、`git diff --check`が通過した。 authoritative
  `v0:gate`は644件pass。初回gateは変更した`v0/agent/README.md`のformatで停止し、 full
  test未実行だった。同fileをformatしたことを再実行理由とし、修正後のgateを一回通した。
- 公式build scriptで確認用binaryを`.tools/increment-192/henji`へ出力した。 build
  IDは`cf15d9fea32041b179ad4de71402c8030ac7b947d490ada894a0ea9b9be5ae32`、
  sourceは`8f6e113b`、sourceDirty=trueのlocal
  candidate。`dist/henji`と常用binaryには配置していない。
- 隔離HOME/XDG/workspaceのcompiled production Coreとtmux TUIで、`/provider`に同梱四routeと
  明示した外部`local-chat`だけが表示され、`openai-chat`が無いことを確認した。
  `openai-chatgpt`、`openai-responses`、`local-chat`を順にTUIで選択し、Session
  selectionをAPIでreadbackした。
- 同TUIで外部`local-chat`を使い、workspaceの`probe.txt`を`read`で読むtool付きturnを実行した。
  localhostの2 request（tool call、tool resultを受けた最終回答）で`LOCAL_CHAT_OK_192`を表示し、
  DBのexecutionがcompleted/canonicalになることを確認した。実provider requestは0回である。
- 旧routeのdefault selectionを隔離configへ置いた場合、selectionは旧値のまま読まれ、task受付は
  `admissionFailed`で却下された。default fileは書換えられなかった。
  隔離DBの保存済みSessionを旧routeのselectionにしたfixtureも、再開後に旧値のまま参照できた。
  同梱`--root-provider openai-chat`はconfigured providerが無いとしてexit 1になった。
- 利用者が同名の外部declarationを明示した場合は、一般的な外部providerとして解決・選択できた。
  同梱route廃止を、利用者による外部provider追加の禁止へ拡張していない。
- 差分の自己確認では、active sourceに`openai-chat`専用処理が残っていないことと、共有adapterが
  維持されていることを照合した。architecture・roadmapと既存実データは変更していない。

証拠はgit管理外の`.tools/increment-192/`に置く。`gate.log`、`type-check.log`、`build.log`、
`checks.json`、`tmux-result.json`、`tui-provider-*.txt`、`tui-selected-*.txt`、
`tui-local-chat-completed.txt`と`tmux_check.py`を参照する。 tmux確認の初期失敗は隔離credential
fileのmodeと未保存Sessionを再開対象にしたprobe準備に起因し、
probeを修正して再確認した。製品への追加修正は行っていない。

local実装と計画上の確認は完了した。常用配置・実providerによる通常利用・利用者の完了承認は未実施である。
