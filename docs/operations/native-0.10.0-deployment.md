# 常用binary 0.10.0配置 — 2026-10-07

利用者の「0.10.0として再build・配置」（2026-10-07）により、JSR公開後のcommit
`e11a978e03d16d79afa724dbc417abc2b9c27eb3`から公式`henji:compile`で0.10.0をbuildし、
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。

build入力は0.10.0のrelease candidateと同一で、JSR公開候補のauthoritative gate（691 pass/0 fail）を
使用した。full gateや実provider確認は繰り返していない。

- version: `henji 0.10.0`
- sourceDirty: `false`
- build ID: `89d2edb4d7034545823c6825182a9663e9c35272fc80fdc456f830c79dadb3bd`
- runtime SHA-256: `c644c80f7f305f30eb5b4da0a12b3a601d3dcfea8821aabd8fa57872d473cfa9`
- binary SHA-256: `5404a60920d942cacbf9d1d7548fe0bad1578c2a9136d2a27daf3bcd27fbb2c3`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

candidateの`--version`を確認し、両配置先のversion・SHA-256一致を確認した。
配置先binaryで隔離HOME/XDG/workspace、外部DenoのないPATHを使い、compiled Coreを起動した。Core
APIから0.10.0・clean sourceを確認し、120×35のtmuxでproduction TUIの`Henji Harness v0.10.0`と
`● ready`表示、Ctrl-QによるTUI終了とCoreのexit 0を確認した。task投入と実provider requestは0。
既存Core・Session・実config・credentialは変更していない。

旧207 binary（0.9.0、SHA-256 `e6a548c89d9acaf58bf01f1b28c4cc6152fb4179011110bd5bf4a8b6625f9a98`）は
git管理外の`.tools/native-0.10.0-deployment/henji.dist.previous`と`henji.local.previous`へ退避し、
`~/.local/bin/henji.previous`にも保存した。元の`henji.previous`（206の配置版、SHA-256
`5e831c51bd0c369f1190fe457187dcc7e099cf0e9d2c5bf4d9e1d93b0aafe51d`）は
`henji.local.previous.pre0.10.0`へ保存した。同directoryの`build.log`、`state.json`、
`startup-verification.json`、`startup-core.json`、`startup-tui.txt`、`startup-ready.json`、
`startup-runtime.json`に確認結果を保存した。
新しい起動から0.10.0が適用される。起動中のCore/TUIの停止・再起動は行っていない。
