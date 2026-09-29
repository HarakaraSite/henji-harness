# Increment 156 — S15: 履歴閲覧中のEscで最新表示へ戻る

更新日: 2026-09-29

ステータス: 利用者確認・完了承認済み（2026-09-29）。Increment 156は完了。
local実装・非破壊的検証・commit/push・常用配置・配置後確認を完了した。
利用者のEsc確認と「インクリメントを完了としてセッションを終わります」により、完了承認・セッション終了を記録する。

## 要件と権限

利用者の「s15をやりたいtuiの分離で条件が変わっているかもしれないが」によりS15を採用する。
当初はlocal実装と非破壊的検証を行う範囲だった。追加指示「コミットプッシュ配置を行ってください」により、
commit/push・常用配置と配置後確認を行う。公開と構想・architecture・roadmapの変更は含めない。
既存の未採用S26メモは保持する。

通常利用メモから移した観測・利用者判断（2026-09-26）:

- ターン実行中にPageUpで履歴を遡り、Escで閲覧を終えようとするとターンがキャンセルされる。 Increment
  128ではbusy中のEscを常にcancelとし、履歴閲覧中は`PgDn latest`と`Esc cancel`を表示していた。
- busy中でも履歴閲覧中はEscで最新表示へ戻りたい。最新表示中のEscはターンをキャンセルする。
  当時はメモのみの指示だったが、今回の指示で実装へ採用した。

| 操作・状態       | 必要な動作                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ |
| 履歴閲覧中のEsc  | busyを含め、最新表示へ戻る。キャンセルAPIを送らず、draftとCoreの実行を維持する。           |
| 最新表示中のEsc  | 実行中なら従来のexecution.cancelを送る。idleでは最新表示を維持する。                       |
| PageDown         | 既存のページ移動と最新表示へ戻る動作を維持する。                                           |
| フッター・ヘルプ | 履歴閲覧中はEsc latestを案内し、Esc cancelを表示しない。最新表示中のcancel案内は維持する。 |
| overlay中のEsc   | 既存のヘルプ・pickerを閉じる動作を維持する。                                               |

## TUI分離後の現行経路と計画

通常CLI → `remote_tui_cli.ts` → `runRemoteTui` → input decoder → overlay処理 → PageUp/PageDown/Esc →
`TuiRenderer`のUI-local scroll、または`HenjiApiClient.executionCancel` → Core。
以前の`controller.ts`は廃止され、現在の入口は`v0/tui/remote_session.ts`にある。
Coreが実行・semantic履歴を所有し、TUIがeditor、overlay、scrollを所有する。
複数TUIのscrollはそれぞれ独立している。新しいCore状態やAPI、保存先は不要。

分離後も、Escの入口はactive executionの有無をscrollより先に判定しており、S15の問題が残っている。
overlay処理の後でscrollがfollowLatest以外ならrenderer.latest()を優先する。
フッターの履歴案内とcancel controlsの選択、接続TUIのヘルプを動作に揃える。
履歴表示中にstream更新が届いても、既存のscroll anchor保持をそのまま利用する。

## 検証方針

- retained footerの旧仕様testを更新し、busy/idleの履歴案内と最新表示時のcancel案内を確認する。
- 接続TUIのfocused testでbusy中のPageUp → Escがcancelを送らず、最新表示中のEscが送ること、
  draft、stream更新、PageDownとoverlay復帰を確認する。
- 関連focused test、必要なtype check、format、lint、git diff --checkを行う。full gateは要求しない。
- 隔離HOME/XDG/workspaceのtmuxでproduction TUI/Coreを操作する。 loopback
  providerで進行中の実行を作り、HTTP snapshotと画面からキャンセルされないことと
  最新表示中のキャンセルを確認する。外部provider requestと実credentialは利用しない。

## 結果

### 実装

`remote_session.ts`でoverlay処理後、EscはscrollがfollowLatest以外なら最新表示へ戻る。
その後に従来のactive executionのキャンセル判定を行う。Core/APIとscrollの所有境界は変更していない。
`layout.ts`の履歴フッターはbusyを含めEsc latestを優先する。元のstatusからcancelをcontrolとして
取り出したうえで履歴中の表示から除外し、notice/detailsへEsc cancelが再出現することも防ぐ。
最新表示時のcancel controls、PageDown、overlayのEscを維持した。
接続TUIのヘルプとHTTP操作文書を動作に揃えた。

