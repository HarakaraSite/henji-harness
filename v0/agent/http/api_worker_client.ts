import type { EncodedDataReply } from '../data/client.ts';
import type { CoreService } from '../host/core_service.ts';
import { CoreServiceError, coreServiceErrorData } from '../host/core_service_error.ts';
import type { ApiWorkerToMain, MainToApiWorker } from './api_worker_protocol.ts';

export interface CoreServerOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly onServiceClosed?: () => void | Promise<void>;
}

export interface CoreServerHandle {
  readonly url: string;
  readonly finished: Promise<void>;
  readonly shutdown: () => Promise<void>;
}

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

const replyTransfer = (value: unknown): Transferable[] => {
  if (typeof value !== 'object' || value === null || !('bytes' in value)) return [];
  const bytes = (value as EncodedDataReply).bytes;
  return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
};

/** Start the HTTP adapter in an API Worker and keep Core ownership in this process. */
export const startCoreServer = async (
  service: CoreService,
  options: CoreServerOptions = {},
): Promise<CoreServerHandle> => {
  const worker = new Worker(new URL('./api_bootstrap.ts', import.meta.url), { type: 'module' });
  const ready = deferred<string>();
  const drained = deferred<void>();
  const listenerClosed = deferred<void>();
  const finish = deferred<void>();
  const failed = deferred<Error>();
  void finish.promise.catch(() => {});
  const operations = new Set<Promise<void>>();
  const subscriptions = new Map<number, () => void>();
  const cancelledSubscriptions = new Set<number>();
  let workerAlive = true;
  let failure: Error | undefined;
  let coreClosePromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let failureCleanup: Promise<void> | undefined;

  const send = (message: MainToApiWorker, transfer: Transferable[] = []): void => {
    if (!workerAlive) return;
    worker.postMessage(message, transfer);
  };

  const settleOperations = async (): Promise<void> => {
    while (operations.size > 0) await Promise.allSettled([...operations]);
  };

  const closeCore = (): Promise<void> => {
    if (coreClosePromise !== undefined) return coreClosePromise;
    service.beginShutdown();
    coreClosePromise = (async () => {
      await settleOperations();
      await service.close();
      await options.onServiceClosed?.();
    })();
    return coreClosePromise;
  };

  const fail = (error: unknown): void => {
    if (failure !== undefined) return;
    failure = error instanceof Error ? error : new Error(String(error));
    workerAlive = false;
    ready.reject(failure);
    finish.reject(failure);
    failureCleanup = closeCore().finally(() => worker.terminate());
    void failureCleanup.catch(() => {});
    failed.resolve(failure);
  };

  const invoke = async (
    message: Extract<ApiWorkerToMain, { kind: 'operation' }>,
  ): Promise<void> => {
    const { operation, args, id } = message;
    try {
      let value: unknown;
      if (operation === 'subscribeSession') {
        const subscriptionId = message.subscriptionId;
        if (subscriptionId === undefined) throw new CoreServiceError(500, 'invalid_subscription');
        const subscription = await service.subscribeSession(
          args[0] as string,
          (bytes) => send({ kind: 'session.frame', subscriptionId, bytes }),
        );
        if (cancelledSubscriptions.delete(subscriptionId)) subscription.unsubscribe();
        else subscriptions.set(subscriptionId, subscription.unsubscribe);
        value = undefined;
      } else if (operation === 'coreShutdown') {
        value = await service.coreShutdown(
          args[0] as Parameters<CoreService['coreShutdown']>[0],
          () => send({ kind: 'shutdown.accepted' }),
        );
      } else {
        const call = service[operation] as (...callArgs: unknown[]) => unknown;
        value = await Reflect.apply(call, service, [...args]);
      }
      send({ kind: 'reply', id, value }, replyTransfer(value));
    } catch (error) {
      const data = coreServiceErrorData(error) ?? {
        status: 500,
        code: 'internal_error',
        message: 'core request failed',
      };
      send({ kind: 'reply.error', id, error: data });
    }
  };

  worker.onmessage = (event: MessageEvent<ApiWorkerToMain>): void => {
    const message = event.data;
    if (message.kind === 'ready') {
      ready.resolve(message.url);
    } else if (message.kind === 'operation') {
      const operation = invoke(message);
      operations.add(operation);
      void operation.then(
        () => operations.delete(operation),
        () => operations.delete(operation),
      );
    } else if (message.kind === 'unsubscribe') {
      const unsubscribe = subscriptions.get(message.subscriptionId);
      if (unsubscribe === undefined) cancelledSubscriptions.add(message.subscriptionId);
      else {
        subscriptions.delete(message.subscriptionId);
        unsubscribe();
      }
    } else if (message.kind === 'shutdown.response.returned') {
      void shutdown().catch(fail);
    } else if (message.kind === 'drained') {
      drained.resolve();
    } else if (message.kind === 'listener.closed') {
      workerAlive = false;
      listenerClosed.resolve();
      finish.resolve();
    } else if (message.kind === 'listener.failed') {
      fail(new Error(`API Worker listener failed: ${message.error}`));
    }
  };
  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    fail(new Error(`API Worker failed: ${event.message}`));
  };
  worker.onmessageerror = (): void => fail(new Error('API Worker message could not be cloned'));

  worker.postMessage(
    {
      kind: 'start',
      options: {
        hostname: options.hostname ?? '127.0.0.1',
        port: options.port ?? 0,
      },
    } satisfies MainToApiWorker,
  );

  let url: string;
  try {
    url = await ready.promise;
  } catch (error) {
    await failureCleanup;
    throw error;
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      if (failure !== undefined) {
        await failureCleanup;
        return;
      }
      service.beginShutdown();
      send({ kind: 'drain' });
      try {
        await Promise.race([
          drained.promise,
          failed.promise.then((error) => Promise.reject(error)),
        ]);
        await settleOperations();
        await closeCore();
        send({ kind: 'stop.listener' });
        await Promise.race([
          listenerClosed.promise,
          failed.promise.then((error) => Promise.reject(error)),
        ]);
        await finish.promise;
      } catch (error) {
        if (failure === undefined) fail(error);
        await failureCleanup;
      }
    })();
    return shutdownPromise;
  };

  return { url, finished: finish.promise, shutdown };
};
