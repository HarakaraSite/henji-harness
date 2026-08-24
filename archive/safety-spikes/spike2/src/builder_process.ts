import { ADMISSION_LIMITS } from './admission_profile.ts';
import {
  type BuilderCompiledResponseV1,
  type BuilderRequestV1,
  type BuilderResponseV1,
  decodeFrame,
  encodeFrame,
} from './builder_protocol.ts';
import { digestValue, exactObject, stringValue } from './runtime_schema.ts';
import { domainDigest } from '../../spike1/src/digests.ts';
import { TYPESCRIPT_ENV_NAMES } from './builder_environment.ts';

export interface BuilderPathsV1 {
  readonly denoExecutable: string;
  readonly repositoryRoot: string;
  readonly cacheDirectory: string;
  readonly emptyWorkingDirectory: string;
}

export type BuilderProcessResultV1 =
  | { readonly status: 'completed'; readonly response: BuilderResponseV1; readonly stderr: string }
  | {
    readonly status: 'failed';
    readonly code: 'builder_busy' | 'builder_timeout' | 'builder_protocol';
    readonly stderr: string;
  };

let builderActive = false;

const collectBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let exceeded = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit + 1 - kept;
      if (remaining > 0) {
        const part = value.subarray(0, remaining);
        chunks.push(part);
        kept += part.byteLength;
      }
      if (kept > limit || value.byteLength > remaining) exceeded = true;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(Math.min(kept, limit + 1));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
};

const canonicalBase64Bytes = (value: unknown, expectedCount: unknown): Uint8Array => {
  const encoded = stringValue(value, 'artifactBytesBase64', 180_000);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('base64 alphabet');
  }
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!Number.isSafeInteger(expectedCount) || expectedCount !== bytes.byteLength) {
    throw new Error('artifact length');
  }
  if (btoa(binary) !== encoded || bytes.byteLength > ADMISSION_LIMITS.emittedArtifactBytes) {
    throw new Error('base64 canonical');
  }
  return bytes;
};

export const validateBuilderResponse = async (
  value: unknown,
  request: BuilderRequestV1,
): Promise<BuilderResponseV1> => {
  if (typeof value !== 'object' || value === null) throw new Error('response object');
  const status = (value as { status?: unknown }).status;
  if (status === 'compiled') {
    const response = exactObject(value, [
      'schemaVersion',
      'requestId',
      'status',
      'sourceHash',
      'compilerOptionsDigest',
      'emittedMediaType',
      'artifactBytesBase64',
      'artifactByteCount',
      'diagnostics',
      'closure',
    ], '$builderResponse');
    if (
      response.schemaVersion !== 'builder-response/v1' ||
      response.requestId !== request.requestId || response.sourceHash !== request.sourceHash ||
      response.compilerOptionsDigest !== request.compilerOptionsDigest ||
      response.emittedMediaType !== 'application/javascript+module' ||
      !Array.isArray(response.diagnostics) || response.diagnostics.length !== 0
    ) throw new Error('response binding');
    const closure = exactObject(response.closure, ['schemaVersion', 'modules'], 'closure');
    if (
      closure.schemaVersion !== 'module-closure/v1' || !Array.isArray(closure.modules) ||
      closure.modules.length !== 0
    ) throw new Error('response closure');
    canonicalBase64Bytes(response.artifactBytesBase64, response.artifactByteCount);
    return response as unknown as BuilderCompiledResponseV1;
  }
  const response = exactObject(
    value,
    ['schemaVersion', 'requestId', 'status', 'stage', 'code', 'detailsDigest'],
    '$builderResponse',
  );
  if (
    response.schemaVersion !== 'builder-response/v1' || response.status !== 'rejected' ||
    response.requestId !== request.requestId || response.stage !== 'builder' ||
    !['compiler_diagnostic', 'artifact_oversize'].includes(String(response.code))
  ) throw new Error('rejected response binding');
  const detailsDigest = digestValue(response.detailsDigest, 'detailsDigest');
  const expectedDetails = await domainDigest('henji/spike2/rejection-details/v1', {
    stage: response.stage,
    code: response.code,
  });
  if (detailsDigest !== expectedDetails) throw new Error('rejected details binding');
  return response as unknown as BuilderResponseV1;
};

