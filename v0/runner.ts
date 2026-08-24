import { type Failure, failure, type ResponseEnvelope } from './domain.ts';
import { decodeJsonl, encodeJsonl, errorResponse, request, response } from './protocol.ts';
import type { ModelGenerate, ModelRequest } from './model.ts';

export const LIMITS = {
  sessionMs: 45_000,
  messageBytes: 256 * 1024,
  taskBytes: 8 * 1024,
  contextBytes: 32 * 1024,
  constraintsCount: 32,
  constraintBytes: 1024,
  stdoutBytes: 512 * 1024,
  stderrBytes: 256 * 1024,
  totalOutputBytes: 768 * 1024,
} as const;

export type LimitOverrides = { [Key in keyof typeof LIMITS]?: number };

export interface RunnerOptions {
  readonly denoCommand: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly requestPayload: unknown;
  readonly modelGenerate: ModelGenerate;
  /** The profile selected by the host; extension output is never authoritative. */
  readonly modelProfile: string;
  readonly limits?: LimitOverrides;
}

export interface RunnerResult {
  readonly payload?: unknown;
  readonly failure?: Failure;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly durationMs: number;
  readonly hostCalls: number;
  readonly profile: string;
  readonly argv: readonly string[];
}

const drain = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onBytes: (bytes: number) => void,
): Promise<{ bytes: number; exceeded: boolean }> => {
  const reader = stream.getReader();
  let bytes = 0;
  let exceeded = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      onBytes(bytes);
      if (bytes > limit) exceeded = true;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, exceeded };
};

const spawnArgs = (entrypoint: string): string[] => [
  'run',
  '--no-prompt',
  '--no-config',
  '--no-lock',
  '--cached-only',
  '--no-npm',
  '--no-remote',
  '--deny-read',
  '--deny-write',
  '--deny-net',
  '--deny-env',
  '--deny-sys',
  '--deny-run',
  '--deny-ffi',
  '--deny-import',
  entrypoint,
];

