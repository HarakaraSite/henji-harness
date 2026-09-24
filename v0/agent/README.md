# Agent source layout

`v0/agent` groups the active Agent implementation by responsibility:

- `core/`: provider-neutral messages, events, turn control, context, cancellation, and steering.
- `definitions/`: Agent definitions, selection, workspace instruction discovery, skills, identities,
  and resolved manifests.
- `instructions/`: the managed/built-in Henji base instruction, Worker-core finalizer, and named
  Definition contribution components; role text is kept under `instructions/roles/`.
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

`worker_agent_api.ts` remains the public composition facade. `cli/henji_cli.ts` is the one
production entry and `scripts/build_henji.ts` compiles it with the Worker bootstrap and built-in
Definitions. Terminal-specific implementation remains under `v0/tui`; the UI-neutral presentation
contract and adapter remain under `v0/presentation`.

The compiled command dispatches both Surfaces through the same headless Worker capsule and Host
commit path:

- `henji [TUI flags]` starts the interactive terminal Surface and optionally persists a Session.
- `henji run` starts one noninteractive turn without persisting a Session transcript; diagnostics,
  provider evidence, and execution artifacts still use the workspace state root. It prints
  final-only stdout by default, `--json` for a curated NDJSON event stream (`{"v":1,"kind":...}`,
  ending in a `result` record), or `--stream` for live assistant text on stdout and tool activity on
  stderr. `--json` and `--stream` are mutually exclusive; the CLI projection never exposes provider
  replay state or Host-internal durability/evidence ids.

The interactive Session owns its active provider/model route and reasoning effort independently of
the Definition revision. The launcher defaults to `openrouter-chat`; the other bundled ids are
`openrouter-responses`, `openai-chat`, and `openai-responses`. `--root-provider <provider-id>` uses
that provider's effective declaration and catalog. Data-only declarations under `providers/*.json`
can add ids using a binary-owned protocol adapter. The binary bundles only the default Agent Definition;
named children use installed external Definitions. Sonar `web_search` keeps an independent OpenRouter
route and credential. The current standalone-era Session record schema v6 persists provider, API,
auth-profile identity, active selection, change history, per-committed-turn attribution, and each
committed turn's logical built-in Definition ref and build manifest. Previous development schemas
remain in the old state namespace and are not interpreted by the compiled command.

The installation-wide `instruction:henji-base` slot starts from a minimal built-in core (agent role
and the credential/Authorization boundary). A user-scoped
`$XDG_CONFIG_HOME/henji-harness/instruction.md` file, when present, is read directly before each
Worker generation and replaces that core; there is no install or activation step. The Host passes
the selected source identity and exact bytes as a data-only core input, and the Worker-core
finalizer prepends that base once to root and async child Definition contributions.
Context history retains the source identity, content digest, exact text, and byte projection into
provider requests.

`/provider` switches the root among bundled and externally declared provider ids in the current idle
Session and applies the selected provider's complete default model/effort selection. `/model` opens
the active provider's searchable effective catalog; choosing a model also selects that model's
default effort. `/effort` changes only the active provider/model's effort. These commands are
idle-only and take effect on the next root turn. The bundled OpenAI catalog contains `gpt-5.6-sol`,
`gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-6-astra`.

The interactive launcher and `henji run` accept `--provider-timeout-ms N` for a positive
safe-integer request deadline. It defaults to 300,000 ms and applies to each root, async child,
and context-compaction model request in that Worker invocation. Both also accept `--max-steps N` to
override the root Agent's model-step limit; the built-in default Definition allows
128 steps when no override is supplied. Neither option is Session state, so a Session switch keeps
the TUI invocation values and a later invocation returns to the defaults unless the flags are
supplied again. A reached deadline is reported as `provider deadline exceeded`; Henji does not
automatically retry or select another model. The TUI footer keeps transient status on row one, the
cwd, short Session ID, and Session title on row two, and the root provider, model, and effort on row
three.

`validation/production_cli_e2e.ts` starts the compiled production command only when invoked with the
exact `--confirm-external-call` argument. It retains an isolated workspace, child channels, provider
evidence, and the Worker execution artifact under `/tmp/henji-production-e2e-*`, then emits one JSON
report. The live task is intentionally absent from `v0:test`, `v0:gate`, and CI; its provider call
requires a separate user instruction for each invocation.
