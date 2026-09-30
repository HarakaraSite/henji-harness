# Local upstream reference snapshots

These files are pinned upstream planning references for the trusted-local Deno vertical slice. They
are not Henji Harness product source, dependencies, or implementation contracts. Compare the
smallest relevant mechanisms, cite the exact path and commit in the plan, and adopt behavior through
the repository's current approval process.

Only this README is tracked by Henji's Git repository. Snapshot source trees under `_refs/` are
ignored and kept locally; a fresh checkout does not include them. Retrieve the pinned upstream
commit below and apply the documented selection and `AGENTS.md` renaming when preparing a local
reference tree.

## Snapshots

Refreshed on 2026-10-01 from each upstream's default branch HEAD, then pinned to the commits below.
Pi, Zot, Deno Docs, OpenComputer, and both Cloudflare repositories use `main`; DeepSeek Harness uses
`master`; OpenCode uses `dev`. These are source snapshots, rather than latest-release selections.

| Local path | Upstream | Pinned commit | License | Intended comparison |
|---|---|---|---|---|
| `pi/` | <https://github.com/earendil-works/pi> | `b35af04f465d60c2f15d124ed074476b8986deb4` | MIT; see `pi/LICENSE` | Agent loop, provider abstraction, tool-call flow, extension boundaries, and runtime reload |
| `zot/` | <https://github.com/patriceckhart/zot> | `e5c9e04d01555b042050d26b670e622b35fe2642` | MIT; see `zot/LICENSE` | Lightweight harness structure, subprocess JSON-RPC extensions, extension lifecycle, and explicit extension opt-in |
| `deepseek-harness/` | <https://github.com/deepseek-ai/deepseek-harness> | `639ed015397290b3745d163aafe02ffee4aa3f84` | MIT; see `deepseek-harness/LICENSE` | Plugin composition, dynamic package definition and activation, immutable versions, effect cleanup, and session event sourcing |
| `deno-docs/examples/scripts/openai_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/openai_tool_use.ts> | `662a268a1585ed865f912a44f88e8f6f915a1a26` | MIT; see `deno-docs/LICENSE` | Minimal OpenAI tool-use loop in Deno |
| `deno-docs/examples/scripts/anthropic_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/anthropic_tool_use.ts> | `662a268a1585ed865f912a44f88e8f6f915a1a26` | MIT; see `deno-docs/LICENSE` | Minimal Anthropic tool-use loop in Deno |
| `opencomputer/` | <https://github.com/diggerhq/opencomputer> | `ee9f69e9eb7c7e6aede14b415dd38fcd0a5ae3b8` | Apache-2.0; see `opencomputer/LICENSE` | Limited comparison of the agent package and TypeScript SDK examples; infrastructure, web, and deployment trees are excluded |
| `cloudflare-agents/` | <https://github.com/cloudflare/agents> | `040458edb8f2c87a25e5ac446709054a5f553e14` | MIT; see `cloudflare-agents/LICENSE` | Chat turn concurrency, abort, resumable streaming, message persistence/recovery, and the future agent-tool boundary; Durable Objects infrastructure, MCP, frontend, deployment, voice, and email trees are excluded |
| `cloudflare-sandbox-sdk/` | <https://github.com/cloudflare/sandbox-sdk> | `f9e972a14123bef3b93e9bb337bab6e83419fe7e` | Apache-2.0; see `cloudflare-sandbox-sdk/packages/sandbox/LICENSE` | SDK 1.0 file operations and their shared helpers, public exports, package README/metadata, and the minimal example; Container command/lifecycle usage is visible in the example. Bucket mount/backup implementations, bridge, sites, Docker images, and unrelated examples are excluded |
| `opencode/` | <https://github.com/anomalyco/opencode> | `e9f8a210b9e2b1e13d375b84906069886eb3b767` | MIT; see `opencode/LICENSE` and package license notices | Coding-agent loop, Session/context handling, tools and subagents, CLI/TUI, provider integration, and client/server boundaries; the complete source tree is available as reference |

### Refresh notes

- The seven existing snapshots were refreshed and OpenCode was added. Upstream license files were
  checked and retained. No upstream behavior was adopted into Henji by this refresh.
- Cloudflare Sandbox SDK's default branch now contains SDK 1.0. Its former command/process clients,
  `sandbox.ts`, and `packages/shared/src/types.ts` no longer exist there. The current SDK delegates
  commands and lifecycle to the Container API; the selected file-operation sources and minimal
  example replace the old selection. See `cloudflare-sandbox-sdk/packages/sandbox/README.md`.
- Existing research and increment documents describe their recorded commits. Their comparisons were
  not rerun against these new snapshots; historical paths may have moved or disappeared. Use the
  recorded upstream commit when checking historical evidence, and cite the new commit for new work.

## Handling rules

- The snapshots contain no nested `.git` directories and do not track upstream automatically.
- Upstream `AGENTS.md` files are renamed to `AGENTS.upstream.md`. This is the only source-tree
  transformation and prevents reference material from becoming active Codex instructions.
- A refresh may update a snapshot when useful. Record the upstream URL, new pinned commit, applicable
  license, and a comparison of adopted behavior in this file and the relevant plan.
- Do not infer that a whole upstream architecture is adopted. Extract only relevant comparison
  evidence for the current plan.
- Preserve upstream license notices when reusing code. Prefer independent implementation from the
  observed contract unless copying is explicitly justified.
- A future refresh must be an explicit operation that records the new commit and rechecks licenses.
