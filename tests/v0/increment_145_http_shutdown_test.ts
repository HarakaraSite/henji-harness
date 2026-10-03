import { ok, strictEqual } from 'node:assert';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { type CoreSessionFrameSink, createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { decodeCoreCommandValue } from '../../v0/api/codec.ts';
import type { CommandResult, SessionOpenValue, SessionStreamFrame } from '../../v0/api/contract.ts';

const frame = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);

const opened = (result: CommandResult<SessionOpenValue>) => {
  strictEqual(result.kind, 'accepted', JSON.stringify(result));
  if (result.kind !== 'accepted') throw new Error('Session was not opened');
  return result.value;
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for shutdown execution');
};

const processAlive = async (pid: string): Promise<boolean> =>
  (await new Deno.Command('/bin/bash', {
    args: [
      '-c',
      'if read -r stat < /proc/$1/stat; then rest=${stat##*) }; [[ ${rest%% *} != Z ]]; else exit 1; fi',
      'shutdown-probe',
      pid,
    ],
    stdout: 'null',
    stderr: 'null',
  }).output()).success;

Deno.test('Increment 145 HTTP shutdown drains SSE and settles active Bash before serving history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice7-http-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/openrouter-api-key`,
    'increment-145-local-provider-key',
    { mode: 0o600 },
  );

  const shellCommand =
    `trap '' TERM; bash -c 'trap "" TERM; while :; do sleep 10; done' & printf '%s\\n' "$!" > child.pid; printf '%s\\n' "$$" > command.pid; while :; do sleep 10; done`;
  let providerRequests = 0;
  let provider: Deno.HttpServer | undefined;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let events: AsyncGenerator<SessionStreamFrame> | undefined;
  let history: SqliteHistoryV7ProductionStore | undefined;
  const shutdownStatuses: number[] = [];
  try {
    provider = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen() {} },
      async (request) => {
        await request.json();
        providerRequests += 1;
        const responseEvent = {
          type: 'response.completed',
          response: {
            id: crypto.randomUUID(),
            output: [{
              type: 'message',
              id: crypto.randomUUID(),
              role: 'assistant',
              status: 'completed',
              content: [],
            }, {
              type: 'function_call',
              id: crypto.randomUUID(),
              status: 'completed',
              call_id: 'slice7-bash-call',
              name: 'bash',
              arguments: JSON.stringify({
                command: shellCommand,
                timeoutMs: 120_000,
              }),
            }],
          },
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame(responseEvent));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    const providerDeclarations = builtinProviderDeclarations().map((entry) =>
      entry.providerId === 'openrouter-responses'
        ? {
          ...entry,
          endpoint: `http://127.0.0.1:${(provider!.addr as Deno.NetAddr).port}/v1`,
        }
        : entry
    );
    const options = {
      workspaceRoot,
      configRoot,
      stateRoot,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      physicalIoMode: 'production' as const,
      agent: 'default' as const,
      rootMaxSteps: 3,
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations,
    };
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url, async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/core/shutdown')) {
        shutdownStatuses.push(response.status);
      }
      return response;
    });
    const receipt = opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
      }),
    );
    const sessionId = receipt.sessionId;
    strictEqual((await client.sessionRead(sessionId)).session.persistence, 'persistent');
    events = client.sessionSubscribe(sessionId);
    const initial = await events.next();
    ok(!initial.done && initial.value.kind === 'session.snapshot');
    const streamFinished = (async () => {
      for (;;) {
        const next = await events!.next();
        if (next.done) return;
      }
    })();

    const taskText = 'Keep the local Bash process until Core shutdown';
    const taskCommandId = crypto.randomUUID();
    const task = await client.taskSubmit(sessionId, {
      commandId: taskCommandId,
      text: taskText,
    });
    strictEqual(task.kind, 'accepted', JSON.stringify(task));
    if (task.kind !== 'accepted') throw new Error('task was rejected');
    const executionId = task.value.executionId;
    await waitFor(async () => {
      try {
        return (await Deno.readTextFile(`${workspaceRoot}/command.pid`)).trim().length > 0 &&
          (await Deno.readTextFile(`${workspaceRoot}/child.pid`)).trim().length > 0;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    });
    const commandPid = (await Deno.readTextFile(`${workspaceRoot}/command.pid`)).trim();
    const childPid = (await Deno.readTextFile(`${workspaceRoot}/child.pid`)).trim();
    ok(await processAlive(commandPid), 'Bash command process was not active');
    ok(await processAlive(childPid), 'Bash descendant was not active');
    strictEqual(providerRequests, 1);

    const shutdownCommandId = crypto.randomUUID();
    const shutdown = await client.coreShutdown({ commandId: shutdownCommandId });
    strictEqual(shutdown.kind, 'accepted', JSON.stringify(shutdown));
    if (shutdown.kind !== 'accepted') throw new Error('shutdown was rejected');
    strictEqual(shutdownStatuses[0], 202);
    strictEqual(shutdown.target.kind, 'core');
    strictEqual(shutdown.value.result, 'requested');
    const commandState = await core.commandRead(shutdownCommandId);
    strictEqual(commandState.kind, 'accepted');
    if (commandState.kind !== 'accepted') {
      throw new Error('shutdown receipt was not retained');
    }
    const decodedShutdown = decodeCoreCommandValue(commandState.value);
    ok('result' in decodedShutdown);
    strictEqual(decodedShutdown.result, 'requested');

    const afterShutdown = await core.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'This task must not be admitted after shutdown',
    });
    strictEqual(afterShutdown.kind, 'rejected');
    if (afterShutdown.kind === 'rejected') {
      strictEqual(afterShutdown.reason, 'unavailable');
    }

    await server.finished;
    await streamFinished;
    server = undefined;
    strictEqual(providerRequests, 1);
    ok(!(await processAlive(commandPid)), 'shutdown retained the Bash command');
    ok(!(await processAlive(childPid)), 'shutdown retained the Bash descendant');
    strictEqual(core.coreRead().activeSessionId, null);

    history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {});
    await history.initialize();
    const saved = history.listExecutions().find((row) => row.executionId === executionId);
    ok(saved, 'shutdown did not persist the active execution');
    strictEqual(saved.task, taskText);
    strictEqual(saved.lifecycle, 'settled');
    strictEqual(
      (await history.readWorker(sessionId)).sessionId,
      sessionId,
    );
  } finally {
    await events?.return(undefined);
    await server?.shutdown();
    await core?.close();
    history?.close();
    await provider?.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 145 Core.close waits for a Session slot admitted before shutdown', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice7-open-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  try {
    await Deno.mkdir(workspaceRoot, { recursive: true });
    core = await createCoreService({
      workspaceRoot,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      stateRoot: `${environment.XDG_STATE_HOME}/henji-harness/v1`,
      physicalIoMode: 'production',
      providerDeclarations: builtinProviderDeclarations(),
    });
    const opening = core.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    const closing = core.close();
    const openedSession = opened(await opening);
    await closing;
    strictEqual(core.coreRead().activeSessionId, null);
    ok(openedSession.sessionId.length > 0);
  } finally {
    await core?.close();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 145 closes an SSE subscription stopped before its HTTP stream starts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice7-sse-race-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let events: AsyncGenerator<SessionStreamFrame> | undefined;
  const controller = new AbortController();
  let releaseSubscription!: () => void;
  let releaseCleanup!: () => void;
  let subscriptionReady!: () => void;
  let cleanupStarted!: () => void;
  let callbackStatus!: (status: number) => void;
  const subscriptionGate = new Promise<void>((resolve) => releaseSubscription = resolve);
  const cleanupGate = new Promise<void>((resolve) => releaseCleanup = resolve);
  const subscriptionEntered = new Promise<void>((resolve) => subscriptionReady = resolve);
  const cleanupEntered = new Promise<void>((resolve) => cleanupStarted = resolve);
  const callbackProbe = new Promise<number>((resolve) => callbackStatus = resolve);
  try {
    await Deno.mkdir(workspaceRoot, { recursive: true });
    core = await createCoreService({
      workspaceRoot,
      configRoot: `${environment.XDG_CONFIG_HOME}/henji-harness`,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      stateRoot: `${environment.XDG_STATE_HOME}/henji-harness/v1`,
      physicalIoMode: 'provider-free',
      providerDeclarations: builtinProviderDeclarations(),
    });
    const service = {
      ...core,
      async subscribeSession(
        sessionId: string,
        sink: CoreSessionFrameSink,
      ) {
        const subscription = await core!.subscribeSession(sessionId, sink);
        subscriptionReady();
        await subscriptionGate;
        return subscription;
      },
      async close() {
        cleanupStarted();
        await cleanupGate;
        await core!.close();
      },
    };
    server = await startCoreServer(service, {
      async onServiceClosed() {
        const response = await fetch(`${server!.url}/api/v1/core`);
        callbackStatus(response.status);
      },
    });
    const client = new HenjiApiClient(server.url);
    const receipt = opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
      }),
    );
    events = client.sessionSubscribe(receipt.sessionId, {
      signal: controller.signal,
    });
    const firstFrame = events.next();
    await subscriptionEntered;

    const shutdown = await client.coreShutdown({ commandId: crypto.randomUUID() });
    strictEqual(shutdown.kind, 'accepted', JSON.stringify(shutdown));
    if (shutdown.kind !== 'accepted') throw new Error('shutdown was rejected');
    releaseSubscription();
    const first = await firstFrame;
    ok(!first.done && first.value.kind === 'session.snapshot');

    await cleanupEntered;
    const duringCleanup = await fetch(`${server.url}/api/v1/core`);
    strictEqual(duringCleanup.status, 503);
    releaseCleanup();
    strictEqual(await callbackProbe, 503);

    const streamClosed = (async () => {
      for (;;) {
        const next = await events!.next();
        if (next.done) return true;
      }
    })().catch(() => false);
    const streamEnded = await Promise.race([
      streamClosed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    strictEqual(streamEnded, true, 'SSE stream did not close after shutdown');
    await server.finished;
    const afterClose = await fetch(server.url).then(() => false, () => true);
    strictEqual(afterClose, true, 'HTTP listener closed after cleanup');
  } finally {
    releaseSubscription();
    releaseCleanup();
    controller.abort();
    await events?.return(undefined).catch(() => {});
    await Promise.race([
      server?.shutdown() ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await core?.close();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
