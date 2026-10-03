const activation =
  '--agent NAME | --agent-file FILE\n  --max-steps N --provider-timeout-ms MS --root-provider ID';
const target = '--new | --continue | --session ID | --no-session';

const help: Readonly<Record<string, string>> = {
  henji: `Usage: henji [TUI options] | COMMAND [options]

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

No arguments is equivalent to henji tui.
TUI options: --core ID | --connect URL; ${target};
  ${activation}
Use henji COMMAND --help for command usage.
--version displays this executable's build. --help displays usage.
`,
  tui: `Usage: henji tui [--core ID | --connect URL] [${target}]
  ${activation}

Without a Core target, start a fresh Core and Session for this workspace.
With --core, select a live Core by full ID or unique prefix; --connect selects a URL.
Session options apply to that selected Core. /detach or Ctrl-D detaches; /quit or Ctrl-Q stops this Core and exits the TUI.
`,
  serve: `Usage: henji serve [--host HOST] [--port PORT] [--json]
  [${target}]
  ${activation}

Run the Core without a UI or an implicit task. The default port is automatic.
Every invocation starts a fresh Core. An explicit target opens that Session.
`,
  core: `Usage: henji core list [--json]
       henji core status [--core ID | --connect URL] [--json]
       henji core stop [--core ID | --connect URL]

List and status without a target show this workspace's Core collection.
Select a Core by full ID, unique prefix or URL. Queries never start a Core.
Stop without a target only lists Cores and instructions; it does not stop them.
Explicit stop waits for Worker and process cleanup.
`,
  run: `Usage: henji run [--task TEXT] [--json | --stream]
  [--agent NAME | --agent-file FILE] [--max-steps N] [--provider-timeout-ms MS]

Without --task, read the task from stdin. Output is final text by default,
curated NDJSON with --json, or live assistant text with --stream.
`,
  history: `Usage: henji history [--connect URL] (--session ID-OR-PREFIX | --latest)
  [--view session | canonical | detail]

Read history without starting a task or activating a Session.
`,
  sessions: 'Usage: henji sessions list | delete --session ID --yes\n',
  agent:
    'Usage: henji agent list | inspect [--name NAME | --file FILE]\n       henji agent activate --file FILE [--name NAME] | deactivate [--name NAME]\n',
  tool:
    'Usage: henji tool list | inspect --name NAME\n       henji tool activate --name NAME --folder FOLDER | deactivate --name NAME\n',
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
