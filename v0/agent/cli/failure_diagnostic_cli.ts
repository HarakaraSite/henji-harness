import {
  DenoFailureDiagnosticStore,
  FailureDiagnosticStoreError,
} from '../session/failure_diagnostic_store.ts';
import { isFailureDiagnostic } from '../session/failure_diagnostic.ts';
import {
  DenoProviderEvidenceStore,
  ProviderEvidenceStoreError,
} from '../provider/provider_evidence_store.ts';
import {
  DenoWorkerExecutionArtifactStore,
  WorkerExecutionArtifactStoreError,
} from '../worker/worker_execution_artifact_store.ts';
import type { WorkerExecutionArtifactV1 } from '../worker/worker_execution_artifact.ts';

const encoder = new TextEncoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_invocation: 'invalid invocation',
  diagnostic_not_found: 'diagnostic not found',
  diagnostic_busy: 'diagnostic busy',
  diagnostic_invalid: 'diagnostic invalid',
  diagnostic_capacity: 'diagnostic capacity reached',
  diagnostic_io_failure: 'diagnostic I/O failure',
  provider_evidence_not_found: 'provider evidence not found',
  provider_evidence_invalid: 'provider evidence invalid',
  provider_evidence_io_failure: 'provider evidence I/O failure',
  worker_execution_artifact_not_found: 'Worker execution artifact not found',
  worker_execution_artifact_invalid: 'Worker execution artifact invalid',
  worker_execution_artifact_io_failure: 'Worker execution artifact I/O failure',
};

export type FailureDiagnosticCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'evidence_list' }
  | { readonly kind: 'evidence_show'; readonly id: string }
  | { readonly kind: 'execution_list' }
  | { readonly kind: 'execution_show'; readonly id: string };

export class FailureDiagnosticCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'FailureDiagnosticCliInvocationError';
  }
}

export const parseFailureDiagnosticArgs = (
  args: readonly string[],
): FailureDiagnosticCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (args.length === 1 && args[0] === 'latest') return { kind: 'latest' };
  if (args.length === 2 && args[0] === 'executions' && args[1] === 'list') {
    return { kind: 'execution_list' };
  }
  if (
    args.length === 4 && args[0] === 'executions' && args[1] === 'show' &&
    args[2] === '--id' && UUID_V4.test(args[3])
  ) return { kind: 'execution_show', id: args[3] };
  if (args.length === 2 && args[0] === 'evidence' && args[1] === 'list') {
    return { kind: 'evidence_list' };
  }
  if (
    args.length === 4 && args[0] === 'evidence' && args[1] === 'show' &&
    args[2] === '--id' && UUID_V4.test(args[3])
  ) return { kind: 'evidence_show', id: args[3] };
  if (
    args.length === 3 && args[0] === 'show' && args[1] === '--id' &&
    UUID_V4.test(args[2])
  ) return { kind: 'show', id: args[2] };
  if (
    args.length === 4 && args[0] === 'delete' && args[1] === '--id' &&
    UUID_V4.test(args[2]) && args[3] === '--yes'
  ) return { kind: 'delete', id: args[2] };
  throw new FailureDiagnosticCliInvocationError();
};

const errorLine = (code: string): string =>
  JSON.stringify({
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.invalid_invocation,
    },
  }) + '\n';

const executionSummary = (execution: WorkerExecutionArtifactV1) => ({
  executionId: execution.executionId,
  settledAt: execution.settledAt,
  sessionId: execution.sessionId,
  turn: execution.turn,
  definitionKind: execution.definition.kind,
  workerGeneration: execution.workerGeneration,
  settlement: execution.settlement,
  ...(execution.providerEvidenceId === undefined ? {} : {
    providerEvidenceId: execution.providerEvidenceId,
  }),
});

const absolutePath = (value: string): boolean =>
  value.startsWith('/') && value.trim() === value && !value.includes('\0') &&
  !value.includes('\r') && !value.includes('\n');

const resolvePhysicalWorkspace = async (root = Deno.cwd()): Promise<string> => {
  const workspace = await Deno.realPath(root);
  const info = await Deno.lstat(workspace);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error('workspace is not a directory');
  }
  return workspace;
};

