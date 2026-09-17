# Handoff

## Records

### Increment 51〜61 — instruction CLI、OpenRouter Responses、provider宣言と一般化

- 状態: Increment 61は完了・配置済み。provider identityを`providerId` + `protocol` + `authProfile`へ一般化し、
  data-only宣言でbuilt-inとは別の新しい`providerId`を追加できるようにした（`openai-responses` protocol限定）。
  例: `providers/openai-alt.json`（`providerId: "openai-alt"`, `protocol: "openai-responses"`, endpoint
  `https://api.openai.com/v1`, `authProfile: "openai-api-key"`, fixed catalog/defaults）を置くとbuilt-in `openai`と
  併設され、`/provider`・`--root-provider openai-alt`・model pickerで選択できる。endpoint/authProfile/catalog/
  defaultsは宣言から解決し、Session/evidenceは`providerId`/`protocol`/`authProfile`/`modelId`/`effort`で
  attributionする。実装commit `6a34bf07`。clean commitからbuild
  `ee42b5f85bb4f09077b936b437581030d5329402d4ee0087ef1904dfc9508aea`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `e8773c10bccf103397cd858c4aa25691f848441eee1597457e9a6f7c1bc062af`、source
  `6a34bf075d5f8a562d94d018779321058aeb9f71`、`sourceDirty=false`）。authoritative `v0:gate`通過。実機で
  `--root-provider openai-alt`のfooterが`provider:openai-alt model:gpt-5.6-terra medium`を示すことを確認した
  （provider requestは行っていない）。
  前段: Increment 59/60（provider宣言、endpoint/catalog override、`871cfb6c`／`e1814528`）、Increment 58
  （OpenRouter Responses経路、`4d21a9ea`／`d231addc`、実provider probe）、Increment 57（`25325498`／`5fc5b962`）、
  Increment 56（`d71c026f`／`7cb653d7`）、Increment 55（`2e8ce3da`／`48eb4cd6`）、Increment 54
  （`40ce44a9`／`bbb82615`）、Increment 53（`a8ac6a85`／`ee3dbdf3`）、Increment 52（`1ee500ab`／`56276f49`）、
  Increment 51（`e709b100`／`0afad72c`）。architecture（`multi-provider-routing-and-auth.md`、
  `henji-host-agent-worker.md`）とroadmapはprovider一般化を反映済み。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: `openai-chat-completions`の新provider id（Chat Completions adapterのprovider-agnostic化）は未着手の後続。
  他候補はS2、S4、S5、A1、A2、A3、A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-61.md`、`docs/experience/normal-use-inbox.md`。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。同じresource IDには旧
  `2e00f40b…`もinactiveで残っている。宣言providerは`$XDG_CONFIG_HOME/henji-harness/providers/*.json`。
  reserved id（`openrouter`/`openai`）の再定義は拒否、新規idは`openai-responses` protocolのみ選択可能。
