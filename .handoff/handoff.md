# Handoff

## Records

### 次Incrementの候補選定

- 状態: 通常利用メモの未採用候補を比較し、次の小規模対応として`read`分割範囲のtool表示を推奨した。request時点の予定範囲を短く表示し、settled後も維持する案であり、まだIncrement 18への採用・計画作成・実装は行っていない。
- 次: 利用者がこの候補をIncrement 18として採用するか確認する。
- 正本: `docs/experience/normal-use-inbox.md`
- 注意: 現行案は、`offset`・`limit`がある場合だけ`lines 1–200`や`lines 201+`のように表示し、tool引数全体やfile内容の表示には広げない。リポジトリ内には利用者所有の未追跡`_refs/*`があり、変更対象にしない。
