import {
  DefinitionStartupError,
  definitionStartupErrorValue,
  type HostDefinitionSelection,
  parseDefinitionRevisionSelector,
  resolveRequestedDefinition,
} from '../definitions/definition_selection.ts';
import {
  type HeadlessWorkerRun,
  type HeadlessWorkerRunOptions,
  runHeadlessWorker,
} from '../worker/worker_headless_runner.ts';
import type { AgentEventSink } from '../core/events.ts';
import {
  HenjiInstructionError,
  henjiInstructionErrorValue,
} from '../instructions/base_instruction.ts';
import {
  CliRunEventProjector,
  OrderedTextWriter,
  renderStreamEvent,
  serializeCliRunRecord,
} from './run_events.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

export const MAX_TASK_BYTES = 64 * 1024;
const encoder = new TextEncoder();

/** Headless output mode: default final-only text, machine NDJSON, or human live text. */
export type OutputMode = 'text' | 'json' | 'stream';
const OUTPUT_FLAGS: ReadonlySet<string> = new Set(['--json', '--stream']);

/** Determine the requested output mode before any other argument validation. */
export const parseOutputMode = (args: readonly string[]): OutputMode => {
  let mode: OutputMode = 'text';
  for (const argument of args) {
    if (argument === '--json') {
      if (mode === 'stream') throw new AgentInputError();
      mode = 'json';
    } else if (argument === '--stream') {
      if (mode === 'json') throw new AgentInputError();
      mode = 'stream';
    }
  }
  return mode;
};

export class AgentInputError extends Error {
  constructor() {
    super('invalid agent invocation');
    this.name = 'AgentInputError';
  }
}

export type OutputWriter = (text: string) => void | PromiseLike<void>;

/** Test seams keep channel validation provider-free; production uses the headless Worker route. */
export interface RuntimeCliDependencies {
  readonly stdinIsTerminal?: () => boolean;
  readonly stdin?: ReadableStream<Uint8Array>;
  readonly readStdin?: () => Promise<Uint8Array>;
  readonly run?: (
    task: string,
    selection: HostDefinitionSelection,
    eventSink?: AgentEventSink,
    options?: Pick<HeadlessWorkerRunOptions, 'rootMaxSteps' | 'providerTimeoutMs'>,
  ) => Promise<HeadlessWorkerRun>;
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly runtimePaths?: () => Readonly<{ dataRoot: string; configRoot: string }>;
  readonly writeStdout?: OutputWriter;
  readonly writeStderr?: OutputWriter;
}

const invalidInput = (): AgentInputError => new AgentInputError();

const normalizedTask = (text: string): string => {
  const task = text.trim();
  if (task.length === 0 || encoder.encode(task).byteLength > MAX_TASK_BYTES) {
    throw invalidInput();
  }
  return task;
};

export interface ParsedRuntimeArgs {
  readonly taskArg: string | undefined;
  readonly rawAgentName: string | undefined;
  readonly rawDefinitionRevision?: string;
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
}

/** Parse the exact application argv contract, returning undefined task for stdin. */
export const parseTaskArg = (args: readonly string[]): ParsedRuntimeArgs => {
  let task: string | undefined;
  let rawAgentName: string | undefined;
  let rawDefinitionRevision: string | undefined;
  let rootMaxSteps: number | undefined;
  let providerTimeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument !== '--task' && argument !== '--agent' &&
      argument !== '--definition-revision' && argument !== '--max-steps' &&
      argument !== '--provider-timeout-ms'
    ) throw invalidInput();
    if (index + 1 >= args.length) throw invalidInput();
    if (argument === '--task') {
      if (task !== undefined) throw invalidInput();
      task = args[index + 1];
    } else if (argument === '--max-steps' || argument === '--provider-timeout-ms') {
      const value = args[index + 1];
      if (!/^[0-9]+$/.test(value)) throw invalidInput();
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidInput();
      if (argument === '--max-steps') {
        if (rootMaxSteps !== undefined) throw invalidInput();
        rootMaxSteps = parsed;
      } else {
        if (providerTimeoutMs !== undefined) throw invalidInput();
        providerTimeoutMs = parsed;
      }
    } else {
      if (argument === '--agent') {
        if (rawAgentName !== undefined) throw invalidInput();
        rawAgentName = args[index + 1];
      } else {
        if (rawDefinitionRevision !== undefined) throw invalidInput();
        rawDefinitionRevision = args[index + 1];
        try {
          parseDefinitionRevisionSelector(rawDefinitionRevision);
        } catch {
          throw invalidInput();
        }
      }
    }
    index += 1;
  }
  if (rawAgentName !== undefined && rawDefinitionRevision !== undefined) throw invalidInput();
  return {
    taskArg: task,
    rawAgentName,
    ...(rawDefinitionRevision === undefined ? {} : { rawDefinitionRevision }),
    ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
  };
};

