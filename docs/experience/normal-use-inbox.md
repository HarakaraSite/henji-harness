# 通常利用メモ

Henjiを通常利用して気づいたことを、未整理のまま蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。
- 個別incrementへ採用した項目は、そのincrementの正本文書へ移して未振り分け一覧から除く。

## 未振り分け

- Henjiの回答をterminal向けplain textにする方法を検討する。
- TUIへのMarkdown renderer導入を検討する。
- 良い点: tool callの内容の一部を確認できる。表示には改善の余地もある。例:
  `tool> bash GOCACHE=/tmp/gocache go run ./cmd/fja --help ✓`
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
- Markdown rendererは通常利用increment 2までには対応せずpendingとする。increment 3以降の候補として、
  まず現在のplain text出力を一切変えず、assistant本文のrendererだけをTUI内部の差し替え可能なcomponentへ
  抽出する案を検討する。その後Markdownを採用する場合も対応範囲を限定して始める。Mermaid等が必要に
  なった場合はrenderer全体の交換だけでなく、Markdown内のblock rendererを拡張する形も候補とする。
  一般的なplugin/load機構までは現時点で決めない。
- tool利用効率はF24の将来の自己改訂対象になり得るが、現時点ではF02・F06の通常改善として実装する。
  increment 2で`maxSteps`を先に実装した後、increment 3以降の対応候補とする。ここで整える
  tool metadataやinterfaceはF24の実装基盤として再利用できるが、それだけでF24完了とはしない。
- agentによる出力component選択はpendingの構想候補とする。agentが具体的なTUI renderer実装を選ぶのでは
  なく、plain text、Markdown、Mermaid等の意味上のcontent kindまたはpresentation intentを返し、Host側の
  Surfaceが利用可能なrenderer componentへ解決する境界が候補。現在のstring出力contractを変更する必要が
  生じた場合に、F10と将来のF24として構想・architectureへ戻って検討する。