export const artifactBytesFromResponse = (response: BuilderCompiledResponseV1): Uint8Array =>
  canonicalBase64Bytes(response.artifactBytesBase64, response.artifactByteCount);

const stderrText = (output: { bytes: Uint8Array; exceeded: boolean }): string => {
  const marker = '\n[truncated]';
  if (!output.exceeded) return new TextDecoder().decode(output.bytes);
  const markerBytes = new TextEncoder().encode(marker);
  const kept = output.bytes.subarray(0, ADMISSION_LIMITS.stderrBytes - markerBytes.byteLength);
  return `${new TextDecoder().decode(kept)}${marker}`;
};

export const runBuilder = async (
  paths: BuilderPathsV1,
  request: BuilderRequestV1,
): Promise<BuilderProcessResultV1> => {
  if (builderActive) return { status: 'failed', code: 'builder_busy', stderr: '' };
  builderActive = true;
  let child: Deno.ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const allowEnv = TYPESCRIPT_ENV_NAMES.join(',');
    const root = paths.repositoryRoot;
    const command = new Deno.Command(paths.denoExecutable, {
      args: [
        'run',
        `--config=${root}/deno.spike2.json`,
        '--cached-only',
        '--frozen',
        `--lock=${root}/deno.spike2.lock`,
        '--node-modules-dir=none',
        '--no-remote',
        '--no-prompt',
        '--no-check',
        `--allow-read=${root}/spike2/builder,${root}/spike2/src,${paths.cacheDirectory}`,
        '--deny-write',
        '--deny-net',
        `--allow-env=${allowEnv}`,
        '--deny-sys',
        '--deny-run',
        '--deny-ffi',
        '--deny-import',
        `${root}/spike2/builder/main.ts`,
      ],
      cwd: paths.emptyWorkingDirectory,
      clearEnv: true,
      env: { DENO_DIR: paths.cacheDirectory },
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    });
    child = command.spawn();
    const stdoutPromise = collectBounded(child.stdout, ADMISSION_LIMITS.builderResponseBytes + 4);
    const stderrPromise = collectBounded(child.stderr, ADMISSION_LIMITS.stderrBytes);
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ADMISSION_LIMITS.builderTimeoutMilliseconds);
    });
    const completion = (async () => {
      const writer = child!.stdin.getWriter();
      try {
        await writer.write(encodeFrame(request, ADMISSION_LIMITS.builderRequestBytes));
        await writer.close();
      } catch (error) {
        try {
          await writer.abort(error);
        } catch {
          // The child may already have closed the pipe.
        }
        throw error;
      }
      const status = await child!.status;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return { status, stdout, stderr };
    })();
    const outcome = await Promise.race([completion, timeout]).catch(() => 'exception' as const);
    if (outcome === 'timeout') {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited between the deadline and kill.
      }
      await Promise.allSettled([child.status, completion, stdoutPromise, stderrPromise]);
      const stderr = await stderrPromise;
      return {
        status: 'failed',
        code: 'builder_timeout',
        stderr: stderrText(stderr),
      };
    }
    if (outcome === 'exception') {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      await Promise.allSettled([child.status, completion, stdoutPromise, stderrPromise]);
      const stderr = await stderrPromise;
      return { status: 'failed', code: 'builder_protocol', stderr: stderrText(stderr) };
    }
    const renderedStderr = stderrText(outcome.stderr);
    if (!outcome.status.success || outcome.stdout.exceeded) {
      return { status: 'failed', code: 'builder_protocol', stderr: renderedStderr };
    }
    try {
      return {
        status: 'completed',
        response: await validateBuilderResponse(
          decodeFrame(outcome.stdout.bytes, ADMISSION_LIMITS.builderResponseBytes),
          request,
        ),
        stderr: renderedStderr,
      };
    } catch {
      return { status: 'failed', code: 'builder_protocol', stderr: renderedStderr };
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    builderActive = false;
  }
};
