import type { ProviderEvidenceV2 } from '../provider/provider_evidence.ts';
import {
  DenoProviderEvidenceStore,
  providerEvidencePaths,
} from '../provider/provider_evidence_store.ts';
import { sessionPaths } from '../session/session_store.ts';
import type { WorkerExecutionArtifactV2 } from '../worker/worker_execution_artifact.ts';
import {
  DenoWorkerExecutionArtifactStore,
  workerExecutionArtifactPaths,
} from '../worker/worker_execution_artifact_store.ts';
import {
  evaluateProductionCliE2e,
  preflightFailureReport,
  PRODUCTION_CLI_E2E_CHILD_DEADLINE_MS,
  PRODUCTION_CLI_E2E_CONFIRMATION,
  PRODUCTION_CLI_E2E_TASK,
  type ProductionCliE2eChildResult,
  type ProductionCliE2ePaths,
  type ProductionCliE2eReport,
} from './production_cli_e2e_contract.ts';

export const PRODUCTION_CLI_LAUNCHER = new URL('../../../dist/henji', import.meta.url).pathname;
export const PRODUCTION_CLI_E2E_PATH = '/usr/bin:/bin' as const;
const RUN_PARENT = '/tmp' as const;
const RUN_PREFIX = 'henji-production-e2e-' as const;

export interface ProductionCliCommandOptions {
  readonly args: readonly ['run'];
  readonly input: `${typeof PRODUCTION_CLI_E2E_TASK}\n`;
  readonly cwd: string;
  readonly clearEnv: true;
  readonly env: Readonly<{
    HOME: string;
    XDG_CONFIG_HOME: string;
    XDG_DATA_HOME: string;
    XDG_STATE_HOME: string;
    PATH: typeof PRODUCTION_CLI_E2E_PATH;
  }>;
  readonly stdin: 'piped';
  readonly stdout: 'piped';
  readonly stderr: 'piped';
}

export interface ProductionCliE2eDependencies {
  readonly nonce?: () => string;
  readonly runChild?: (
    command: typeof PRODUCTION_CLI_LAUNCHER,
    options: ProductionCliCommandOptions,
    deadlineMs: number,
  ) => Promise<ProductionCliE2eChildResult>;
  readonly listExecutions?: (
    stateRoot: string,
    workspaceRoot: string,
  ) => Promise<readonly WorkerExecutionArtifactV2[]>;
  readonly listEvidence?: (
    stateRoot: string,
    workspaceRoot: string,
  ) => Promise<readonly ProviderEvidenceV2[]>;
  readonly sessionTranscriptExists?: (
    stateRoot: string,
    workspaceRoot: string,
  ) => Promise<boolean>;
  readonly childDeadlineMs?: number;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const validateOwnedDirectory = async (path: string): Promise<void> => {
  const info = await Deno.lstat(path);
  const uid = Deno.uid();
  if (
    !info.isDirectory || info.isSymlink || info.uid !== uid || info.mode === null ||
    (info.mode & 0o7777) !== 0o700
  ) throw new Error(`invalid retained directory: ${path}`);
};

const createLayout = async (): Promise<ProductionCliE2ePaths> => {
  const runRoot = await Deno.makeTempDir({ dir: RUN_PARENT, prefix: RUN_PREFIX });
  await Deno.chmod(runRoot, 0o700);
  const workspaceRoot = `${runRoot}/workspace`;
  const stateBase = `${runRoot}/state`;
  await Deno.mkdir(workspaceRoot, { mode: 0o700 });
  await Deno.mkdir(stateBase, { mode: 0o700 });
  await validateOwnedDirectory(runRoot);
  await validateOwnedDirectory(workspaceRoot);
  await validateOwnedDirectory(stateBase);
  const stateRoot = `${stateBase}/henji-harness/v1`;
  const executionLayout = await workerExecutionArtifactPaths(stateRoot, workspaceRoot);
  const evidenceLayout = await providerEvidencePaths(stateRoot, workspaceRoot);
  return {
    runRoot,
    workspaceRoot,
    stateRoot,
    noncePath: `${workspaceRoot}/e2e-input.txt`,
    childStdoutPath: `${runRoot}/child-stdout.txt`,
    childStderrPath: `${runRoot}/child-stderr.txt`,
    executionsPath: executionLayout.executions,
    evidencePath: evidenceLayout.evidence,
  };
};

const delay = (milliseconds: number): Promise<'deadline'> =>
  new Promise((resolve) => setTimeout(() => resolve('deadline'), milliseconds));

const defaultRunChild = async (
  command: typeof PRODUCTION_CLI_LAUNCHER,
  options: ProductionCliCommandOptions,
  deadlineMs: number,
): Promise<ProductionCliE2eChildResult> => {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command, {
      args: [...options.args],
      cwd: options.cwd,
      clearEnv: options.clearEnv,
      env: { ...options.env },
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    }).spawn();
  } catch (error) {
    return {
      started: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      error: errorText(error),
    };
  }
  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.input));
    await writer.close();
  } catch (error) {
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may already have stopped after the failed input write.
    }
    const settled = await child.output();
    return {
      started: true,
      exitCode: settled.code,
      signal: settled.signal,
      timedOut: false,
      stdout: new TextDecoder('utf-8', { fatal: false }).decode(settled.stdout),
      stderr: new TextDecoder('utf-8', { fatal: false }).decode(settled.stderr),
      error: errorText(error),
    };
  }
  const output = child.output();
  const winner = await Promise.race([output, delay(deadlineMs)]);
  let timedOut = false;
  let settled: Deno.CommandOutput;
  if (winner === 'deadline') {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may have completed at the deadline boundary.
    }
    const terminated = await Promise.race([output, delay(1_000)]);
    if (terminated === 'deadline') {
      try {
        child.kill('SIGKILL');
      } catch {
        // The SIGTERM may already have completed.
      }
      settled = await output;
    } else settled = terminated;
  } else settled = winner;
  return {
    started: true,
    exitCode: settled.code,
    signal: settled.signal,
    timedOut,
    stdout: new TextDecoder('utf-8', { fatal: false }).decode(settled.stdout),
    stderr: new TextDecoder('utf-8', { fatal: false }).decode(settled.stderr),
  };
};

