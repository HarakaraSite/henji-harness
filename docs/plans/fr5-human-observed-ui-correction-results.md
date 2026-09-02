# FR5 human-observed UI correction results

Plan: `docs/plans/fr5-human-observed-ui-correction.md`

## Cycle 1

Status: **implemented; awaiting human use**

実利用で確認された通常画面の問題だけを補正した。

- 成功turnのrequest count、evidence ID、readback commandを通常会話logから外した。
- tool call/progress/resultを一つの短いentryへ統合し、`read`全文やraw result JSONを表示しない。
- streaming assistantを完了時に同じ`assistant>` entryへ確定する。
- footerは実際のcommitted turnを更新し、ready/busyとsession/turnを優先して重複を除く。
- ASCII、日本語、途中位置、行末、wrapのcursor cell計算を補正した。
- failureは診断IDを常時表示せず、cancel、provider response等を区別する短い固定理由を残す。
- evidence保存、diagnostics CLI、provider/tool/session semantics、UI/core境界は変更していない。

Piを第一参照、Zotを補助参照として、同一entry settlement、表示幅、簡潔なactivity表示を参考にした。
F1とalternate screenは変更していない。

Initial functional reviewのP2 3件（failure理由消失、cancel時の未完了tool残留、context表示時の
session/turn脱落）は局所修正し、narrow re-reviewで全件Closed、Blocker/P1/P2 0となった。

最小suiteは既存18件に人間観測由来6件を加えた24件。owner authoritative `v0:gate`は安定候補に
一回だけ実行し、24/24、check/fmt/lint/diffがgreen。provider、credential、production task、retained
state、dependency、`_refs/*`は操作していない。

次は本人が通常利用し、質問・短いtool activity・final・次入力、footer、cursorを評価する。合格または
Cycle 1の一度の補正後にCycle 2へ進む。

## Cycle 2

Status: **implemented; awaiting human use**

retained production TUIは最初のframeより前にalternate screenへ入り、streaming/tool/progressの全再描画を
現在sessionの画面内へ隔離する。終了時はrendererを閉じ、inputとterminal modeを復元してからalternate
screenを離れ、cursorを表示する。PageUp/PageDown/Ctrl-Lの現session viewport操作は既存のUI-local実装を
維持した。通常footerからはeditor draftの`pending editor:<bytes>B`だけを外し、editor metadata表示と
active/recovery laneは保持した。

focused Cycle 1/Cycle 2 tests、check、fmt、lint、diff checkは実行済み。alternate screenの実利用での
scrollback、終了復元、streaming/tool taskの本人確認は未実施であり、Cycle 3は開始していない。

### Cycle 2 local correction

Status: **implemented; awaiting follow-up human use**

本人利用で確認された二点だけを補正した。`５`（U+FF15）を含むverified fullwidth formsをlayout/renderの
両方で2 display cellsとして扱い、halfwidth formsは1 cellのままにした。paste後のcursor、backspace、
挿入が表示位置と一致するfocused regressionを追加した。PageUpの最古ページでstartup/omitted rowへ
到達した場合は、latestへ戻らず最初のconversation entryへanchorするよう補正し、PageDown/Ctrl-Lは維持した。

Cycle 1/2 focused tests、check、fmt、lint、diff checkは実行済み。補正後の本人によるfullwidth入力と
最古ページの再確認が残っており、Cycle 3は開始していない。
