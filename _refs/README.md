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

Pi, Zot, and OpenCode were refreshed on 2026-10-07 from their upstream default branch HEADs, then
pinned to the commits below. The other snapshots retain their 2026-10-02 revisions.
Pi, Zot, Deno Docs, OpenComputer, and both Cloudflare repositories use `main`; DeepSeek Harness uses
`master`; OpenCode uses `dev`. These are source snapshots, rather than latest-release selections.

| Local path | Upstream | Pinned commit | License | Intended comparison |
|---|---|---|---|---|
| `pi/` | <https://github.com/earendil-works/pi> | `b30a6dd779340f7bc2f3ffa60f4c0a5f914ba9ae` | MIT; see `pi/LICENSE` | Agent loop, provider abstraction, tool-call flow, extension boundaries, and runtime reload |
| `zot/` | <https://github.com/patriceckhart/zot> | `d1e278ee2400cc686983c9b1f7949bd905501e39` | MIT; see `zot/LICENSE` | Lightweight harness structure, subprocess JSON-RPC extensions, extension lifecycle, and explicit extension opt-in |
| `deepseek-harness/` | <https://github.com/deepseek-ai/deepseek-harness> | `639ed015397290b3745d163aafe02ffee4aa3f84` | MIT; see `deepseek-harness/LICENSE` | Plugin composition, dynamic package definition and activation, immutable versions, effect cleanup, and session event sourcing |
| `deno-docs/examples/scripts/openai_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/openai_tool_use.ts> | `9e5dd8d930c8734defe1c3172986e6312353ac1c` | MIT; see `deno-docs/LICENSE` | Minimal OpenAI tool-use loop in Deno |
| `deno-docs/examples/scripts/anthropic_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/anthropic_tool_use.ts> | `9e5dd8d930c8734defe1c3172986e6312353ac1c` | MIT; see `deno-docs/LICENSE` | Minimal Anthropic tool-use loop in Deno |
| `opencomputer/` | <https://github.com/diggerhq/opencomputer> | `968c1d4d5e02e430b05481421a1c74536304f7bc` | Apache-2.0; see `opencomputer/LICENSE` | Limited comparison of the agent package and TypeScript SDK examples; infrastructure, web, and deployment trees are excluded |
| `cloudflare-agents/` | <https://github.com/cloudflare/agents> | `23033f77936aa35393a41f44bbcd3ee14ba5a2c0` | MIT; see `cloudflare-agents/LICENSE` | Chat turn concurrency, abort, resumable streaming, message persistence/recovery, and the future agent-tool boundary; Durable Objects infrastructure, MCP, frontend, deployment, voice, and email trees are excluded |
| `cloudflare-sandbox-sdk/` | <https://github.com/cloudflare/sandbox-sdk> | `f9e972a14123bef3b93e9bb337bab6e83419fe7e` | Apache-2.0; see `cloudflare-sandbox-sdk/packages/sandbox/LICENSE` | SDK 1.0 file operations and their shared helpers, public exports, package README/metadata, and the minimal example; Container command/lifecycle usage is visible in the example. Bucket mount/backup implementations, bridge, sites, Docker images, and unrelated examples are excluded |
| `opencode/` | <https://github.com/anomalyco/opencode> | `ecc4916b5a9608c30e6dd58a67f2137b594407ca` | MIT; see `opencode/LICENSE` and package license notices | Coding-agent loop, Session/context handling, tools and subagents, CLI/TUI, provider integration, and client/server boundaries; the complete source tree is available as reference |

### Refresh notes

- On 2026-10-07, Pi, Zot, and OpenCode were updated for the requested feature comparison. Each full
  source archive was fetched at its exact commit, root MIT licenses were rechecked, and all upstream
  `AGENTS.md` files were renamed to `AGENTS.upstream.md`. Installed files, modes, and symlinks were
  checked against the prepared snapshots; the previous local trees were preserved in `/tmp`.
  No upstream behavior was adopted into Henji by this refresh.
- Upstream commit timestamps (UTC): Pi `2026-10-07T10:26:43Z`, Zot `2026-10-06T07:55:15Z`,
  OpenCode `2026-10-06T22:32:45Z`. Selection is default-branch source, not latest release.
- The other snapshots were last checked on 2026-10-02. At that time, Deno Docs, OpenComputer, and
  Cloudflare Agents were updated; DeepSeek Harness and Cloudflare Sandbox SDK were already at their
  latest default-branch HEADs.
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
