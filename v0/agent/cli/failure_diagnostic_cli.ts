import {
  cliErrorMessage,
  cliErrorText,
  CliInvocationError,
  commandError,
  parseCliOptions,
} from './cli_error.ts';
import { FailureDiagnosticStoreError } from '../session/failure_diagnostic_store.ts';
import { isFailureDiagnostic } from '../session/failure_diagnostic.ts';
import type { StoredExecutionRow } from '../history/history_store_contract.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { executionEffectsFromEvents } from '../history/execution_effect_projection.ts';
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

type FailureDiagnosticCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'execution_list' }
  | { readonly kind: 'execution_show'; readonly id: string }
  | { readonly kind: 'execution_events'; readonly id: string }
  | { readonly kind: 'execution_context'; readonly id: string }
  | {
    readonly kind: 'execution_request';
    readonly id: string;
    readonly ordinal: number;
  };

const parseFailureDiagnosticArgs = (
  args: readonly string[],
): FailureDiagnosticCliCommand => {
  const execution = args[0] === 'executions';
  const command = args[execution ? 1 : 0];
  const commands = execution
    ? ['list', 'show', 'events', 'context', 'request']
    : ['list', 'latest', 'show', 'delete'];
  if (!commands.includes(command)) {
    throw commandError(command, commands.join(', '));
  }
  const needsId = !['list', 'latest'].includes(command);
  const flags = parseCliOptions(
    args.slice(execution ? 2 : 1),
    needsId ? command === 'request' ? ['--id', '--ordinal'] : ['--id'] : [],
    command === 'delete' ? ['--yes'] : [],
  );
  const id = flags.get('--id');
  if (needsId && id === undefined) {
    throw new CliInvocationError('Missing required --id');
  }
  if (id !== undefined && !UUID_V4.test(id)) {
    throw new CliInvocationError(
      '--id must be a full execution or diagnostic UUID',
    );
  }
  if (command === 'delete' && !flags.has('--yes')) {
    throw new CliInvocationError('Diagnostic deletion requires --yes');
  }
  if (execution) {
    if (command === 'list') return { kind: 'execution_list' };
    if (command === 'request') {
      const value = flags.get('--ordinal');
      if (value === undefined) {
        throw new CliInvocationError('Missing required --ordinal');
      }
      const ordinal = Number(value);
      if (
        !/^\d+$/u.test(value) || !Number.isSafeInteger(ordinal) || ordinal < 1
      ) {
        throw new CliInvocationError(
          '--ordinal must be a positive integer starting at 1',
        );
      }
      return { kind: 'execution_request', id: id!, ordinal };
    }
    return {
      kind: `execution_${command}` as
        | 'execution_show'
        | 'execution_events'
        | 'execution_context',
      id: id!,
    };
  }
  if (command === 'list' || command === 'latest') return { kind: command };
  return { kind: command as 'show' | 'delete', id: id! };
};

const errorLine = (code: string): string =>
  cliErrorText('diagnostics', ERROR_MESSAGES[code] ?? code, true);

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
  configurationId: execution.configurationId,
  configuration: execution.configuration,
  maxSteps: execution.maxSteps,
  ...(execution.instanceCorrelation === undefined ? {} : {
    instanceCorrelation: execution.instanceCorrelation,
  }),
  workerGeneration: execution.workerGeneration,
  acknowledgement: execution.acknowledgement,
  generationAvailability: execution.generationAvailability,
  diagnosticCapture: execution.diagnosticCapture,
  artifactCapture: execution.artifactCapture,
  contextCapture: execution.contextCapture,
});

const contextCaptureForReadback = (
  execution: StoredExecutionRow,
  hasContext: boolean,
): StoredExecutionRow['contextCapture'] =>
  execution.lifecycle === 'active' && execution.contextCapture === 'none' &&
    hasContext
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

interface FailureDiagnosticCliDependencies {
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
  } catch (error) {
    await writeOutput(
      dependencies.writeStderr,
      cliErrorText('diagnostics', cliErrorMessage(error), true),
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
      command.kind === 'execution_events' ||
      command.kind === 'execution_context' ||
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
        const events = history.listExecutionEvents(command.id);
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              ...executionSummary(execution),
              events,
              effects: executionEffectsFromEvents(
                command.id,
                execution.outcome,
                events,
              ),
            })
          }\n`,
          'stdout',
        );
      } else if (command.kind === 'execution_events') {
        const execution = history.readExecution(command.id);
        const events = history.listExecutionEvents(command.id);
        await writeOutput(
          dependencies.writeStdout,
          `${
            JSON.stringify({
              schemaVersion: 3,
              executionId: execution.executionId,
              events,
              effects: executionEffectsFromEvents(
                command.id,
                execution.outcome,
                events,
              ),
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
        const request = history.readExecutionRequest(
          command.id,
          command.ordinal,
        );
        const contextCapture = contextCaptureForReadback(
          execution,
          true,
        );
        const facts = history.readExecutionRequestFacts(
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
              providerFacts: facts,
            })
          }\n`,
          'stdout',
        );
      }
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
        : error.code === 'history_invalid' ||
            error.code === 'history_io_failure'
        ? error.code
        : command.kind === 'execution_list' ||
            command.kind === 'execution_show' ||
            command.kind === 'execution_events'
        ? 'history_io_failure'
        : 'diagnostic_io_failure'
      : error instanceof FailureDiagnosticStoreError
      ? error.code
      : command.kind === 'execution_list' ||
          command.kind === 'execution_show' ||
          command.kind === 'execution_events'
      ? 'history_io_failure'
      : 'diagnostic_io_failure';
    await writeOutput(dependencies.writeStderr, errorLine(code), 'stderr');
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
