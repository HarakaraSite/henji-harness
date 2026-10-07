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
