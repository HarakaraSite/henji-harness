# Henji Harness

English | [日本語](README.ja.md)

Henji Harness is a locally-run agent harness developed in Deno. From a single standalone executable,
it provides an interactive TUI and non-interactive runs, Session history, switchable providers and
models, JSON Agent configuration, and folder-based tools. The name Henji comes from the Japanese
word "henji" (返事), meaning "reply".

In the current Henji runtime, the Host handles the TUI and headless Surfaces, Worker lifecycle,
history stored in SQLite, and selection of the current JSON Agent configuration for a Session. The
headless Agent Worker composes the selected configuration with the current model, common
instructions, and concrete tools. An Agent can name child Agents in its `agents` list; the model can
start a child in a separate Deno Worker and separate Execution with `spawn_subagent`, and take in
the child result with `collect_subagent` (V1 fork/join). General Surface replacement and durable
AgentInstance revision transitions are not yet implemented.

Long term, the goal is a self-revision workflow that creates revision candidates from actual usage
experience and has a human explicitly adopt them. This self-revision workflow is not yet
implemented.

## Development status

This is currently a 0.x development version, and breaking changes are frequent, including to the
CLI, storage formats, and configuration contracts. Existing Session and configuration formats are
not automatically migrated. When using it, pin the version and check the changes before updating.

## Quick Start

