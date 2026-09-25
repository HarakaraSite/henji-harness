# Increment 129 — ツール呼び出しに添えたassistant本文の履歴表示（S14）

状態:
実装・検証完了（2026-09-25）。focused test・type check・format・lint・`git diff --check`通過。tmux上の
production TUI（session再開restore表示）と`henji history --view session`の実経路確認（隔離XDG、provider
callなし）、およびlive経路の実provider call確認（隔離XDG、1turn・2 request）まで完了。
残作業はbuild・`~/.local/bin/henji`配置・`main` pushの利用者承認のみ。表示labelは`assistant note>`に確定
（利用者確認2026-09-25）。`henji history --view canonical`は今回非対応（利用者判断2026-09-25）。
roadmap F05のstatus記述更新は承認済みで反映済み。構想・architectureは変更しない。

## 必要なproduct動作と根拠

- モデルがツール呼び出しと一緒のprovider messageで返した確定したassistant本文
  （`AssistantMessage.text`、contentが`ToolCallContent[]`のmessage）を、対応する`tool>`行の直前に
  1つのentryとして残し、同一turn内の後続発話・最終回答で置き換えない。人間が時系列で読み返せる。
- 最終回答（contentがtextのmessage）はこれまで通りturn末尾、全`tool>`行の後に表示する。
- stream中のprogress（`assistant~`）は1つのentryを更新し続け、確定時にそのentryへsettlingする。
  確定後に残るのは確定本文だけとし、stream中のprogress断片を一件ずつ保存・表示しない
  （S14の候補記載どおり、progress断片の蓄積は対象外）。
- session再開時のrestore表示と`henji history --view session`は、上の時系列形を同じ順序・同じラベルで
  出す。Increment 99が固定した「session viewの形＝resumeの形」のparityは維持する。
- 最終回答・`thinking>`とは区別できる表示にする。添え本文のlabelは`assistant note>`（確定、
  利用者確認2026-09-25）。最終回答は`assistant>`、thinkingは`thinking>`のまま。
- 根拠:
  - 通常利用メモS14の観測（2026-09-24、session `a2098f7c`）: `Now the production TUI verification ...`
    のようなツール呼び出し添え本文がTUIで後続発話・最終回答に置き換わり、通常のTUIログと
    `henji history --view session`で後から読めない。元の本文は実行記録に残る。
  - 依頼（2026-09-25）: 「通常利用メモのS14を対応したい」＝個別Incrementへの採用。
  - 実行証拠: 実行記録（session recordの`transcript`、semantic historyの`execution_messages`／
    `session_messages`）には各model stepの`AssistantMessage`が`text`付きで保存されており
    （`tests/v0/current_code_test.ts` "saved sessions preserve assistant text accompanying tool calls"、
    `sqlite_history_v7_production_store.ts` `readSessionHistory`が`message_json`を全文復元）、
    欠落は表示層だけである。

## 現行経路と対象

データ経路（変更しない）:

- `v0/agent/core/loop.ts`: model stepごとに`assistantToolMessage(calls, result.text, ...)`が
  `AssistantMessage`（content=`ToolCallContent[]`＋optional `text`）を`transcript`へpushし、
  `assistant_message` eventをそのstepの`tool_call` event（loop.ts内、`assistant_message`の後）より
  先にdeliverする。event順は時系列なので、entryを出来事順に積めば正しい配置になる。
- `v0/presentation/adapter_projection.ts` `assistantMessage`: `message.text`をprojectionへ保持する
  （live eventと`restoredPresentationMessages`の両方）。
- `v0/agent/session/history_export.ts` `renderHistoryMarkdown`: `message.text`を`### assistant>`として
  対応`tool>`の前に出しており、`henji history --view canonical`は既に非破壊。変更不要。
- `v0/agent/cli/run_events.ts` `CliRunEventProjector`: model stepごとに`assistant_message`を1件出しており、
  `henji run`の構造化出力も非破壊。変更不要。

表示経路（collapseしている箇所、変更対象）:

