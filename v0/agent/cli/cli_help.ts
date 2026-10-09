const activation =
  '--agent NAME | --agent-file FILE\n  --max-steps N --provider-timeout-ms MS --root-provider ID';
const target = '--new | --continue | --session ID | --no-session';

const help: Readonly<Record<string, string>> = {
  hjh: `Usage: hjh [TUI options] | COMMAND [options]

  tui          Connect a TUI; start a fresh local Core
  serve        Run the Core in the foreground without a UI
  core         List, show or stop a Core
  run          Execute one task with a local headless Host
  history      Read saved history, locally or via --connect
  sessions     Manage local saved Sessions
  agent        Select and inspect current JSON Agent settings
  tool         Select and inspect external tool folders
  diagnostics  Read local diagnostics and runtime information
  webui        Reserved for the future WebUI; currently unavailable

No arguments is equivalent to hjh tui.
TUI options: --core ID | --connect URL; ${target};
  ${activation}
Use hjh COMMAND --help for command usage.
--version displays this executable's build. --help displays usage.
`,
  tui: `Usage: hjh tui [--core ID | --connect URL] [${target}]
  ${activation}

Without a Core target, start a fresh Core and Session for this workspace.
With --core, select a live Core by full ID or unique prefix; --connect selects a URL.
Session options apply to that selected Core. /detach or Ctrl-D detaches; /quit or Ctrl-Q stops this Core and exits the TUI.
`,
  serve: `Usage: hjh serve [--host HOST] [--port PORT] [--json]
  [${target}]
  ${activation}

Run the Core without a UI or an implicit task. The default port is automatic.
Every invocation starts a fresh Core. An explicit target opens that Session.
`,
  core: `Usage: hjh core list [--json]
       hjh core status [--core ID | --connect URL] [--json]
       hjh core stop [--core ID | --connect URL]

List and status without a target show this workspace's Core collection.
Select a Core by full ID, unique prefix or URL. Queries never start a Core.
Stop without a target only lists Cores and instructions; it does not stop them.
Explicit stop waits for Worker and process cleanup.
`,
  run: `Usage: hjh run [--task TEXT] [--json | --stream]
  [--agent NAME | --agent-file FILE] [--max-steps N] [--provider-timeout-ms MS]

Without --task, read the task from stdin. Output is final text by default,
curated NDJSON with --json, or live assistant text with --stream.
`,
  history: `Usage: hjh history [--connect URL] (--session ID-OR-PREFIX | --latest)
  [--view session | canonical | detail]

Read history without starting a task or activating a Session.
`,
  sessions: 'Usage: hjh sessions list | delete --session ID --yes\n',
  agent:
    'Usage: hjh agent list | inspect [--name NAME | --file FILE]\n       hjh agent activate --file FILE [--name NAME] | deactivate [--name NAME]\n',
  tool:
    'Usage: hjh tool list | inspect --name NAME\n       hjh tool activate --name NAME --folder FOLDER | deactivate --name NAME\n',
  diagnostics: `Usage: hjh diagnostics runtime | list | latest
       hjh diagnostics show --id ID
       hjh diagnostics delete --id ID --yes
       hjh diagnostics executions list
       hjh diagnostics executions show | events | context --id ID
       hjh diagnostics executions request --id ID --ordinal N

ID is a full execution or diagnostic UUID. N is the physical request ordinal, starting at 1.
`,
  webui: 'WebUI is not implemented.\n',
};

/** Match a complete help invocation before any startup or storage work. */
export const cliHelp = (args: readonly string[]): string | undefined => {
  if (args.length === 1 && args[0] === '--help') return help.hjh;
  if (args.length === 2 && args[1] === '--help') return help[args[0]];
  const subcommands: Readonly<Record<string, readonly string[]>> = {
    core: ['list', 'status', 'stop'],
    sessions: ['list', 'delete'],
    agent: ['list', 'inspect', 'activate', 'deactivate'],
    tool: ['list', 'inspect', 'activate', 'deactivate'],
    diagnostics: ['runtime', 'list', 'latest', 'show', 'delete', 'executions'],
  };
  if (args.length === 3 && args[2] === '--help' && subcommands[args[0]]?.includes(args[1])) {
    return help[args[0]];
  }
  if (
    args.length === 4 && args[0] === 'diagnostics' && args[1] === 'executions' &&
    ['list', 'show', 'events', 'context', 'request'].includes(args[2]) && args[3] === '--help'
  ) {
    return help.diagnostics;
  }
  return undefined;
};
