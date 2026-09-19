import { FailureDiagnosticStoreError } from '../session/failure_diagnostic_store.ts';
import { isFailureDiagnostic } from '../session/failure_diagnostic.ts';
import { ProviderEvidenceStoreError } from '../provider/provider_evidence_store.ts';
import type { StoredExecutionRow } from '../history/history_store_contract.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { HistoryStoreError } from '../history/history_store_contract.ts';

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
  history_busy: 'history busy',
  history_invalid: 'history store invalid',
  history_io_failure: 'history store I/O failure',
};

export type FailureDiagnosticCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'evidence_list' }
  | { readonly kind: 'evidence_show'; readonly id: string }
  | { readonly kind: 'execution_list' }
  | { readonly kind: 'execution_show'; readonly id: string }
  | { readonly kind: 'execution_events'; readonly id: string }
  | { readonly kind: 'execution_context'; readonly id: string }
  | { readonly kind: 'execution_request'; readonly id: string; readonly ordinal: number };

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
  if (
    args.length === 4 && args[0] === 'executions' && args[1] === 'events' &&
    args[2] === '--id' && UUID_V4.test(args[3])
  ) return { kind: 'execution_events', id: args[3] };
  if (
    args.length === 4 && args[0] === 'executions' && args[1] === 'context' &&
    args[2] === '--id' && UUID_V4.test(args[3])
  ) return { kind: 'execution_context', id: args[3] };
  if (
    args.length === 6 && args[0] === 'executions' && args[1] === 'request' &&
    args[2] === '--id' && UUID_V4.test(args[3]) && args[4] === '--ordinal' &&
    /^\d+$/u.test(args[5]) && Number(args[5]) >= 1 && Number.isSafeInteger(Number(args[5]))
  ) return { kind: 'execution_request', id: args[3], ordinal: Number(args[5]) };
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

const executionSummary = (execution: StoredExecutionRow) => ({
  executionId: execution.executionId,
  taskId: execution.taskId,
  task: execution.task,
  ...(execution.canonicalSessionId === undefined ? {} : {
    canonicalSessionId: execution.canonicalSessionId,
  }),
  sessionCorrelation: execution.sessionCorrelation,
  turn: execution.turn,
  createdAt: execution.createdAt,
  ...(execution.settledAt === undefined ? {} : { settledAt: execution.settledAt }),
  lifecycle: execution.lifecycle,
  outcome: execution.outcome,
  ...(execution.outcomeJson === undefined ? {} : { outcomeJson: execution.outcomeJson }),
  adoption: execution.adoption,
  baseRevision: execution.baseRevision,
  ...(execution.committedRevision === undefined ? {} : {
    committedRevision: execution.committedRevision,
  }),
  agent: execution.agent,
  model: execution.model,
  build: execution.build,
  definition: execution.definition,
  ...(execution.manifest === undefined ? {} : { manifest: execution.manifest }),
  ...(execution.instanceCorrelation === undefined ? {} : {
    instanceCorrelation: execution.instanceCorrelation,
  }),
  workerGeneration: execution.workerGeneration,
  acknowledgement: execution.acknowledgement,
  generationAvailability: execution.generationAvailability,
  evidenceCapture: execution.evidenceCapture,
  ...(execution.providerEvidenceId === undefined ? {} : {
    providerEvidenceId: execution.providerEvidenceId,
  }),
  diagnosticCapture: execution.diagnosticCapture,
  artifactCapture: execution.artifactCapture,
  contextCapture: execution.contextCapture,
});

const contextCaptureForReadback = (
  execution: StoredExecutionRow,
  hasContext: boolean,
): StoredExecutionRow['contextCapture'] =>
  execution.lifecycle === 'active' && execution.contextCapture === 'none' && hasContext
    ? 'partial'
    : execution.contextCapture;

const resolvePhysicalWorkspace = async (root = Deno.cwd()): Promise<string> => {
  const workspace = await Deno.realPath(root);
  const info = await Deno.lstat(workspace);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error('workspace is not a directory');
  }
  return workspace;
};

