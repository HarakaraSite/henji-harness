import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import type {
  CommandResult,
  SessionOpenValue,
  SessionSnapshot,
  SessionStreamFrame,
} from '../../v0/api/contract.ts';

import { decodeSessionSnapshot, decodeSessionStreamFrame } from '../../v0/api/codec.ts';
import { initialSessionClientState, reduceSessionStreamFrame } from '../../v0/api/reducer.ts';

const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Session operation');
};

Deno.test('Increment 143 HTTP keeps activation, recall consumption, saved view and checkpoint resume on existing Host', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice5-http-' });
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
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });
  const bodies: unknown[] = [];
  let cancelled = false;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      bodies.push(await request.json());
      const requestNumber = bodies.length;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const text = requestNumber === 1
              ? 'Slice 5 noncanonical partial evidence'
              : `Slice 5 completed ${requestNumber}`;
            controller.enqueue(frame({ type: 'response.output_text.delta', delta: text }));
            if (requestNumber === 1) return;
            controller.enqueue(frame({
              type: 'response.completed',
              response: {
                id: crypto.randomUUID(),
                output: [{
                  type: 'message',
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text, annotations: [] }],
                }],
              },
            }));
            controller.close();
          },
          cancel() {
            if (requestNumber === 1) cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
      : entry
  );
  const options = {
    workspaceRoot,
    configRoot,
    stateRoot,
    dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
    physicalIoMode: 'production' as const,
    providerDeclarations: declarations,
  };
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    core = await createCoreService(options);
    server = await startCoreServer(core);
    let client = new HenjiApiClient(server.url);
    const opened = async (result: CommandResult<SessionOpenValue>) => {
      strictEqual(result.kind, 'accepted', JSON.stringify(result));
      if (result.kind !== 'accepted') throw new Error('Session was not opened');
      return await client.sessionRead(result.value.sessionId);
    };
    const openInput = {
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' as const },
      activation: {
        maxSteps: 4,
        providerTimeoutMs: 5_000,
        rootProvider: 'openrouter-responses',
      },
    };
    const [first, duplicate] = await Promise.all([
      client.sessionOpen(openInput),
      client.sessionOpen(openInput),
    ]);
    const initial = await opened(first);
    strictEqual((await opened(duplicate)).session.id, initial.session.id);
    const id = initial.session.id;
    strictEqual((await client.contextRead(id)).context.latestRequest, undefined);
    const receipt = await client.commandRead(openInput.commandId);
    ok(receipt.kind === 'accepted' && 'sessionId' in receipt.value);
    strictEqual(initial.runtime.effectiveConfig?.maxSteps, 4);
    strictEqual(initial.runtime.effectiveConfig?.providerTimeoutMs, 5_000);
    strictEqual(bodies.length, 0);
    const rename = await client.sessionRename(id, {
      commandId: crypto.randomUUID(),
      title: 'Slice 5 renamed Session',
    });
    strictEqual(rename.kind, 'accepted');
    strictEqual((await client.sessionRead(id)).session.position.title, 'Slice 5 renamed Session');
    strictEqual(bodies.length, 0);
    const latestAttach = await opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'continue' },
      }),
    );
    strictEqual(latestAttach.session.id, id);
    strictEqual(latestAttach.runtime.effectiveConfig?.maxSteps, 4);
    strictEqual(bodies.length, 0);
    const cancelledTask = await client.taskSubmit(id, {
      commandId: crypto.randomUUID(),
      text: 'Original cancelled task for recall',
    });
    if (cancelledTask.kind !== 'accepted') throw new Error('cancel task rejected');
    const cancelledId = cancelledTask.value.executionId;
    await waitFor(async () =>
      bodies.length === 1 &&
      Object.values((await client.sessionRead(id)).conversation.entities).some((entity) =>
        entity.kind === 'message' && entity.text.includes('noncanonical partial')
      )
    );
    const savedViewWhileBusy = await client.sessionsList();
    ok(savedViewWhileBusy.sessions.some((session) => session.id === id));
    const busyOpen = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(busyOpen.kind, 'rejected');
    if (busyOpen.kind === 'rejected') strictEqual(busyOpen.reason, 'busy');
    await client.executionCancel(id, cancelledId, { commandId: crypto.randomUUID() });
    await waitFor(async () =>
      cancelled &&
      (await client.executionRead(cancelledId)).execution.processSettlement === 'complete'
    );
    const recallInput = {
      commandId: crypto.randomUUID(),
      action: 'prepare' as const,
      executionId: cancelledId,
    };
    const prepared = await client.recall(id, recallInput);
    strictEqual(prepared.kind, 'accepted', JSON.stringify(prepared));
    strictEqual(
      (await client.contextRead(id)).context.pendingRecall?.sourceExecutionId,
      cancelledId,
    );
    await client.recall(id, recallInput);
    strictEqual(bodies.length, 1);
    const resumedTask = await client.taskSubmit(id, {
      commandId: crypto.randomUUID(),
      text: 'Use the prepared recall once',
    });
    if (resumedTask.kind !== 'accepted') throw new Error('recall task rejected');
    await waitFor(async () =>
      (await client.executionRead(resumedTask.value.executionId)).execution.processSettlement ===
        'complete'
    );
    ok(JSON.stringify(bodies[1]).includes('Original cancelled task for recall'));
    ok(JSON.stringify(bodies[1]).includes('noncanonical partial evidence'));
    strictEqual((await client.contextRead(id)).context.pendingRecall, undefined);
    const next = await client.taskSubmit(id, {
      commandId: crypto.randomUUID(),
      text: 'Next ordinary task without recall',
    });
    if (next.kind !== 'accepted') throw new Error('next task rejected');
    await waitFor(async () =>
      (await client.executionRead(next.value.executionId)).execution.processSettlement ===
        'complete'
    );
    ok(!JSON.stringify(bodies[2]).includes('Original cancelled task for recall'));
    strictEqual(
      (await client.contextRead(id)).context.latestRequest?.executionId,
      next.value.executionId,
    );
    const inherited = await opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
        fromSessionId: id,
      }),
    );
    strictEqual(inherited.runtime.effectiveConfig?.maxSteps, 4);
    strictEqual(inherited.runtime.effectiveConfig?.providerTimeoutMs, 5_000);
    strictEqual(inherited.session.selection.provider, 'openrouter-responses');
    await client.sessionRename(inherited.session.id, {
      commandId: crypto.randomUUID(),
      title: 'Slice 5 other slot',
    });
    const old = await client.sessionRead(id);
    strictEqual(old.runtime.activeSessionId, inherited.session.id);
    strictEqual(old.runtime.effectiveConfig, undefined);
    strictEqual(old.context.latestRequest?.executionId, next.value.executionId);
    strictEqual(bodies.length, 3);
    await server.shutdown();
    server = undefined;
    await core.close();
    core = undefined;
    const history = new SqliteHistoryStore(stateRoot, workspaceRoot, {});
    await history.initialize();
    const handle = await history.openExistingWorker(id);
    const checkpointSummary = 'Slice 5 existing checkpoint applied on resume';
    handle.installCheckpoint({
      contextSchemaVersion: 1,
      sessionId: id,
      createdAt: new Date().toISOString(),
      sourceProfileId: modelRouteProfileId(handle.record!.activeModel),
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: checkpointSummary,
    });
    await handle.close();
    core = await createCoreService(options);
    server = await startCoreServer(core);
    client = new HenjiApiClient(server.url);
    const viewingFrames: SessionStreamFrame[] = [];
    let observedSnapshot: SessionSnapshot | undefined;
    const viewing = await core.subscribeSession(id, (frame) => {
      if (frame !== undefined) {
        const value = decodeSessionStreamFrame(JSON.parse(new TextDecoder().decode(frame)));
        viewingFrames.push(value);
        observedSnapshot = reduceSessionStreamFrame(
          observedSnapshot === undefined ? undefined : initialSessionClientState(observedSnapshot),
          value,
        ).snapshot;
      }
    });
    observedSnapshot = decodeSessionSnapshot(
      JSON.parse(new TextDecoder().decode(viewing.snapshot.bytes)),
    );
    strictEqual(observedSnapshot.runtime.activeSessionId, null);
    const resumed = await opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'exact', sessionId: id },
        activation: { rootProvider: 'openrouter-chat' },
      }),
    );
    strictEqual(resumed.session.selection.provider, 'openrouter-responses');
    strictEqual((await client.contextRead(id)).context.checkpoint?.summary, checkpointSummary);
    strictEqual(bodies.length, 3);
    strictEqual(observedSnapshot.runtime.activeSessionId, id);
    ok(observedSnapshot.runtime.operations.includes('task.submit'));
    const task = await client.taskSubmit(id, {
      commandId: crypto.randomUUID(),
      text: 'Read existing checkpoint on resumed task',
    });
    if (task.kind !== 'accepted') throw new Error('checkpoint task rejected');
    await waitFor(async () =>
      (await client.executionRead(task.value.executionId)).execution.processSettlement ===
        'complete'
    );
    ok(JSON.stringify(bodies[3]).includes(checkpointSummary));
    ok(
      viewingFrames.some((frame) =>
        frame.kind === 'session.update' &&
        frame.conversationDelta?.changes.some((change) =>
          change.kind === 'upsert' && change.entity.kind === 'message' &&
          change.entity.text === 'Read existing checkpoint on resumed task'
        )
      ),
    );
    const none = await opened(
      await client.sessionOpen({ commandId: crypto.randomUUID(), selection: { kind: 'none' } }),
    );
    strictEqual(observedSnapshot.runtime.activeSessionId, none.session.id);
    strictEqual(observedSnapshot.runtime.effectiveConfig, undefined);
    ok(!observedSnapshot.runtime.operations.includes('task.submit'));
    ok(observedSnapshot.runtime.operations.includes('session.open'));
    ok(viewingFrames.every((frame) => frame.kind === 'session.update'));
    viewing.unsubscribe();
    strictEqual((await client.sessionRead(none.session.id)).session.persistence, 'none');
    const sameNone = await opened(
      await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'exact', sessionId: none.session.id },
      }),
    );
    strictEqual(sameNone.session.id, none.session.id);
    strictEqual(bodies.length, 4);
  } finally {
    await server?.shutdown();
    await core?.close();
    await provider.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