export const runExtension = async (options: RunnerOptions): Promise<RunnerResult> => {
  const limits = { ...LIMITS, ...(options.limits ?? {}) };
  const argv = spawnArgs(options.entrypoint);
  const started = performance.now();
  const initialId = `host-${crypto.randomUUID()}`;
  const initial = encodeJsonl(
    request(initialId, 'extension.execute', options.requestPayload),
    limits.messageBytes,
  );
  if (typeof initial !== 'string') {
    return {
      failure: initial,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
      hostCalls: 0,
      profile: options.modelProfile,
      argv,
    };
  }
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(options.denoCommand, {
      args: argv,
      cwd: options.cwd,
      clearEnv: true,
      env: {},
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
  } catch {
    return {
      failure: failure('plugin_exit', 'extension process could not start'),
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
      hostCalls: 0,
      profile: options.modelProfile,
      argv,
    };
  }
  const writer = child.stdin.getWriter();
  const stdoutReader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let buffer = '';
  let final: ResponseEnvelope | undefined;
  let firstFailure: Failure | undefined;
  let hostCalls = 0;
  let stopped = false;
  const hostAbort = new AbortController();
  let releaseHostWait: (next: Failure) => void = () => {};
  const hostFailure = new Promise<Failure>((resolve) => {
    releaseHostWait = resolve;
  });
  const stop = () => {
    if (!stopped) {
      stopped = true;
      try {
        child.kill('SIGKILL');
      } catch { /* already exited */ }
    }
  };
  const fail = (next: Failure) => {
    if (!firstFailure) firstFailure = next;
    try {
      hostAbort.abort(next.message);
    } catch { /* already aborted */ }
    releaseHostWait(next);
    stop();
  };
  const stderrPromise = drain(child.stderr, limits.stderrBytes, (bytes) => {
    stderrBytes = bytes;
    if (bytes > limits.stderrBytes || stdoutBytes + bytes > limits.totalOutputBytes) {
      fail(failure('process_output_limit', 'extension stderr exceeds configured limit'));
    }
  });
  const timer = setTimeout(
    () => fail(failure('process_timeout', 'extension exceeded session deadline')),
    limits.sessionMs,
  );
  try {
    try {
      await writer.write(new TextEncoder().encode(initial));
    } catch {
      fail(failure('plugin_exit', 'extension stdin write failed'));
    }
    while (!firstFailure) {
      const item = await stdoutReader.read();
      if (item.done) break;
      stdoutBytes += new TextEncoder().encode(item.value).byteLength;
      if (stdoutBytes > limits.stdoutBytes || stdoutBytes + stderrBytes > limits.totalOutputBytes) {
        fail(failure('process_output_limit', 'extension stdout exceeds configured limit'));
        break;
      }
      buffer += item.value;
      let newline = buffer.indexOf('\n');
      while (newline >= 0 && !firstFailure) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const decoded = decodeJsonl(line, limits.messageBytes);
        if ('code' in decoded) {
          fail(decoded);
          break;
        }
        if (decoded.kind === 'request') {
          if (
            final || decoded.parentId !== initialId || decoded.method !== 'host.model.generate' ||
            hostCalls > 0
          ) {
            fail(failure('protocol_violation', 'unexpected host request'));
            break;
          }
          hostCalls++;
          const modelRequest = decoded.payload as ModelRequest;
          const generated = await Promise.race([
            Promise.resolve()
              .then(() => options.modelGenerate(modelRequest, hostAbort.signal))
              .catch(() => failure('host_handler_failed', 'host model handler failed')),
            hostFailure,
          ]);
          if (firstFailure) break;
          // Only the model text crosses the extension boundary. In particular, a
          // profile returned by a model adapter or extension is not an identity
          // that the extension can claim in the run trace.
          const reply = 'code' in generated
            ? errorResponse(
              `host-${crypto.randomUUID()}`,
              decoded.id,
              generated.code,
              generated.message,
            )
            : response(`host-${crypto.randomUUID()}`, decoded.id, { text: generated.text });
          const encoded = encodeJsonl(reply, limits.messageBytes);
          if (typeof encoded !== 'string') {
            fail(encoded);
            break;
          }
          try {
            await writer.write(new TextEncoder().encode(encoded));
          } catch {
            fail(failure('plugin_exit', 'extension stdin write failed'));
          }
        } else if (decoded.kind === 'response' && decoded.replyTo === initialId && !final) {
          final = decoded;
          try {
            await writer.close();
          } catch { /* child may have exited */ }
        } else fail(failure('protocol_violation', 'unexpected extension response'));
        newline = buffer.indexOf('\n');
      }
    }
    if (!firstFailure && buffer.length > 0) {
      fail(failure('protocol_violation', 'extension ended with partial JSONL'));
    }
    const status = await child.status;
    const stderrResult = await stderrPromise;
    stderrBytes = stderrResult.bytes;
    if (!firstFailure && stderrResult.exceeded) {
      fail(failure('process_output_limit', 'extension stderr exceeds configured limit'));
    }
    if (!firstFailure && !status.success) {
      fail(failure('plugin_exit', `extension exited with code ${status.code}`));
    }
    if (!firstFailure && !final) {
      fail(failure('protocol_violation', 'extension exited without final response'));
    }
    if (!firstFailure && hostCalls !== 1) {
      fail(failure('protocol_violation', 'extension must make exactly one host model call'));
    }
    if (!firstFailure && final && !final.ok) {
      firstFailure = failure(
        'protocol_violation',
        final.error?.message ?? 'extension returned failure',
        { code: final.error?.code ?? 'extension_failure' },
      );
    }
    return {
      payload: firstFailure ? undefined : final?.payload,
      failure: firstFailure,
      stdoutBytes,
      stderrBytes,
      durationMs: performance.now() - started,
      hostCalls,
      profile: options.modelProfile,
      argv,
    };
  } finally {
    clearTimeout(timer);
    try {
      hostAbort.abort('extension session ended');
    } catch { /* already aborted */ }
    stop();
    try {
      await child.status;
    } catch { /* already reaped */ }
    stdoutReader.releaseLock();
    try {
      writer.releaseLock();
    } catch { /* closed */ }
  }
};

export const probeArgv = (entrypoint: string): readonly string[] => spawnArgs(entrypoint);