### focused確認と自己review

- 接続TUIの140/141/142/143、retained terminal、154 schedulerの6 test file、50 testがpass。
- 156の接続TUI testではbusy中のPageUp、閲覧中のstream snapshot更新、ヘルプ開閉、Escによる
  最新復帰、draft保持、PageDown復帰、最新表示中のキャンセルAPI一回とterminal復元を確認した。
- retained footerの旧仕様testを更新し、busy中のfallback cancel案内とremote statusのcancel案内が
  ともに履歴閲覧中には表示されず、最新表示に戻るとcancel案内へ戻ることを確認した。
- CLIのtype checkとfocused testのtype check、変更TSのlint、変更8ファイルのformat、 git diff
  --checkがpass。full gateは実行していない。
- 自己reviewではoverlay → scroll → executionの判定順序、footerのcontrols/detailsへの表示重複、
  stream更新中のscroll保持、既存のキャンセル受付・PageDown経路を確認した。
  今回は局所的なTUI変更であり、専門agentによるreviewは実施していない。

初回の新testでは、80列で省略される任意のnew below表示を待ち、次に本文のhistoryという文字列も
footerと同じものとして判定していた。実画面の履歴record数とfooterの位置表示を確認するtestへ
修正した。productionの表示幅や省略規則は変更していない。

### 隔離tmuxのproduction経路

sourceと公式build scriptから生成した検証用compiled CLI/Core/TUIを80×30で操作した。
各caseのHOME/XDG/workspaceを隔離し、実configや既存Coreには操作していない。 loopback Responses
providerで一回ずつ実Bashを起動し、外部provider requestは0回、 loopback
requestは合計2回。実credentialは使用していない。

| 操作・観測       | source                                                                       | compiled |
| ---------------- | ---------------------------------------------------------------------------- | -------- |
| busy中PageUp     | Esc latestを表示し、Esc cancelを表示しない                                   | 同左     |
| 履歴中Esc        | 同じexecution ID・running phase・Bash PIDが継続し、最新表示へ戻る            | 同左     |
| 最新表示中Esc    | executionがcancelled/settledとなり、Bashが終了                               | 同左     |
| draft            | 履歴閲覧・Esc復帰の前後で保持                                                | 同左     |
| PageDown         | 最新表示へ戻り、running phaseとBash PIDが継続                                | 同左     |
| ヘルプ中Esc      | 履歴閲覧へ戻り、実行が継続                                                   | 同左     |
| idle中PageUp/Esc | 履歴閲覧から最新表示へ戻る                                                   | 同左     |
| 別接続TUI        | 操作元のPageUpでviewportが変わらず、最新表示を維持                           | 同左     |
| 終了             | observerをCtrl-D、操作元をCtrl-Qで終了。TUI/Coreはexit 0、canonical/echo復元 | 同左     |

検証用binaryは`/home/agent/.local/state/henji-build-artifacts/increment-156-20260929/henji.accepted`、build
IDは `926495628dddd263fee0680ec1a0b914ee86d478d18d587dbd2b876e9b780259`。
証拠は`/home/agent/.local/state/henji-build-artifacts/increment-156-20260929/local-verification/`の
focused-tests.log、build.log、tmux-results.json、tmux.log。 実画面とEsc前後のHTTP
snapshotはsource-105602/・compiled-105602/へ保存した。
確認用Core/TUI/tmuxとBashは終了済み。default-selection.jsonは隔離configにも生成されていない。

## 未実施・残る境界

利用者によるEsc操作確認・increment完了承認は取得済み。公開は未指示。
commit/push・常用配置・配置後確認は追加指示に基づき完了。 外部providerの実測は今回のlocal
UI操作変更には必要とせず、行っていない。
構想・architecture・roadmapは変更していない。既存の未採用S26メモを保持した。

## commit・push・常用配置（2026-09-29）

