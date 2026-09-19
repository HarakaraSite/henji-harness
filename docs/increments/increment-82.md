# Increment 82 — startup headerのbase instruction表記・skills複数行・時刻のタイムゾーン追従

ステータス: **実装・検証完了**

基準commit: `281ba529`

計画日: 2026-09-19

実装日: 2026-09-19

対象: startup orientation（`startupHeaderLines`）の`base:`ラベルを`base instruction:`へ変更し、`skills:`の
一覧を値幅に応じて複数行へ折り返す。headerの時刻をUTC固定から実行環境のローカルタイムゾーンへ変更し、
session pickerの更新日時も同じ共有formatterへ統一する。将来のMCP欄が使えるよう、ラベル付き値の複数行描画を
汎用helperへ分離する。SurfaceはHost-localであり、Worker protocol、Presentation contract、Session schemaを
変更しない。

## 利用者が必要とする動作

- base instructionが解決されているとき、startup headerに`base instruction: <resourceId> · <source> ·
  <digest>`が表示される。
- skills一覧は、値幅に収まらない場合に複数行へ折り返して表示する。skill数が増えても`(+N more)`だけに
  依存せず、名前を横幅の許す限り表示する。
- 折り返しの継続行はラベル列と同じ位置に値が続くよう整列し、各行がheaderのbracket内に収まる。
- 既存の他項目（`session:`／`workspace:`／`agent:`／`context:`／`runtime:`）の意味と表示は変えない。
- compact layout（width<64またはrows<16）の2行表示は変えない。
- headerの時刻は実行環境のローカルタイムゾーンで表示し、実行localeに応じたzone略称（例: `GMT+9`、`PDT`）を
  付す。UTC固定の`Z`表記は使わない。
- 他に時刻を表示する箇所（session pickerの更新日時）も同じ共有formatterを使い、同じローカル日時＋zone略称の
  表記に統一する。

## 根拠

- 通常利用メモS8（2026-09-19）: `base:`は初見で分かりにくい。`skills:`は1行comma区切りで`(+N more)`補完の
  ため、skill数が増えると横幅に収まらない。
- 現行`startupHeaderLines`は`content(label, value)`が`padEnd(11)`固定の1行描画で、複数行を扱えない。
- `skills.names`は上限付きで、超過分は`omitted`に数えられる。複数行化しても`(+N more)`の意味は保てる。

## 実装計画

1. `v0/tui/startup_render.ts`に、ラベル列幅（`base instruction:`が収まる18 cells）と、値幅で折り返す
   `headerContentLines`／`wrapHeaderValue`を追加する。折り返しは`, `境界を優先する。
2. `base:`を`base instruction:`へ変更する。
3. `skills:`を複数行描画へ切り替える。
4. 既存testを更新し、base instructionラベルとskills折り返しのfocused testを追加する。
5. `createdMinute`をUTC正規表現抽出から`Date`のローカル値と`Intl`の`timeZoneName:'short'`へ変更し、既存testを
   timezone非依存へ更新する。
6. TUIの時刻表示formatterを`v0/tui/terminal_text.ts`の`localTimestampText`へ集約し、startup headerとsession
   pickerの両方から使う。pickerのfocused testもzone略称込みへ更新する。
7. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`、authoritative `v0:gate`を実行する。
8. 通常利用メモS8を、未採用のMCP欄予約だけに狭める。

## 対象外

- MCP欄の実際の描画（表示対象のMCP接続managed resourceが未採用のため、複数行helperの再利用に留める）。
- compact layout、help overlay、footerの変更。
- `/history export`やJSONL exportなど保存artifactの時刻は、portabilityのためISO UTCのまま変更しない（画面表示の
  統一とは別扱い）。
- Worker protocol、Presentation contract、Session schema、skills discoveryの変更。
- roadmap・architecture正本の変更（header labelの正本記述はない）。

## Human Gate

2026-09-19、利用者は「さっきのヘッダーの改善も」として、S8のbase instruction表記とskills複数行対応の
実装を指示した。加えてheader時刻をタイムゾーンに沿わせ、実行localeのzone略称を付すよう指示した（zone名は
環境localeに任せ、Asia/Tokyo・`en-US`では`GMT+9`）。加えて、他に時刻を表示する箇所（session pickerの更新
日時）も同じ表記へ統一するよう指示した。MCP欄は未採用の将来予約として実装しない。

## 結果

- `startup_render.ts`に`HEADER_LABEL_COLUMNS`（18）、`wrapHeaderValue`、`headerContentLines`を追加した。
  ラベル列を18 cellsへ広げ、値は値幅で`, `境界優先に折り返す。
- `base:`を`base instruction:`へ変更し、`skills:`を複数行描画へ切り替えた。継続行はラベル列幅＋1の
  空白でインデントしてbracket内へ収める。
- 将来のMCP欄は`headerContentLines`を再利用できる。MCP行自体は表示対象resourceが未採用のため追加しない。
- `createdMinute`を、`Date`のローカル日時と`Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })`のzone名で
  組み立てるよう変更した。実環境（Asia/Tokyo・locale `en-US`）では`2026-09-11 21:34 GMT+9`のように表示される。
- 時刻表示formatterを`v0/tui/terminal_text.ts`の`localTimestampText`へ集約し、startup headerの`createdMinute`と
  session pickerの`localSessionTimestamp`を置き換えた。pickerも同じローカル日時＋zone略称を使う。
- 通常利用メモS8はMCP欄予約のみの候補へ狭めた。

## Verification結果

- focused test: `tui_retained_terminal_test.ts`のstartup header test（base instructionラベル、skills折り返し、
  時刻のローカル表示）とsession picker test（zone略称込み）pass。時刻testはJSTと`TZ=UTC`の両方でpass。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`／authoritative `v0:gate`を実行する。
- live provider、実TTY、compiled binaryは対象外。
