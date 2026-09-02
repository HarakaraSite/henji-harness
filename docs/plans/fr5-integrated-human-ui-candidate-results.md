# FR5 integrated human UI candidate results

Plan: `docs/plans/fr5-integrated-human-ui-candidate.md`

Status: **条件付き合格**

User decision: 2026-09-02 20:38 JST

## 結果

保持済みGate 1 sessionをinstalled production `henji --continue`で再表示し、F1より先に画面本体を
確認した。ユーザーは候補を条件付きで合格とし、正式な日常利用の判断は自身で使った後に行う。

- log、入力欄、ready状態、session、turnを識別できた。
- PageUp/Ctrl-Lで過去の依頼からplanner、tool、結果、finalまで移動できた。
- 未送信draftは過去表示中も保持された。
- Ctrl-T historyはturn単位で移動でき、Escで作業画面へ戻れた。
- 空入力Ctrl-Dはexit 0でterminalを復元した。

## 継続使用で確認する点

- planner resultとBash resultが長いJSONのまま表示され、作業内容より内部構造が目立つ。
- historyでは一つのtool操作が`assistant`、`tool>`、`tool<`として並び、重複して見える。
- F1には`steer`、`follow-up`、`settlement`、`completed effect`など平易でない語が残る。

これらは今回その場で修正しない。実際の利用で問題になった表示・操作を根拠に、必要なら別の
最小実装計画を作る。F1の充実だけで画面本体の使いにくさを補ったとは判定しない。

## 実行境界

- task submit 0、context生成0、provider request 0、費用USD 0。
- credential read、retry、fallback、session切替、fake fixture、source/test変更は行っていない。
- session SHA-256は実行前後とも
  `74be6d7c3cce81c2f85de0ba6d16cf55f7dc8f3593b4e050ca330aae60421978`。
- provider evidenceは3件のまま、diagnostic追加0、session lockは終了後に再取得可能。
- workspaceは既存の`brief.txt`と`release-note.md`だけで、追加ファイルなし。