- `v0/tui/state.ts` `assistant_message`／`assistant_progress`／`assistant_final`: entry id
  `turn-N:attempt-M:assistant`がturn内のsingletonで、後続の確定・progressが同じentryを
  `replaceEntry`で置換する（`relocateFinalAfterTools`／`relocateProgressAfterTools`で最終回答の
  位置だけ補正）。これがTUIログ上の中間本文消失の直接原因。
- `v0/tui/state.ts` `restored_log`: `assistantIndexByTurn`がturn内の先行assistant entryを削除して
  最後のtextだけ残す（`restored:assistant:${turn}`）。session再開後の表示も同じ欠落。
- `v0/agent/history/history_view.ts` `renderMessages`: turn内`assistantLine`を1行だけ保持し、
  後続textで`lines[currentAssistantLine]`を置換する。`renderSessionView`／`renderSessionTimeline`
  （`henji history --view session`）の欠落はここ。
- `v0/tui/conversation_renderer.ts`: label文字列からtoneを引く表（`assistant>`／`assistant~`→assistant）。
  新labelを採用する場合は対応する。`v0/tui/layout.ts`は`entry.kind === 'assistant'`のbodyをassistant
  markdown rendererで描くので、添え本文もmarkdown bodyとして描かれる。

## 計画

1. `v0/tui/state.ts`のassistant entryをmodel stepごとに一意化する。
   - idはbase `turn-N:attempt-M:assistant`を未使用時のみ採用し、以降はsuffix付き
     （例`assistant:<k>`）を既存entry idと衝突しないよう割り当てる。単一発話turnの
     既存id（`tests/v0/current_code_test.ts`が参照）は維持する。
   - `assistant_progress`: `state.activeAssistantId`のlive entryがあればそれを更新し、
     なければ新規entryをappendする（progress断片の保存はしない）。現行の
     `relocateProgressAfterTools`相当（live entryより後に確定tool entryが並ぶ間は更新位置を末尾へ
     寄せる）は残す。`AssistantMessage.text`は契約上optionalで、text無しtool-call messageのときに
     live entryが確定されない現行挙動では、次stepのprogress更新位置がtool行より前に残るため。
   - `assistant_message`／`assistant_final`: live entryがあればそのentryを確定（`live: false`、確定label）し、
     無ければ確定entryをappendする。確定entryは以後再利用しない。確定は添え本文・最終回答の両方に
     「確定時点に対応turnのtool entryがentryより後にある場合に末尾へ寄せる」relocate相当を適用する。
     これにより「toolsの後から流れた最終回答が末尾に来る」回帰ガード（`tests/v0/tui_conversation_presentation_test.ts`
     "keeps the final answer after tools that followed early progress"）は維持する。
     最終回答（text content message／`assistant_final`）は確定時に全tool entryの後ろへ配置される。
   - `assistant_final` action（`v0/tui/tui_renderer.ts` `renderAssistantFinal`経由）も同じ確定規則に揃える。
2. `v0/tui/state.ts` `restored_log`: message順に1text＝1entryで積む（添え本文→対応tool entry、
   最終回答→tool行の後）。turn内の先行entry削除（`assistantIndexByTurn`）を廃止する。
   entry idはmessage indexを含めて一意化する。
3. `v0/agent/history/history_view.ts` `renderMessages`: 添え本文を対応`tool>`行の前に
   決定labelで、最終回答を`assistant>`で、それぞれmessage位置に出す。置換・転置の
   collapseを廃止する。thinkingのmodel step対応（`appendThinking(assistantStep)`）と
   `tool>`行のin-place更新は変更しない。
