import type { ToolExecutionContext } from '../core/execution_context.ts';
import {
  CancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
  TurnCancelledError,
} from '../core/cancellation.ts';
import type { Tool } from './tools.ts';
import {
  BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
  type BashOutputCommandCapture,
  type BashOutputLimitSnapshot,
  BashOutputPersistenceError,
  type BashOutputStore,
  type BashOutputStream,
  createBashOutputStore,
} from './bash_output.ts';
import type { BashToolSeams, Workspace } from './work_tool_contract.ts';
import {
  CAPTURE_GRACE_MS,
  concatBytes,
  DEFAULT_TIMEOUT_MS,
  encoder,
  invalidToolArguments,
  isObject,
  MAX_CAPTURE_BYTES,
  MAX_COMMAND_BYTES,
  MAX_PROGRESS_STREAM_BYTES,
  MAX_TIMEOUT_MS,
  validateObject,
  validTextArgument,
} from './work_tool_value.ts';

const bashSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

interface CapturedStream {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

interface CaptureState {
  readonly done: Promise<CapturedStream>;
  readonly snapshot: () => CapturedStream;
  readonly cancelAndWait: () => Promise<void>;
  readonly progressText: () => string;
}

type BashOutputStopEvent =
  | { readonly kind: 'limit'; readonly limit: BashOutputLimitSnapshot }
  | { readonly kind: 'persistence' };

class BashOutputToolResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BashOutputToolResultError';
  }
}

const startDrain = (
  stream: ReadableStream<Uint8Array>,
  output: BashOutputCommandCapture,
  outputStream: BashOutputStream,
  onOutputStop: (event: BashOutputStopEvent) => void,
  onProgress?: (prefix: string) => void,
): CaptureState => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let progressPrefix = '';
  let progressBytes = 0;
  let progressFrozen = false;
  let progressDisabled = false;
  const progressDecoder = new TextDecoder('utf-8', { fatal: true });
  const outputDecoder = new TextDecoder('utf-8');
  let pendingOutput = '';
  let spooling = false;
  let storageStopped = false;
  const snapshot = (): CapturedStream => ({
    bytes: concatBytes(chunks, total),
    truncated,
  });
  const progressText = (): string => progressPrefix;
  const observe = (bytes: Uint8Array): void => {
    if (progressDisabled || progressFrozen || bytes.byteLength === 0) return;
    let decoded: string;
    try {
      decoded = progressDecoder.decode(bytes, { stream: true });
    } catch {
      // The final bounded capture remains authoritative; only live observation is disabled.
      progressDisabled = true;
      return;
    }
    if (decoded.length === 0) return;
    let changed = false;
    for (const character of decoded) {
      const size = encoder.encode(character).byteLength;
      if (progressBytes + size > MAX_PROGRESS_STREAM_BYTES) {
        // Do not classify a valid scalar crossing the observation cap as malformed. Freeze this
        // stream before the scalar while raw capture continues unchanged.
        progressFrozen = true;
        break;
      }
      progressPrefix += character;
      progressBytes += size;
      changed = true;
    }
    if (changed) onProgress?.(progressPrefix);
  };
  const done = (async (): Promise<CapturedStream> => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        const remaining = MAX_CAPTURE_BYTES - total;
        if (remaining > 0) {
          const retained = item.value.slice(0, remaining);
          chunks.push(retained);
          total += retained.byteLength;
        }
        if (item.value.byteLength > remaining) truncated = true;
        observe(item.value);
        const decoded = outputDecoder.decode(item.value, { stream: true });
        if (!spooling) {
          pendingOutput += decoded;
          if (truncated) {
            spooling = true;
            if (pendingOutput.length > 0) {
              try {
                const result = await output.append(outputStream, pendingOutput);
                if (result.limit) {
                  storageStopped = true;
                  onOutputStop({ kind: 'limit', limit: result.limit });
                }
              } catch {
                storageStopped = true;
                onOutputStop({ kind: 'persistence' });
              }
              pendingOutput = '';
            }
          }
        } else if (!storageStopped && decoded.length > 0) {
          try {
            const result = await output.append(outputStream, decoded);
            if (result.limit) {
              storageStopped = true;
              onOutputStop({ kind: 'limit', limit: result.limit });
            }
          } catch {
            storageStopped = true;
            onOutputStop({ kind: 'persistence' });
          }
        }
      }
      const finalText = outputDecoder.decode();
      if (spooling && !storageStopped && finalText.length > 0) {
        try {
          const result = await output.append(outputStream, finalText);
          if (result.limit) {
            onOutputStop({ kind: 'limit', limit: result.limit });
          }
        } catch {
          onOutputStop({ kind: 'persistence' });
        }
      }
      if (!progressDisabled && !progressFrozen) {
        try {
          observe(new Uint8Array());
          progressDecoder.decode();
        } catch {
          // An incomplete terminal sequence is malformed for live observation only.
          progressDisabled = true;
        }
      }
    } catch {
      // Cancellation after the bounded capture grace is an expected cleanup path.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already have released its reader during cancellation.
      }
    }
    return snapshot();
  })();
  return {
    done,
    snapshot,
    cancelAndWait: async () => {
      await reader.cancel();
      await done;
    },
    progressText,
  };
};

