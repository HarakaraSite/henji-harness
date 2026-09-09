# Agent source layout

`v0/agent` groups the active Agent implementation by responsibility:

- `core/`: provider-neutral messages, events, turn control, context, cancellation, and steering.
- `definitions/`: Agent definitions, selection, instructions, skills, identities, and resolved
  manifests.
- `provider/`: OpenRouter and OpenAI transports, route catalogs, credential access, and provider
  evidence.
- `tools/`: tool declarations, registries, components, and tool implementations including web
  search.
- `session/`: durable sessions, history, replay values, context checkpoints, and diagnostics.
- `runtime/`: direct evaluation composition and shared startup projection.
- `worker/`: production Host/Worker sessions, headless runner, protocol, bootstrap, physical
  bindings, and Worker fixtures.
- `cli/`: TypeScript command entrypoints.
- `validation/`: provider acceptance, the user-confirmed production CLI E2E, sentinels, fixtures,
  and runtime comparison utilities.

`worker_agent_api.ts` remains the public composition facade. The shell launchers stay at this
directory root because the installed `henji` command and operator workflows use those stable paths.
Terminal-specific implementation remains under `v0/tui`; the UI-neutral presentation contract and
adapter remain under `v0/presentation`.

Both production entrypoints use the same headless Worker capsule and Host commit path:

- `session_launcher.sh` starts the interactive terminal Surface and optionally persists a Session.
- `runtime_cli_launcher.sh` starts one noninteractive turn without persisting a Session transcript;
  diagnostics, provider evidence, and execution artifacts still use the workspace state root.

The interactive Session owns its active provider/model route and reasoning effort independently of
the Definition revision. The launcher defaults to OpenRouter; `--root-provider openai` starts a new
OpenAI Responses root using the fixed direct catalog and Platform API-key file. Delegated planner
calls and Sonar `web_search` keep independent OpenRouter routes and credentials. Session schema v4
persists provider, API, auth-profile identity, active selection, change history, and
per-committed-turn attribution; schema v1-v3 records remain readable and upgrade on the next commit.

`/provider` switches the root between OpenRouter and OpenAI in the current idle Session and applies
the selected provider's complete default model/effort selection. `/model` opens the active
provider's searchable repository-curated model list; choosing a model also selects that model's
curated default effort. `/effort` changes only the active provider/model's effort. These commands
are idle-only and take effect on the next root turn. OpenAI's initial direct catalog contains
`gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-6-astra`.

The interactive launcher accepts `--provider-timeout-ms N` for a positive safe-integer request
deadline. It defaults to 120,000 ms and applies to each root, delegated-planner, and context-
compaction model request in that Worker invocation. The value is not Session state, so a Session
switch keeps the invocation value and a later invocation returns to the default unless the flag is
supplied again. A reached deadline is reported as `provider deadline exceeded`; Henji does not
automatically retry or select another model. The TUI footer keeps transient status on row one and
cwd, the short Session ID, root provider, model, and effort on row two.

`validation/production_cli_e2e.ts` starts that production launcher only when invoked with the exact
`--confirm-external-call` argument. It retains an isolated workspace, child channels, provider
evidence, and the Worker execution artifact under `/tmp/henji-production-e2e-*`, then emits one JSON
report. The live task is intentionally absent from `v0:test`, `v0:gate`, and CI; its provider call
requires a separate user instruction for each invocation.
