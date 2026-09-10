# 通常利用 increment 18 — tool activityの意味的preview

ステータス: **完了**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- 同じtoolを連続して使った場合も、人間がTUIのconversation logから各callの対象を区別できる。
- `read`ではfile pathに加えてrequest時点の予定行範囲を短く表示し、分割読込みを同じ内容の重複読込みと
  誤認しない。
- `bash_output`ではstreamとrequest時点の予定byte範囲を表示し、保存済み出力の継続読込みを追える。
- `web_search`ではqueryの先頭、`skill`では読み込むskill名を表示し、実行中の作業内容をtool名だけより
  具体的に理解できる。
- request時に表示したpreviewをprogress中、settled後、現在Sessionの復元後も維持する。

## 根拠と現行product経路

- 通常利用で254行のREADMEを1–200行、201–254行に分けて正しく読んだが、production retained TUIは
  両方を`tool> read README.md`と表示し、同じ内容を二重に読んだように見えた。
- Increment 5のproduction利用では、同じ保存済みstdoutへ`bash_output`をoffset 0と49,150で連続して
  呼んだ。現行TUIは`bash_output`をpreview対象にしないため、両callはtool名だけでは区別できない。
- 現行のretained TUIは`bash`、`read`、`write`、`edit`だけをpreview対象とする。production TUIの
  `PresentationToolCall.arguments`には、今回必要な`read`、`bash_output`、`web_search`、`skill`の
  request引数が既に渡っており、Worker、provider、tool executorのcontract変更は不要である。
- `bash`はcommandの先頭、`write`と`edit`はpathを既に表示するため、現行表示を維持する。

## 表示contract

すべて従来どおり共通の`tool>` labelを使う。`skill>`等の新しいlabel kindは追加しない。実行中は末尾に
`…`、成功後は`✓`、失敗後は`✗`を表示する既存contractを維持する。

| Tool | Request | Activity本文の例 |
| --- | --- | --- |
| `read` | `{path: "README.md"}` | `read README.md` |
| `read` | `{path: "README.md", limit: 200}` | `read README.md lines 1–200` |
| `read` | `{path: "README.md", offset: 201, limit: 200}` | `read README.md lines 201–400` |
| `read` | `{path: "README.md", offset: 201}` | `read README.md lines 201+` |
| `bash_output` | `{stream: "stdout"}`と有効な`outputId` | `bash_output stdout bytes 0–49151` |
| `bash_output` | `{stream: "stderr", offset: 49152, limit: 4096}` | `bash_output stderr bytes 49152–53247` |
| `web_search` | `{query: "Deno 3.0 release status"}` | `web_search Deno 3.0 release status` |
| `skill` | `{name: "handoff-read"}` | `skill handoff-read` |

- `read`は`offset`または`limit`が明示された場合だけ行範囲を加える。省略された`offset`は1として表示する。
  `limit`があればrequest上の最終行、なければ`<offset>+`を使う。実際に返った最終行へsettled時に
  書き換えない。
- `bash_output`はtool contractのdefault offset 0とdefault window 49,152 bytesを含む予定範囲を表示する。
  `outputId`はexecutorが参照するopaque identityのままとし、通常logへ表示しない。実際に返ったbyte数や
  `complete`へsettled時に書き換えない。
- `web_search`はqueryの先頭一行、`skill`はskill名だけを表示する。
- previewは既存どおりUTF-8で先頭を最大96 bytesまでscalar境界を保って表示し、省略時はellipsisを加える。
  tool引数全体、file content、command output、search result、skill本文、tool result本文は通常logへ展開しない。
- previewを構成できないcallはtool名だけを表示し、canonical transcriptとtool実行結果には影響させない。

## 実装計画

1. TUIが所有するtool activity preview formatterを一箇所へまとめ、既存の`bash` command先頭と
   `read`・`write`・`edit` pathの表示を回帰なしで移す。
2. `read`へ上記の予定行範囲、`bash_output`へstreamと予定byte範囲、`web_search`へquery先頭、`skill`へ
   skill名のformatterを追加する。
3. production retained stateがrequest previewをprogress/resultまで保持する現行経路と、canonical transcriptから
   現在Sessionを復元する経路を同じformatterへ接続する。direct test seamのcall時表示も同じformatterを使う。
4. focused product testで、同じfileの分割`read`、同じstreamの分割`bash_output`、`web_search` query、skill名、
   progress/result後とSession復元後の維持、既存tool表示、96-byte上限を確認する。