/** Alias with a name that makes the combined parser intent explicit to internal callers. */
export const parseRuntimeArgs = parseTaskArg;

/** Read at most 65,537 raw stdin bytes and reject as soon as the bound is crossed. */
export const readBoundedStdin = async (
  stream: ReadableStream<Uint8Array> = Deno.stdin.readable,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const value = item.value;
      if (value.byteLength > MAX_TASK_BYTES - total) {
        try {
          await reader.cancel('task input exceeds 64 KiB');
        } catch {
          // Best-effort cancellation: the input is already rejected.
        }
        throw invalidInput();
      }
      if (value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decodeTask = (bytes: Uint8Array): string => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidInput();
  }
  return normalizedTask(text);
};

const defaultStdout: OutputWriter = async (text) => {
  await Deno.stdout.write(encoder.encode(text));
};

const defaultStderr: OutputWriter = async (text) => {
  await Deno.stderr.write(encoder.encode(text));
};

const safeCounter = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const failureValue = (
  outcome: 'contract_failure' | 'max_steps',
  code: 'invalid_input' | 'agent_failure' | 'max_steps',
  message: string,
  counters: {
    steps: number;
    toolCallCount: number;
    toolResultCount: number;
    requestCount: number;
  },
): Record<string, unknown> => ({
  ok: false,
  outcome,
  stopReason: outcome,
  steps: counters.steps,
  toolCallCount: counters.toolCallCount,
  toolResultCount: counters.toolResultCount,
  requestCount: counters.requestCount,
  error: { code, message },
});

const runtimeFailureValue = (run: HeadlessWorkerRun): Record<string, unknown> => {
  const outcome = run.outcome;
  const counters = {
    steps: safeCounter(outcome.steps),
    toolCallCount: safeCounter(outcome.toolCallCount),
    toolResultCount: safeCounter(outcome.toolResultCount),
    requestCount: safeCounter(run.requestCount),
  };
  if (outcome.stopReason === 'max_steps') {
    return failureValue('max_steps', 'max_steps', 'agent request limit reached', counters);
  }
  return failureValue('contract_failure', 'agent_failure', 'agent run failed', counters);
};

const preflightFailureValue = (): Record<string, unknown> =>
  failureValue(
    'contract_failure',
    'invalid_input',
    'invalid agent invocation',
    { steps: 0, toolCallCount: 0, toolResultCount: 0, requestCount: 0 },
  );

const definitionFailureValue = (error: DefinitionStartupError): Record<string, unknown> => ({
  ok: false,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  requestCount: 0,
  error: definitionStartupErrorValue(error),
});

const instructionFailureValue = (error: HenjiInstructionError): Record<string, unknown> => ({
  ok: false,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  requestCount: 0,
  error: henjiInstructionErrorValue(error),
});

const line = (value: Record<string, unknown>): string => JSON.stringify(value) + '\n';

/** Curated terminal result for `--json`, covering both success and failure. */
const resultRecord = (
  run: HeadlessWorkerRun,
  committed: boolean,
): Parameters<typeof serializeCliRunRecord>[0] => {
  const outcome = run.outcome;
  return {
    kind: 'result',
    ok: outcome.ok === true,
    stopReason: outcome.stopReason,
    committed,
    steps: safeCounter(outcome.steps),
    toolCallCount: safeCounter(outcome.toolCallCount),
    toolResultCount: safeCounter(outcome.toolResultCount),
    requestCount: safeCounter(run.requestCount),
    ...(typeof outcome.finalText === 'string' ? { finalText: outcome.finalText } : {}),
    ...(outcome.terminalKind === undefined ? {} : { terminalKind: outcome.terminalKind }),
    ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
    ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
  };
};

