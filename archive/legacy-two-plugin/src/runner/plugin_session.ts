import { error, type HarnessError } from '../domain/errors.ts';
import { decodeJsonlLine, encodeJsonl } from '../protocol/jsonl_codec.ts';
import type { RequestEnvelope, ResponseEnvelope } from '../protocol/envelope.ts';
import type { PluginProcessOptions, PluginProcessResult } from './plugin_process.ts';

export type HostRequestHandler = (request: RequestEnvelope) => Promise<ResponseEnvelope>;

const drainBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onChunk: (bytes: number) => void,
) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let exceeded = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      onChunk(bytes);
      if (bytes <= limit) chunks.push(next.value);
      else exceeded = true;
    }
  } finally {
    reader.releaseLock();
  }
  const kept = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded, text: new TextDecoder().decode(result) };
};

export const runPluginSession = async (
  request: RequestEnvelope,
  options: PluginProcessOptions,
  handleHostRequest: HostRequestHandler,
): Promise<PluginProcessResult> => {
  const started = performance.now();
  const deadline = started + options.timeoutMs;
  const initial = encodeJsonl(request, options.maxMessageBytes);
  if (typeof initial !== 'string') {
    return { failure: initial, stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 0 };
  }
  const child = new Deno.Command(options.denoCommand, {
    args: [
      'run',
      '--no-prompt',
      '--no-config',
      `--allow-read=${options.entrypoint.slice(0, options.entrypoint.lastIndexOf('/'))}`,
      options.entrypoint,
    ],
    cwd: options.cwd,
    env: {},
    clearEnv: true,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let stdoutBytes = 0;
  let final: ResponseEnvelope | undefined;
  let failure: HarnessError | undefined;
  let timedOut = false;
  let hostCallMade = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGKILL');
    } catch { /* exited */ }
  };
  const fail = (next: HarnessError) => {
    if (!failure) failure = next;
    stop();
  };
  const stderrPromise = drainBounded(child.stderr, options.maxStderrBytes, (bytes) => {
    if (bytes > options.maxStderrBytes || stdoutBytes + bytes > options.maxTotalOutputBytes) {
      fail(error('process_output_limit', 'plugin output exceeds a configured byte limit'));
    }
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const writeToPlugin = async (text: string): Promise<boolean> => {
    try {
      await writer.write(new TextEncoder().encode(text));
      return true;
    } catch {
      fail(error('plugin_exit', 'plugin closed stdin before the session completed'));
      return false;
    }
  };
  const closePluginStdin = async () => {
    try {
      await writer.close();
    } catch {
      fail(error('plugin_exit', 'plugin closed stdin before the session completed'));
    }
  };
  try {
    await writeToPlugin(initial);
    while (!failure) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutBytes += new TextEncoder().encode(value).byteLength;
      if (stdoutBytes > options.maxStdoutBytes || stdoutBytes > options.maxTotalOutputBytes) {
        fail(error('process_output_limit', 'plugin stdout exceeds the configured byte limit'));
        break;
      }
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const envelope = decodeJsonlLine(line, options.maxMessageBytes);
        if (!('kind' in envelope)) {
          fail(error('protocol_violation', envelope.message));
          break;
        }
        if (envelope.kind === 'request' && !final) {
          if (hostCallMade || envelope.parentId !== request.id) {
            fail(error('protocol_violation', 'unexpected nested host request'));
            break;
          }
          hostCallMade = true;
          let handlerTimer: ReturnType<typeof setTimeout> | undefined;
          let reply: ResponseEnvelope;
          try {
            const remainingMs = Math.max(0, deadline - performance.now());
            reply = await Promise.race([
              handleHostRequest(envelope),
              new Promise<ResponseEnvelope>((_, reject) => {
                handlerTimer = setTimeout(
                  () => {
                    timedOut = true;
                    stop();
                    reject(new Error('session timed out'));
                  },
                  remainingMs,
                );
              }),
            ]);
          } catch (caught) {
            fail(
              timedOut
                ? error('process_timeout', 'plugin exceeded timeout')
                : error('host_handler_failed', 'host request handler failed', {
                  code: 'host_handler_error',
                  message: String(caught),
                }),
            );
            break;
          } finally {
            if (handlerTimer !== undefined) clearTimeout(handlerTimer);
          }
          if (reply.replyTo !== envelope.id) {
            fail(error('protocol_violation', 'host response does not reply to its request'));
            break;
          }
          const encoded = encodeJsonl(reply, options.maxMessageBytes);
          if (typeof encoded !== 'string') {
            fail(encoded);
            break;
          }
          await writeToPlugin(encoded);
        } else if (envelope.kind === 'response' && envelope.replyTo === request.id && !final) {
          final = envelope;
          await closePluginStdin();
        } else {
          fail(error('protocol_violation', 'unexpected plugin envelope'));
          break;
        }
      }
    }
    if (!failure && buffer.length > 0) {
      fail(error('protocol_violation', 'plugin stdout ended with a partial JSONL line'));
    }
    const status = await child.status;
    const stderrResult = await stderrPromise;
    const stderr = stderrResult.text;
    if (
      !failure &&
      (stderrResult.exceeded || stdoutBytes + stderrResult.bytes > options.maxTotalOutputBytes)
    ) fail(error('process_output_limit', 'plugin output exceeds a configured byte limit'));
    if (!failure && timedOut) failure = error('process_timeout', 'plugin exceeded timeout');
    if (!failure && !status.success) {
      failure = error('plugin_exit', `plugin exited with code ${status.code}`);
    }
    if (!failure && !final) {
      failure = error(
        'protocol_violation',
        'plugin exited without final response',
      );
    }
    return {
      response: failure ? undefined : final,
      failure,
      stderr,
      stdoutBytes,
      stderrBytes: stderrResult.bytes,
      durationMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timeout);
    try {
      stop();
    } catch { /* exited */ }
    await child.status;
    reader.releaseLock();
  }
};
