import { error, type HarnessError } from '../domain/errors.ts';
import {
  decodeJsonlLine,
  DEFAULT_MAX_MESSAGE_BYTES,
  encodeJsonl,
} from '../protocol/jsonl_codec.ts';
import { type Envelope, type ResponseEnvelope } from '../protocol/envelope.ts';

export interface PluginProcessOptions {
  readonly denoCommand: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxMessageBytes?: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxTotalOutputBytes: number;
}

export interface PluginProcessResult {
  readonly response?: ResponseEnvelope;
  readonly failure?: HarnessError;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly durationMs: number;
}

interface StreamResult {
  readonly text: string;
  readonly byteLength: number;
  readonly exceeded: boolean;
}

const decoder = new TextDecoder();

const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<StreamResult> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength <= maxBytes) chunks.push(value);
      else exceeded = true;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: decoder.decode(concat(chunks)), byteLength, exceeded };
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const responseFromStdout = (
  stdout: string,
  requestId: string,
  maxMessageBytes: number,
): ResponseEnvelope | HarnessError => {
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  if (lines.length !== 1 || lines[0] === '') {
    return error('protocol_violation', 'plugin stdout must contain exactly one JSONL response');
  }
  const envelope = decodeJsonlLine(lines[0], maxMessageBytes);
  if (!('kind' in envelope)) return error('protocol_violation', envelope.message);
  if (envelope.kind !== 'response' || envelope.replyTo !== requestId) {
    return error('protocol_violation', 'plugin response must reply to the supplied request');
  }
  return envelope;
};

export const runPlugin = async (
  request: Envelope,
  options: PluginProcessOptions,
): Promise<PluginProcessResult> => {
  const started = performance.now();
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const encoded = encodeJsonl(request, maxMessageBytes);
  if (typeof encoded !== 'string') {
    return { failure: encoded, stderr: '', stdoutBytes: 0, stderrBytes: 0, durationMs: 0 };
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
  const stdoutPromise = readBounded(child.stdout, options.maxStdoutBytes);
  const stderrPromise = readBounded(child.stderr, options.maxStderrBytes);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }, options.timeoutMs);

  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(encoded));
    await writer.close();
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      stdoutPromise,
      stderrPromise,
    ]);
    const durationMs = performance.now() - started;
    const totalOutput = stdout.byteLength + stderr.byteLength;
    if (stdout.exceeded || stderr.exceeded || totalOutput > options.maxTotalOutputBytes) {
      return {
        failure: error('process_output_limit', 'plugin output exceeds a configured byte limit'),
        stderr: stderr.text,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        durationMs,
      };
    }
    if (timedOut) {
      return {
        failure: error('process_timeout', 'plugin exceeded timeout'),
        stderr: stderr.text,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        durationMs,
      };
    }
    if (!status.success) {
      return {
        failure: error('plugin_exit', `plugin exited with code ${status.code}`),
        stderr: stderr.text,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        durationMs,
      };
    }
    const response = responseFromStdout(stdout.text, request.id, maxMessageBytes);
    if ('code' in response) {
      return {
        failure: response,
        stderr: stderr.text,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        durationMs,
      };
    }
    return {
      response,
      stderr: stderr.text,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      durationMs,
    };
  } catch (caught) {
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const durationMs = performance.now() - started;
    return {
      failure: error(
        timedOut ? 'process_timeout' : 'plugin_exit',
        timedOut ? 'plugin exceeded timeout' : String(caught),
      ),
      stderr: stderr.text,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
      durationMs,
    };
  } finally {
    clearTimeout(timeout);
  }
};