/** Run the normal print-only command and return its process exit code. */
export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: RuntimeCliDependencies = {},
): Promise<number> => {
  const stdout = new OrderedTextWriter(dependencies.writeStdout ?? defaultStdout);
  const stderr = new OrderedTextWriter(dependencies.writeStderr ?? defaultStderr);
  let mode: OutputMode = 'text';
  let modeInvalid = false;
  try {
    mode = parseOutputMode(args);
  } catch {
    // `--json` and `--stream` together are invalid; report through the default text channel.
    modeInvalid = true;
  }
  const emitError = (value: Record<string, unknown>): void => {
    if (mode === 'json') {
      stdout.enqueue(serializeCliRunRecord({ kind: 'error', error: value }));
    } else {
      stderr.enqueue(line(value));
    }
  };
  try {
    if (modeInvalid) throw invalidInput();
    const parsed = parseTaskArg(args.filter((argument) => !OUTPUT_FLAGS.has(argument)));
    // Resolve before probing or reading stdin and before any runtime/workspace construction.
    const defaultRoot = parsed.rawAgentName === undefined &&
      parsed.rawDefinitionRevision === undefined;
    const paths = defaultRoot &&
        (dependencies.dataRoot === undefined || dependencies.configRoot === undefined)
      ? dependencies.runtimePaths?.() ??
        (dependencies.run === undefined ? resolveRuntimePaths() : undefined)
      : undefined;
    const dataRoot = dependencies.dataRoot ?? paths?.dataRoot;
    const configRoot = dependencies.configRoot ?? paths?.configRoot;
    let selection: HostDefinitionSelection;
    try {
      selection = await resolveRequestedDefinition(
        parsed.rawAgentName,
        parsed.rawDefinitionRevision,
        dataRoot,
        configRoot,
      );
    } catch (error) {
      if (error instanceof DefinitionStartupError) throw error;
      throw invalidInput();
    }
    const argvTask = parsed.taskArg;
    const terminal = dependencies.stdinIsTerminal?.() ??
      Deno.stdin.isTerminal();
    if (argvTask !== undefined && !terminal) throw invalidInput();

    let task: string;
    if (argvTask !== undefined) {
      task = normalizedTask(argvTask);
    } else {
      if (terminal) throw invalidInput();
      let bytes: Uint8Array;
      try {
        bytes = dependencies.readStdin
          ? await dependencies.readStdin()
          : await readBoundedStdin(dependencies.stdin);
      } catch (error) {
        if (error instanceof AgentInputError) throw error;
        throw invalidInput();
      }
      if (!(bytes instanceof Uint8Array)) throw invalidInput();
      task = decodeTask(bytes);
    }

    const projector = new CliRunEventProjector();
    let streamedText = false;
    const sink: AgentEventSink | undefined = mode === 'text' ? undefined : (event) => {
      for (const projected of projector.project(event)) {
        if (mode === 'json') {
          stdout.enqueue(serializeCliRunRecord(projected));
          continue;
        }
        const rendered = renderStreamEvent(projected);
        if (rendered.stdout !== undefined) {
          if (projected.kind === 'assistant_delta') streamedText = true;
          stdout.enqueue(rendered.stdout);
        }
        if (rendered.stderr !== undefined) stderr.enqueue(rendered.stderr);
      }
    };
    const runner = dependencies.run ??
      ((input, selected, eventSink, options) =>
        runHeadlessWorker(input, selected, {
          dataRoot,
          configRoot,
          eventSink,
          ...options,
        }));
    const run = await runner(task, selection, sink, {
      ...(parsed.rootMaxSteps === undefined ? {} : { rootMaxSteps: parsed.rootMaxSteps }),
      ...(parsed.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: parsed.providerTimeoutMs }),
    });
    const succeeded = run.outcome.ok &&
      (run.outcome.stopReason === 'final' || run.outcome.stopReason === 'tool_terminal') &&
      typeof run.outcome.finalText === 'string';
    if (succeeded) {
      const finalText = run.outcome.finalText as string;
      if (mode === 'json') {
        stdout.enqueue(serializeCliRunRecord(resultRecord(run, projector.wasCommitted)));
      } else if (mode === 'stream') {
        if (!streamedText) {
          stdout.enqueue(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
        }
      } else {
        stdout.enqueue(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
      }
      return 0;
    }
    if (mode === 'json') {
      stdout.enqueue(serializeCliRunRecord(resultRecord(run, projector.wasCommitted)));
    } else {
      stderr.enqueue(line(runtimeFailureValue(run)));
    }
    return 1;
  } catch (error) {
    if (error instanceof DefinitionStartupError) {
      emitError(definitionFailureValue(error));
      return 1;
    }
    if (error instanceof HenjiInstructionError) {
      emitError(instructionFailureValue(error));
      return 1;
    }
    if (error instanceof AgentInputError) {
      emitError(preflightFailureValue());
      return 1;
    }
    emitError(failureValue(
      'contract_failure',
      'agent_failure',
      'agent run failed',
      { steps: 0, toolCallCount: 0, toolResultCount: 0, requestCount: 0 },
    ));
    return 1;
  } finally {
    await stdout.drain();
    await stderr.drain();
  }
};

if (import.meta.main) Deno.exit(await main());
