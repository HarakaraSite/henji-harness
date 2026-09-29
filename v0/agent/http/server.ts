import {
  type CoreService,
  CoreServiceError,
  type CoreSessionFrameSink,
} from '../host/core_service.ts';
import type {
  CatalogReadInput,
  CoreShutdownInput,
  CredentialRegisterInput,
  ExecutionCancelInput,
  FollowUpQueueInput,
  RecallInput,
  SelectionChangeInput,
  SessionOpenInput,
  SessionRenameInput,
  SteeringSubmitInput,
  TaskSubmitInput,
} from '../../api/contract.ts';

const encoder = new TextEncoder();

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const errorResponse = (error: unknown): Response => {
  if (error instanceof CoreServiceError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  return json({
    error: { code: 'internal_error', message: 'core request failed' },
  }, 500);
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new CoreServiceError(
      400,
      'invalid_json',
      'request body must be JSON',
    );
  }
};

const readSessionOpenInput = async (
  request: Request,
): Promise<SessionOpenInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    !object(value.selection) ||
    !['new', 'continue', 'exact', 'none'].includes(
      String(value.selection.kind),
    ) ||
    (value.selection.kind === 'exact' &&
      typeof value.selection.sessionId !== 'string') ||
    (value.activation !== undefined && !object(value.activation))
  ) {
    throw new CoreServiceError(
      400,
      'invalid_session_open',
      'invalid session open input',
    );
  }
  if (object(value.activation)) {
    for (const key of ['agent', 'definitionRevision', 'rootProvider']) {
      if (
        value.activation[key] !== undefined &&
        typeof value.activation[key] !== 'string'
      ) {
        throw new CoreServiceError(400, 'invalid_session_open');
      }
    }
    for (const key of ['maxSteps', 'providerTimeoutMs']) {
      const field = value.activation[key];
      if (
        field !== undefined &&
        (typeof field !== 'number' || !Number.isSafeInteger(field) ||
          field <= 0)
      ) {
        throw new CoreServiceError(400, 'invalid_session_open');
      }
    }
  }
  if (
    value.fromSessionId !== undefined && typeof value.fromSessionId !== 'string'
  ) {
    throw new CoreServiceError(400, 'invalid_session_open');
  }
  return value as unknown as SessionOpenInput;
};

const readSessionRenameInput = async (
  request: Request,
): Promise<SessionRenameInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    typeof value.title !== 'string'
  ) {
    throw new CoreServiceError(400, 'invalid_session_rename');
  }
  return { commandId: value.commandId, title: value.title };
};

const readSelectionChangeInput = async (
  request: Request,
): Promise<SelectionChangeInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    !object(value.selection) ||
    typeof value.selection.provider !== 'string' ||
    typeof value.selection.modelId !== 'string' ||
    typeof value.selection.effort !== 'string'
  ) throw new CoreServiceError(400, 'invalid_selection_change');
  return {
    commandId: value.commandId,
    selection: {
      provider: value.selection.provider,
      modelId: value.selection.modelId,
      effort: value.selection.effort,
    },
  };
};

const readCredentialRegisterInput = async (
  request: Request,
): Promise<CredentialRegisterInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.authProfile !== 'string' ||
    typeof value.value !== 'string'
  ) throw new CoreServiceError(400, 'invalid_credential_register');
  return { authProfile: value.authProfile, value: value.value };
};

const readCoreShutdownInput = async (
  request: Request,
): Promise<CoreShutdownInput> => {
  const value = await readJson(request);
  if (!object(value) || typeof value.commandId !== 'string') {
    throw new CoreServiceError(400, 'invalid_core_shutdown');
  }
  return { commandId: value.commandId };
};

const readCatalogInput = (url: URL): CatalogReadInput => {
  const kind = url.searchParams.get('kind');
  if (kind === 'providers' || kind === 'credentials') return { kind };
  const provider = url.searchParams.get('provider');
  if (kind === 'models' && provider !== null) {
    return {
      kind,
      provider,
      ...(url.searchParams.has('sessionId')
        ? { sessionId: url.searchParams.get('sessionId')! }
        : {}),
    };
  }
  const modelId = url.searchParams.get('modelId');
  if (kind === 'efforts' && provider !== null && modelId !== null) {
    return { kind, provider, modelId };
  }
  throw new CoreServiceError(
    400,
    'invalid_catalog_query',
    'invalid catalog query',
  );
};

