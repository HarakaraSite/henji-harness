import type { CoreService } from '../host/core_service.ts';
import { CoreServiceError } from '../host/core_service_error.ts';
import type { CoreSessionFrameSink } from '../host/core_service.ts';
import {
  type ApiOperationName,
  type ApiWorkerToMain,
  type MainToApiWorker,
} from './api_worker_protocol.ts';
import { type CoreHttpApi, type CoreHttpSubscription, createCoreRequestHandler } from './server.ts';

type ApiWorkerScope = {
  onmessage: ((event: MessageEvent<MainToApiWorker>) => void) | null;
  postMessage(message: ApiWorkerToMain): void;
  close(): void;
};

const scope = globalThis as unknown as ApiWorkerScope;
let server: Deno.HttpServer | undefined;
let admissionClosed = false;
let stoppingListener = false;
let nextRequestId = 1;
let drainPromise: Promise<void> | undefined;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();
const subscriptions = new Map<number, CoreSessionFrameSink>();
const activeHandlers = new Set<Promise<Response>>();

const post = (message: ApiWorkerToMain): void => scope.postMessage(message);

const rpc = (
  operation: ApiOperationName,
  args: readonly unknown[] = [],
  subscriptionId?: number,
): Promise<unknown> => {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({
      kind: 'operation',
      id,
      operation,
      args,
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    });
  });
};

const api: CoreHttpApi = {
  coreRead: async () => await rpc('coreRead') as Awaited<ReturnType<CoreService['coreRead']>>,
  coreShutdown: async (input, onAccepted) => {
    const value = await rpc('coreShutdown', [input]);
    if ((value as { kind?: string }).kind === 'accepted') onAccepted?.();
    return value as Awaited<ReturnType<CoreService['coreShutdown']>>;
  },
  subscribeSession(sessionId, sink, subscriptionId): CoreHttpSubscription {
    subscriptions.set(subscriptionId, sink);
    let active = true;
    const ready = rpc('subscribeSession', [sessionId], subscriptionId).then(
      () => {},
    );
    return {
      ready,
      unsubscribe() {
        if (!active) return;
        active = false;
        subscriptions.delete(subscriptionId);
        post({ kind: 'unsubscribe', subscriptionId });
      },
    };
  },
  sessionsList: async () =>
    await rpc('sessionsList') as Awaited<
      ReturnType<CoreService['sessionsList']>
    >,
  sessionRead: async (sessionId) =>
    await rpc('sessionRead', [sessionId]) as Awaited<
      ReturnType<CoreService['sessionRead']>
    >,
  sessionOpen: async (input) =>
    await rpc('sessionOpen', [input]) as Awaited<
      ReturnType<CoreService['sessionOpen']>
    >,
  sessionDelete: async (sessionId, input) =>
    await rpc('sessionDelete', [sessionId, input]) as Awaited<
      ReturnType<CoreService['sessionDelete']>
    >,
  sessionRename: async (sessionId, input) =>
    await rpc('sessionRename', [sessionId, input]) as Awaited<
      ReturnType<CoreService['sessionRename']>
    >,
  selectionChange: async (sessionId, input) =>
    await rpc('selectionChange', [sessionId, input]) as Awaited<
      ReturnType<CoreService['selectionChange']>
    >,
  catalogRead: async (input) =>
    await rpc('catalogRead', [input]) as Awaited<
      ReturnType<CoreService['catalogRead']>
    >,
  modelFavorite: async (input) =>
    await rpc('modelFavorite', [input]) as Awaited<
      ReturnType<CoreService['modelFavorite']>
    >,
  credentialPresenceRead: async () =>
    await rpc('credentialPresenceRead') as Awaited<
      ReturnType<CoreService['credentialPresenceRead']>
    >,
  chatgptAuth: async (input) =>
    await rpc('chatgptAuth', [input]) as Awaited<
      ReturnType<CoreService['chatgptAuth']>
    >,
  credentialRegister: async (input) =>
    await rpc('credentialRegister', [input]) as Awaited<
      ReturnType<CoreService['credentialRegister']>
    >,
  recall: async (sessionId, input) =>
    await rpc('recall', [sessionId, input]) as Awaited<
      ReturnType<CoreService['recall']>
    >,
  contextRead: async (sessionId) =>
    await rpc('contextRead', [sessionId]) as Awaited<
      ReturnType<CoreService['contextRead']>
    >,
  taskSubmit: async (sessionId, input) =>
    await rpc('taskSubmit', [sessionId, input]) as Awaited<
      ReturnType<CoreService['taskSubmit']>
    >,
  executionCancel: async (sessionId, executionId, input) =>
    await rpc('executionCancel', [sessionId, executionId, input]) as Awaited<
      ReturnType<CoreService['executionCancel']>
    >,
  steeringSubmit: async (sessionId, executionId, input) =>
    await rpc('steeringSubmit', [sessionId, executionId, input]) as Awaited<
      ReturnType<CoreService['steeringSubmit']>
    >,
  followUpQueue: async (sessionId, input) =>
    await rpc('followUpQueue', [sessionId, input]) as Awaited<
      ReturnType<CoreService['followUpQueue']>
    >,
  followUpPageRead: async (sessionId, cursor) =>
    await rpc('followUpPageRead', [sessionId, cursor]) as Awaited<
      ReturnType<CoreService['followUpPageRead']>
    >,
  followUpRead: async (sessionId, queueId) =>
    await rpc('followUpRead', [sessionId, queueId]) as Awaited<
      ReturnType<CoreService['followUpRead']>
    >,
  commandRead: async (commandId) =>
    await rpc('commandRead', [commandId]) as Awaited<
      ReturnType<CoreService['commandRead']>
    >,
  executionRead: async (executionId) =>
    await rpc('executionRead', [executionId]) as Awaited<
      ReturnType<CoreService['executionRead']>
    >,
  conversationPageRead: async (sessionId, cursor, direction) =>
    await rpc('conversationPageRead', [
      sessionId,
      cursor,
      direction,
    ]) as Awaited<
      ReturnType<CoreService['conversationPageRead']>
    >,
  conversationContentRead: async (locator, offset, length) =>
    await rpc('conversationContentRead', [locator, offset, length]) as Awaited<
      ReturnType<CoreService['conversationContentRead']>
    >,
  historyStreamOpen: async (input) =>
    await rpc('historyStreamOpen', [input]) as Awaited<
      ReturnType<CoreService['historyStreamOpen']>
    >,
  historyStreamRead: async (streamId) =>
    await rpc('historyStreamRead', [streamId]) as Awaited<
      ReturnType<CoreService['historyStreamRead']>
    >,
  historyStreamClose: async (streamId) => {
    await rpc('historyStreamClose', [streamId]);
  },
  historyRead: async (input) =>
    await rpc('historyRead', [input]) as Awaited<
      ReturnType<CoreService['historyRead']>
    >,
};

