# Increment 164 — Markdown見出しをcyanで表示

更新日: 2026-10-01

ステータス: **local実装・検証・コード／test通常レビュー完了。利用者確認待ち。**

利用者が通常利用で、`user>`ラベルとassistant本文のMarkdown見出し`#`／`##`／`###`が
同じblueで識別しにくいことを観測した。色の候補を確認し、利用者の「ではそうしよう　次のインクリメントとして
計画して」により、Markdown見出しをcyan（青緑・水色系）へ変更する本incrementを採用した。

当初の指示はincrementへの採用と計画作成までだった。追加指示「では実装してください 実装後、コードと
テストを通常レビューさせてください」により、local実装、検証、コード／test通常レビューが承認された。
Session `fb5a6bb1`で実装と検証を終えた後、reviewの収集中にcancelとなった。利用者の「最後まで
やってもらえる？」により、残る通常レビューを再開した。常用配置、commit/push、公開は未指示。

## 利用者が必要とする動作

- production TUIで`user>`ラベルは現在のblueを維持する。
- assistant本文のATX Markdown見出し`#`〜`######`は、見出し記号と本文を含む見出し行全体を
  standard ANSI cyan（SGR 36）で表示する。
- streaming中、settled後、保存Sessionの再表示で、同じMarkdown見出しを同じcyanで表示する。
- 見出しが折り返された場合も、現在のheading spanの範囲を維持し、継続行をcyanで表示する。
- `assistant>`のyellow、`tool>`・list・emphasisのgreen、quoteのmagenta、failureのred、tableのdim、
  boldの装飾は変更しない。
- 色はterminalの最終frameにだけ加える。assistant本文、layout text、Presentation event、canonical
  conversation、保存履歴、model contextへANSI sequenceを混入させない。

成功基準は、人間がproduction TUI上でblueの`user>`とcyanのMarkdown見出しを見分けられ、既存の本文・折返し・
履歴表示が変わらないことである。

## 現行経路と変更点

現在の表示経路は次のとおり。

```text
providerのassistant本文
  → Presentation／Session snapshot
  → assistant log entry
  → markdownAssistantRenderer
       ATX見出しをAssistantSpan tone `heading`として投影
  → layoutUi
       plain textとspan範囲を保持
  → module-local renderLayoutRow
       SPAN_SGR.heading = BLUE_SGR
  → terminal frame
```

`user>`は別経路で`ConversationLabelTone = user`となり、`LABEL_SGR.user = BLUE_SGR`で描画される。
したがって、Markdown parser、Session、API、保存形式を変更せず、既存のHost-owned span toneの色対応だけで
要求を満たせる。

現在の`assistant_layout.ts`は`#{1,6}`を一つの`heading` toneとして扱い、見出し行全体と折返し継続行へspanを
付ける。heading level別の新しいtoneや配色は追加しない。最小変更はstandard cyan定数をterminal表示層へ追加し、
`SPAN_SGR.heading`だけをblueからcyanへ切り替えることである。

[Increment 96](increment-96.md)は見出し行全体をblueにする当時の仕様と結果を保持する。本incrementは
全行着色と折返しspanを維持したまま、その色指定だけをcyanへ置き換える。

## 計画レビュー結果

利用者の指示により、通常レビューと批判的レビューを独立したreviewerで実施した。
初回の批判的review runはChatGPT providerのtransport errorで結果を返さなかったため、OpenRouter Chatの
別runで再実行した。失敗runをreview結果として採用していない。

両reviewとも必須findingは0件（Blocking 0、P1 0、P2 0）。現行のheading parser／span、
streaming・settled・restored entry、labelとspanの独立したSGR map、最終frameだけのANSI付与を直接照合し、
cyan定数追加と`SPAN_SGR.heading`の切替が最小変更であることを確認した。隔離tmuxのproduction経路、
localhost模擬provider、外部requestなしという検証と、実装・配置等の未承認境界も妥当と判定した。

任意提案は次のように扱う。

- 保存Sessionの再表示は、実装結果に単なるPageUpだけでなく、新しいCoreで保存Sessionを開き直した確認を記録する。
- Increment 96のblue指定を本incrementが置き換える関係を上記へ追記した。
- 経路図の`renderLayoutRow`をmodule-local関数として訂正した。
- 通常利用メモのtheme／256色／truecolor候補は今回採用していないため移動・削除しない。今回の対象は既存の
  standard ANSI配色内でheading toneを変える一動作だけである。

reviewerはread-onlyで、test、full gate、実装、ファイル変更を行っていない。