利用者の追加指示に従い、S15の実装・test・要件/結果・操作文書とhandoffをcommit/pushする。
既存の未採用S26メモをworking treeへ保持し、今回のcommitへ含めない。 固定commitのclean
checkoutから公式buildし、検証済みcandidateのruntime SHA-256と一致することを
確認する。旧binaryを保存し、常用先へ原子的に配置する。
配置binaryそのものを隔離HOME/XDG/workspace/tmuxで確認し、結果を後続文書commitへ記録・pushする。
稼働中の既存Coreは停止・移行しない。

実装・test・要件/結果・操作文書・S15の採用移動・handoffの8ファイルをcommit
`8a90fe083523a8a02ad35cc1cd5852dd6e85c799`へまとめ、origin/mainへpushした。
S26の既存メモはcommitへ含めず、作業前の本文と一致する状態でworking treeへ保持した。

固定commitのclean checkoutからDeno 2.9.7で公式buildした。初回は/tmpの容量不足でcompileが失敗した。
生成したcheckoutを通常ディスクへ移し、git worktreeの参照を修復して再buildし、成功した。
生成binaryのruntime SHA-256は受入済みsource/compiled候補と一致し、sourceDirty=false。
旧binaryを保存し、`/home/agent/.local/bin/henji`へ原子的に配置した。henji 0.7.0。

- build ID: `4e85dfe6f714e78368df2d1e7b56bf3c5f00124626fed729fb30b7ac61411395`。
- runtime SHA-256: `c5ff397654accc5e88b31941c153a9fa3873884b7b532724f77ab46991c45a31`。
- binary SHA-256: `cff9ec278b3258f876196f41850ec87d54c926159344bcd90196a8995e934296`。
- 旧binary: `/home/agent/.local/state/henji-build-artifacts/increment-156-20260929/henji.previous`。
  SHA-256は`e5bf3376e20d114ce222b393ae43d4625aa27b5cfbf53c5bd1f3d18b393df7c6`。

配置binaryそのものを隔離HOME/XDG/workspace/tmuxの80×30で実操作した。 HTTP Core
identityのsource/build/dirtyと配置identityが一致し、busy履歴中Escによる最新復帰と
Bashの継続、最新表示中Escによるcancelled/settledとBash終了を再確認した。
draft保持、PageDown、ヘルプ開閉、idle時の履歴復帰、別TUIのscroll独立、terminal復元も確認した。
loopback provider requestは1回、外部provider requestは0回。配置時点の既存Core二つは PID/start
time・epoch・Session・idle状態を保持したままHTTP応答し、停止・移行していない。

配置証拠は`/home/agent/.local/state/henji-build-artifacts/increment-156-20260929/deployment/`の
build.log（初回失敗）、build-retry.log、deployment.json、version.txt、tmux-results.json、tmux.log、
preexisting-cores.json、preexisting-cores-after.json。画面とHTTP snapshotはdeployed-107592/。
確認用Core/TUI/tmuxとBashは終了済み。実configへのdefault-selection書込みは無い。

作業中の追加指示「tmp内クリアして」に従い、S15の成果物と証拠を上記の通常ディスクへ移し、
/tmpの不要な作業生成物63件、約3.56 GiBを削除した。
稼働中Codex/tmuxのソケットとOS管理ディレクトリは保持し、既存Coreへの影響が無いことを確認した。
削除対象一覧と容量はdeployment/tmp-cleanup.jsonへ保存した。 配置・清掃記録とhandoffは文書commit
`43fb242e571a7499d3e808a6ea363e5168abcfab`へまとめ、origin/mainへpushした。

## 利用者確認・完了承認（2026-09-29）

利用者の「escは確認しました インクリメントを完了としてセッションを終わります」により、
Esc操作の確認、Increment 156の完了承認とセッション終了を記録した。
確認用Core/TUI/tmuxは既に終了済みで、常用配置と既存Core二つを保持する。
未採用S26・S27のメモは[通常利用メモ](../experience/normal-use-inbox.md)へ保持し、
このincrementの実装・完了範囲へ含めない。JSR公開と構想・architecture・roadmapの変更は未指示。
