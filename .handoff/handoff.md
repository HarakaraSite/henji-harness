# Handoff

## Records

### Increment 51〜64 — provider外部化（宣言・一般化・replay・既定・同梱default・chat provider）

- 状態: Increment 64は完了・配置済み。curated catalog/既定をコード定数から同梱default declarations
  （`v0/agent/provider/defaults/provider-defaults.json`、`provider_defaults.ts`）へ移し、`builtinProviderDeclarations()`
  が検証して返す。宣言で`openai-chat-completions` protocolの新provider（OpenAI互換Chat Completions）を追加でき、
  宣言endpoint/profileで`OpenRouterAgentModel`へ配線する。`OpenRouterAgentProfile.reasoningEffortField`で宣言chatは
  `reasoning_effort`を出力する。実装commit `e8c8ae98`。clean commitからbuild
  `8d164d9f66eedefdb1809d01dd43cd323e162889aa0c8aaa325d8c70d0adb53d`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換（両方SHA-256
  `e0642d4ccb57c71e2f6e1d55c3e1beaf74a0f45790f53898d578c165af7d1ff2`、source
  `e8c8ae98bd6f1feb93882d7f3b091b6f732c362f`、`sourceDirty=false`）。authoritative `v0:gate`通過（初回は
  `provider-defaults.json`整形のみで停止、修正後再実行で成功）。実probeで宣言`openai-chat`（endpoint
  `https://api.openai.com/v1`、`gpt-5.6-terra`）のtool turnが完走し、canonical commit・evidence api
  `openai-chat-completions`・endpoint `https://api.openai.com/v1/chat/completions`を確認した。
  前段: Increment 63（既定selection外部化とbuilt-in catalog override、`26743c62`／`b001b74e`）、Increment 62
  （replay scope、`5218618a`／`5d17d754`）、Increment 61（宣言provider一般化、`6a34bf07`／`4ef3d59b`）、
  Increment 59/60（provider宣言、`871cfb6c`／`e1814528`）、Increment 58（OpenRouter Responses、
  `4d21a9ea`／`d231addc`）、Increment 57（`25325498`／`5fc5b962`）、Increment 56（`d71c026f`／`7cb653d7`）、
  Increment 55（`2e8ce3da`／`48eb4cd6`）、Increment 54（`40ce44a9`／`bbb82615`）、Increment 53
  （`a8ac6a85`／`ee3dbdf3`）、Increment 52（`1ee500ab`／`56276f49`）、Increment 51（`e709b100`／`0afad72c`）。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
- 次: 完全外部化(c)の続き。Increment 65（planner default・`web_search`(Sonar)のrole別既定を宣言/設定化）、
  Increment 66（built-in id削除とSession影響、既定解決不能時の入力ブロック）。他候補はS2、S4、S5、A1、A2、A3、
  A5、A6、A7、R1〜R4。
- 正本: `docs/increments/increment-51.md`〜`increment-64.md`、`docs/experience/normal-use-inbox.md`、
  `docs/roadmap.md`のProvider外部化節。
- 注意: active external revisionは`local/henji-base@sha256:82d67dd2…`。宣言providerは
  `$XDG_CONFIG_HOME/henji-harness/providers/*.json`、既定selectionは同`default-selection.json`。
  `openrouter`/`openai`/`openrouter-responses`はcatalog/defaultsのみoverride可能。新規idは`openai-responses`と
  `openai-chat-completions`の両protocolを選択可能。adapterはbinary-owned、protocolは固定enum。OpenAI Chat
  Completionsは`gpt-5.6-terra`でfunction toolsと`reasoning_effort`の併用を受け付けない（`/v1/responses`か
  `reasoning_effort:'none'`）。