## 実装計画

1. `v0/tui/terminal.ts`へstandard ANSI cyan（SGR 36）の定数を追加する。
2. `v0/tui/tui_renderer.ts`でassistant spanの`heading`をcyanへ対応付ける。
   `LABEL_SGR.user`はblueのまま維持し、ほかのlabel／span／footer toneを変更しない。
3. 既存のMarkdown frame確認を更新し、少なくとも`#`、`##`、`###`と、対応する
   `heading` spanがplain layoutのまま最終frameだけcyanになることを確認する。
   同じframeまたは既存のlabel確認で`user>`がblueのままであることも確認する。
4. focused test、必要なtype check、変更ファイルのformat・lint、`git diff --check`を実行する。
   局所的なSurface色変更のため、authoritative full gateは計画へ追加しない。
   当初計画に独立reviewは含めなかったが、追加指示により実装後のコード／test通常レビューを行う。
5. 隔離HOME／XDG／workspaceのtmux上でproduction TUIを起動する。localhostの模擬providerから
   `#`／`##`／`###`を含むassistant本文を一回返し、blueの`user>`、cyanの見出し、既存色、折返し、
   settled後の表示をANSI付きcaptureと実画面で確認する。保存後にTUI／Coreを閉じ、同じ保存Sessionを
   新しいCoreで再開して、復元された見出しもcyanであることを確認する。外部provider requestと実credentialは
   使用しない。

## 検証と受入

### Focused確認

- `layoutUi`の見出し本文とspanはANSIを含まない。
- final terminal frameは見出し全体にSGR 36と直後のresetを持つ。
- `user>`はSGR 34のままで、見出しのcyanがラベルや通常本文へ漏れない。
- streaming／settledで同じrendererを使う既存経路を維持する。
- headingのwrap、source anchor、cell幅、frame byte上限の計算方法を変更しない。

### Production TUI確認

- 隔離したproduction TUIへ人間の入力を送り、`user>`がblueであることを確認する。
- localhost模擬providerが返す`#`、`##`、`###`をcyanとして確認する。
- 見出しの後の通常段落と、既存のlist／quote等の色が変更されていないことを確認する。
- turn完了後とPageUp／PageDownによる履歴表示に加え、新しいCoreで保存Sessionを再開した表示でも
  見出しがcyanであることを確認する。
- 確認用Core、TUI、tmux、隔離XDGを実configや既存Coreへ影響させない。

## 実装と検証結果

### 実装

計画どおり、`v0/tui/terminal.ts`へ`CYAN_SGR = '\x1b[36m'`を追加し、
`v0/tui/tui_renderer.ts`の`SPAN_SGR.heading`だけを`BLUE_SGR`から`CYAN_SGR`へ切り替えた。
`LABEL_SGR.user`とその他のlabel／span／footer mapping、Markdown parser、layout、Session、API、保存形式は
変更していない。

既存のconversation Markdown testはassistant本文へ`#`、`##`、`###`を含め、plain layoutのまま最終frameで
三つの見出しがSGR 36になることを確認するよう更新した。`user>`のSGR 34は既存の同test file内の確認を維持した。
Increment 84／96の見出し全行spanと折返し確認は変更せず通過した。

### Focused確認

- `tests/v0/tui_conversation_presentation_test.ts`と
  `tests/v0/increment_84_assistant_layout_test.ts`: **33 passed、0 failed**。
- `v0/tui/terminal.ts`、`v0/tui/tui_renderer.ts`、変更testの`deno check`: pass。
- 同3 fileの`deno fmt --check`と`deno lint`: pass。
- increment対象fileの`git diff --check`: pass。
- authoritative full gateは計画どおり実行していない。

文書を含めた任意の`deno fmt --check`では、既存handoffの本increment外の行を含むMarkdown再整形候補が報告された。
関連しないtracked行を整形しない方針に従い、文書全体の自動整形は行わず、projectのformat対象である変更TS／testを
上記のとおり確認した。

### Compiled production TUI確認

公式`deno task --config deno.v0.json henji:compile`でcandidateを作り、隔離HOME／XDG／workspaceの
80×24 tmuxからcompiled Core／TUIを起動した。外部providerや実credentialは使わず、localhostの
Chat Completions模擬providerが一requestで次を返した。

```markdown
# Primary heading
## Secondary heading
### Tertiary heading

Plain paragraph.

- list item

> quoted text
```

