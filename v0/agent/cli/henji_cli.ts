import { cliErrorMessage, cliErrorText, parseCliOptions } from './cli_error.ts';
import { cliHelp } from './cli_help.ts';
import { runProcessRunner } from '../runtime/process_runner.ts';
import { runTypescriptProcessEntry } from '../tools/run_typescript_process_entry.ts';
import { main as tuiMain } from './tui_cli.ts';
import { runCliWorker } from './run_worker_client.ts';
import { main as sessionsMain } from './session_cli.ts';
import { main as historyMain } from './history_cli.ts';
import { main as diagnosticsMain } from './failure_diagnostic_cli.ts';
import { configurationMain } from './configuration_cli.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { main as serveMain } from './serve_cli.ts';
import { main as coreMain } from './core_cli.ts';

const encoder = new TextEncoder();

const writeStdout = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

const writeInvalid = async (message: string): Promise<number> => {
  await Deno.stderr.write(encoder.encode(cliErrorText('', message, true)));
  return 1;
};

const versionLine = (): string => {
  const manifest = buildManifest();
  return [
    `henji ${manifest.productVersion}`,
    `build=${manifest.buildId}`,
    `source=${manifest.sourceRevision}${manifest.sourceDirty ? '+dirty' : ''}`,
    `deno=${manifest.denoVersion}`,
    `target=${manifest.target}`,
    `runtime=${manifest.embeddedRuntimeSha256}`,
    `agent-config-schema=${manifest.agentConfigurationSchemaVersion}`,
    `tool-api=${manifest.supportedToolApiContracts.join(',')}`,
    `hook-api=${manifest.supportedHookApiContracts.join(',')}`,
  ].join(' ') + '\n';
};

const runtimeDiagnostics = async (args: readonly string[]): Promise<number> => {
  try {
    parseCliOptions(args, []);
    const paths = resolveRuntimePaths();
    await writeStdout(`${
      JSON.stringify({
        schemaVersion: 1,
        runtime: 'trusted-local',
        sandbox: 'no-hard-sandbox',
        build: buildManifest(),
        executable: paths.executable,
        workspace: paths.workspace,
        configRoot: paths.configRoot,
        dataRoot: paths.dataRoot,
        stateRoot: paths.stateRoot,
        credentialRoot: paths.credentialRoot,
      })
    }\n`);
    return 0;
  } catch (error) {
    await Deno.stderr.write(
      encoder.encode(cliErrorText('diagnostics', cliErrorMessage(error), true)),
    );
    return 1;
  }
};

/** Classify the complete CLI before a selected command touches workspace or durable state. */
export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  if (args.length === 3 && args[0] === '--internal-run-typescript') {
    return await runTypescriptProcessEntry(args[1], args[2]);
  }
  if (args.length === 1 && args[0] === '--internal-process-runner') {
    await runProcessRunner();
    return 0;
  }
  if (args[0] === '--internal-core-bootstrap') {
    if (args.length !== 3 || args[1].length === 0 || args[2].length === 0) {
      return await writeInvalid('Invalid internal Core bootstrap arguments');
    }
    return await serveMain([], { bootstrapToken: args[1], coreEpoch: args[2] });
  }
  if (args.length === 1 && args[0] === '--version') {
    await writeStdout(versionLine());
    return 0;
  }
  const help = cliHelp(args);
  if (help !== undefined) {
    await writeStdout(help);
    return 0;
  }
  if (args[0] === 'run') return await runCliWorker(args.slice(1));
  if (args[0] === 'serve') return await serveMain(args.slice(1));
  if (args[0] === 'core') return await coreMain(args.slice(1));
  if (args[0] === 'tui') return await tuiMain(args.slice(1));
  if (args[0] === 'webui') {
    await Deno.stderr.write(encoder.encode(cliErrorText('webui', 'WebUI is not implemented.')));
    return 1;
  }
  if (args[0] === 'sessions') return await sessionsMain(args.slice(1));
  if (args[0] === 'history') return await historyMain(args.slice(1));
  if (args[0] === 'agent') return await configurationMain('agent', args.slice(1));
  if (args[0] === 'tool') return await configurationMain('tool', args.slice(1));
  if (args[0] === 'diagnostics') {
    if (args[1] === 'runtime') return await runtimeDiagnostics(args.slice(2));
    return await diagnosticsMain(args.slice(1));
  }
  if (args.length === 0 || args[0].startsWith('--')) return await tuiMain(args);
  return await writeInvalid(
    `Unknown command '${args[0]}'.${
      args[0] === 'list' ? " To list Cores, use 'henji core list'." : ''
    }`,
  );
};

if (import.meta.main) Deno.exit(await main());