4. `v0/tui/conversation_renderer.ts`: `assistant note>`のtone（assistant）対応を追加する。
5. Test（各testは下のproduct動作に対応）:
   - 追加: 1turnに添え本文付き複数stepがあるとき、TUI live log／restore／session viewの3経路で
     各本文が対応tool行の前に時系列で残る（S14本体）。
   - 追加: progressだけの未確定断片は確定後に残らない（S14対象外の固定）。
   - 追加: `assistant_final`（tool_terminal／`submit_json_result`）経路で添え本文が残り、最終回答が
     全tool entryの後に来る（計画レビュー採用F1）。
   - 更新（product動作変更に伴う）:
     `tests/v0/tui_conversation_presentation_test.ts`
     "conversation presentation streams the final assistant response after completed tools"は
     消えていた添え本文が残る形へ、
     `tests/v0/increment_99_history_cli_test.ts`
     "Increment 99 session view places mixed assistant final as resume does"は
     `checking the file`が残る形へ。parity主張（session view＝resume形）自体は維持する。
   - label変更に伴い、既存expectationのlabel表記を`assistant note>`へ揃える。更新testのexpectationは
     entry数・label込みで揃える（例: 同testの中間assertionは3 entries、streaming entryのlabelは
     `assistant~`）。
6. 検証: 対象testのfocused実行、type check、format、lint、`git diff --check`。
   Surface変更なので、完了前に隔離XDGのtmux production TUIで実経路確認を行う（承認済み2026-09-25）。
   実provider callを伴う確認は、実施前に対象・回数・保存先を提示して利用者の明示承認を得る。

## 意味上の判断

- 添え本文を対応tool呼び出しの直前に置く、最終回答はturn末尾に置く: S14の候補記載に従う。
- progress断片の保存・一件ずつの表示はしない: S14の候補記載に従う。
- 添え本文のlabelは`assistant note>`（利用者確認2026-09-25）。`thinking summary>`のような複合labelの
  既存流儀に合わせ、最終回答`assistant>`・`thinking>`と区別する。testのlabel表記もこれに揃える。
  適用範囲はTUIログ（live・restore）と`henji history --view session`。
- `henji history --view canonical`は今回非対応（利用者判断2026-09-25）。`### assistant>`のままとし、
  添え本文は対応`### tool>`の前に出る時系列で区別する（変更前から非破壊であることは確認済み）。

未確定（利用者確認が必要）:

- `AssistantMessage.text`が無くprogressが流れたケース（modelが可視text無しでtool callのみ返した
  variant）は未観測のため仕様化しない。現行どおり確定本文が無い場合はentryを起こさない。
- `henji run`の構造化出力で添え本文と最終回答を区別するmarkerは現状無く、本Incrementの対象外。
  必要になったら別途決める。

## 受入確認

- 人間がproduction TUIで、ツール使用を含むturnの作業途中発話を、対応する結果とともに
  時系列で読み返せること。session再開後、`henji history --view session`でも同じ順序で読めること。
- 最終回答・thinkingと取り違えない表示であること。
- focused test、type check、format、lint、`git diff --check`、tmux実経路確認（承認済み2026-09-25）。
  隔離XDGで行い、実configへ書かない。実provider callを伴う場合は、実施前に対象・回数・保存先を
  提示して利用者の明示承認を得る。restore表示の確認はprovider callなしで実施できる。

## 計画レビュー（2026-09-25）

reviewer2人（通常レビュー・批判的レビュー）で計画をレビューし、採用findingを計画へ反映してから実装した。

- 通常レビュー採用F1: `assistant_final`（tool_terminal）経路の確定・配置規則とtestが未確認。
  → 計画の確定規則を`assistant_final`にも適用し、test追加（`Increment 129 keeps assistant notes when the
  tool terminal final settles`）。
- 批判的レビュー採用1: `assistant_progress`のrelocate規則（現行`relocateProgressAfterTools`）の欠落と、
  settle-relocate条件の「event順が崩れた場合」という誤ったcharacterization。text無しtool-call messageは
  `AssistantMessage.text`がoptionalの契約上の通常形で、このときlive entryが確定されず次stepのprogressが
  tool行より前のentryを更新し続ける。 → progress relocate相当を残すと明記し、settle-relocate条件を
  「確定時点に対応turnのtool entryがentryより後にある場合」に改め、添え本文確定にも適用。
- 批判的レビュー採用2: `assistant_final`／tool_terminalの最終回答位置規則の未定義。 → 「確定時に全tool entry
  の後ろへ配置（relocate含む）」を明記しtest追加。