const readRecallInput = async (request: Request): Promise<RecallInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    (value.action !== 'prepare' && value.action !== 'clear') ||
    (value.executionId !== undefined && typeof value.executionId !== 'string')
  ) {
    throw new CoreServiceError(400, 'invalid_recall');
  }
  return value as unknown as RecallInput;
};

const readTaskSubmitInput = async (
  request: Request,
): Promise<TaskSubmitInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new CoreServiceError(
      400,
      'invalid_task_submit',
      'invalid task submit input',
    );
  }
  return { commandId: value.commandId, text: value.text };
};

const readSteeringSubmitInput = async (
  request: Request,
): Promise<SteeringSubmitInput> => {
  const value = await readTaskSubmitInput(request);
  return value;
};

const readFollowUpQueueInput = async (
  request: Request,
): Promise<FollowUpQueueInput> => {
  const value = await readJson(request);
  if (
    !object(value) || typeof value.commandId !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.afterExecutionId !== 'string'
  ) {
    throw new CoreServiceError(
      400,
      'invalid_follow_up',
      'invalid follow-up input',
    );
  }
  return {
    commandId: value.commandId,
    text: value.text,
    afterExecutionId: value.afterExecutionId,
  };
};

const readExecutionCancelInput = async (
  request: Request,
): Promise<ExecutionCancelInput> => {
  const value = await readJson(request);
  if (!object(value) || typeof value.commandId !== 'string') {
    throw new CoreServiceError(
      400,
      'invalid_execution_cancel',
      'invalid execution cancel input',
    );
  }
  return { commandId: value.commandId };
};

const decodePathId = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CoreServiceError(400, 'invalid_session_id', 'invalid session id');
  }
};

const sseFrame = (value: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

const streamSession = async (
  service: CoreService,
  sessionId: string,
  request: Request,
): Promise<Response> => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pending: Uint8Array[] = [];
  let canceled = false;
  let streamClosed = false;
  const sink: CoreSessionFrameSink = (frame): void => {
    if (frame === undefined) {
      if (streamClosed || canceled) return;
      streamClosed = true;
      try {
        controller?.close();
      } catch {
        // The client may have closed its connection at the same time as core shutdown.
      }
      return;
    }
    if (streamClosed || canceled) return;
    const bytes = sseFrame(frame);
    if (controller === undefined) pending.push(bytes);
    else {
      try {
        controller.enqueue(bytes);
      } catch {
        canceled = true;
        streamClosed = true;
        subscription?.unsubscribe();
      }
    }
  };

  const subscription = await service.subscribeSession(sessionId, sink);
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      try {
        controller.enqueue(
          sseFrame({
            kind: 'session.snapshot',
            snapshot: subscription!.snapshot,
          }),
        );
        for (const frame of pending) controller.enqueue(frame);
        pending.length = 0;
        if (streamClosed) controller.close();
      } catch {
        canceled = true;
        streamClosed = true;
        subscription?.unsubscribe();
      }
    },
    cancel() {
      canceled = true;
      streamClosed = true;
      subscription?.unsubscribe();
    },
  });
  if (request.signal.aborted || canceled) {
    subscription.unsubscribe();
  }
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
};

interface CoreHandlerLifecycle {
  readonly isAdmissionClosed: () => boolean;
  readonly onShutdownAccepted: () => void;
  readonly scheduleShutdown: () => void;
}

