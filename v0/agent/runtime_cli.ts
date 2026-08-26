import { runRuntime, type RuntimeRun, type RuntimeTestSeam } from './runtime.ts';

export const MAX_TASK_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export class AgentInputError extends Error {
  constructor() {
    super('invalid agent invocation');
    this.name = 'AgentInputError';
  }
}

export type OutputWriter = (text: string) => void | PromiseLike<void>;

/** Test seams keep direct validation permission-free; production uses Deno I/O. */
export interface RuntimeCliDependencies {
  readonly stdinIsTerminal?: () => boolean;
  readonly stdin?: ReadableStream<Uint8Array>;
  readonly readStdin?: () => Promise<Uint8Array>;
  readonly run?: (task: string) => Promise<RuntimeRun>;
  readonly runtimeSeam?: RuntimeTestSeam;
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

/** Parse the exact application argv contract, returning undefined for stdin. */
export const parseTaskArg = (args: readonly string[]): string | undefined => {
  let task: string | undefined;
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--task') throw invalidInput();
    if (found || index + 1 >= args.length) throw invalidInput();
    found = true;
    task = args[index + 1];
    index += 1;
  }
  return task;
};

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

const failureLine = (
  outcome: 'contract_failure' | 'max_steps',
  code: 'invalid_input' | 'agent_failure' | 'max_steps',
  message: string,
  counters: {
    steps: number;
    toolCallCount: number;
    toolResultCount: number;
    requestCount: number;
  },
): string =>
  JSON.stringify({
    ok: false,
    outcome,
    stopReason: outcome,
    steps: counters.steps,
    toolCallCount: counters.toolCallCount,
    toolResultCount: counters.toolResultCount,
    requestCount: counters.requestCount,
    error: { code, message },
  }) + '\n';

const runtimeFailureLine = (run: RuntimeRun): string => {
  const outcome = run.outcome;
  const counters = {
    steps: safeCounter(outcome.steps),
    toolCallCount: safeCounter(outcome.toolCallCount),
    toolResultCount: safeCounter(outcome.toolResultCount),
    requestCount: safeCounter(run.requestCount),
  };
  if (outcome.stopReason === 'max_steps') {
    return failureLine(
      'max_steps',
      'max_steps',
      'agent request limit reached',
      counters,
    );
  }
  return failureLine(
    'contract_failure',
    'agent_failure',
    'agent run failed',
    counters,
  );
};

const preflightFailureLine = (): string =>
  failureLine(
    'contract_failure',
    'invalid_input',
    'invalid agent invocation',
    { steps: 0, toolCallCount: 0, toolResultCount: 0, requestCount: 0 },
  );

/** Run the normal print-only command and return its process exit code. */
export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: RuntimeCliDependencies = {},
): Promise<number> => {
  const stdout = dependencies.writeStdout ?? defaultStdout;
  const stderr = dependencies.writeStderr ?? defaultStderr;
  try {
    const argvTask = parseTaskArg(args);
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

    const runner = dependencies.run ??
      ((value: string) => runRuntime(value, dependencies.runtimeSeam));
    const run = await runner(task);
    if (
      run.outcome.ok &&
      (run.outcome.stopReason === 'final' || run.outcome.stopReason === 'tool_terminal') &&
      typeof run.outcome.finalText === 'string'
    ) {
      const finalText = run.outcome.finalText;
      await stdout(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
      return 0;
    }
    await stderr(runtimeFailureLine(run));
    return 1;
  } catch (error) {
    if (error instanceof AgentInputError) {
      await stderr(preflightFailureLine());
      return 1;
    }
    await stderr(failureLine(
      'contract_failure',
      'agent_failure',
      'agent run failed',
      { steps: 0, toolCallCount: 0, toolResultCount: 0, requestCount: 0 },
    ));
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