- 批判的レビュー採用3（軽微）: 更新testのexpectation detail不足（entry数・streaming label）。 → 計画へ明記。
- 不採用: 記述修正のみの指摘、未観測variantの推測仕様化、canonical labelのscoping未記録
  （→「意味上の判断」へ記録済み）。
- 耐えた点: entry id一意化とscroll anchor／id契約、thinkingのmodel step対応、`restored_log`新規則と
  `messageTurns`／omitted行、label依存処理（toneは`v0/tui/layout.ts`が`entry.kind`から付与し、
  `conversation_renderer.ts`の変更は不要）、`history_export.ts`／`run_events.ts`／SQLiteの非変更主張。

## 実装

- `v0/tui/state.ts`: assistant entry idをmessageごとに一意化（`assistantEntryId`、base id未使用時は
  `turn-N:attempt-M:assistant`を維持）。確定は`settleAssistantEntry`でlive entryへsettlingまたは新規
  appendし、relocate相当で末尾へ寄せる。`assistant_progress`は`activeAssistantId`のlive entry更新または
  新規append＋現行relocate相当維持。`restored_log`の`assistantIndexByTurn`による先行entry削除を廃止し、
  message順に1text＝1entry（`assistant note>`／`assistant>`）。
- `v0/agent/history/history_view.ts` `renderMessages`: turn内1行保持・置換のcollapseを廃止し、各本文を
  message位置（添え本文は対応tool行の前）に`assistant note>`／`assistant>`で出力。thinkingのmodel step対応と
  `tool>`行のin-place更新は変更なし。
- `v0/tui/conversation_renderer.ts`: 変更不要（assistant系entryのtoneは`v0/tui/layout.ts`がkindから付与）。
- test: `tests/v0/increment_129_assistant_note_history_test.ts`追加（3経路時系列保持＋parity、progress断片
  非保存、`assistant_final`経路）。`tests/v0/tui_conversation_presentation_test.ts`と
  `tests/v0/increment_99_history_cli_test.ts`のexpectationを新label・新形状へ更新。

## 検証結果

- focused test: `tui_conversation_presentation`＋`current_code`＋`increment_129`（43件）、
  `increment_99-history-cli`（5件）、`increment-120-thinking-history`（5件）、
  `tui_retained_terminal`＋`tui_tool_preview`＋`tui_controller_overlay`（67件）すべて通過。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check` 通過。
- 実経路確認（隔離XDG、provider callなし、2026-09-25）:
  - `henji history --view session`で、添え本文が`assistant note>`として対応`tool>`行の前に、最終回答が
    turn末尾に時系列で出ることを確認（多stepのtool使用turnを含むsessionを隔離XDGへseedして確認）。
  - tmux上のproduction TUI（`henji --session <id>`のrestore表示）で同じ時系列形とlabel区別を確認。
    実config・実XDGへは一切書いていない。
  - `henji history --view canonical`が変更されず`### assistant>`のまま（非対応の決定どおり）であることを確認。
- live経路の実provider call確認（隔離XDG、実config・実履歴・実workspaceに非保存、2026-09-25、
  利用者承認済み: 対象＝tool使用turn 1つ、回数＝1turn・provider request 2step（上限6）、
  保存先＝`/tmp/henji-i129-live`配下の隔離XDGのみ）:
  - production TUI実行中に、添え本文`assistant note> 作業手順: …`が対応`tool> read README.md lines 1–2 ✓`
    の直前に確定して残り、後続stepのthinking・最終回答で置き換わらないことを確認。
  - 最終回答`assistant>`が全tool行の後のturn末尾に来ること、`thinking>`（stepごと）とlabelで区別されることを確認。
  - 同sessionの`henji history --view session`が同じ時系列形・同じlabelで永続化されていることを確認。

## 正本更新

- 通常利用メモ: S14を候補一覧と本文から除去し、観測・候補本文を本Incrementへ移した（採用に伴う移動）。
- roadmap F05: status記述へ「ツール呼び出し添え本文の保持（Increment 129）」を追記済み
  （利用者の承認済み2026-09-25）。
- 構想・architecture: 変更しない。
