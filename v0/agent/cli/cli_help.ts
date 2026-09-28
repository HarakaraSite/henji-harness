const activation =
  '--agent NAME | --definition-revision REF\n  --max-steps N --provider-timeout-ms MS --root-provider ID';
const target = '--new | --continue | --session ID | --no-session';

const help: Readonly<Record<string, string>> = {
  henji: `Usage: henji [TUI options] | COMMAND [options]

  tui          Connect a TUI; start the local Core when needed
  serve        Run the Core in the foreground without a UI
  core         Show or stop a Core
  run          Execute one task with a local headless Host
  history      Read saved history, locally or via --connect
  sessions     Manage local saved Sessions
  module       Manage local Agent Definitions
  tool         Manage local tool Definitions
  diagnostics  Read local diagnostics and runtime information
  webui        Reserved for the future WebUI; currently unavailable

No arguments is equivalent to henji tui.
TUI options: --connect URL; ${target};
  ${activation}
Use henji COMMAND --help for command usage.
--version displays this executable's build. --help displays usage.
`,
  tui: `Usage: henji tui [--connect URL] [${target}]
  ${activation}

Without --connect, discover or start the Core for this workspace.
With --connect, use only that URL. UI exit detaches; core stop shuts down.
`,
  serve: `Usage: henji serve [--host HOST] [--port PORT] [--json]
  [${target}]
  ${activation}

Run the Core without a UI or an implicit task. The default port is automatic.
An existing local Core is reused. When starting a new Core, an explicit target opens that Session.
`,
  core: `Usage: henji core status [--connect URL] [--json]
       henji core stop [--connect URL]

Status never starts a Core. Stop waits for Worker and process cleanup.
`,
  run: `Usage: henji run [--task TEXT] [--json | --stream]
  [--agent NAME | --definition-revision REF] [--max-steps N] [--provider-timeout-ms MS]

Without --task, read the task from stdin. Output is final text by default,
curated NDJSON with --json, or live assistant text with --stream.
`,
  history: `Usage: henji history [--connect URL] (--session ID-OR-PREFIX | --latest)
  [--view session | canonical | detail]

Read history without starting a task or activating a Session.
`,
  sessions: 'Usage: henji sessions list | delete --session ID --yes\n',
  module: 'Usage: henji module install | list | inspect | export | import [options]\n',
  tool:
    'Usage: henji tool install | list | active | inspect | activate | deactivate | uninstall [options]\n',
  diagnostics:
    'Usage: henji diagnostics runtime | list | latest | show | delete | executions [options]\n',
  webui: 'WebUI is not implemented.\n',
};

/** Match a complete help invocation before any startup or storage work. */
export const cliHelp = (args: readonly string[]): string | undefined => {
  if (args.length === 1 && args[0] === '--help') return help.henji;
  if (args.length === 2 && args[1] === '--help') return help[args[0]];
  if (
    args.length === 3 && args[0] === 'core' &&
    (args[1] === 'status' || args[1] === 'stop') && args[2] === '--help'
  ) {
    return help.core;
  }
  return undefined;
};