const resolveStateRoot = (): string => resolveRuntimePaths().stateRoot;

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
    const history = new SqliteHistoryStore(stateRoot, workspace);
    await history.initialize();
    if (
      command.kind === 'execution_list' || command.kind === 'execution_show' ||
      command.kind === 'execution_events' || command.kind === 'execution_context' ||
      command.kind === 'execution_request'
    ) {
      if (command.kind === 'execution_list') {
        const executions = history.listExecutions();
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 2,
              executions: executions.map(executionSummary),
            })
          }\n`,
          'stdout',
        );
      } else if (command.kind === 'execution_show') {
        const execution = history.readExecution(command.id);
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              ...executionSummary(execution),
              events: history.listExecutionEvents(command.id),
              effects: history.listExecutionEffects(command.id),
            })
          }\n`,
          'stdout',
        );
      } else if (command.kind === 'execution_events') {
        const execution = history.readExecution(command.id);
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 3,
              executionId: execution.executionId,
              events: history.listExecutionEvents(command.id),
              effects: history.listExecutionEffects(command.id),
            })
          }\n`,
          'stdout',
        );
      } else if (command.kind === 'execution_context') {
        const execution = history.readExecution(command.id);
        const context = history.listExecutionContext(command.id);
        const contextCapture = contextCaptureForReadback(
          execution,
          context.snapshot !== undefined || context.requests.length > 0 ||
            context.relations.length > 0,
        );
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 1,
              execution: {
                ...executionSummary(execution),
                contextCapture,
              },
              capture: contextCapture,
              ...context,
            })
          }\n`,
          'stdout',
        );
      } else {
        const execution = history.readExecution(command.id);
        const request = history.readExecutionRequest(command.id, command.ordinal);
        const contextCapture = contextCaptureForReadback(
          execution,
          true,
        );
        const evidence = history.readExecutionRequestProviderEvidence(
          command.id,
          command.ordinal,
        );
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 1,
              execution: {
                ...executionSummary(execution),
                contextCapture,
              },
              capture: contextCapture,
              request,
              providerEvidence: evidence,
            })
          }\n`,
          'stdout',
        );
      }
    } else if (command.kind === 'evidence_list') {
      const evidenceStore = history.providerEvidence;
      const evidence = await evidenceStore.list();
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ schemaVersion: 2, evidence })}\n`,
        'stdout',
      );
    } else if (command.kind === 'evidence_show') {
      const evidenceStore = history.providerEvidence;
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
      const store = history.diagnostics;
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
      const store = history.diagnostics;
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
      const store = history.diagnostics;
      const diagnostic = await store.read(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(diagnostic)}\n`,
        'stdout',
      );
    } else {
      const store = history.diagnostics;
      await store.delete(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ ok: true, deleted: command.id })}\n`,
        'stdout',
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof HistoryStoreError
      ? error.code === 'history_busy'
        ? command.kind === 'list' || command.kind === 'latest' ||
            command.kind === 'show' || command.kind === 'delete'
          ? 'diagnostic_busy'
          : 'history_busy'
        : error.code === 'history_invalid' || error.code === 'history_io_failure'
        ? error.code
        : command.kind === 'evidence_list' || command.kind === 'evidence_show'
        ? 'provider_evidence_io_failure'
        : command.kind === 'execution_list' || command.kind === 'execution_show' ||
            command.kind === 'execution_events'
        ? 'history_io_failure'
        : 'diagnostic_io_failure'
      : error instanceof FailureDiagnosticStoreError
      ? error.code
      : error instanceof ProviderEvidenceStoreError
      ? error.code
      : command.kind === 'evidence_list' || command.kind === 'evidence_show'
      ? 'provider_evidence_io_failure'
      : command.kind === 'execution_list' || command.kind === 'execution_show' ||
          command.kind === 'execution_events'
      ? 'history_io_failure'
      : 'diagnostic_io_failure';
    await writeOutput(dependencies.writeStderr, errorLine(code), 'stderr');
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
