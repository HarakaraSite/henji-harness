# 通常利用 Increment 25 — Bash workspace開始directoryの明示

ステータス: **完了**

## 利用者が必要とする動作

- `bash`の各callがRuntime factsに示されたcurrent workspace directoryから開始することを
  modelが理解する。
- current workspace内を操作するcommandではrelative pathを使い、同じworkspace rootへの不要な
  `cd`を各callで繰り返さない。
- 別directoryで実行する必要がある場合は、必要な`cd`とcommandを同じfresh shell call内で
  実行できる。

## 根拠と観測evidence

- Increment 23のproduction Human Gateで、Qwenが複数の`bash` callごとに
  `cd /home/masat.guest/src/forgejo-agent && ...`を付けた。
- 現行system instructionはRuntime factsとしてcanonical current working directoryを注入し、`bash`
  executorも`Deno.Command`の`cwd`へworkspace rootを渡している。
- 現行`bash` descriptionは`from the workspace`と記載するが、active guidelineは各callがfresh
  shellであることと状態が後続callへ残らないことだけを明記する。各callがRuntime factsの
  directoryから開始すること、そこではrelative pathを使えばよいことは明記していない。

## 実際のproduct経路

`bash` tool componentのdescriptionと`promptGuidelines`はdefault AgentCompositionのactive tool
guidelineへ合成され、OpenRouterのsystem messageまたはOpenAI Responsesの`instructions`から
modelへ渡る。modelが返した`bash` callは既存executorがworkspace rootを`cwd`にして実行する。

## 未確認事項

- instructionへの追従はmodelにより確率的であり、offline testでproductionのtool選択成功は代替しない。
- 今回観測した反復`cd`は不要だったが、subdirectory固有のbuild commandなど、別directoryへの
  `cd`が必要な実利用経路は保持evidenceから否定されていない。

## Product動作

- `bash` descriptionとactive guidelineは、各callがRuntime factsのcurrent workspace directoryから
  開始することを明示する。
- current workspaceを対象とするcommandはrelative pathを使い、同じdirectoryへ`cd`しないよう
  modelへ伝える。
- commandが別directoryで実行される必要がある場合だけ、そのcall内で`cd`する。
- executorのcwd、fresh-shell実行、tool schema、tool result、Hostの実行可否判断は変更しない。

## 実装計画

1. `bash` tool descriptionとactive guidelineにworkspace開始directoryとrelative-path方針を追加する。
2. default compositionが新しいguidelineを含み、`bash`を持たないplannerへ混入しないことを
   focused testで確認する。
3. `bash` executorが実際にworkspace rootからcommandを開始する既存動作をfocused testで確認する。
4. 関連type check、format、lint、`git diff --check`を行い、stable candidateでauthoritative
   `v0:gate`を一回実行する。
5. production retained TUIでrepository調査taskを行い、不要なworkspace rootへの`cd`なしで
   完遂することをHuman Gateとして確認する。

## 成功条件

- modelへ、各`bash` callがRuntime factsのcurrent workspace directoryから開始することが渡る。
- current workspace内のcommandでrelative pathを使い、同じworkspace rootへの反復`cd`を行わない。
- 別directoryでの実行とfresh-shell setupを必要とする正当なcommandを妨げない。
- default rootだけがbash固有guidelineを受け、plannerのguideline構成を変えない。
- production調査taskが必要なtool利用と最終回答まで完了する。

## 対象外

- executorのcwd決定、新しいcwd注入機構、Hostによる`cd`の拒否またはcommand書換え
- tool input schema、result、bash process、environment、timeout、output readbackの変更
- model別prompt、step上限、tool call数上限
- 構想、architecture、roadmap正本の変更

## 承認

- 利用者は2026-09-10に初期実装計画を承認した。

## 実装結果

- `bash` tool descriptionに、fresh shellがRuntime factsに示されたcurrent workspace directoryから
  開始することを追加した。
- `bash` active guidelineに、current workspaceではrelative pathを使って同じdirectoryへ`cd`せず、
  commandが別directoryを必要とする場合だけ同call内でdirectoryを変える動作を追加した。
- executor、cwd決定、fresh-shell実行、tool schema、tool result、planner構成は変更していない。
- 採用した観測と改善候補を通常利用メモから本文書へ移した。

## 検証結果

- default compositionのactive `bash` guidelineとplannerへの非混入を含むfocused
  `current_code_test.ts` 15件が成功した。
- `bash` commandの`pwd`が渡したworkspace rootと一致する実動作を含むfocused
  `increment_5_bash_output_test.ts` 11件が成功した。
- 対象fileのtype check、format、lint、`git diff --check`は成功した。
- 最初のauthoritative `v0:gate`は、Increment 16の既存testが旧`bash` guidelineの文字列を
  exactに期待して1件失敗した。新しいworkspace開始contractの期待へ更新し、該当focused
  test 4件の成功後にこの具体的理由でgateを再実行した。type check、全体format、lint、
  全144 testが成功した。

## Human Gate

production retained TUIでrepository調査taskを行い、必要な`bash` callがRuntime factsに示された
current workspace directoryから開始し、同じworkspace rootへの反復`cd`なしで最終回答まで完遂する
ことを利用者が確認する。

利用者は2026-09-10、`/home/masat.guest/src/forgejo-agent`から新しいproduction retained
TUI Session `7a420797`を起動し、branch、working tree、直近3 commit、`v0:gate`構成の調査を
依頼した。9回の`bash` callはすべてRuntime factsのcurrent workspaceから直接実行され、
同じworkspace rootへの`cd`を一度も含まず、最終回答まで完遂した。

依頼に含めた`deno.v0.json`は実行workspaceに存在せず、後続のfile探索が発生したが、
それらのcallもworkspace rootへの反復`cd`を含まなかった。利用者が結果を提示し、Human Gateを
通過したものとしてIncrement 25を完了した。
