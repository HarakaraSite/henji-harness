# 常用binary 0.11.0配置 — 2026-10-07

利用者が211・212とヘッダー表示固定を受け入れ、push・v0.11.0のJSR公開・常用配置を指示した。
push済みsource `f75087fb6551b279270e551444f0be4f4c7c3118`から公式`henji:compile`でbuildし、
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。

- version: `henji 0.11.0`
- sourceDirty: `false`
- build ID: `b68ee1a82b9d146eb9e6bf3bcced4e976092ebb443f5256a16bbb801fe9d8146`
- runtime SHA-256: `8864c9cf867efce5a080bac314ac2382407a3c3a5d8d5cc7697726f2e1ace3f0`
- binary SHA-256: `388a03800ae87e8145649e9a3614bd0cfe86f0bbe3bfd1699f2d5306d62bf152`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

公開候補のauthoritative `v0:gate`を1回実行し、682 pass／0 fail、type・format・lintもPASS。
配置先両方とcandidateのversion・SHA-256一致を確認した。
配置binaryのcompiled Core/TUIを隔離HOME/XDG・workspace・外部DenoのないPATH・tmuxで起動した。
Core APIのsource一致・clean・0.11.0、TUIの`Henji Harness v0.11.0`・ready表示、normal screen／mouse off、
複数行editorのUp/Home編集、F4 picker・Escでdraft保持、Ctrl-QのTUI終了とCore exit 0を確認した。
task投入・実provider requestは0回。通知の配色は変えず、S38へ要望を記録した。

旧0.10.0 binary（source `afc75e0b`、SHA-256 `99d2b87b3ba113ac4a6100bae038c6f5b57e77f24723e5afdf335c688d9d512a`）は
`henji.previous`と`.tools/native-0.11.0-deployment/henji.local.previous`へ保存した。
旧distは`henji.dist.previous`、元の`henji.previous`は`henji.local.previous.pre0.11.0`へ保存した。
同directoryの`build.log`、`deployment.json`、`smoke.json`、`smoke-tui.txt`等へ確認結果を保存した。

既存の稼働Core/TUIは停止・再起動していない。新しいCore/TUIの起動から0.11.0が適用される。
JSR公開は[公開記録](jsr-publish.md#0110-publication--2026-10-07-jst)を参照する。

## 公開後のTUI修正配置 — 2026-10-07

利用者の「コミット、配置」の指示により、source `b7a904ca57a39d0be344a22f3841723b3f9be66d`を
公式`henji:compile`でbuildし、`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。
終了時の画面clear、F4の標準色、未観測の本文置き換え対応の削除、tool行・本文ラベルの再出力抑止、
system／thinking／tool／入力欄の配色と、折り返しを含む複数行入力の上下移動を含む。
要件・実装・focused検証は[Increment 212](../increments/increment-212.md)を参照する。

- version: `henji 0.11.0`、sourceDirty: `false`
- build ID: `316f06be431b4613e83196c2f151b5caafff776afd08c990c9dc55cbc0e02ed7`
- runtime SHA-256: `effdba4322970871f73c4d7b08478354e82fee85e85e534468dae31db5fa6d69`
- binary SHA-256: `15300e787673769daec7e550f86462f1625f5241f2722b5ca4e27820fe571735`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

candidateと両配置先のversion・SHA-256一致を確認した。直前のsource `f75087fb`のbinaryは
`henji.previous`と`.tools/tui-post011-deployment/henji.local.previous`へ保持した。
旧distと、更新前の`henji.previous`も同directoryで保持し、以前のbackupは変更していない。

配置binaryのcompiled Core/TUIを隔離HOME/XDG・workspace・外部DenoのないPATH・tmuxで操作した。
Core APIでsource `b7a904ca`・clean・0.11.0を確認し、normal screen／mouse off、F4の標準色を確認した。
localhost chat SSEの80行thinking・80行本文が重複なく表示され、resize後もthinking／assistantの
ラベルは1回だった。thinking全体の標準色Dim、tool prefixの黄色Dim、入力背景gray 237を実SGRで確認した。
改行なしで11行に折り返されたdraftをUp／Downで隠れた行まで移動して編集できた。
local bashのtool行は開始時の`…`付き1行だけを残し、保存Session再表示では`✓`付き1行になる。
F1でlocal streamをcancelし、systemのCANCELLEDは紫Dimだった。
Ctrl-Q後はshell promptが最上行左端に戻り、その下は空行。開始前の80行markerと会話はscrollbackに残った。
localhost requestは4回、外部provider requestは0回、Core exit 0。full gateは繰り返していない。

記録（git対象外）: `.tools/tui-post011-deployment/build.log`、`deployment.json`、`result.json`、
`deploy_smoke.py`、`styled.txt`、`editor-top.txt`、`editor-edited-bottom.txt`、
`after-exit-screen.txt`、`after-exit-history.txt`。

既存の稼働Core/TUIは停止・再起動していない。新しいTUI起動から表示変更が適用される。
今回のsourceのpush・JSR追加公開は実施していない。