const resolveStateRoot = (): string => {
  const supplied = Deno.env.get('HENJI_SESSION_STATE_ROOT');
  if (supplied !== undefined) {
    if (!absolutePath(supplied)) throw new Error('invalid state root');
    return supplied;
  }
  const xdg = Deno.env.get('XDG_STATE_HOME');
  const home = Deno.env.get('HOME');
  const base = xdg !== undefined && xdg.trim() !== ''
    ? xdg
    : home === undefined || home.trim() === ''
    ? ''
    : `${home}/.local/state`;
  if (!absolutePath(base)) throw new Error('invalid state root');
  return `${base}/henji-harness`;
};

export interface FailureDiagnosticCliDependencies {
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
}

const writeOutput = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  text: string,
  fallback: 'stdout' | 'stderr',
): Promise<void> => {
  if (writer !== undefined) {
    await writer(text);
    return;
  }
  const stream = fallback === 'stdout' ? Deno.stdout : Deno.stderr;
  await stream.write(encoder.encode(text));
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: FailureDiagnosticCliDependencies = {},
): Promise<number> => {
  let command: FailureDiagnosticCliCommand;
  try {
    command = parseFailureDiagnosticArgs(args);
  } catch {
    await writeOutput(
      dependencies.writeStderr,
      errorLine('invalid_invocation'),
      'stderr',
    );
    return 1;
  }
  try {
    const workspace = await resolvePhysicalWorkspace(
      dependencies.workspaceRoot,
    );
    const stateRoot = dependencies.stateRoot ?? resolveStateRoot();
    if (command.kind === 'execution_list' || command.kind === 'execution_show') {
      const executionStore = new DenoWorkerExecutionArtifactStore(stateRoot, workspace);
      if (command.kind === 'execution_list') {
        const executions = await executionStore.list();
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 1,
              executions: executions.map(executionSummary),
            })
          }\n`,
          'stdout',
        );
      } else {
        const execution = await executionStore.read(command.id);
        await writeOutput(
          dependencies.writeStdout,
          `${JSON.stringify(execution)}\n`,
          'stdout',
        );
      }
    } else if (command.kind === 'evidence_list') {
      const evidenceStore = new DenoProviderEvidenceStore(stateRoot, workspace);
      const evidence = await evidenceStore.list();
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ schemaVersion: 1, evidence })}\n`,
        'stdout',
      );
    } else if (command.kind === 'evidence_show') {
      const evidenceStore = new DenoProviderEvidenceStore(stateRoot, workspace);
      let evidence;
      try {
        evidence = await evidenceStore.read(command.id);
      } catch (error) {
        if (
          !(error instanceof ProviderEvidenceStoreError) ||
          error.code !== 'provider_evidence_not_found'
        ) {
          throw error;
        }
        const evidenceId = await evidenceStore.readDiagnosticLink(command.id);
        evidence = await evidenceStore.read(evidenceId);
      }
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(evidence)}\n`,
        'stdout',
      );
    } else if (command.kind === 'list') {
      const store = new DenoFailureDiagnosticStore(stateRoot, workspace);
      const diagnostics = await store.list();
      if (!diagnostics.every(isFailureDiagnostic)) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ schemaVersion: 1, diagnostics })}\n`,
        'stdout',
      );
    } else if (command.kind === 'latest') {
      const store = new DenoFailureDiagnosticStore(stateRoot, workspace);
      const diagnostics = await store.list();
      const latest = diagnostics.at(-1);
      if (latest === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(latest)}\n`,
        'stdout',
      );
    } else if (command.kind === 'show') {
      const store = new DenoFailureDiagnosticStore(stateRoot, workspace);
      const diagnostic = await store.read(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(diagnostic)}\n`,
        'stdout',
      );
    } else {
      const store = new DenoFailureDiagnosticStore(stateRoot, workspace);
      await store.delete(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ ok: true, deleted: command.id })}\n`,
        'stdout',
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof FailureDiagnosticStoreError
      ? error.code
      : error instanceof ProviderEvidenceStoreError
      ? error.code
      : error instanceof WorkerExecutionArtifactStoreError
      ? error.code
      : command.kind === 'evidence_list' || command.kind === 'evidence_show'
      ? 'provider_evidence_io_failure'
      : command.kind === 'execution_list' || command.kind === 'execution_show'
      ? 'worker_execution_artifact_io_failure'
      : 'diagnostic_io_failure';
    await writeOutput(dependencies.writeStderr, errorLine(code), 'stderr');
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
