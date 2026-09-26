import { runProcessRunner } from '../runtime/process_runner.ts';
import { main as tuiMain } from './tui_cli.ts';
import { main as runMain } from './runtime_cli.ts';
import { main as sessionsMain } from './session_cli.ts';
import { main as historyMain } from './history_cli.ts';
import { main as diagnosticsMain } from './failure_diagnostic_cli.ts';
import { main as moduleMain } from './module_cli.ts';
import { main as toolMain } from './tool_cli.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();

const writeStdout = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

const writeInvalid = async (): Promise<number> => {
  await Deno.stderr.write(encoder.encode(
    `${
      JSON.stringify({
        ok: false,
        error: { code: 'invalid_invocation', message: 'invalid invocation' },
      })
    }\n`,
  ));
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
    `definition-api=${manifest.supportedAgentDefinitionApiContracts.join(',')}`,
    `tool-definition-api=${manifest.supportedToolDefinitionApiContracts.join(',')}`,
  ].join(' ') + '\n';
};

const runtimeDiagnostics = async (): Promise<number> => {
  try {
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
      })
    }\n`);
    return 0;
  } catch {
    return await writeInvalid();
  }
};

/** Classify the complete CLI before a selected command touches workspace or durable state. */
export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  if (args.length === 1 && args[0] === '--internal-process-runner') {
    await runProcessRunner();
    return 0;
  }
  if (args.length === 1 && args[0] === '--version') {
    await writeStdout(versionLine());
    return 0;
  }
  if (args[0] === 'run') return await runMain(args.slice(1));
  if (args[0] === 'sessions') return await sessionsMain(args.slice(1));
  if (args[0] === 'history') return await historyMain(args.slice(1));
  if (args[0] === 'module') return await moduleMain(args.slice(1));
  if (args[0] === 'tool') return await toolMain(args.slice(1));
  if (args[0] === 'diagnostics') {
    if (args.length === 2 && args[1] === 'runtime') return await runtimeDiagnostics();
    return await diagnosticsMain(args.slice(1));
  }
  if (args.length === 0 || args[0].startsWith('--')) return await tuiMain(args);
  return await writeInvalid();
};

if (import.meta.main) Deno.exit(await main());