const handlerFor = (
  service: CoreService,
  lifecycle: CoreHandlerLifecycle,
) =>
async (request: Request): Promise<Response> => {
  try {
    if (lifecycle.isAdmissionClosed()) {
      return json({
        error: { code: 'core_stopping', message: 'Core is stopping' },
      }, 503);
    }
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/core' && request.method === 'GET') {
      return json(service.coreRead());
    }
    if (
      url.pathname === '/api/v1/core/shutdown' && request.method === 'POST'
    ) {
      const result = await service.coreShutdown(
        await readCoreShutdownInput(request),
        lifecycle.onShutdownAccepted,
      );
      const response = json(result, result.kind === 'accepted' ? 202 : 200);
      if (result.kind === 'accepted') lifecycle.scheduleShutdown();
      return response;
    }
    if (url.pathname === '/api/v1/catalogs' && request.method === 'GET') {
      return json(await service.catalogRead(readCatalogInput(url)));
    }
    if (url.pathname === '/api/v1/catalogs/favorite' && request.method === 'POST') {
      const value = await readJson(request);
      if (
        !object(value) || typeof value.provider !== 'string' || typeof value.modelId !== 'string' ||
        typeof value.favorite !== 'boolean'
      ) throw new CoreServiceError(400, 'invalid_model_favorite');
      return json(
        await service.modelFavorite({
          provider: value.provider,
          modelId: value.modelId,
          favorite: value.favorite,
        }),
      );
    }
    if (
      url.pathname === '/api/v1/credentials/presence' &&
      request.method === 'GET'
    ) {
      return json(await service.credentialPresenceRead());
    }
    if (
      url.pathname === '/api/v1/credentials/register' &&
      request.method === 'POST'
    ) {
      return json(
        await service.credentialRegister(
          await readCredentialRegisterInput(request),
        ),
      );
    }
    if (
      url.pathname === '/api/v1/workspace/paths' && request.method === 'GET'
    ) {
      const prefix = url.searchParams.get('prefix') ?? undefined;
      return json(await service.pathRead(prefix));
    }
    if (url.pathname === '/api/v1/sessions' && request.method === 'GET') {
      return json(await service.sessionsList());
    }
    if (
      url.pathname === '/api/v1/sessions/open' && request.method === 'POST'
    ) {
      return json(
        await service.sessionOpen(await readSessionOpenInput(request)),
      );
    }
    const title = /^\/api\/v1\/sessions\/([^/]+)\/title$/u.exec(url.pathname);
    if (title !== null && request.method === 'POST') {
      return json(
        await service.sessionRename(
          decodePathId(title[1]),
          await readSessionRenameInput(request),
        ),
      );
    }
    const selection = /^\/api\/v1\/sessions\/([^/]+)\/selection$/u.exec(
      url.pathname,
    );
    if (selection !== null && request.method === 'POST') {
      return json(
        await service.selectionChange(
          decodePathId(selection[1]),
          await readSelectionChangeInput(request),
        ),
      );
    }
    const recall = /^\/api\/v1\/sessions\/([^/]+)\/recall$/u.exec(
      url.pathname,
    );
    if (recall !== null && request.method === 'POST') {
      return json(
        await service.recall(
          decodePathId(recall[1]),
          await readRecallInput(request),
        ),
      );
    }
    const context = /^\/api\/v1\/sessions\/([^/]+)\/context$/u.exec(
      url.pathname,
    );
    if (context !== null && request.method === 'GET') {
      return json(await service.contextRead(decodePathId(context[1])));
    }
    const task = /^\/api\/v1\/sessions\/([^/]+)\/tasks$/u.exec(url.pathname);
    if (task !== null && request.method === 'POST') {
      const result = await service.taskSubmit(
        decodePathId(task[1]),
        await readTaskSubmitInput(request),
      );
      return json(result, result.kind === 'accepted' ? 202 : 200);
    }
    const steering = /^\/api\/v1\/sessions\/([^/]+)\/executions\/([^/]+)\/steering$/u.exec(
      url.pathname,
    );
    if (steering !== null && request.method === 'POST') {
      const result = await service.steeringSubmit(
        decodePathId(steering[1]),
        decodePathId(steering[2]),
        await readSteeringSubmitInput(request),
      );
      return json(result, result.kind === 'accepted' ? 202 : 200);
    }
    const followUp = /^\/api\/v1\/sessions\/([^/]+)\/follow-up$/u.exec(
      url.pathname,
    );
    if (followUp !== null && request.method === 'POST') {
      const result = await service.followUpQueue(
        decodePathId(followUp[1]),
        await readFollowUpQueueInput(request),
      );
      return json(result, result.kind === 'accepted' ? 202 : 200);
    }
    const followUpRead = /^\/api\/v1\/sessions\/([^/]+)\/follow-up\/([^/]+)$/u
      .exec(url.pathname);
    if (followUpRead !== null && request.method === 'GET') {
      return json(
        await service.followUpRead(
          decodePathId(followUpRead[1]),
          decodePathId(followUpRead[2]),
        ),
      );
    }
    const cancel = /^\/api\/v1\/sessions\/([^/]+)\/executions\/([^/]+)\/cancel$/u.exec(
      url.pathname,
    );
    if (cancel !== null && request.method === 'POST') {
      return json(
        await service.executionCancel(
          decodePathId(cancel[1]),
          decodePathId(cancel[2]),
          await readExecutionCancelInput(request),
        ),
      );
    }
    const command = /^\/api\/v1\/commands\/([^/]+)$/u.exec(url.pathname);
    if (command !== null && request.method === 'GET') {
      return json(await service.commandRead(decodePathId(command[1])));
    }
    const execution = /^\/api\/v1\/executions\/([^/]+)$/u.exec(url.pathname);
    if (execution !== null && request.method === 'GET') {
      return json(await service.executionRead(decodePathId(execution[1])));
    }
    const events = /^\/api\/v1\/sessions\/([^/]+)\/events$/u.exec(
      url.pathname,
    );
    if (events !== null && request.method === 'GET') {
      return await streamSession(service, decodePathId(events[1]), request);
    }
    const session = /^\/api\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (session !== null && request.method === 'GET') {
      return json(await service.sessionRead(decodePathId(session[1])));
    }
    if (url.pathname === '/api/v1/history' && request.method === 'GET') {
      const view = url.searchParams.get('view') ?? 'session';
      const sessionRef = url.searchParams.get('session') ?? undefined;
      const latest = url.searchParams.get('latest') === 'true';
      return json(
        await service.historyRead({
          ...(sessionRef === undefined ? {} : { sessionRef }),
          ...(latest ? { latest: true } : {}),
          view: view as 'session' | 'canonical' | 'detail',
        }),
      );
    }
    return json({
      error: { code: 'not_found', message: 'API route not found' },
    }, 404);
  } catch (error) {
    return errorResponse(error);
  }
};

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

