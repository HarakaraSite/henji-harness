# Increment 212 — S36: TUIの会話履歴表示を端末scrollbackへ任せる

状態: 個別incrementへ採用・要件整理済み（2026-10-07）。詳細設計・実装・検証は未着手。

## 目的・採用と承認範囲

利用者の「では、1と2をそれぞれインクリメントとする」により、提案した第二段階のS36を採用した。
第一段階の[Increment 211](increment-211.md)で入力履歴とキー操作を整理し、実表示・操作確認を終えて
から本incrementへ進む。今回の指示は分割・採用と文書化として扱い、実装は開始していない。

Henji独自の会話履歴スクロールを端末scrollbackへ移し、スクロール・検索・選択・コピーを端末へ任せる。
Henjiは入力と実行操作、生成中表示、会話の保存とSession再開時の再出力を担う。

## 原観測・利用者の判断

- 2026-10-07、利用者はtmuxまたはGhostty単独のscrollbackへ会話履歴表示を任せる案を検討した。
  Session再開時は保存会話を再出力する方針で、端末の履歴上限の制約を理解している。
- S36を進めるため、S35のmouse wheel履歴参照オン／オフ切替案は取り下げた。
- 入力欄・footerを固定するtmux上下pane連携は、tmux固有になるため見送った。
  会話と入力欄・footerは同じ端末に表示し、履歴閲覧中は入力欄・footerも画面外へ移る方針である。
- tmux copy-mode中はHenjiにキーが届かず、抜けてからHenjiを操作する制約を利用者が了承した。
- 元メモではGhosttyの`scroll-to-bottom = keystroke, no-output`仕様を根拠に、出力だけでは最新へ
  戻らず、アプリへキーを送ると最新へ戻ると想定した。EscもHenjiへ届くことから、実行キャンセルを
  外す判断は211へ採用した。この想定について変更後TUIのGhostty実機確認は未実施である。

元メモの外部仕様参照（2026-10-07確認の記録）:
[tmux copy-mode](https://github.com/tmux/tmux/wiki/Getting-Started#copy-and-paste)、
[Ghostty scroll-to-bottom](https://ghostty.org/docs/config/reference#scroll-to-bottom)。
着手時は実際の端末設定・挙動を確認し、仕様からの想定と実測を区別する。

## 必要な動作・受入条件

1. 通常画面へ会話を順次出力し、確定してscrollbackへ流れた表示を後から描き直さない。
   履歴のスクロール・検索・選択・コピーをHenji独自のviewportで処理しない。
2. 生成中の本文・thinking・tool進捗／結果、入力欄・footerを表示・更新できる。
   すでにscrollbackへ流れたtool開始行への結果は続きとして追記し、過去行への書き直しを避ける。
   進行中の同じentityの更新を、確定した過去会話の変更と混同しない。
3. 複数行入力とpickerを会話表示と共存させ、211で整理したキー操作を使用できる。
   最新表示では入力欄・footerが見え、履歴閲覧中は同じ端末の表示全体がスクロールする。
   pane分割による固定入力欄は追加しない。
4. SQLiteのsemantic履歴を維持する。Sessionを開き直したときは、その保存会話を順番に再出力できる。
   端末scrollbackを永続履歴の正本にしない。
5. tmuxとGhostty単独の履歴参照・コピーを想定する。tmux copy-modeのキー消費や端末の履歴上限は、
   了承済みの制約として扱う。端末設定をHenjiが自動で変更しない。

## 現行product経路・影響範囲

2026-10-07のsource確認:

- API snapshot/update → reducerと会話投影 → `tui_renderer.ts` → layout・`screen_frame.ts` → 端末出力。
- `TerminalLifecycle`はalternate screenとmouse trackingを要求する。`screen_frame.ts`は画面内の行を
  上書きするため、mouse trackingを解除するだけでは会話全体を順番にscrollbackへ残せない。
- Henji内の履歴参照は`remote_session.ts`からrendererのviewportへ渡る。
  保存会話とSessionの切替・再開は既存Core/API/Dataの経路にあり、端末履歴とは状態の所有者が異なる。

対象はTUIの端末lifecycle・描画・履歴閲覧・入力／pickerとの接続と対応test。
置換で使われなくなるviewport・履歴操作・状態と専用testは、残る利用箇所を確認して同じ変更で整理する。
非TUIの`run --stream`、Core/APIの操作・保存契約、provider adapter、実dataの削除は対象外。
構想・architecture・roadmapへの反映が必要なら、変更案を本書へ置き、別途明示承認を得てから変更する。

## 着手時に決める設計事項・確認方針

- 表示を確定して端末へ流す境界と、生成中の更新領域を定義する。
  長い本文・thinking・tool進捗が画面を超える場合も、過去表示の書き直しに頼らず読める経路を設計する。
- 複数行入力・footer・pickerの配置と、閉じた後の会話表示への復帰方法を決める。
  Session切替・再開の再出力とライブ更新の接続も、保存済み内容を欠落・重複させない経路として整理する。
- focused確認は、順次出力と生成中の更新、tool開始／結果、入力とpicker、保存Sessionの再出力に対応させる。
  現行viewportを仕様として固定するtestは、新しいproduct動作に合わせて修正・整理する。
- 変更箇所のtype check・format・lint・`git diff --check`と、隔離HOME/XDGのtmux上のproduction TUIで
  生成中・履歴閲覧・コピー・複数行入力・picker・Session再開の実経路を確認し、本書へ記録する。
  Ghostty単独の確認環境と確認担当は着手時に整理し、未確認の挙動を確認済みとして扱わない。
- 実provider callが必要なら、対象・回数・保存先について別途明示承認を得る。full gateは要求しない。
  メモリ削減率・描画速度の改善率を本incrementの受入条件にしない。

## 現在の未実施事項

211の先行実施、本incrementの詳細設計・local実装・focused確認・実表示と操作確認。
commit・常用build・配置・pushは今回実施していない。
