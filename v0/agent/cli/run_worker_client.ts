import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import { WorkerHostStartupError } from '../worker/worker_host_session.ts';
import type { AgentEvent } from '../core/events.ts';
import {
  HenjiInstructionError,
  henjiInstructionErrorValue,
} from '../instructions/base_instruction.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import { runHeadlessWorker } from '../worker/worker_headless_runner.ts';
import type {
  MainToRunWorker,
  RunWorkerErrorData,
  RunWorkerToMain,
} from './run_worker_protocol.ts';

const encoder = new TextEncoder();

const workerFailureLine = (): string =>
  `${
    JSON.stringify({
      ok: false,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      steps: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      requestCount: 0,
      error: { code: 'agent_failure', message: 'agent run failed' },
    })
  }\n`;

const workerFailure = async (): Promise<number> => {
  await Deno.stderr.write(encoder.encode(workerFailureLine()));
  return 1;
};

const resolutionError = (): RunWorkerErrorData => ({ kind: 'invalid_configuration' });
const runError = (error: unknown): RunWorkerErrorData =>
  error instanceof WorkerHostStartupError && error.code === 'configuration_rejected'
    ? {
      kind: 'configuration',
      value: {
        code: error.code,
        message: 'Agent configuration rejected',
        stage: 'worker_start',
        reason: error.message,
        rejections: error.configurationRejections,
      },
    }
    : error instanceof HenjiInstructionError
    ? { kind: 'instruction', value: henjiInstructionErrorValue(error) }
    : { kind: 'agent_failure' };

/** Launch the CLI Worker; the selected executable Definition remains owned by this process. */
export const runCliWorker = async (args: readonly string[] = Deno.args): Promise<number> => {
  const paths = resolveRuntimePaths();
  const worker = new Worker(new URL('./run_bootstrap.ts', import.meta.url), { type: 'module' });
  let workerAlive = true;
  let workerFailed = false;
  let selection: AgentConfigurationChoice | undefined;
  let doneResolve!: (exitCode: number) => void;
  const done = new Promise<number>((resolve) => {
    doneResolve = resolve;
  });
  const send = (message: MainToRunWorker): void => {
    if (workerAlive) worker.postMessage(message);
  };

  const replyError = (
    kind: 'resolve.error' | 'run.error',
    id: number,
    error: RunWorkerErrorData,
  ): void => send({ kind, id, error });

  worker.onmessage = (event: MessageEvent<RunWorkerToMain>): void => {
    const message = event.data;
    if (message.kind === 'done') {
      workerAlive = false;
      worker.terminate();
      doneResolve(message.exitCode);
      return;
    }
    if (message.kind === 'resolve.request') {
      const resolveSelection = (): void => {
        try {
          if (message.rawAgentName !== undefined && message.rawAgentFile !== undefined) {
            throw new Error('invalid choice');
          }
          selection = message.rawAgentFile === undefined
            ? (message.rawAgentName === undefined ? {} : { name: message.rawAgentName })
            : { file: message.rawAgentFile };
          send({
            kind: 'resolve.result',
            id: message.id,
            selection: { choice: structuredClone(selection) },
          });
        } catch {
          replyError('resolve.error', message.id, resolutionError());
        }
      };
      void resolveSelection();
      return;
    }
    if (message.kind === 'run.request') {
      const run = async (): Promise<void> => {
        try {
          if (selection === undefined) throw new Error('Agent choice was not resolved');
          const result = await runHeadlessWorker(message.task, selection, {
            dataRoot: paths.dataRoot,
            configRoot: paths.configRoot,
            ...(message.options.rootMaxSteps === undefined
              ? {}
              : { rootMaxSteps: message.options.rootMaxSteps }),
            ...(message.options.providerTimeoutMs === undefined
              ? {}
              : { providerTimeoutMs: message.options.providerTimeoutMs }),
            ...(message.events
              ? { eventSink: (event: AgentEvent) => send({ kind: 'run.event', event }) }
              : {}),
          });
          send({ kind: 'run.result', id: message.id, result });
        } catch (error) {
          replyError('run.error', message.id, runError(error));
        }
      };
      void run();
    }
  };

  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    if (!workerAlive) return;
    workerFailed = true;
    workerAlive = false;
    worker.terminate();
    doneResolve(1);
  };
  worker.onmessageerror = (): void => {
    if (!workerAlive) return;
    workerFailed = true;
    workerAlive = false;
    worker.terminate();
    doneResolve(1);
  };

  worker.postMessage(
    {
      kind: 'start',
      args: [...args],
      build: buildManifest(),
      runtimePaths: { dataRoot: paths.dataRoot, configRoot: paths.configRoot },
    } satisfies MainToRunWorker,
  );

  const exitCode = await done;
  return workerFailed ? await workerFailure() : exitCode;
};
