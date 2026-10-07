import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import type { SessionStreamFrame } from '../../v0/api/contract.ts';

Deno.test('Increment 209 HTTP client receives a long snapshot and updates across split UTF-8 and SSE separators', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i209-sse-' });
  await Deno.mkdir(`${root}/workspace`);
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    core = await createCoreService({
      workspaceRoot: `${root}/workspace`,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const sessionId = (await client.coreRead()).activeSessionId!;
    // A long title is real public Session metadata, not an alternate snapshot shape.
    const title = '会話🙂'.repeat(16_384);
    const renamed = await client.sessionRename(sessionId, {
      commandId: crypto.randomUUID(),
      title,
    });
    strictEqual(renamed.kind, 'accepted');
    const snapshot = await client.sessionRead(sessionId);
    strictEqual(snapshot.session.position.title, title);
    const expected: SessionStreamFrame[] = [
      { kind: 'session.snapshot', snapshot },
      ...[1, 2, 3].map((offset) => ({
        kind: 'session.update' as const,
        cursor: { ...snapshot.cursor, revision: snapshot.cursor.revision + offset },
        previousRevision: snapshot.cursor.revision + offset - 1,
        changes: [],
      })),
    ];
    const encoder = new TextEncoder();
    const snapshotBytes = encoder.encode(`: connected\r\ndata: ${JSON.stringify(expected[0])}`);
    const subsequent = encoder.encode(
      `data: ${JSON.stringify(expected[1])}\n\n` +
        `data: ${JSON.stringify(expected[2])}\r\n\r\n` +
        `data: ${JSON.stringify(expected[3])}`,
    );
    const fragmented = new HenjiApiClient(server.url, () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let offset = 0; offset < snapshotBytes.length; offset += 257) {
                controller.enqueue(snapshotBytes.subarray(offset, offset + 257));
              }
              // Deliver a CRLF separator one byte at a time, then several events together.
              for (const byte of encoder.encode('\r\n\r\n')) {
                controller.enqueue(new Uint8Array([byte]));
              }
              controller.enqueue(subsequent);
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ));
    const received: SessionStreamFrame[] = [];
    for await (const frame of fragmented.sessionSubscribe(sessionId)) received.push(frame);
    deepStrictEqual(received, expected);

    // The normal production HTTP stream still exposes the same snapshot.
    const stream = client.sessionSubscribe(sessionId);
    try {
      const first = await stream.next();
      ok(!first.done);
      deepStrictEqual(first.value, expected[0]);
    } finally {
      await stream.return(undefined);
    }
  } finally {
    await server?.shutdown();
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 209 HTTP shutdown waits for a pending read handler before closing Core', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i209-drain-' });
  await Deno.mkdir(`${root}/workspace`);
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let releaseRead!: () => void;
  let readEntered!: () => void;
  const readGate = new Promise<void>((resolve) => releaseRead = resolve);
  const readStarted = new Promise<void>((resolve) => readEntered = resolve);
  let closed = false;
  try {
    core = await createCoreService({
      workspaceRoot: `${root}/workspace`,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
    });
    server = await startCoreServer({
      ...core,
      async sessionsList() {
        readEntered();
        await readGate;
        strictEqual(closed, false);
        return await core!.sessionsList();
      },
      async close() {
        closed = true;
        await core!.close();
      },
    });
    const client = new HenjiApiClient(server.url);
    const pendingRead = client.sessionsList();
    await readStarted;
    const result = await client.coreShutdown({ commandId: crypto.randomUUID() });
    strictEqual(result.kind, 'accepted');
    const stopping = await fetch(`${server.url}/api/v1/core`);
    strictEqual(stopping.status, 503);
    strictEqual(closed, false);
    releaseRead();
    deepStrictEqual(await pendingRead, { sessions: [] });
    await server.finished;
    strictEqual(closed, true);
  } finally {
    releaseRead();
    await server?.shutdown();
    await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});
