# 通常利用メモ

Henjiを通常利用して気づいたことを、未整理のまま蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。

## 未振り分け

- TUIにカレントディレクトリ（repository）を表示してほしい。
- フッターに`F1 help`は表示しない。
- Henjiの回答をterminal向けplain textにする方法を検討する。
- TUIへのMarkdown renderer導入を検討する。
- 良い点: tool callの内容の一部を確認できる。表示には改善の余地もある。例:
  `tool> bash GOCACHE=/tmp/gocache go run ./cmd/fja --help ✓`
- READMEとコードの矛盾確認で、8回のtool call後、回答を返す前に`step limit reached`となった。
  repository調査には現行のstep上限8では足りない場合があるため、制限緩和を検討する。
- repository調査で、8.7 KiBのREADMEに`read`を使わず、4 KiBで出力が切れる`bash cat`と
  `tail`を繰り返してstepを消費した。対象repoにtool選択を導くinstructionはなく、productionの
  tool descriptionにも`read`を優先する方針はない。固定instruction、tool description、tool設計の
  どこで効率的な選択を支えるか検討する。Henjiのbash環境では`rg`がPATH外なので`grep`の選択は妥当。
- 参照実装調査とHenjiへの示唆（未採用）:
  - Piはtoolごとのdefinition metadataにdescription、schema、実行処理、TUI表示に加えて
    `promptGuidelines`を持たせ、有効なtoolのguidelineだけをsystem promptへ合成する。`read`には
    「`cat`や`sed`ではなく`read`でfileを調べる」という選択指針がある。
  - Zotはtool利用指針をsystem promptへ追加せず、tool schema・descriptionとmodelの判断に任せる。
    CLIのstep上限は既定で無制限であり、必要な場合だけ`--max-steps`で指定する。
  - PiとZotの`read`は50 KiBまたは2,000行で区切り、`offset`・`limit`で続きを読める。`bash`も
    同じ上限で区切るが、全出力を一時fileへ保存し、必要なら読み返せる。
  - Henjiでは、byte・line上限はtool実装またはtool設定、tool固有の選択指針はtool definition
    metadata、有効toolと指針の合成はAgentCompositionの責務候補として検討する。`read`の
    `offset`・`limit`、続きを示すtruncation result、`bash`全出力のreadbackも改善候補とする。
    tool自体をself-revision対象にする場合はF24に当たる。
- 第1回の通常利用incrementを終了した。通常利用中に気づきを随時蓄積する方法は、具体的な改善候補を
  見つけるうえで有効だと感じられた。
