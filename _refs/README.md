# Local upstream reference snapshots

These files are pinned upstream planning references for the trusted-local Deno vertical slice. They
are not Henji Harness product source, dependencies, or implementation contracts. Compare the
smallest relevant mechanisms, cite the exact path and commit in the plan, and adopt behavior through
the repository's current approval process.

## Snapshots

| Local path | Upstream | Pinned commit | License | Intended comparison |
|---|---|---|---|---|
| `pi/` | <https://github.com/earendil-works/pi> | `08dc60bc52d89d6823a9738cc90b1916e5e446e5` | MIT; see `pi/LICENSE` | Agent loop, provider abstraction, tool-call flow, extension boundaries, and runtime reload |
| `zot/` | <https://github.com/patriceckhart/zot> | `f60e492e551892e737d24a7eaf7730f1f60b75af` | MIT; see `zot/LICENSE` | Lightweight harness structure, subprocess JSON-RPC extensions, extension lifecycle, and explicit extension opt-in |
| `deepseek-harness/` | <https://github.com/deepseek-ai/deepseek-harness> | `c291e7961a515f6d7af9304e7fd1d257929aef26` | MIT; see `deepseek-harness/LICENSE` | Plugin composition, dynamic package definition and activation, immutable versions, effect cleanup, and session event sourcing |
| `deno-docs/examples/scripts/openai_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/openai_tool_use.ts> | `eb8f78e90dbc72f3b3ab7dcd85609622379b5bca` | MIT; see `deno-docs/LICENSE` | Minimal OpenAI tool-use loop in Deno |
| `deno-docs/examples/scripts/anthropic_tool_use.ts` | <https://github.com/denoland/docs/blob/main/examples/scripts/anthropic_tool_use.ts> | `eb8f78e90dbc72f3b3ab7dcd85609622379b5bca` | MIT; see `deno-docs/LICENSE` | Minimal Anthropic tool-use loop in Deno |
| `opencomputer/` | <https://github.com/diggerhq/opencomputer> | `d54f2c239a293216ff13f069ffc1ed7b853f9761` | Apache-2.0; see `opencomputer/LICENSE` | Limited comparison of the agent package and TypeScript SDK examples; infrastructure, web, and deployment trees are excluded |
| `cloudflare-agents/` | <https://github.com/cloudflare/agents> | `2f957bc2a3ffb7aee14792bb3cb658ad3176ed93` | MIT; see `cloudflare-agents/LICENSE` | Chat turn concurrency, abort, resumable streaming, message persistence/recovery, and the future agent-tool boundary; Durable Objects infrastructure, MCP, frontend, deployment, voice, and email trees are excluded |
| `cloudflare-sandbox-sdk/` | <https://github.com/cloudflare/sandbox-sdk> | `664d8e36d22f2b8f286a9cac90551113afdb316c` | Apache-2.0; see `cloudflare-sandbox-sdk/packages/sandbox/LICENSE` | Named sandbox identity/reuse plus command, file, process, stream, and cancellation boundaries; bridge, sites, documentation, Docker images, and unrelated examples are excluded |

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