5. 関連するsource guide、roadmap、通常利用メモ、increment文書、handoffを実装結果へ合わせる。
6. focused test、該当type check、format、lint、`git diff --check`、差分reviewを行い、安定候補で
   authoritative `v0:gate`を一回実行する。

## Product確認

| 動作 | 確認方法 |
| --- | --- |
| 二つの分割`read`が異なる行範囲に見える | retained conversation state/layoutへ実際のtool call/result eventを通す |
| 二つの`bash_output`がstreamとbyte範囲で区別できる | default値と明示offset/limitのfocused preview test |
| 検索内容とskill名を追える | `web_search`と`skill`のcall/result表示比較 |
| settled後とSession復元後もrequest previewが残る | progress/result reducerとrestored transcriptのfocused regression |
| 既存の`bash`、`write`、`edit`表示が変わらない | 現行preview testの回帰確認 |
| 通常logへ本文やraw JSONを展開しない | result本文と非表示引数を含むeventから生成したlogを確認 |

表示は既存のproduction Presentation eventから決定でき、providerや外部serviceの挙動に依存しない。実provider call、
credential読取り、browser E2E、real-TTY E2Eは行わない。

## 対象外

- `delegate_to_planner`のpreview。将来のサブエージェント機能拡張と一緒に設計する。
- `submit_json_result`および任意の外部toolへ引数を自動表示するgeneric fallback。
- `bash`のtimeout、`write`のcontent byte数、`edit`の置換数など、現行表示で具体的な問題が観測されていない追加情報。
- tool result本文、実際の最終行・byte数、error理由をsettled activityへ表示すること。
- `tool>` label、label色、conversation layout、canonical transcript、history export、Presentation contract、
  Worker protocol、tool input/output contractの変更。
- tool componentが自身のSurface表示metadataを宣言する一般機構。tool revisionとSurface componentの将来設計で扱う。

## Human Gate

利用者は2026-09-10、`read`、`bash_output`、`web_search`、`skill`をIncrement 18の候補範囲として採用し、
`delegate_to_planner`は将来のサブエージェント機能拡張に合わせて対象外とした。

同日、利用者は上記の初期実装計画と、実装、focused test、差分review、authoritative `v0:gate`までを承認した。

## Implementation result

- `v0/tui/tool_activity.ts`へ既知toolの意味的preview formatterを追加し、production retained stateとdirect
  renderer seamから共用した。
- `read`は明示された`offset`・`limit`から予定行範囲、`bash_output`は実際のtool defaultを含むstream・
  予定byte範囲、`web_search`はquery先頭、`skill`はskill名を表示する。
- 既存の`bash` command先頭と`write`・`edit` pathを同じformatterへ移し、表示内容を維持した。
- retained stateがcall時のpreviewをprogressとresultで引き継ぐ既存経路を維持し、canonical transcriptからの
  Session復元でも同じpreviewを再構成する。
- `delegate_to_planner`とunknown toolは名前だけの表示を維持した。Presentation、Worker、tool executor、
  canonical transcript、history exportのcontractは変更していない。

## Review

default agentが承認済み計画、現行tool input contract、production retained event経路、差分を照合した。
previewはrequest引数だけから決まり、tool実行やresultを変更しない。`bash_output`のdefault windowはexecutorが
exportする正本の定数を参照し、表示値との重複定義を置いていない。未解決のcorrectness findingはない。

## Verification

- Focused TUI product test: 21 passed、0 failed。分割`read`、`bash_output`のdefault・明示window、
  `web_search` query、skill名、progress/result後、Session復元後、direct seam、既存tool、非表示本文を確認した。
- 対象source/testのtype check、format、lint、`git diff --check`: 成功。
- stable candidateへauthoritative `v0:gate`を一回実行し、type check、format 195 files、lint 192 files、
  全129 testが成功した。

検証はprovider-freeな既存test経路だけを使用し、実provider request、credential読取り、browser E2E、
real-TTY E2Eは行っていない。

## Production確認と受入

2026-09-10、利用者がproduction retained TUIで通常利用し、`read README.md lines 1–2000`の予定範囲表示と、
複数の`web_search`がquery先頭で区別できることを確認した。path-onlyの`read README.md`、settled marker、
長いqueryのellipsisも表示contractどおりだった。

同日、利用者はIncrement 18を完了として受け入れた。