const defaultListExecutions = (
  stateRoot: string,
  workspaceRoot: string,
): Promise<readonly WorkerExecutionArtifactV2[]> =>
  new DenoWorkerExecutionArtifactStore(stateRoot, workspaceRoot).list();

const defaultListEvidence = (
  stateRoot: string,
  workspaceRoot: string,
): Promise<readonly ProviderEvidenceV2[]> =>
  new DenoProviderEvidenceStore(stateRoot, workspaceRoot).list();

const defaultSessionTranscriptExists = async (
  stateRoot: string,
  workspaceRoot: string,
): Promise<boolean> => {
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  try {
    await Deno.lstat(paths.sessions);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const writeReport = async (
  report: ProductionCliE2eReport,
  writer?: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  const line = `${JSON.stringify(report)}\n`;
  if (writer !== undefined) await writer(line);
  else await Deno.stdout.write(new TextEncoder().encode(line));
};

/** Run one explicitly confirmed production CLI E2E and retain every local observation. */
export const runProductionCliE2e = async (
  args: readonly string[],
  dependencies: ProductionCliE2eDependencies = {},
): Promise<ProductionCliE2eReport> => {
  if (args.length !== 1 || args[0] !== PRODUCTION_CLI_E2E_CONFIRMATION) {
    return preflightFailureReport('invalid_invocation');
  }
  let paths: ProductionCliE2ePaths;
  try {
    paths = await createLayout();
  } catch (error) {
    return preflightFailureReport('run_layout_failed', errorText(error));
  }
  const nonce = dependencies.nonce?.() ??
    `henji-e2e-${crypto.randomUUID().toLowerCase().replaceAll('-', '')}`;
  try {
    await Deno.writeTextFile(paths.noncePath, nonce, { mode: 0o600 });
  } catch (error) {
    return preflightFailureReport('run_layout_failed', errorText(error), paths);
  }
  const options: ProductionCliCommandOptions = {
    args: ['run'],
    input: `${PRODUCTION_CLI_E2E_TASK}\n`,
    cwd: paths.workspaceRoot,
    clearEnv: true,
    env: {
      HOME: Deno.env.get('HOME')!,
      XDG_CONFIG_HOME: `${Deno.env.get('HOME')!}/.config`,
      XDG_DATA_HOME: `${paths.runRoot}/data`,
      XDG_STATE_HOME: `${paths.runRoot}/state`,
      PATH: PRODUCTION_CLI_E2E_PATH,
    },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  };
  const runChild = dependencies.runChild ?? defaultRunChild;
  let child: ProductionCliE2eChildResult;
  try {
    child = await runChild(
      PRODUCTION_CLI_LAUNCHER,
      options,
      dependencies.childDeadlineMs ?? PRODUCTION_CLI_E2E_CHILD_DEADLINE_MS,
    );
  } catch (error) {
    child = {
      started: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      error: errorText(error),
    };
  }
  try {
    await Deno.writeTextFile(paths.childStdoutPath, child.stdout, { mode: 0o600 });
    await Deno.writeTextFile(paths.childStderrPath, child.stderr, { mode: 0o600 });
  } catch (error) {
    return preflightFailureReport('run_layout_failed', errorText(error), paths);
  }

  let executions: readonly WorkerExecutionArtifactV2[] | null = null;
  let executionReadError: string | undefined;
  try {
    executions = await (dependencies.listExecutions ?? defaultListExecutions)(
      paths.stateRoot,
      paths.workspaceRoot,
    );
  } catch (error) {
    executionReadError = errorText(error);
  }
  let evidence: readonly ProviderEvidenceV2[] | null = null;
  let evidenceReadError: string | undefined;
  try {
    evidence = await (dependencies.listEvidence ?? defaultListEvidence)(
      paths.stateRoot,
      paths.workspaceRoot,
    );
  } catch (error) {
    evidenceReadError = errorText(error);
  }
  let sessionTranscriptExists: boolean | null = null;
  try {
    sessionTranscriptExists = await (
      dependencies.sessionTranscriptExists ?? defaultSessionTranscriptExists
    )(paths.stateRoot, paths.workspaceRoot);
  } catch {
    sessionTranscriptExists = null;
  }
  return evaluateProductionCliE2e({
    paths,
    nonce,
    child,
    executions,
    ...(executionReadError === undefined ? {} : { executionReadError }),
    evidence,
    ...(evidenceReadError === undefined ? {} : { evidenceReadError }),
    sessionTranscriptExists,
  });
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: ProductionCliE2eDependencies = {},
): Promise<number> => {
  const report = await runProductionCliE2e(args, dependencies);
  await writeReport(report, dependencies.writeStdout);
  return report.ok ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
