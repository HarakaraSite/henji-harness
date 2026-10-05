# 常用binary 0.9.0配置 — 2026-10-05

利用者の「常用バイナリも置き換えて」により、JSR公開後のcommit
`65c420ef5e92f64f0606778a6b655c774e72b9ed`から公式`henji:compile`で0.9.0をbuildし、
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。

前回の[Increment 191](../increments/increment-191.md)配置sourceから、runtime・build script・vendor・
Deno config/lockの変更はない。build入力の差分は`jsr.json`のversion更新だけで、 JSR公開候補の645
test成功結果を使用した。full gateや実provider確認は繰り返していない。

- version: `henji 0.9.0`
- sourceDirty: `false`
- build ID: `f536af638b0b6dfcd054baa123f7dfbd9d70ab0bb5f5a90586414a8154d1995c`
- runtime SHA-256: `7460af1099cdfbfbd2aef5bdbd5918dcbcb080dd8883f81c043c169d0f130e9f`
- binary SHA-256: `d88b822428d66bd2d8144a1ee21a1dffd7c53f22761a3437ed4703689de4eb91`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

candidateの`--version`と`--help`を確認し、両配置先のversion・SHA-256一致を確認した。
配置先binaryで隔離HOME/XDG/workspace、外部DenoのないPATHを使い、compiled Coreを起動した。 Core
APIから0.9.0・clean sourceを確認し、120×35のtmuxでproduction TUIのready表示、
Ctrl-QによるTUI終了とCoreのexit 0を確認した。task投入と実provider requestは0。
既存Core・Session・実config・credentialは変更していない。

旧191 binaryはgit管理外の`.tools/native-0.9.0-deployment/henji.dist.previous`と
`henji.local.previous`へ退避した。同directoryの`build.log`、`deployment.json`、
`startup-verification.json`、`startup-tui.txt`、`startup-core.json`に確認結果を保存した。
新しい起動から0.9.0が適用される。起動中のCore/TUIの停止・再起動は行っていない。
