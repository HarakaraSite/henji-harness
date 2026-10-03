# 通常利用 Increment 31 — セッション開始時のヘッダー充実

ステータス: **完了**

## 利用者が必要とする動作

- Henjiを起動した直後に、現在のSession、workspace、agent、読み込まれたcontextとskills、実行境界を
  一画面で確認できる。
- `--continue`、`--session`、同じworkspace内の`/sessions`復元でも、現在bindingの情報を表示する。
- `/rename`後は同じヘッダーのtitleを直ちに更新する。
- 過去表示ではヘッダーをSession先頭の一つのblockとして確認でき、各pageへ繰り返し表示しない。
- `/history export`にはSession識別情報とexport時点のruntime情報をMarkdown metadataとして含める。

## 採用した表示

通常幅では、次の情報を枠付きblockで表示する。

- Session作成日時（UTC、分まで）、title（未設定時は`untitled`）、起動mode、短縮Session ID
- workspace、agent、instruction source、最大5件のskill名と残件数
- `trusted-local`およびhard sandboxの有無

provider、model、effortは既存footerに表示されるため重複させない。standalone executableとしてのversion正本が
まだないためversionも表示しない。固定help文はF1 overlayとslash command候補へ任せる。

小さいterminalではeditorとfooterを圧迫しない二行表示へ切り替え、作成日時、title、mode、短縮ID、workspaceを
保持する。headerは構造化したstartup/session情報からterminal sizeごとに再描画し、生成済み文字列を固定しない。

## Sessionとruntime情報の扱い

- 新規Sessionの`createdAt`はHost生成時に一度だけ確定し、最初のcommit、model変更、rename、通常turn commitで
  同じ値を使う。
- `createdAt`とtitleをHostのcurrent positionからpresentation/TUIへ渡す。`/sessions`切替時はtarget bindingの
  positionへ置き換える。
- ヘッダーはcanonical conversation transcriptへ加えない。retained layoutの先頭blockとして保持する。
- exportのtitle、createdAt、Session ID、agent、turnはcommand受付時のcurrent bindingから同期的にsnapshotする。
- instruction source、skills、trustはSession作成時snapshotではなく現在processの解決済み情報なので、exportでは
  `Runtime at export`と明記する。

## `/history export`形式

既存の完全なcommit済みcanonical transcriptに加え、先頭へtitle、createdAt、Session ID、workspace、agent、
through turnを置く。続けて`Runtime at export`へcontext、skills、trust、hard sandbox有無を記録する。tool callと
tool result本文を含むturn本文の既存形式は変えない。

## 対象外

- Markdown本文renderer
- 全workspace横断のSession picker
- standalone executableのversion表示
- provider/model/effortのheader重複表示
- roadmap、architecture、構想文書の変更

## 実装と検証計画

1. Hostが新規・復元SessionのstableなcreatedAtとtitleをcurrent positionへ投影する。
2. presentationとTUIがstructured header stateを保持し、起動、resize、rename、`/sessions`切替を同じrendererへ通す。
3. startup headerをretained logの先頭に一度保持し、通常幅と小terminalのlayoutを確認する。
4. history exportがcurrent bindingとruntime metadataを非同期write前にsnapshotする。
5. focused test、type check、format、lint、差分reviewを行い、stable candidateでauthoritative `v0:gate`を一回実行する。

## 完了条件

- new、continue、exact、no-sessionの各modeで識別情報が正しい。
- Session切替とrename後のheaderがcurrent bindingと一致する。
- PageUpで最古位置へ移動したときheaderが一度だけ存在し、小terminalでは二行へ縮退する。
- `/history export`がSession metadataと`Runtime at export`を含み、command受付後のbinding変更と混ざらない。

## 実装結果

- Worker HostでSession生成時に`createdAt`を一度確定し、rename、model変更、turn commit、復元後のcurrent
  positionで同じ値を使うようにした。titleもcurrent positionを通してpresentationへ渡す。
- startup表示を二行の生成済み文字列からstructured stateへ変更した。通常幅では九行の枠付きblock、小さい
  terminalでは二行に再投影し、長いworkspaceは末尾のrepository名を残す。
- new、continue、exact、no-sessionを区別し、`/sessions`切替ではtarget SessionのcreatedAt、title、短縮IDへ
  更新する。`/rename`結果は永続化された正規化後titleから更新する。
- headerをconversation entryへ混ぜずretained logの先頭に保持した。最古位置を表すviewport stateを追加し、
  PageUpでheaderから表示した後もPageDown、Esc、通常task受付で従来どおり最新追尾へ戻る。
- `/history export`へtitle、createdAtと`Runtime at export`を追加した。transcript、binding metadata、runtime
  metadataはwriterの最初の非同期境界より前にsnapshotする。
- 旧compact startup専用の`sessionLine`とworkspace整形関数は利用箇所がなくなったため削除した。

## Reviewと検証結果

- 差分reviewで、new/restoreのcreatedAt正本、Session切替のevent順序、rename正規化、terminal resize、最古
  viewport、history exportのbinding snapshotを確認した。未解決のcorrectness findingはない。
- 80×24の通常headerと50×12のcompact headerを実際のprojection出力で確認した。
- TUI 25件、history export 6件、Worker Host 42件のfocused testが成功した。
- stable candidateに対するauthoritative `v0:gate`を一回実行し、type check、format、lint、およびoffline
  test 149件がすべて成功した。

## 完了判断

- 利用者がproduction TTYでSession開始headerを確認し、2026-09-11にIncrement 31の動作を受け入れた。
- 全workspace横断Session picker、standalone executableのversion表示、roadmap・architecture・構想文書の変更は
  このincrementへ追加せず、合意した対象外のままとする。
