# 通常利用 Increment 30 — 現在Sessionの履歴検索とjump

ステータス: **実装・検証完了、通常利用確認待ち**

## 利用者が必要とする動作

- 現在のPageUp / PageDownによる即時の履歴閲覧を維持したまま、現在Sessionのcommit済み履歴をkeywordで
  検索し、該当箇所へjumpできる。
- 再開時の表示上限やTUIのretained log上限より古い履歴も検索できる。
- 検索後もPageUp / PageDownで周辺を閲覧し、Escで最新表示へ戻れる。
- 将来assistant本文をMarkdown表示へ差し替えても、検索位置がterminal styleやwrap後の文字列に依存しない。

## 根拠となる現行動作

- 現行PageUp / PageDownは、同じconversation領域を`entryId`とscalar offsetでanchorし、Escまたは最新pageへの
  PageDownで`followLatest`へ戻る。別の履歴modeを開く操作は必要ない。
- Session再開時にTUIへ復元するのは最大100 messages / 2 MiB、retained logは最大512 entries / 2 MiBであり、
  画面上のlogだけではcommit済みcanonical transcript全体を検索できない。
- Host側Sessionはcommit済みtranscript全体を保持し、既存のhistory projectionはturn、message index、role、
  bounded textを返せる。
- 現在の`AssistantContentRenderer`はHost-localに差し替えられるが、返り値はplain stringである。layout rowの
  offsetは投影後stringを基準にしており、Markdown変換後も使えるsource coordinateではない。

## Product動作

- idle時のPageUpは現在と同様に最新付近から一page古い表示へ即座に移動し、履歴閲覧状態に入る。Session
  先頭へ自動移動しない。PageUp / PageDownとEscの現動作を維持する。
- 履歴閲覧中の`/`はtask editorへ入力せず、keyword入力を開始する。keyword入力中はprintable text、paste、
  Backspaceを編集に使い、Enterで確定し、Escで検索入力だけを取り消す。
- 最初の検索は現在の表示位置に関係なく、commit済みcanonical transcriptの先頭から、表示対象となるuser、
  assistant、tool call / result textをliteralかつcase-insensitiveに検索する。正規表現は使わない。
- Enterは最も古い一致へjumpする。検索確定後の`n`は次の新しい一致、`N`は一つ古い一致へjumpし、端では
  wrapせず停止する。match ordinal / totalとkeywordをfooterへ表示する。
- 一致箇所が通常retained logより古い場合も、Hostはそのexact messageを含むbounded history windowを返し、
  conversation領域はそのwindowを同じ表示規則で描画する。検索表示からPageUp / PageDownで前後のbounded
  windowへ移動できる。
- Escは検索入力中なら入力だけを取消し、それ以外の履歴閲覧中なら検索状態を破棄して元のretained logの
  最新表示へ戻る。未送信draftは変更しない。
- 検索対象とmatch identityはcanonical sourceのturn、message index、role、source scalar rangeで表す。
  terminal escape、label色、wrap、将来のassistant本文rendererによる投影後stringを検索正本にしない。
- layout rowは対応するcanonical source rangeを保持し、viewport jumpはsource coordinateから表示rowへ
  解決する。現行plain text表示とlabel色は変更しない。

## 実装計画

1. canonical transcriptを一回走査し、検索可能なentryとsource coordinateを作るHost-owned history searchを
   追加する。queryごとに全match identityを返さず、現在matchとcount、およびbounded windowを返す。
2. presentation intent / resultへ、現在Sessionに対するhistory search、次・前match、window移動をdata-onlyで
   追加する。Session切替後の古い結果を適用しないようbinding identityと相関させる。
3. retained TUIにhistory browsing / search query stateを追加し、PageUpによる現在の即時閲覧、`/`入力、Enter、
   `n` / `N`、Esc、PageUp / PageDownをcontrollerへ接続する。
4. conversation projectionとlayout rowへcanonical source identity / rangeを運び、plain rendererと将来rendererの
   表示投影から検索anchorを分離する。
5. focused testで、現行PageUpの開始位置、表示上限より古いmatch、日本語とASCII、複数match、端での停止、
   draft保持、wrap後のsource anchor、Session bindingの切替を確認する。
6. repository定義のformat、type check、lint、`git diff --check`を実行し、安定候補に対する`v0:gate`を一回だけ
   実行する。

## 成功条件

- 100 messagesより古いcommit済み履歴にだけ存在するkeywordを検索し、最も古いmatchへjumpできる。
- `n` / `N`でchronologicalな次・前matchへ移動し、footerのordinalと表示内容が一致する。
- PageUpだけの既存利用では最新付近からの即時閲覧、PageDown末尾とEscによる最新復帰が変わらない。
- 検索、履歴window移動、終了の前後でcanonical transcript、Session commit、未送信draftが変わらない。
- assistant rendererが本文を別の表示へ投影しても、canonical source coordinateからmatchを識別できる。

## 対象外

- Markdown renderer、Markdown parser、code block / table / hyperlinkのterminal表示
- `j` / `k`、`h` / `l`、`Ctrl-U` / `Ctrl-D`、`g` / `G`によるvi風の一般移動
- mouse wheel、横scroll、検索結果のhighlight、正規表現
- 複数Sessionを横断する検索、provider context、未commitのstreaming output
- `$VISUAL` / `$EDITOR`で履歴を開く操作、`/history export`の変更
- architecture、roadmap、canonical Session schemaの変更

## 承認

- 利用者は、PageUp / PageDownの即時閲覧を維持し、keyword確定時はSession先頭から最も古い一致へjump、
  `n`で新しい一致、`N`で古い一致へ移動する動作を承認した。
- Markdown renderer自体は実装せず、検索とviewport anchorをcanonical source coordinateへ分離する基盤だけを
  このincrementへ含める。

## 実装結果

- Host-owned canonical transcript検索を追加し、literalかつcase-insensitiveな全一致から、指定ordinalとその
  一致を含むbounded history pageだけをpresentation境界へ返すようにした。
- PageUpでanchorした閲覧中の`/`、keyword入力、Enter、`n` / `N`、PageUp / PageDown、Escをretained TUIへ
  接続した。検索前のdraftとmain retained logは置換しない。
- matchはturn、message index、role、source scalar rangeで保持し、history layout rowもwrap後に対応するsource
  rangeを保持する。検索結果はSession binding identityが変わった場合に適用しない。
- focused testで101 turnの先頭にだけあるmatch、日本語とASCII、複数match、`n` / `N`、draft保持、wrap後の
  source range、古いSession bindingの結果破棄を確認した。
- authoritative `v0:gate`を一回実行し、format、type check、lint、全testが成功した。主要test群75件、provider
  stream compatibility 20件、および各increment / production CLI testがすべて成功した。

## 通常利用で確認する操作

1. PageUpで現在Sessionの履歴を開き、`/`を入力する。
2. keywordを入力してEnterを押し、最も古い一致へjumpすることを確認する。
3. `n`で新しい一致、`N`で古い一致へ移動し、PageUp / PageDownで周辺を閲覧する。
4. Escで最新表示へ戻り、検索前の未送信draftが残っていることを確認する。
