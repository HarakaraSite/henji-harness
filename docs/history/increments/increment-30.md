# 通常利用 Increment 30 — 履歴表示の一貫性と検索試行の取り下げ

ステータス: **完了**

## 利用者が必要とする動作

- PageUp / PageDownで現在Sessionの過去表示へ即座に移動し、Escで最新表示へ戻れる。
- live表示、起動時のSession復元、`/sessions`からの復元、履歴閲覧で同じconversation表示を使う。
- userとassistantの本文、および集約済みの短いtool行を確認し、terminalの機能で必要な箇所をcopyできる。
- commit済みcanonical transcript全体は`/history export`で別々のMarkdown snapshotとして保存できる。

## 根拠となる現行動作

- PageUp / PageDownは、TUIが実際に描画したconversation rowを`entryId`とscalar offsetでanchorする。
- Sessionはtool callとtool result本文を含む完全なcanonical transcriptを保持する。一方、通常表示ではtool名、
  既知toolの短いcall preview、成否を一つの`tool>`行へ集約する。
- Session側にはsemantic contextとexportに使うcausal history index、および内部presentation contractに残る
  bounded page projectionがある。後者はTUIが描画したterminal rowによるviewportとは異なる単位である。

## 採用したProduct動作

- idle時のPageUpは最新付近から一page古い表示へ移動し、PageDownは新しい側へ移動する。先頭へ自動移動
  しない。履歴末尾へのPageDown、Esc、または通常taskの受付後に最新追尾へ戻る。
- 過去表示中も未送信draftを変更しない。
- live、起動時復元、`/sessions`復元、PageUp / PageDownによる履歴閲覧は同じsettled conversation表示を
  使う。tool result本文はcanonical transcriptに保持するが通常表示へ展開しない。
- keyword検索、検索入力、match移動、highlightは提供しない。
- `/history export`は変更せず利用できる。

## 検索試行を取り下げた理由

初回実装では、PageUp後の`/`、keyword入力、Enter、`n` / `N`、highlightを追加し、Session側のbounded
history pageへjumpした。通常利用で、同じ履歴が通常のPageUp / PageDownでは3 page、検索後には4 pageに
なることを確認した。

原因は、通常閲覧がterminal高とwrap後の描画rowをpage単位にする一方、検索がHost側の固定byte上限による
bounded entry pageを使い、二つのpage定義を一画面で混在させたことである。検索結果への追補だけでは、
閲覧・検索・page移動を一つの連続したdocumentとして扱えないため、このincrementでは検索UIと検索専用
contractを取り下げた。causal history indexはsemantic contextおよびhistory export、bounded projectionは
既存の内部presentation contractで使うため残した。

## 実装結果

- live、起動時復元、`/sessions`復元のsettled表示を共通化し、assistant本文の分割表示とtool call / resultが
  離れて表示される不整合を修正した。
- 履歴検索のHost API、presentation intent / result、controller state、検索入力、`n` / `N`、一致位置、
  reverse-video highlightを削除した。
- PageUp / PageDown、Esc、draft保持、`/history export`、compact tool行、canonical transcriptの完全な保存を
  維持した。
- focused type checkと関連する50 testが成功した。安定候補に対するauthoritative `v0:gate`も一回実行し、
  format、type check、lint、全testが成功した。

## 後続候補

履歴閲覧で人間が行いたいことは、過去turn、指示、結果を確認し、terminalでcopyすることである。keyword
検索は、人間が記憶している場所へ素早く移動する手段として有用になり得る。再採用時は、閲覧と検索で
同じ連続document、wrap、viewport、page移動を使うread-only text viewerとして設計し、Host側bounded pageを
画面上のpage定義として直接使わない。

## 対象外

- read-only text viewerとkeyword検索の再実装
- Markdown renderer、vi風navigation、mouse wheel、横scroll
- `$VISUAL` / `$EDITOR`でexportを開く操作
- architecture、canonical Session schemaの変更

## 通常利用で確認する操作

1. PageUp / PageDownで同じconversation rowを前後に移動できることを確認する。
2. Escで最新表示へ戻り、未送信draftが保持されることを確認する。
3. live、起動時復元、`/sessions`復元でuser、assistant、集約済みtool行が同じ順序と内容で表示されることを
   確認する。
4. 必要に応じて`/history export`でcanonical transcript全体をMarkdownへ保存できることを確認する。

## 完了判断

- production TTYの通常利用でPageUp後のretained conversationと`history rows ... · Esc latest`の位置表示を
  確認した。
- 利用者はkeyword検索を取り下げ、PageUp / PageDownと`/history export`を現在の閲覧手段とする結果を受け入れ、
  2026-09-11にIncrement 30を完了と判断した。
- 同じ通常利用で観測した外部情報調査時のtool選択は、このincrementを再開せず、通常利用メモの未採用候補として
  別に記録した。
