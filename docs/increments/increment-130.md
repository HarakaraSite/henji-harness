# Increment 130 — PageUpで履歴の真の先頭へ到達する

状態: 実装・focused検証・隔離XDGでのtmux実操作確認・local binary配置完了（2026-09-26）。
pushは未実施。

## 必要なproduct動作と根拠

- 長い保存SessionでPageUpを続けると、履歴の真の先頭（startup headerを含む）へ到達する。
  先頭でさらにPageUpを押しても最新へ戻らない。PageDownで順に新しい履歴へ戻り、末尾で最新追尾に戻る。
- 履歴表示中のfooterは、全履歴中のentry位置と、そのentry内の表示行位置を示す。
  描画窓だけの行番号を全履歴の行番号に見える形で表示しない。
- 根拠: session `d15bc9b2-8db8-4a54-b7eb-88c926411f5e`の94×48 tmuxで、
  PageUpを続けると`history rows 11-25/25`となり、その次のPageUpで最新表示へ戻った。
  同じ操作を繰り返すと窓群を巡回する。窓境界では`1-42/600`の次が
  `1095-1136/1136`のようになり、全体位置が読めない。

## 現行経路と原因

- `input_decoder.ts`→`controller.ts`の`page_up`→`TuiRenderer.scrollPage`→
  `pageHistoryWindow`→`layoutUi`が通常・busyの両方で使われる。
- 全entryは`UiState.log.entries`に保持し、`historyWindow`が描画対象entryを選ぶ。 最古の窓はstartup
  headerを含み、entry数が少ないため表示行数がviewport未満になる。
- `scrollPage`の`maxStart === 0`分岐は、その窓が一画面に収まることを
  全履歴が一画面に収まることと混同し、閲覧中でも`latest()`を呼ぶ。
  最古窓への切替時に最初のentryへanchorするため、header行も飛ばす。
- footerの`history rows`は`layoutUi`が現在の窓の`log.rows`だけで計算する。

## 実装計画

1. `scrollPage`で、短い中間窓はPageUpで前の窓へ進め、短い最古窓では
   headerを含む`oldest`へ着地させる。最古での追加PageUpは位置を保ち、
   PageDownでの往復と末尾での最新追尾を保つ。
2. footerは画面先頭に見えるentryの全履歴中の番号と、そのentry内の表示行番号を示す。 startup
   headerが先頭に見えるときは`history start`とする。 busyの`PgDn latest`／`Esc cancel`は維持する。
3. focused testで、最古窓がviewport未満の復元履歴、繰り返しPageUp、
   PageDownでの往復、窓境界の全体位置表示を確認する。
4. 型・format・lint・`git diff --check`の後、隔離XDGのproduction TUIを
   tmuxで操作し、先頭とfooterを確認する。実provider callは不要。

描画方式の性能変更と新しいジャンプキーは、この不具合の修正に含めない。

## 実施結果

- `scrollPage`は、短い中間窓でもPageUpで前の窓へ移り、最古窓が一画面に収まるときは startup
  headerを含む`oldest`へ着地する。最古での追加PageUpは最新へ戻さない。
- footerは画面先頭のentryを全履歴中の番号で示し、そのentry内の表示行番号を添える。 startup
  headerが見える位置では`history start`とする。
- 94×48の短い最古窓を持つ復元履歴で、先頭到達、追加PageUp、PageDownでの復帰、
  全履歴entry番号の単調な移動をfocused testへ追加した。`tui_retained_terminal_test.ts`
  51件、対象の`deno check`、`deno fmt --check`、`deno lint`、`git diff --check`が成功した。
- 隔離XDG `/tmp/henji-i130-tui-nu4h1zz7`へ現在workspaceのSQLite DBを read-onlyのbackup
  APIで複製し、credentialを含めずprovider宣言と既定選択のみを配置した。 source版のproduction
  TUIをtmuxの94×48 paneで`--session d15bc9b2-8db8-4a54-b7eb-88c926411f5e` として起動した。PageUp
  204回で`history start`へ到達し、追加2回も先頭に留まった。
  PageDownで次のentryへ進み、続く203回で`ready`の最新追尾へ戻った。
  観測したfooterのentry番号はPageUpで非増加、PageDownで非減少だった。 Ctrl-Dで正常終了（exit
  0）。task送信と実provider callは行っていない。
- 実装・検証記録をcommit `5c03fb39c8b50a959f0111903613065dabc8e113`にまとめ、 clean
  treeから`deno task --config deno.v0.json henji:compile`でbuildした。
  `dist/henji --version`はsource revision `5c03fb39…`、build ID `ec1890ee…f4f2c`を表示した。
  binaryのSHA-256は`4bb5a8e5dee7df60b630a0b120c68bf438ce44955ffb121e84849e15b61aa44b`。
- 利用者の明示承認を受け、build済みbinaryを`~/.local/bin/henji`へ原子的に配置した。
  配置後の`--version`はsource revision `5c03fb39…`、build ID `ec1890ee…f4f2c`を表示し、
  配置先と`dist/henji`のSHA-256はともに
  `4bb5a8e5dee7df60b630a0b120c68bf438ce44955ffb121e84849e15b61aa44b`だった。
  既に起動中のHenjiには再起動後に反映される。
