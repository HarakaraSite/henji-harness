# 通常利用 increment 23 — 取得済み結果の再利用、調査終了、tool実行境界

ステータス: **完了**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- 同一turnで正常に取得済みのsource、tool result、web search resultを再利用し、具体的な理由なしに同じread、
  重複範囲の取得、同趣旨のsearchを繰り返さない。
- continuation、truncation、source変更、前回failure、または既存結果で解決できない具体的な問いがある場合は、
  必要な範囲だけを追加取得する。
- requested answerを支えるsourceが揃ったら調査を終了し、追加取得自体を目的にしない。
- `bash`が毎回fresh shellで実行されることをmodelが理解し、後続callには残らない環境設定だけのcommandを
  実行しない。設定が必要なら、それを消費するcommandと同じcallで実行する。
- ユーザーが現在のtaskで実instanceまたは認証済みclientの利用を明示的に求めていない限り、toolから
  credential設定を読んだりsourceしたり、task対象の認証済みserviceへ接続しない。

## 根拠と観測証拠

- production retained TUIのSession `77e1f980`ではForgejo APIの概要説明を完遂したが、同じ
  `docs/FORGEJO_API_RESEARCH.md`、`.handoff/handoff.md`、重複するline範囲、類似queryのweb searchを繰り返した。
- Session `79e87fa2`ではQwen rootが15回の`bash`、10回の`read`、3回の`web_search`を含む29 tool callsと
  21 provider requestsを行った。model step 18の21回目でAlibaba providerがHTTP 502
  `STOP_ENGINE_ERROR`を返し、turn全体がuncommittedになった。
- 同Sessionの別実行では、`set -a; . "$HOME/.config/fja/config.env"; set +a`と同義のcommandを別々の
  `bash` callで実行し、同じcall内に設定を消費するcommandがなかった。現行`bash`はcallごとに新しいprocessを
  起動するため、その環境変更は後続callへ引き継がれないが、tool descriptionとguidelineはこの実行契約を
  modelへ明記していなかった。
- 「Forgejo APIを調査し概要を説明して」というrepositoryまたは公開APIの調査依頼に対し、実instanceや
  認証済みclientの利用は求められていなかった。credential設定のsourceと認証済みservice利用を認める境界も
  Henji共通instructionに明記されていなかった。
- 現行Henji共通instructionはcurrent sourceの直接取得と完了前の照合を求めるが、同一turnで取得済みの結果を
  再利用すること、再取得が必要な条件、十分な根拠が揃った後の終了を明記していない。
- agent loopとRegistryはmodelが返した有効なtool callを順に実行し、同一引数または重複範囲を検出して拒否する
  contractを持たない。今回の変更はこの実行境界を変えず、modelのtool選択をinstructionで改善する。

## Product動作

### 取得済み結果の再利用

- 同一turnのtranscriptに成功済みtool resultがある場合、その内容を後続判断と回答に再利用する。
- 同じsourceまたは同趣旨の外部情報を再取得するのは、次のいずれかを満たす場合に限る。
  - resultにcontinuationまたはtruncationが示され、未取得範囲が必要である。
  - write、edit、外部状態変化等によりsourceが取得後に変わった。
  - 前回取得がfailureであり、成功結果が残っていない。
  - 既存結果では答えられない具体的な問いまたは箇所があり、その不足を埋める。
- line windowを追加取得する場合は既取得範囲と重複させず、案内されたoffsetと必要なlimitを使う。workspace fileを
  正常に`read`できている場合、同じ内容を得るための`bash cat`や`sed`へ切り替えない。
- web searchは既存sourceで未解決の、現在性または外部確認を必要とする問いに使う。語句だけを変えた同趣旨の
  queryを、具体的な情報不足なしに繰り返さない。

### 調査終了

- requested answerをcurrent sourceと必要な外部確認が支えられる時点でtool利用を終了し、回答する。
- source間の不一致または未確認事項が残る場合は、その内容を区別して回答する。情報が増える可能性だけを理由に
  取得を続けない。
- この動作はinstruction上のtool選択方針であり、Hostはtool callを重複判定、拒否、短縮しない。正当な再取得と
  modelの自律的な調査を維持する。

### Bash実行契約とcredential許可境界

- `bash`のtool definitionとactive tool guidelineは、callごとにfresh shellであり、`cd`、変数代入、`export`、
  `source`、alias、functionの状態が後続callへ残らないことをmodelへ伝える。
- 環境設定を必要とするcommandは同じ`bash` call内で設定を消費し、効果がcall終了時に失われる設定だけの
  commandは実行しない。
- modelは、ユーザーが現在のtaskで実instanceまたは認証済みclientの利用を明示的に求めた場合だけ、toolから
  credential設定を読む・sourceする、またはtask対象の認証済みserviceへ接続する。repository、source code、
  documentation、API、product、serviceの調査・説明・要約だけの依頼は、この許可に含めない。
- 許可された場合もcredential値を表示しない。この方針はmodelのtask tool利用に対するもので、Henji Workerが
  provider request時に行う既存のprovider credential解決は変更しない。

## 実装計画

1. Henji共通instruction componentへ、成功済みresultの再利用、再取得条件、非重複window、web searchの不足駆動、
   十分な根拠が揃った時点の終了、task toolに対するcredential許可境界を追加する。
