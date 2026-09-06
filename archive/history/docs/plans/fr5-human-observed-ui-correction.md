# FR5 human-observed UI correction

## 目的

実利用で確認されたUI問題を、短い実装と本人利用の反復で直す。機械testを、人間による
通常画面の判断の代わりにしない。model回答の内容は今回の対象外とする。

## 維持するもの

- provider、tool、session、Agent Definitionの動作
- provider evidenceの保存と明示的なCLI readback
- 三領域（作業log、入力欄、一行footer）
- dependencyなし

## Cycle 1: 通常画面を会話として成立させる

主対象: `v0/tui/state.ts`、`layout.ts`、`render.ts`。表示事実が不足する場合だけpresentation
adapter/contractを変更する。

- 成功turnの`requests>`、`evidence>`、`readback>`を通常logから外す。
- failureは短い利用者向け表示にし、診断IDとcommandは明示的な詳細表示へ退避する。
- toolは「何を実行中か／完了したか」を一つの短いentryで示す。`read`全文やraw JSONを通常logへ
  展開しない。
- 完了したassistantを`assistant>`へ確定する。
- footerへready/busy、session、実際のcommitted turnを重複なく表示する。
- ASCII、日本語、行末、途中編集、wrapでcursor位置を表示と一致させる。

確認は変更箇所のfocused test、check/fmt/lint/diff、短いfunctional reviewに限定する。その後、本人が
短い質問とread/Bashを伴うtaskを通常利用し、質問・結論・次入力の見つけやすさとcursorを判断する。
問題が残ればCycle 2へ混ぜず、Cycle 1を一度補正する。

## Cycle 2: 現在sessionの画面を隔離する

主対象: `v0/tui/terminal.ts`、`render.ts`、必要なcontroller composition。

旧計画のmain-screen固定を撤回し、alternate screenを採用する。これは元planner inputの必須条件ではなく、
実利用でscrollback汚染と旧terminal表示の混在を起こしたrepo内設計判断である。
terminal制御に独自性を求めず、Piを第一参照、Zotを補助参照として、alternate screenの開始・終了、
再描画、scroll、正常終了・signal・failure時の復元順を比較し、実績のある挙動を採用する。

- 起動中はHenjiの現在sessionだけを表示する。
- streaming/progressは同じ位置を更新し、terminal scrollbackへ途中frameを残さない。
- PageUp/PageDown/Ctrl-LはHenji自身の現session logだけを操作する。
- 正常終了、cancel、signal、出力失敗の全経路で起動前の画面、cursor、terminal modeを復元する。

最小のfocused PTY確認とcheck/fmt/lint/diff、terminal lifecycleに限定したfunctional review後、本人が
streaming/tool task、session内scroll、終了復元を通常利用で判断する。問題があれば次へ進まない。

## Cycle 3: tool行頭previewを付ける（縮小版）

本人判断により、個別tool開閉と詳細復帰は初期バージョンの必須としない。Cycle 3は
`v0/tui/state.ts` の一行表示だけを変更する。

- 対象は `bash/read/write/edit` の4 toolのみ。live（`…`）と完了（`✓/✗`）で同一形式とする。
- 引数の行頭のみを表示し、端末幅ではなく現行の表示セル幅とbyte上限の範囲で `…` 打切りする。
  複数行commandも改行展開せず、最初の行相当のみとする。
- raw JSONや全文は通常logへ出さない。Piの `renderCall/formatBashCall`、Zotの `ShortArgs`
  と同じ発想の最小版とし、frameworkやstate modelの移植はしない。
- 個別展開（開閉後のdraft/cursor/scroll復帰）は将来の必要時に別途計画する。

focused checkとfunctional review後、本人が新規taskと継続sessionを使って評価する。

## 共通境界

- Pi/ZotはUI挙動とterminal lifecycleを積極的に参考にする。framework、API、全state modelの移植は
  必要としないが、既存解を避けるための独自実装は行わない。
- repository作業からprovider、credential、production taskを実行しない。実利用と費用は本人操作とする。
- 各cycleで使いにくさが増えた場合は次へ進まず、観測箇所だけを補正する。
- provider/tool semantics、session schema、evidence保存、Agent Definition、新dependencyが必要なら停止する。
- full gateを各cycleで繰り返さない。全cycle後の安定候補に必要ならownerが一回だけ行う。
- 完了は本人が通常利用で判断した時点とする。

## 対象外

F1 helpの内容と文言は今回変更しない。通常画面の機能と操作が確定した後、実際の最終仕様を説明する
別incrementとして扱う。F1の現状を理由に各cycleの通常画面を合格にしない。