const waitForCapture = async (
  stdout: CaptureState,
  stderr: CaptureState,
  waitForSettlement: boolean,
  seams: BashToolSeams,
): Promise<readonly [CapturedStream, CapturedStream]> => {
  await seams.beforeCapture?.(waitForSettlement);
  if (waitForSettlement) {
    await Promise.all([stdout.done, stderr.done]);
    return [await stdout.done, await stderr.done];
  }
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      Promise.all([stdout.done, stderr.done]).then(() => true),
      new Promise<boolean>((resolve) => {
        captureTimer = setTimeout(() => resolve(false), CAPTURE_GRACE_MS);
      }),
    ]);
    if (completed) return [await stdout.done, await stderr.done];
    const settled = await Promise.allSettled([
      stdout.cancelAndWait(),
      stderr.cancelAndWait(),
    ]);
    if (settled.some((result) => result.status === 'rejected')) {
      throw new Error('capture cleanup failed');
    }
    return [stdout.snapshot(), stderr.snapshot()];
  } finally {
    if (captureTimer !== undefined) clearTimeout(captureTimer);
  }
};

export const createBashTool = (
  workspace: Workspace,
  outputStore: BashOutputStore = createBashOutputStore(),
  seams: BashToolSeams = {},
): Tool => ({
  name: 'bash',
  description:
    'Run one Bash command from the workspace. Default timeout 30000 ms; maximum 120000 ms. stdout and stderr are captured separately. Truncated output can be continued with bash_output.',
  inputSchema: bashSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, [
      'command',
      ...(isObject(argumentsValue) && 'timeoutMs' in argumentsValue ? ['timeoutMs'] : []),
    ], 'bash');
    if (
      !Object.hasOwn(args, 'command') || typeof args.command !== 'string' ||
      !validTextArgument(args.command, MAX_COMMAND_BYTES) ||
      args.command.trim().length === 0
    ) {
      throw invalidToolArguments('bash');
    }
    const timeoutMs = Object.hasOwn(args, 'timeoutMs') ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (
      typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) throw invalidToolArguments('bash');
    throwIfCancelled(context?.signal);
    const outputCapture = outputStore.beginCommand();
    const abandonCancelledCapture = async (): Promise<void> => {
      try {
        await outputCapture.abandon();
      } catch {
        throw new CancellationCleanupError();
      }
    };
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command('/bin/bash', {
        args: ['--noprofile', '--norc', '-c', args.command],
        cwd: workspace.root,
        clearEnv: true,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
    } catch {
      await outputCapture.finish().catch(() => undefined);
      throw new Error('bash could not start');
    }
    let timedOut = false;
    let cancellationRequested = false;
    let outputStopEvent: BashOutputStopEvent | undefined;
    let outputStopResolve!: (value: 'output') => void;
    const outputStop = new Promise<'output'>((resolve) => {
      outputStopResolve = resolve;
    });
    const noteOutputStop = (event: BashOutputStopEvent): void => {
      if (outputStopEvent !== undefined) return;
      outputStopEvent = event;
      outputStopResolve('output');
    };
    const reportProgress = context?.reportProgress;
    const stderrCapture: { current?: CaptureState } = {};
    const stdout = startDrain(
      child.stdout,
      outputCapture,
      'stdout',
      noteOutputStop,
      (prefix) => {
        reportProgress?.(
          `stdout:\n${prefix}\nstderr:\n${stderrCapture.current?.progressText() ?? ''}`,
        );
      },
    );
    const stderr = startDrain(
      child.stderr,
      outputCapture,
      'stderr',
      noteOutputStop,
      (prefix) => {
        reportProgress?.(
          `stdout:\n${stdout.progressText()}\nstderr:\n${prefix}`,
        );
      },
    );
    stderrCapture.current = stderr;
    let status: Deno.CommandStatus | undefined;
    const statusPromise = child.status.then((value) => {
      status = value;
      return value;
    });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      cancellationRequested = true;
      cancellationResolve?.('cancelled');
    };
    let cancellationResolve: ((value: 'cancelled') => void) | undefined;
    const cancellation = new Promise<'cancelled'>((resolve) => {
      cancellationResolve = resolve;
      context?.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutTimer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const teardown = async (cancelledByUser: boolean): Promise<void> => {
      let cleanupFailedAfterCancellation = false;
      const cancellationWon = (): boolean =>
        cancellationRequested || context?.signal?.aborted === true;
      const noteCleanupFailure = (): void => {
        if (cancellationWon()) cleanupFailedAfterCancellation = true;
      };
      if (status === undefined) {
        try {
          child.kill('SIGTERM');
        } catch {
          if (status === undefined) noteCleanupFailure();
        }
        const termGrace = await Promise.race([
          statusPromise.then(() => 'status' as const),
          new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), CAPTURE_GRACE_MS)),
        ]);
        if (termGrace === 'grace' && status === undefined) {
          try {
            child.kill('SIGKILL');
          } catch {
            if (status === undefined) noteCleanupFailure();
          }
        }
        try {
          await statusPromise;
        } catch {
          noteCleanupFailure();
        }
      }
      try {
        await waitForCapture(stdout, stderr, cancelledByUser, seams);
        // A timeout may begin ordinary bounded capture cleanup before the user requests
        // cancellation. Once that request arrives, upgrade to full capture settlement before
        // allowing the interrupted turn to surface.
        if (cancellationWon() && !cancelledByUser) {
          await waitForCapture(stdout, stderr, true, seams);
        }
      } catch {
        noteCleanupFailure();
        const settled = await Promise.allSettled([
          stdout.cancelAndWait(),
          stderr.cancelAndWait(),
        ]);
        if (settled.some((result) => result.status === 'rejected')) {
          noteCleanupFailure();
        }
      }
      if (cancellationWon() && cleanupFailedAfterCancellation) {
        throw new CancellationCleanupError();
      }
    };
    try {
      const first = await Promise.race([
        statusPromise.then(() => 'status' as const),
        timeout,
        cancellation,
        outputStop,
      ]);
      if (first === 'timeout' || first === 'cancelled' || first === 'output') {
        if (first === 'cancelled') cancellationRequested = true;
        if (first === 'timeout') timedOut = true;
        await teardown(cancellationRequested);
      } else {
        await statusPromise;
        // A cancellation can be requested in the same turn as child completion. It wins only
        // before the result is settled, after all direct resources have been reaped.
        if (cancellationRequested || context?.signal?.aborted) {
          await teardown(true);
        }
        await waitForCapture(stdout, stderr, false, seams);
      }
      if (cancellationRequested || context?.signal?.aborted) {
        await abandonCancelledCapture();
        throw new TurnCancelledError();
      }
      const [capturedStdout, capturedStderr] = await waitForCapture(
        stdout,
        stderr,
        false,
        seams,
      );
      let outputSummary;
      try {
        outputSummary = await outputCapture.finish();
      } catch (error) {
        if (error instanceof BashOutputPersistenceError) {
          outputStopEvent = { kind: 'persistence' };
          outputSummary = await outputCapture.summary();
        } else throw error;
      }
      // The final partial segment is persisted asynchronously. Cancellation that arrives while
      // that flush is in flight still owns the turn, so do not retain an identity that the loop
      // will never commit to the transcript.
      if (cancellationRequested || context?.signal?.aborted) {
        await abandonCancelledCapture();
        throw new TurnCancelledError();
      }
      const result: Record<string, unknown> = {
        stdout: new TextDecoder().decode(capturedStdout.bytes),
        stderr: new TextDecoder().decode(capturedStderr.bytes),
        exitCode: status?.signal === null ? status.code : null,
        signal: status?.signal ?? null,
        timedOut,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
      };
      if (outputSummary.available && outputSummary.outputId !== undefined) {
        const streams = Object.entries(outputSummary.streams).map((
          [stream, totalBytes],
        ) => ({
          stream,
          totalBytes,
          offset: 0,
          limit: BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
        }));
        result.outputId = outputSummary.outputId;
        result.savedStreams = outputSummary.streams;
        result.outputComplete = outputSummary.limit === undefined;
        result.readback = {
          tool: 'bash_output',
          outputId: outputSummary.outputId,
          streams,
        };
      }
      if (outputSummary.limit !== undefined) {
        result.outputLimitExceeded = true;
        result.outputComplete = false;
        result.outputLimit = outputSummary.limit;
      }
      if (outputStopEvent?.kind === 'persistence') {
        result.outputComplete = false;
        result.error = 'bash output persistence failed';
        throw new BashOutputToolResultError(JSON.stringify(result));
      }
      return JSON.stringify(result);
    } catch (error) {
      if (
        error instanceof CancellationCleanupError || isTurnCancelledError(error)
      ) {
        await abandonCancelledCapture();
        throw error;
      }
      if (error instanceof BashOutputToolResultError) throw error;
      throw new Error('bash could not start');
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      context?.signal?.removeEventListener('abort', onAbort);
    }
  },
});