const onMessage = (event: MessageEvent<MainToApiWorker>): void => {
  const message = event.data;
  if (message.kind === 'start') {
    try {
      const handler = createCoreRequestHandler(api, {
        isAdmissionClosed: () => admissionClosed,
        onShutdownAccepted: () => admissionClosed = true,
        scheduleShutdown: () => {
          setTimeout(() => post({ kind: 'shutdown.response.returned' }), 0);
        },
      });
      server = Deno.serve(
        {
          hostname: message.options.hostname,
          port: message.options.port,
          onListen() {},
        },
        (request) => {
          const operation = handler(request);
          activeHandlers.add(operation);
          void operation.then(
            () => activeHandlers.delete(operation),
            () => activeHandlers.delete(operation),
          );
          return operation;
        },
      );
      const runningServer = server;
      void runningServer.finished.then(
        () => {
          if (!stoppingListener) {
            post({
              kind: 'listener.failed',
              error: 'API HTTP listener finished unexpectedly',
            });
          }
        },
        (error) => {
          if (!stoppingListener) {
            post({
              kind: 'listener.failed',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      const address = server.addr as Deno.NetAddr;
      const host = message.options.hostname.includes(':')
        ? `[${message.options.hostname}]`
        : message.options.hostname;
      post({ kind: 'ready', url: `http://${host}:${address.port}` });
    } catch (error) {
      post({
        kind: 'listener.failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (message.kind === 'reply' || message.kind === 'reply.error') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.kind === 'reply.error') {
      waiter?.reject(
        new CoreServiceError(
          message.error.status,
          message.error.code,
          message.error.message,
        ),
      );
    } else {
      waiter?.resolve(message.value);
    }
    return;
  }
  if (message.kind === 'session.frame') {
    void Promise.resolve(
      subscriptions.get(message.subscriptionId)?.(message.bytes),
    )
      .finally(() =>
        post({
          kind: 'session.ack',
          subscriptionId: message.subscriptionId,
          sequence: message.sequence,
        })
      );
    return;
  }
  if (message.kind === 'shutdown.accepted') {
    admissionClosed = true;
    return;
  }
  if (message.kind === 'drain') {
    admissionClosed = true;
    drainPromise ??= (async () => {
      // Every RPC belongs to a handler, including the awaited subscription.ready.
      while (activeHandlers.size > 0) {
        await Promise.allSettled([...activeHandlers]);
      }
      post({ kind: 'drained' });
    })();
    return;
  }
  if (message.kind === 'stop.listener') {
    stoppingListener = true;
    void (async () => {
      try {
        await drainPromise;
        await server?.shutdown();
        await server?.finished;
        post({ kind: 'listener.closed' });
        scope.close();
      } catch (error) {
        post({
          kind: 'listener.failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
};

scope.onmessage = onMessage;
