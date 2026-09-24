# Henji Harness

English | [日本語](README.ja.md)

Henji Harness is a locally-run agent harness developed in Deno. From a single standalone
executable, it provides an interactive TUI and non-interactive runs, Session history,
switchable providers and models, and TypeScript Agent Definitions. The name Henji comes from
the Japanese word "henji" (返事), meaning "reply".

In the current Henji runtime, the Host handles the TUI and headless Surfaces, Worker
lifecycle, history stored in SQLite, and selection of the exact Agent Definition used by a
Session. The headless Agent Worker evaluates a built-in or installed trusted TypeScript
Definition and composes the current model, instructions, and tools. A parent Definition can
declare an `agent:<name>` catalog; the model can start a child in a separate Deno Worker and
separate Execution with `spawn_subagent`, and take in the child result with
`collect_subagent` (V1 fork/join). General Surface replacement, revision transitions of
durable AgentInstances, and context and loops composable from a Definition are not yet
implemented.

Long term, the goal is a self-revision workflow that creates revision candidates from actual
usage experience and has a human explicitly adopt them. This self-revision workflow is not
yet implemented.

## Development status

This is currently a 0.x development version, and breaking changes are frequent, including to
the CLI, storage formats, and the Agent Definition API. Migrations for existing Sessions and
Definitions, and compatibility reads of older formats, are sometimes not provided. When using
it, pin the version and check the changes before updating.

## Quick Start

The current checkout uses Deno 2.9.7. See the
[official installation guide](https://docs.deno.com/runtime/getting_started/installation/) for
how to install Deno.

```sh
git clone https://forge.harakara.site/littleisland/henji-harness.git
cd henji-harness
deno task --config deno.v0.json henji:compile
./dist/henji --version
```

Save the OpenRouter API key for the default provider in a file readable only by its owner.

```sh
henji_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness"
install -d -m 700 "$henji_config_dir"
install -m 600 /path/to/your/openrouter-api-key "$henji_config_dir/openrouter-api-key"
```

Start the TUI in the directory you want to work in. Type a prompt and press Enter to send it,
and use `/help` to see the commands.

```sh
cd /path/to/your/workspace
/path/to/henji-harness/dist/henji
```

Non-interactive runs and listing saved Sessions are also available from the same binary.

```sh
printf 'Summarize the README\n' | /path/to/henji-harness/dist/henji run
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace'
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace' --json
/path/to/henji-harness/dist/henji run --task 'Explain the structure of this workspace' --stream
/path/to/henji-harness/dist/henji sessions list
```

By default, `run` writes only the final text to stdout. `--json` writes the events during a
turn as one JSON per line (NDJSON, `{"v":1,"kind":...}`) to stdout, and emits a `result`
record at the end. `--stream` writes assistant text to stdout incrementally and a summary of
tool activity to stderr. `--json` and `--stream` are mutually exclusive. Unknown `kind`
values may be ignored. `--json` differs from `tool --json`, which returns a single object.

To use OpenAI direct, save the key as `openai-api-key` in the same config directory, and start
with `henji --root-provider openai-responses` for the Responses API or
`henji --root-provider openai-chat` for Chat Completions. For OpenRouter you can choose the
default `openrouter-chat` or `openrouter-responses`, which uses the same
`openrouter-api-key`. Data-only declarations in `providers/*.json` let you add other provider
IDs that speak a supported protocol.

## Main features available now

- TUI and headless `run`
- Switching of provider, model, and reasoning effort for OpenRouter (Chat Completions /
  Responses) and OpenAI direct
- Sessions, conversation history, and execution records (including failures and
  interruptions) stored in SQLite
- TUI commands such as `/new`, `/sessions`, `/history`, and `/recall`
- Install, versioned revisions, export/import, and execution of TypeScript Agent Definitions
- Install of the Henji base instruction, activate/deactivate of an exact revision, and
  runtime attribution
- Loading of `AGENTS.md` and of workspace/user-scoped Zot, Claude, and Agents-compatible
  Skills

You can check the runtime layout with `henji diagnostics runtime`, which does not display
credential values. By default it stores config in
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness`, managed data in
`${XDG_DATA_HOME:-$HOME/.local/share}/henji-harness`, and Session state in
`${XDG_STATE_HOME:-$HOME/.local/state}/henji-harness`.

## Agent Definition

Local TypeScript Agent Definitions are installed into managed data before execution.
Installed revisions are immutable, and you specify the exact revision at run time.

```sh
./dist/henji module install ./agent/entry.ts --id team/answer-agent
./dist/henji module list
./dist/henji --definition-revision team/answer-agent@sha256:<full-digest>
```

## Henji Instruction

The Henji common base instruction uses a minimal built-in core (the role identity and the
credential/Authorization boundary) by default. Detailed working policy is loaded simply by
placing it in the following user-scoped file (no install or activate needed).

```text
${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/instruction.md
```

If the file exists it replaces the built-in core, and if it does not exist the minimal core
is used. The content is treated byte-equivalently, without trimming, newline conversion, or
Unicode normalization, and is recorded in execution attribution as the source identity
(`user/instruction.md`) and a content digest. If the file cannot be read or its content is
invalid, it fails before the turn starts rather than silently falling back to the built-in.

A recommended template for detailed policy is in
[`docs/operations/base-instruction-template.md`](docs/operations/base-instruction-template.md).

For detailed design and implementation status, see the
[concept](docs/concepts/experience-driven-self-revision.md),
[architecture](docs/architecture/henji-host-agent-worker.md), and
[roadmap](docs/roadmap.md).

## JSR package

[`@henji/harness`](https://jsr.io/@henji/harness) exposes a composition API for building
TypeScript Agent Definitions. Native binaries are not distributed from JSR. To use the CLI,
build it from a repository checkout.

In 0.x, APIs and contracts may change incompatibly, so specify an exact version.

```sh
deno add --save-exact jsr:@henji/harness@0.5.0
```

```ts
import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from 'jsr:@henji/harness@0.5.0';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input);

export default definition;
```

`createPlannerAgentComposition` can likewise compose a planner Definition into a
root-runnable form with the same input boundary.

## Links

- [Source: Forgejo](https://forge.harakara.site/littleisland/henji-harness)
- [Package: JSR](https://jsr.io/@henji/harness)

## License

MIT