/** Start the standalone HTTP API. Shutdown closes SSE readers before awaiting the HTTP server. */
export const startCoreServer = (
  service: CoreService,
  options: CoreServerOptions = {},
): Promise<CoreServerHandle> => {
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? 0;
  let admissionClosed = false;
  let scheduleShutdown = (): void => {};
  const pendingHandlers = new Set<Promise<Response>>();
  const routeHandler = handlerFor(service, {
    isAdmissionClosed: () => admissionClosed,
    onShutdownAccepted: () => admissionClosed = true,
    scheduleShutdown: () => scheduleShutdown(),
  });
  const server = Deno.serve(
    { hostname, port, onListen() {} },
    (request) => {
      if (admissionClosed) return routeHandler(request);
      const url = new URL(request.url);
      if (
        url.pathname === '/api/v1/core/shutdown' && request.method === 'POST'
      ) return routeHandler(request);
      const pending = routeHandler(request);
      pendingHandlers.add(pending);
      void pending.then(
        () => pendingHandlers.delete(pending),
        () => pendingHandlers.delete(pending),
      );
      return pending;
    },
  );
  const address = server.addr as Deno.NetAddr;
  const formattedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  const url = `http://${formattedHost}:${address.port}`;
  let shutdownPromise: Promise<void> | undefined;
  let serviceClosePromise: Promise<void> | undefined;
  let shutdownScheduled = false;
  const closeService = (): Promise<void> => {
    if (serviceClosePromise !== undefined) return serviceClosePromise;
    admissionClosed = true;
    service.beginShutdown();
    serviceClosePromise = (async () => {
      while (pendingHandlers.size > 0) {
        await Promise.allSettled([...pendingHandlers]);
      }
      await service.close();
      await options.onServiceClosed?.();
    })();
    return serviceClosePromise;
  };
  const finished = (async () => {
    try {
      await server.finished;
    } finally {
      await closeService();
    }
  })();
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    admissionClosed = true;
    service.beginShutdown();
    shutdownPromise = (async () => {
      try {
        await closeService();
      } finally {
        await server.shutdown();
      }
      await finished;
    })();
    return shutdownPromise;
  };
  scheduleShutdown = (): void => {
    if (shutdownScheduled) return;
    shutdownScheduled = true;
    setTimeout(() => {
      void shutdown().catch(() => {});
    }, 0);
  };
  return Promise.resolve({
    url,
    finished,
    shutdown,
  });
};
