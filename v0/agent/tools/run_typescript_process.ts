import type { Workspace } from './work_tool_contract.ts';
import type { ToolContext } from './tools.ts';
import type { ProcessExecutor, ProcessOperation } from '../runtime/process_contract.ts';
import { runtimeProcessRunnerLaunch } from '../runtime/process_executor.ts';
import {
  CancellationCleanupError,
  throwIfCancelled,
  TurnCancelledError,
} from '../core/cancellation.ts';

export interface TypescriptProcessInput {
  readonly code: string;
  readonly workspace: Workspace;
  readonly input: unknown;
}
export type TypescriptProcessReply =
  | { readonly ok: true; readonly result: string }
  | { readonly ok: false; readonly error: string };

const discard = (stream: ReadableStream<Uint8Array>): Promise<void> =>
  stream.pipeTo(new WritableStream<Uint8Array>({ write() {} }));

/** The existing Host process owner remains responsible for physical spawn, stop and settlement. */
export const executeTypescriptProcess = async (
  code: string,
  workspace: Workspace,
  input: unknown,
  processes: ProcessExecutor,
  context?: ToolContext,
): Promise<string> => {
  const signal = context?.signal;
  throwIfCancelled(signal);
  const directory = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-code-process-',
  });
  const inputPath = `${directory}/input.json`;
  const resultPath = `${directory}/result.json`;
  await Deno.writeTextFile(
    inputPath,
    JSON.stringify({ code, workspace, input }),
  );
  throwIfCancelled(signal);
  const applicationArgs = ['--internal-run-typescript', inputPath, resultPath];
  const args = Deno.build.standalone ? applicationArgs : [
    'run',
    '--no-prompt',
    '--cached-only',
    '--unstable-worker-options',
    '--allow-read',
    '--allow-write',
    '--allow-net',
    '--allow-env=HOME,NODE_V8_COVERAGE',
    '--config',
    new URL('../../../deno.v0.json', import.meta.url).pathname,
    new URL('../cli/henji_cli.ts', import.meta.url).pathname,
    ...applicationArgs,
  ];
  const launch = runtimeProcessRunnerLaunch(Deno.execPath(), args);
  let operation: ProcessOperation | undefined;
  let stopping: Promise<void> | undefined;
  const onAbort = (): void => {
    if (operation !== undefined) {
      stopping ??= operation.stop();
      void stopping.catch(() => {});
    }
  };
  try {
    operation = processes.start({
      ...launch,
      cwd: workspace.root,
      // Only source-runtime discovery needs HOME; no credential or provider environment is copied.
      env: { HOME: Deno.env.get('HOME') ?? '/tmp' },
    }, {
      callId: context !== undefined && 'callId' in context ? context.callId : undefined,
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const drains = Promise.all([
      discard(operation.stdout),
      discard(operation.stderr),
    ]);
    void drains.catch(() => {});
    const status = await operation.status;
    await operation.closed;
    await drains;
    if (signal?.aborted) {
      await stopping;
      throw new TurnCancelledError();
    }
    if (status.exitCode !== 0) {
      throw new Error(
        `TypeScript execution process exited (${status.signal ?? status.exitCode})`,
      );
    }
    const reply: TypescriptProcessReply = JSON.parse(
      await Deno.readTextFile(resultPath),
    );
    throwIfCancelled(signal);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  } catch (error) {
    if (operation !== undefined) {
      try {
        await (stopping ?? operation.stop());
        await operation.closed;
      } catch {
        if (signal?.aborted) throw new CancellationCleanupError();
        throw error;
      }
    }
    if (signal?.aborted) throw new TurnCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await operation?.release();
  }
};