2. `bash` tool definitionとactive tool guidelineへfresh-shell契約と、設定を消費するcommandを同じcallに置く動作を
   追加する。bashを持たないagentへbash固有guidelineを合成しない。
3. defaultとplannerが同じ共通componentを受け、OpenRouter system messageとOpenAI Responses instructionsへ同じ
   resolved instructionが渡る既存構成を維持する。
4. instruction composition、active tool guidelineと両provider wire mappingのfocused testを更新する。modelの
   確率的なtool選択をoffline fixtureで成功したことにはしない。
5. focused test、type check、format、lint、`git diff --check`と差分reviewを行い、stable candidateでauthoritative
   `v0:gate`を一回実行する。
6. 利用者がproduction retained TUIでsource調査taskを実行し、回答に必要な取得を保ちながら、理由のない同一read、
   重複範囲、同趣旨searchが減ることをHuman Gateとして確認する。

## 成功条件

- built-in defaultとplannerへ同じ再利用・再取得・終了方針が合成され、両provider wireへ同じ意味で渡る。
- bashを持つrootへfresh-shell契約がtool definitionとactive tool guidelineの両方で渡り、bashを持たないplannerへ
  bash固有guidelineが混入しない。
- repository、source code、documentation、API、product、serviceの調査・説明・要約だけの依頼では、credential
  設定を読まず、認証済みserviceへ接続しない。実instanceまたは認証済みclientの利用が明示された場合は、
  credential値を表示せず必要な接続を行える。
- modelは成功済みresultを後続stepで利用し、追加取得が必要な場合だけ不足範囲または具体的な問いを取得する。
- source準拠、正確性、必要なweb search、continuation、変更後の再確認を妨げない。
- production調査taskが最終回答まで完了し、観測された不要な反復が減る。

## 対象外

- HostまたはRegistryによるduplicate tool callの検出、拒否、cache、書換え
- tool call数、provider request数、web search数の固定上限
- provider retry、provider/model fallback、routing変更
- `read`、`bash`、`web_search`のinput schema、result、保存形式変更
- model別prompt、effort既定値、agent step budgetの変更
- 構想、architecture、roadmap正本の変更

## 実装結果

- 利用者は2026-09-10に初期実装計画を承認した。
- `v0/agent/instructions/henji_common.ts`のHenji共通instructionへ、同一turnの成功済みresult再利用、再取得を
  必要とする条件、非重複の継続read、具体的な不足に対応するweb search、根拠が揃った時点での調査終了を
  追加した。続くproduction観測を受け、task toolからcredential設定または認証済みserviceへアクセスするための
  ユーザー許可境界も追加した。
- `v0/agent/tools/bash_tool.ts`のtool descriptionとactive tool guidelineへ、callごとのfresh shell、後続callへ
  状態が残らないこと、必要な設定と消費commandを同じcallに置くことを追加した。
- 共通componentの既存compositionを維持したため、built-in defaultとplannerは同じ方針を受け、OpenRouterの
  system messageとOpenAI Responsesの`instructions`へ同じresolved instructionが渡る。
- HostまたはRegistryのtool実行、provider transport、retry、fallback、model selection、tool input schemaとresultは
  変更していない。

## 検証結果

- instruction composition、default/planner共有、Worker/direct runtime一致、OpenRouter/OpenAI wire mappingの
  focused testは4件通過した。
- revised scopeのbash description・active guideline、default/planner分離、共通credential境界を含むfocused testは
  19件通過した。
- 対象fileのtype check、format check、lintと`git diff --check`は通過した。
- 改訂後の最初の`v0:gate`は、evidenceのrequest bodyに含まれる通常のinstruction中の`authorization`という語を
  credential漏洩と誤判定する既存Increment 7 testで停止した。fixture credential値が含まれない検証は保持し、
  一般語だけを禁止するassertionを削除した。該当focused test通過後、この具体的修正を理由に再実行した
  authoritative `v0:gate`でtype check、全体format、lint、全140 testが通過した。

## Human Gate

利用者は2026-09-10、異なるOpenRouter modelで同じForgejo API調査taskを試し、不要なtool反復と長いtool loopを
観測した。同一turnの成功済みresultを再利用し、具体的な不足がある場合だけ追加取得するinstruction改善を
Increment 23として実施する方針と初期実装計画を承認した。その後、bashのfresh-shell契約とcredential許可境界を
追加する改訂も承認した。

再起動後のproduction retained TUIで同じ調査taskを実行し、Session `4506689f`ではcredential設定の読取り、
認証済みinstanceへの接続、設定だけのbash call、理由のない同一source取得を行わず、必要なrepository sourceと
一回のweb searchから概要説明を完遂した。続くSession `c41865cf`もcredentialまたは認証済みinstanceへアクセスせず
完遂したが、Qwen `xhigh`による長い推論と調査反復を観測した。利用者は後者をmodel特性として運用上注意する所感とし、
model別のproduct対応候補にはしないと判断した。workspace rootへの反復`cd`は別の未採用候補として通常利用メモへ
保存した。利用者はこれらの結果を確認し、2026-09-10にIncrement 23を完了とした。
