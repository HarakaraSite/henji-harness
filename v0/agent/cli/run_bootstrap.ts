import { installBuildManifest } from '../runtime/build_manifest.ts';
import type { HeadlessWorkerRun } from '../worker/worker_headless_runner.ts';
import { main } from './runtime_cli.ts';
import {
  type CliDefinitionSelectionInfo,
  type CliRunOptions,
  type MainToRunWorker,
  type RunWorkerErrorData,
  RunWorkerPortError,
  type RunWorkerStart,
  type RunWorkerToMain,
} from './run_worker_protocol.ts';
import type { AgentEvent, AgentEventSink } from '../core/events.ts';

type RunWorkerScope = {
  onmessage: ((event: MessageEvent<MainToRunWorker>) => void) | null;
  postMessage(message: RunWorkerToMain): void;
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const scope = globalThis as unknown as RunWorkerScope;
const pending = new Map<
  number,
  { readonly kind: 'resolve'; readonly deferred: Deferred<CliDefinitionSelectionInfo> } | {
    readonly kind: 'run';
    readonly deferred: Deferred<HeadlessWorkerRun>;
    readonly eventSink?: AgentEventSink;
  }
>();
let nextId = 1;
let started = false;

const post = (message: RunWorkerToMain): void => scope.postMessage(message);

const rejectPending = (id: number, error: RunWorkerErrorData): void => {
  const request = pending.get(id);
  if (request === undefined) return;
  pending.delete(id);
  request.deferred.reject(new RunWorkerPortError(error));
};

scope.onmessage = (event: MessageEvent<MainToRunWorker>): void => {
  const message = event.data;
  if (message.kind === 'start') {
    if (started) return;
    started = true;
    const start = message as RunWorkerStart;
    installBuildManifest(start.build);
    const resolveDefinition = (
      rawAgentName: string | undefined,
      rawDefinitionRevision: string | undefined,
    ): Promise<CliDefinitionSelectionInfo> => {
      const id = nextId++;
      const request = deferred<CliDefinitionSelectionInfo>();
      pending.set(id, { kind: 'resolve', deferred: request });
      post({ kind: 'resolve.request', id, rawAgentName, rawDefinitionRevision });
      return request.promise;
    };
    const run = (
      task: string,
      eventSink?: AgentEventSink,
      options?: CliRunOptions,
    ): Promise<HeadlessWorkerRun> => {
      const id = nextId++;
      const request = deferred<HeadlessWorkerRun>();
      pending.set(id, { kind: 'run', deferred: request, eventSink });
      post({
        kind: 'run.request',
        id,
        task,
        events: eventSink !== undefined,
        options: options ?? {},
      });
      return request.promise;
    };

    void main(start.args, {
      resolveDefinition,
      run,
    }).then(
      (exitCode) => post({ kind: 'done', exitCode }),
      () => post({ kind: 'done', exitCode: 1 }),
    );
    return;
  }

  if (message.kind === 'resolve.result') {
    const request = pending.get(message.id);
    if (request?.kind !== 'resolve') return;
    pending.delete(message.id);
    request.deferred.resolve(message.selection);
  } else if (message.kind === 'resolve.error' || message.kind === 'run.error') {
    rejectPending(message.id, message.error);
  } else if (message.kind === 'run.event') {
    const runRequest = [...pending.values()].find((request) => request.kind === 'run');
    runRequest?.eventSink?.(message.event as AgentEvent);
  } else if (message.kind === 'run.result') {
    const request = pending.get(message.id);
    if (request?.kind !== 'run') return;
    pending.delete(message.id);
    request.deferred.resolve(message.result);
  }
};
