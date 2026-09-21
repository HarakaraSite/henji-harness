# Increment 95 — 会話ログのPageDownがassistant本文で停止する修正

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: Increment 74（表示凍結の修正、B3切り分け）、Increment 76（保存Sessionの閲覧と現行Definitionでの
継続）、Increment 84（assistant本文レイアウトとMarkdownタグ着色）、通常利用メモ
[`normal-use-inbox.md`](../experience/normal-use-inbox.md)のB3。

## 利用者が必要とする動作

- 保存Sessionを再開した会話ログで、PageUpで履歴先頭まで遡り、その後PageDownで最新まで戻れる。
- assistant本文が長い（Markdown表・リスト等で多数行になる）Sessionでも、PageDownが途中で停止しない。
- 上記は実経路（production TUI、実Session）で確認できる。

## 事象

利用者観測（2026-09-21）: 会話ログでPageUpをして履歴先頭まで閲覧した後、PageDownしても2ページ程度しか
参照できず、それ以上先へ進めない。`/sessions`で過去Sessionを選んで再開すると再現する。

inbox B3は「PageUpで履歴先頭まで到達できない」として未クローズだったが、今回の再現は逆方向（先頭到達後の
PageDown停止）で、同一のアンカースクロール機構の問題である。

## 原因

`v0/tui/layout.ts`の`logRows`は、assistant entryの本文を`AssistantContentRenderer`（既定は
`markdownAssistantRenderer`）で複数行へ展開する際、全行に`sourceScalarOffset: 0`を固定していた。

会話ログのPageUp/PageDown（`TuiRenderer.scrollPage`）は、スクロール位置を`entryId`＋`sourceScalarOffset`の
アンカーで保持する。アンカー行の探索は`row.entryId === anchor && row.sourceScalarOffset >= offset`であるため、
assistant entryの全行がoffset 0だと、どの行を指しても必ずそのentryの先頭行に解決される。この結果、大きな
assistant本文（最終応答のMarkdown表など）に入ると、PageDownが同じ位置に固定されて先へ進めない。

非assistant entryは`wrap`が行ごとに単調増加するoffsetを付けるため、この問題はassistant本文だけに生じる。
履歴ビュー（`overlayRows`）は`wrap`を使うため影響しない。

再現（実Session `e284da25`のcanonical transcriptを`restored_log`で復元）:

- 修正前: `history rows 22-39/184`でPageDownが固定（`scroll`は`anchored`、offset 0のまま）。
- assistant entryの全行が`sourceScalarOffset: 0`であることを直接確認。

## 修正

assistant entryの行ごとに、直前までの描画行のscalar長＋改行1で単調増加する`sourceScalarOffset`を付ける。
offsetは会話ログのスクロール位置決めだけに使われ、行の内容は変えない。

## 検証

- 回帰test `tests/v0/tui_retained_terminal_test.ts`「retained PageDown advances through a large assistant
  entry after oldest」を追加。200行のassistant本文で、
  - assistant行の`sourceScalarOffset`が単調増加すること、
  - PageUpでoldestへ到達後、PageDownが単調に前進し`followLatest`へ戻ること、
  を確認する。修正を一時的に戻すと本testは失敗し、修正後に成功する。
- 実Session `e284da25`のtranscriptを復元したfocused再現で、修正後はPageDownが前進し最新へ到達することを
  確認した。
- `tui_retained_terminal_test.ts`（39件）、`deno check`、`deno fmt --check`、`deno lint`、`git diff --check`は
  成功。

## 対象外

- assistant rendererのoffsetを元のentry textのscalar位置へ厳密対応させること。会話ログのアンカーは行の
  同一性を保てればよく、検索blinkは履歴ビューの別経路が担う。
- 履歴ビュー（`/history`、pickerの`v`）のページング。本修正の対象外で、既存動作を変更していない。
- 実TTYでの目視確認。focused再現と回帰testまでを確認範囲とする。

## 未確認事項

- 極端に長い単一行（`wrap`が分割する行）とassistant本文の組み合わせで、アンカーがresize後にどの行へ
  復元されるかは未確認。停止しないことは確認済み。
