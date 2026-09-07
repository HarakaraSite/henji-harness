# Agent source layout

`v0/agent` groups the active Agent implementation by responsibility:

- `core/`: provider-neutral messages, events, turn control, context, cancellation, and steering.
- `definitions/`: Agent definitions, selection, instructions, skills, identities, and resolved
  manifests.
- `provider/`: OpenRouter transport and profile, credential access, and provider evidence.
- `tools/`: tool declarations, registries, components, and tool implementations including web
  search.
- `session/`: durable sessions, history, replay values, context checkpoints, and diagnostics.
- `runtime/`: normal runtime composition and startup projection.
- `worker/`: Worker host/runtime protocol, bootstrap, physical bindings, and Worker fixtures.
- `cli/`: TypeScript command entrypoints.
- `validation/`: provider acceptance, sentinels, fixtures, and runtime comparison utilities.

`worker_agent_api.ts` remains the public composition facade. The shell launchers stay at this
directory root because the installed `henji` command and operator workflows use those stable paths.
Terminal-specific implementation remains under `v0/tui`; the UI-neutral presentation contract and
adapter remain under `v0/presentation`.
