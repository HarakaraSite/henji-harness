import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { reduceSessionStreamFrame, type SessionClientState } from '../../v0/api/reducer.ts';

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for Core state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

Deno.test('Increment 210 saved HTTP streams track busy and slot changes while reopened owners retain follow-ups', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i210-core-' });
  await Deno.mkdir(`${root}/workspace`);
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let holding = true;
  const held: Array<() => void> = [];
  const streams: {
    stop: AbortController;
    done: Promise<void>;
    state?: SessionClientState;
    snapshots: Map<number, SessionSnapshot>;
  }[] = [];
  try {
    core = await createCoreService({
      workspaceRoot: `${root}/workspace`,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: capsule.send.bind(capsule),
          terminate: capsule.terminate.bind(capsule),
          subscribe: (listener) =>
            capsule.subscribe((message) => {
              if (holding && message.kind === 'turn_settled') {
                held.push(() => listener(message));
              } else listener(message);
            }),
        };
      },
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const connect = async (sessionId: string) => {
      const stream: typeof streams[number] = {
        stop: new AbortController(),
        done: Promise.resolve(),
        snapshots: new Map(),
      };
      stream.done = (async () => {
        try {
          for await (
            const frame of client.sessionSubscribe(sessionId, { signal: stream.stop.signal })
          ) {
            stream.state = reduceSessionStreamFrame(stream.state, frame);
            stream.snapshots.set(stream.state.snapshot.cursor.revision, stream.state.snapshot);
          }
        } catch (error) {
          if (!stream.stop.signal.aborted) throw error;
        }
      })();
      void stream.done.catch(() => {});
      streams.push(stream);
      await waitFor(() => stream.state !== undefined);
      return stream;
    };
    const sessionA = (await client.coreRead()).activeSessionId!;
    holding = false;
    const seeded = await client.taskSubmit(sessionA, {
      commandId: crypto.randomUUID(),
      text: 'Save Session A before viewing and reopening it',
    });
    strictEqual(seeded.kind, 'accepted');
    if (seeded.kind !== 'accepted') throw new Error('Session A was not saved');
    await waitFor(async () =>
      (await client.executionRead(seeded.value.executionId)).execution.processSettlement ===
        'complete'
    );
    holding = true;
    const streamA = await connect(sessionA);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') throw new Error('Session B was not opened');
    const sessionB = opened.value.sessionId;
    const streamB = await connect(sessionB);
    await waitFor(() => streamA.state!.snapshot.runtime.activeSessionId === sessionB);
    const oldQueueIds: string[] = [];
    for (const round of [1, 2]) {
      const task = await client.taskSubmit(sessionB, {
        commandId: crypto.randomUUID(),
        text: `parent ${round}`,
      });
      strictEqual(task.kind, 'accepted');
      if (task.kind !== 'accepted') throw new Error('parent was not admitted');
      await waitFor(() => held.length === 1);
      await waitFor(() =>
        !streamA.state!.snapshot.runtime.operations.includes('session.open') &&
        !streamA.state!.snapshot.runtime.operations.includes('credential.register')
      );
      const queued = await client.followUpQueue(sessionB, {
        commandId: crypto.randomUUID(),
        afterExecutionId: task.value.executionId,
        text: `follow-up ${round}`,
      });
      strictEqual(queued.kind, 'accepted');
      if (queued.kind !== 'accepted') throw new Error('latest owner did not accept follow-up');
      oldQueueIds.push(queued.value.queueId);
      held.shift()!();
      await waitFor(() => held.length === 1);
      const started = await client.followUpRead(sessionB, queued.value.queueId);
      strictEqual(started.followUp.status, 'started');
      ok(started.followUp.executionId);
      held.shift()!();
      await waitFor(async () =>
        (await client.executionRead(started.followUp.executionId!)).execution.processSettlement ===
          'complete'
      );
      await waitFor(() =>
        streamA.state!.snapshot.runtime.operations.includes('session.open') &&
        streamA.state!.snapshot.runtime.operations.includes('credential.register') &&
        streamB.state!.snapshot.runtime.operations.includes('task.submit')
      );
      const saved = await client.sessionRead(sessionB);
      await waitFor(() => streamB.state!.snapshot.conversation.cut === saved.conversation.cut);
      deepStrictEqual(streamB.state!.snapshot.conversation, saved.conversation);
      for (const queueId of oldQueueIds) {
        strictEqual((await client.followUpRead(sessionB, queueId)).followUp.status, 'started');
        ok(saved.pending.followUps.some((record) => record.queueId === queueId));
      }
      if (round === 1) {
        for (const sessionId of [sessionA, sessionB]) {
          const reopened = await client.sessionOpen({
            commandId: crypto.randomUUID(),
            selection: { kind: 'exact', sessionId },
          });
          strictEqual(reopened.kind, 'accepted', JSON.stringify(reopened));
          await waitFor(() =>
            streams.every((stream) => stream.state!.snapshot.runtime.activeSessionId === sessionId)
          );
        }
        const reopened = await client.sessionRead(sessionB);
        ok(reopened.pending.followUps.some((record) => record.queueId === queued.value.queueId));
      }
    }
    const renamed = await client.sessionRename(sessionB, {
      commandId: crypto.randomUUID(),
      title: 'Core state remains usable',
    });
    strictEqual(renamed.kind, 'accepted');
    if (renamed.kind !== 'accepted') throw new Error('rename was not accepted');
    ok(renamed.cursor);
    const receiptCursor = renamed.cursor;
    await waitFor(() => streamB.snapshots.has(receiptCursor.revision));
    const published = streamB.snapshots.get(receiptCursor.revision)!;
    deepStrictEqual(published.cursor, receiptCursor);
    strictEqual(published.session.position.title, 'Core state remains usable');
    ok(published.runtime.operations.includes('task.submit'));
    ok(streamA.state!.snapshot.runtime.operations.includes('session.open'));
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
    for (const stream of streams) stream.stop.abort();
    await Promise.all(streams.map((stream) => stream.done));
    await server?.shutdown();
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});
