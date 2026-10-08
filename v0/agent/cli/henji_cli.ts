import { cliErrorMessage, cliErrorText, parseCliOptions } from './cli_error.ts';
import { cliHelp } from './cli_help.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

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
    const { runTypescriptProcessEntry } = await import('../tools/run_typescript_process_entry.ts');
    return await runTypescriptProcessEntry(args[1], args[2]);
  }
  if (args.length === 1 && args[0] === '--internal-process-runner') {
    const { runProcessRunner } = await import('../runtime/process_runner.ts');
    await runProcessRunner();
    return 0;
  }
  if (args[0] === '--internal-core-bootstrap') {
    if (args.length !== 3 || args[1].length === 0 || args[2].length === 0) {
      return await writeInvalid('Invalid internal Core bootstrap arguments');
    }
    const { main: serveMain } = await import('./serve_cli.ts');
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
  if (args[0] === 'run') {
    const { runCliWorker } = await import('./run_worker_client.ts');
    return await runCliWorker(args.slice(1));
  }
  if (args[0] === 'serve') {
    const { main: serveMain } = await import('./serve_cli.ts');
    return await serveMain(args.slice(1));
  }
  if (args[0] === 'core') {
    const { main: coreMain } = await import('./core_cli.ts');
    return await coreMain(args.slice(1));
  }
  if (args[0] === 'tui') {
    const { main: tuiMain } = await import('./tui_cli.ts');
    return await tuiMain(args.slice(1));
  }
  if (args[0] === 'webui') {
    await Deno.stderr.write(encoder.encode(cliErrorText('webui', 'WebUI is not implemented.')));
    return 1;
  }
  if (args[0] === 'sessions') {
    const { main: sessionsMain } = await import('./session_cli.ts');
    return await sessionsMain(args.slice(1));
  }
  if (args[0] === 'history') {
    const { main: historyMain } = await import('./history_cli.ts');
    return await historyMain(args.slice(1));
  }
  if (args[0] === 'agent') {
    const { configurationMain } = await import('./configuration_cli.ts');
    return await configurationMain('agent', args.slice(1));
  }
  if (args[0] === 'tool') {
    const { configurationMain } = await import('./configuration_cli.ts');
    return await configurationMain('tool', args.slice(1));
  }
  if (args[0] === 'diagnostics') {
    if (args[1] === 'runtime') return await runtimeDiagnostics(args.slice(2));
    const { main: diagnosticsMain } = await import('./failure_diagnostic_cli.ts');
    return await diagnosticsMain(args.slice(1));
  }
  if (args.length === 0 || args[0].startsWith('--')) {
    const { main: tuiMain } = await import('./tui_cli.ts');
    return await tuiMain(args);
  }
  return await writeInvalid(
    `Unknown command '${args[0]}'.${
      args[0] === 'list' ? " To list Cores, use 'henji core list'." : ''
    }`,
  );
};

if (import.meta.main) Deno.exit(await main());