The current checkout uses Deno 2.9.7. See the
[official installation guide](https://docs.deno.com/runtime/getting_started/installation/) for how
to install Deno.

```sh
git clone https://forge.harakara.site/littleisland/henji-harness.git
cd henji-harness
deno task --config deno.v0.json henji:compile
./dist/henji --version
deno task --config deno.v0.json henji:package
# Run install.sh in the package directory printed by the command above.
```

The package includes editable `search`, `git_inspect`, `web_search`, and `web_fetch` tool folders
and the `runtime-start-time` hook. Run its `install.sh` to install the binary, register the tools,
and enable the default hook. Local search prefers rg and uses grep when rg is unavailable, and
`git_inspect` inspects the workspace repository read-only. Existing external source edits are
retained unless the corresponding `--replace-tools` or `--replace-hooks` option is specified. See
the [package instructions](external-tools/README.md) for installation options.

Use `henji --help` and `henji COMMAND --help` to see the available commands and options.

Save the OpenRouter API key for the default provider in a file readable only by its owner.
Credential values live in the credential root under the state directory, not in the config root.

```sh
henji_credential_dir="${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1/credentials"
install -d -m 700 "$henji_credential_dir"
install -m 600 /path/to/your/openrouter-api-key "$henji_credential_dir/openrouter-api-key"
```

You can also register provider and service credentials from the TUI with `/login`; they are saved to
the same credential files. ChatGPT sign-in is part of this list, and its credentials (including the
tokens under `chatgpt/`) are saved in the same credential root. Exa is included in this list for
`web_search`.

External tools can add service registration metadata in `$henji_config_dir/credentials/*.json`. The
declarations are non-secret; values are stored in the credential root. For example, a Brave tool can
declare:

```json
{
  "schemaVersion": 1,
  "authProfile": "brave-api-key",
  "label": "Brave — API key",
  "purpose": "Web search",
  "method": "api-key",
  "consumers": ["tool:brave_search"]
}
```

These declarations contain display metadata, not key values. Restart the Core after changing
declarations, then use `/login` to save or update the key. Entries sharing an `authProfile` use one
registration and one credential file. Service entries do not appear in the model provider list.

External tools use `requestProvider` with the declared `authProfile`. Authentication defaults to
Bearer; a service such as Brave can set
`authentication: { kind: 'header', name: 'X-Subscription-Token' }` on its request. The dispatcher
resolves and inserts the key, so the tool factory never receives it. This declaration registers a
credential; the external tool supplies the service's request behavior.

Start the TUI in the directory you want to work in. Type a prompt and press Enter to send it, and
use `/help` to see the commands.

```sh
cd /path/to/your/workspace
/path/to/henji-harness/dist/henji
```

Non-interactive runs, listing saved Sessions, and reading saved history are also available from the
same binary.

```sh
printf 'Summarize the README\n' | /path/to/henji-harness/dist/henji run
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace'
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace' --json
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace' --stream
/path/to/henji-harness/dist/henji sessions list
/path/to/henji-harness/dist/henji history --latest
```

By default `run` writes only the final text to stdout. `--json` writes the turn's events as one JSON
object per line (NDJSON, `{"v":1,"kind":...}`) to stdout and ends with a `result` record. `--stream`
writes assistant text incrementally to stdout and a summary of tool activity to stderr. `--json` and
`--stream` are mutually exclusive. Unknown `kind` values may be ignored. `--json` differs from
`tool --json`, which returns a single object.

Non-TTY callers pass the task on stdin; `--task` is available from a TTY.

```sh
printf 'Explain the structure of this workspace\n' | /path/to/henji-harness/dist/henji run --json
```

Switch provider with `/provider`, model with `/model`, and reasoning effort with `/effort`. To use
OpenAI direct, save the key as `openai-api-key` in the same credential root, and start with
`henji --root-provider openai-responses` for the Responses API. Register ChatGPT with `/login`
sign-in and select `openai-chatgpt`. For OpenRouter you can choose the default `openrouter-chat` or
`openrouter-responses`, which uses the same `openrouter-api-key`. Data-only declarations in
`providers/*.json` let you add other provider IDs that speak a supported protocol.

## CLI commands

`henji --help` lists the following commands.

- `henji tui` — connect a TUI; the same as `henji` with no arguments, starting a fresh Core when
  there is no target
- `henji serve` — run a Core in the foreground without a UI
- `henji core list | status | stop` — list, inspect, or stop this workspace's Cores
- `henji run` — execute one task with a local headless Host
- `henji history` — read saved history locally or via `--connect URL`
- `henji sessions list | delete --session ID --yes` — manage saved Sessions
- `henji agent list | inspect | activate | deactivate` — select and inspect current JSON Agent
  settings
- `henji tool list | inspect | activate | deactivate` — select and inspect external tool folders
- `henji diagnostics runtime | list | latest | show | delete | executions` — read the runtime layout
  and diagnostics
- `henji webui` — reserved for the future WebUI; currently unavailable

`tui`, `serve`, and `run` also accept `--agent NAME` or `--agent-file FILE`, `--max-steps N`,
`--provider-timeout-ms MS`, and `--root-provider ID`.

## Parallel Cores and explicit reconnect

Each `henji` or `henji tui` invocation starts a fresh Core and Session, even in the same workspace.
Independent work can proceed in parallel in two terminals, identified by the Core ID and Session ID
shown on screen. `henji serve` starts a fresh foreground Core without opening a Session unless
requested. Cores share workspace history, config, and credentials; each Core owns its active
Session, child Agents, and tools. `henji run` keeps a headless entry separate from HTTP Cores.

```sh
henji core list
henji --core <core-id-or-unique-prefix>
henji --core <core-id> --new
henji --session <saved-session-id>
henji core status --core <core-id> --json
henji core stop --core <core-id>
```

The TUI header shows both Core and Session IDs. `/detach` or Ctrl-D detaches the TUI and leaves
accepted work running. `/quit` or Ctrl-Q stops the attached Core, including active work, and exits
this TUI after resource cleanup. Type `/` followed by a letter for command suggestions; Tab
completes a single match. Reconnect by Core ID or `--connect URL`; `--session` without a Core target
resumes saved work in a fresh Core. `core stop` without a target lists Cores and instructions. See
[HTTP operations](docs/operations/http-api.md) for connection and Session details.

## Main features available now

- TUI and headless `run`
- Switching of provider, model, and reasoning effort for OpenRouter (Chat Completions / Responses),
  OpenAI direct (Responses / Chat Completions), and ChatGPT sign-in, with live provider model lists
  and favorites
- Sessions, conversation history, and execution records (including failures and interruptions)
  stored in SQLite
- TUI commands such as `/new`, `/sessions`, `/view`, `/resume`, `/context`, `/rename`, `/recall`,
  `/provider`, `/model`, `/effort`, `/login`, `/detach`, and `/quit`
- JSON Agent configuration with current-file selection, and child Agents named in the `agents` list
- Folder-based TypeScript tools with a JSON metadata file and local imports, plus Agent and tool
  configuration management from the CLI
- Loading of the Henji base instruction from a user file, and runtime attribution
- Loading of `AGENTS.md` and of workspace/user-scoped Zot, Claude, and Agents-compatible Skills

You can check the runtime layout with `henji diagnostics runtime`, which does not display credential
values. By default it stores config in `${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness`, managed
data in `${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`, Session state in
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1`, and credential values in
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness/v1/credentials`.

## Agent configuration and tools

Agent behavior lives in JSON files under the Henji config directory. `agents.json` can select a
current default file and map named Agents to their current files:

```json
{
  "schemaVersion": 1,
  "default": "agents/my-root.json",
  "agents": { "reviewer": "agents/reviewer.json" }
}
```

An Agent JSON file contains its `name`, optional `revision`, `instruction`, `tools`, and `agents`.
The bundled default is used when no default file is selected. Omitting the Agent choice selects the
root default; an explicit name selects that named catalog entry, including a named `default`. The
`generic` child uses the bundled configuration with its own name and does not inherit a named
Agent's instruction. Configuration files are read again when a new Worker starts, so edits apply to
newly started work.

The bundled default and generic Agents select six standard work tools: `read`, `write`, `edit`,
`bash`, `bash_output`, and `run_typescript`. Explicit Agent `tools` lists must include
`run_typescript` to use it; an empty list remains empty.

`run_typescript` runs the body of an async TypeScript function with the Deno runtime embedded in
Henji. Each call runs in a child process of the same Henji binary. Cancellation stops and settles
that process, including synchronous computation, before the next task continues. `input` is optional
JSON (default `null`); `workspace` is the absolute workspace root. Read/write access covers the
workspace and `/tmp`, and code can access the network. Environment, subprocess, system and FFI
permissions are disabled inside the code Worker. Return a JSON value; omitting `return` produces
`null`. Use `await import()` to acquire Deno std and its dependencies at runtime, without installing
an external Deno CLI or bundling std at build time. Imports accept only `jsr:@std/...` and
`https://jsr.io/@std/...` sources, including their std dependencies. Other packages, Node built-ins,
local file modules and additional Workers are unavailable. Ordinary `fetch()` and JavaScript
`eval()` remain available.

For example, the tool arguments below parse CSV input and save the result. The code begins with the
one-line purpose comment that the tool row shows:

```json
{
  "code": "// Parse the CSV input and save the rows\nconst csv = await import('jsr:@std/csv'); const rows = csv.parse(input, { skipFirstRow: true }); await Deno.writeTextFile(workspace + '/rows.json', JSON.stringify(rows)); return rows;",
  "input": "name,value\na,42\n"
}
```

```sh
henji agent list
henji agent inspect --name reviewer
henji agent activate --file agents/reviewer.json --name reviewer
henji agent deactivate --name reviewer
```

`tools.json` maps tool names to folders. Each folder contains `tool.json` with the matching name, an
arbitrary revision label, API contract `henji-tool/v1`, and an entry module:

```json
{ "schemaVersion": 1, "tools": { "marker": "tools/marker" } }
```

```json
{ "name": "marker", "revision": "local-1", "apiContract": "henji-tool/v1", "entry": "index.ts" }
```

The entry module's default export is a tool factory. It runs once at Worker startup and may import
other files in its folder. A folder mapping for an Agent's selected tool replaces the bundled
implementation of that name.

```sh
henji tool list
henji tool inspect --name marker
henji tool activate --name marker --folder tools/marker
henji tool deactivate --name marker
```

## External hooks

The package installs `hooks.json` with `runtime-start-time` as the default hook. It adds the Worker
start time, timezone, and UTC offset to the Agent's shared context; each new Worker records its own
start time. Edit the TypeScript source under
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/hooks/runtime-start-time/`. A new Worker loads the
edit; a Worker that is already running keeps its loaded hook.

`hooks.json` selects the common defaults and maps hook names to TypeScript entry files. An Agent
JSON can omit `hooks` to use those defaults, provide an ordered list to replace them, or use an
empty list to disable external hooks:

```json
{
  "schemaVersion": 1,
  "default": ["runtime-start-time"],
  "hooks": {
    "runtime-start-time": "hooks/runtime-start-time/index.ts"
  }
}
```

To select a different hook for one Agent, add `"hooks": ["my-hook"]` to that Agent's JSON and map
`my-hook` in the common catalog. Reinstalling retains both hook source edits and the catalog;
`./install.sh --replace-hooks` replaces packaged hook files while preserving the catalog. The
installer does not edit Agent JSON. See
[hook package instructions](external-tools/README.md#runtime-hooks).

The runtime uses a new `history.sqlite3` database. It does not migrate the prior history database;
existing files are left available to the user.

## Henji Instruction

The Henji common base instruction uses a minimal built-in core (the role identity and the
credential/Authorization boundary) by default. Detailed working policy is loaded simply by placing
it in the following user-scoped file (no install or activate needed).

```text
${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/instruction.md
```

If the file exists it replaces the built-in core, and if it does not exist the minimal core is used.
The content is treated byte-equivalently, without trimming, newline conversion, or Unicode
normalization, and is recorded in execution attribution as the source identity
(`user/instruction.md`) and a content digest. If the file cannot be read or its content is invalid,
it fails before the turn starts rather than silently falling back to the built-in.

A recommended template for detailed policy is in
[`docs/operations/base-instruction-template.md`](docs/operations/base-instruction-template.md).

For detailed design and implementation status, see the
[concept](docs/concepts/experience-driven-self-revision.md),
[architecture](docs/architecture/henji-host-agent-worker.md), and [roadmap](docs/roadmap.md).

## JSR package

[`@henji/harness`](https://jsr.io/@henji/harness) exposes the TypeScript tool factory API. Native
binaries are not distributed from JSR. To use the CLI, build it from a repository checkout.

The `jsr:@henji/harness@0.11.0/hooks` entrypoint exposes `HookFactory` and the hook lifecycle
contract.

In 0.x, APIs and contracts may change incompatibly, so specify an exact version.

```sh
deno add --save-exact jsr:@henji/harness@0.11.0
```

```ts
import type { ToolFactory } from 'jsr:@henji/harness@0.11.0';

const marker: ToolFactory = ({ workspace }) => ({
  name: 'marker',
  fileAccess: 'none',
  description: `Mark files in ${workspace.root}`,
  inputSchema: { type: 'object' },
  execute: () => 'ok',
});

export default marker;
```

Import `ToolFactory` or `ToolFactoryInput` from `jsr:@henji/harness@0.11.0`. The standalone binary
bundles its default Agent and core tools. `search`, `git_inspect`, `web_search`, and `web_fetch` are
supplied as editable folders in the package and registered by its installer. Named Agent and tool
files are selected from the config directory.

## Links

- [Source: Forgejo](https://forge.harakara.site/littleisland/henji-harness)
- [Package: JSR](https://jsr.io/@henji/harness)

## License

MIT