plain captureで本文がそのまま表示され、ANSI付きtmux captureでは次を確認した。tmuxはHenjiのSGR reset 0を
foreground reset 39へ正規化するため、capture上の終端はSGR 39である。

- `user>`: blue（SGR 34）
- `#`／`##`／`###`の見出し行全体: cyan（SGR 36）
- list marker: green（SGR 32）のまま
- quote marker: magenta（SGR 35）のまま
- 通常段落:着色なし

80×12へresizeしてPageUpで`history start`へ移動し、PageDownで最新表示へ戻った。最初のCoreを終了後、同じ
保存Session `de34dd03-…`を新しいCoreで再開し、blueの`user>`、三見出しのcyan、list／quoteの既存色が同じで
あることをANSI captureで再確認した。Session再開ではprovider requestを追加せず、localhostへのrequestは合計1回、
外部requestは0回。確認用TUI、Core、tmux、模擬providerは終了済みで、実config、実Session、既存Coreは変更していない。

candidate identity:

- version: `henji 0.8.0`
- build ID: `c3762b581651c1a8eef4895c6dececd0b12e5a2b3e9712e8c90ed9cfb8c7eac7`
- source: `85256f4e57629c3703ff83c10f865cf42d22531e+dirty`
- runtime SHA-256: `996ee8adc5bf52f78d33eefff8505100f413d0b2fecb4efb3b39b84b55d4c99e`
- binary SHA-256: `bc39ee0c8c1f0787e889fb861fe6008262b6a4dce39cb8d533bd3797a7411a2b`

証拠は
`/home/agent/.local/state/henji-build-artifacts/increment-164-20261001/`へ保存した。
`probe/settled-ansi.txt`が初回turn、`probe/resumed-ansi.txt`が新しいCoreでのSession再開、
`probe/resumed-page-up.txt`／`resumed-page-down.txt`が履歴移動、`requests.log`がlocalhost request数を示す。

常用binaryへの配置、commit/push、公開は行っていない。利用者指定のコード／test通常レビューも、以下のとおり完了した。

## 実装後のコード／test通常レビュー

2026-10-01、利用者の再開指示によりread-onlyの独立reviewerで残っていた通常レビューを実施した。
対象はcyan定数、headingのSGR対応、更新した最終frame testと関連source・既存test・実行証拠である。
同じfileにあるSession削除等の別incrementの差分は対象外とした。

結果: **Blocking 0、P1 0、P2 0。必須修正・任意提案なし。**

- SGR 36への変更がheading対応だけに留まり、userのSGR 34と他の既存色を維持していることを確認した。
- 既存parserの`#{1,6}`、全行span、折返し継続行、streaming／settled／復元entryから共通の描画経路を確認した。
- ANSI付与が最終frameに留まり、本文・状態・layout・保存履歴へ混入しないことを確認した。
- 更新testの三見出しcyan・plain layout、既存のuser blue・全行span・wrap確認が要件に対応すると確認した。
- 保存済みのsettled／新Core復元／PageUpのANSI captureから、cyan見出し、blue user、green list、
  magenta quote、通常段落の着色なしを確認した。

reviewerはtest、TUI、full gateを再実行せず、実装・配置・commit/pushを行っていない。
streamingと折返しはsourceと既存testの静的確認であり、実行済み確認は上記検証結果を参照した。
coordinating ownerも保存証拠をreadbackし、settled／復元の色指定と、最新candidateによる対象Sessionの
cyan表示を確認した。コード変更は不要であり、通常レビュー結果を採用した。

当初依頼されたlocal実装、検証、実装後通常レビューは完了した。利用者による完了承認、
常用配置、commit/push、公開は本結果では実施済みと扱わない。

## 対象外

- heading levelごとに別の色・bold・dimを割り当てること。
- Markdown parser、対応記法、本文文字列、保存内容、model contextを変更すること。
- user、assistant、tool、system、failure labelの配色変更。
- theme設定、256色、truecolor、利用者ごとの配色設定。
- TUI以外のheadless出力、`henji history`のplain text出力へのANSI追加。
- 外部provider call、実credential、commit/push、常用配置、公開。

## 文書の境界

この変更は既存のHost-owned rendererによるSurface表示の範囲に収まり、構想の目的、Host／Worker境界、
roadmap上の必要機能や実装状態を変更しない。構想・architecture・roadmapは変更しない。

architectureには現在のdefault rendererをplain textとする古い記述、また`system>`色について現行
Increment 159と異なる記述が残るが、本incrementのMarkdown見出し色とは別の既存不整合であり、計画外に修正しない。
