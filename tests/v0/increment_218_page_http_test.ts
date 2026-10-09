import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

Deno.test('Increment 218 HTTP client browses stable older pages and UTF-8 detail without changing active Session', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-page-http-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const core = await createCoreService({
    workspaceRoot,
    stateRoot: `${root}/state`,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
  });
  const server = await startCoreServer(core);
  try {
    const client = new HenjiApiClient(server.url);
    const sessionId = core.coreRead().activeSessionId!;
    const huge = '日本語'.repeat(250_000);
    for (let index = 0; index < 55; index++) {
      const result = await client.taskSubmit(sessionId, {
        commandId: `page-command-${index}`,
        text: index === 0 ? huge : `task ${index}`,
      });
      strictEqual(result.kind, 'accepted');
      if (result.kind !== 'accepted') throw new Error('task rejected');
      const deadline = Date.now() + 10_000;
      while (
        (await core.executionRead(result.value.executionId)).execution.processSettlement !==
          'complete'
      ) {
        if (Date.now() > deadline) throw new Error('task did not settle');
        await new Promise((done) => setTimeout(done, 2));
      }
    }
    const latest = await client.conversationPageRead(sessionId);
    strictEqual(latest.schemaVersion, 3);
    strictEqual(latest.page.hasOlder, true);
    ok(Object.values(latest.entities).filter((entry) => entry.kind === 'execution').length <= 50);
    let older = await client.conversationPageRead(
      sessionId,
      latest.page.lowerExecutionOrder,
      'older',
    );
    while (older.page.hasOlder) {
      older = await client.conversationPageRead(sessionId, older.page.lowerExecutionOrder, 'older');
    }
    const first = Object.values(older.entities).find((entry) =>
      entry.kind === 'execution' && entry.position.executionOrder === older.page.lowerExecutionOrder
    );
    ok(first?.kind === 'execution');
    const locator = Object.values(older.entities).flatMap((entry) =>
      'details' in entry ? entry.details ?? [] : []
    ).find((value) => value.executionId === first.executionId && value.field === 'task');
    ok(locator);
    const chunk = await client.conversationContentRead(locator);
    strictEqual(new TextEncoder().encode(chunk.text).byteLength, chunk.nextOffset - chunk.offset);
    strictEqual(chunk.text, huge.slice(0, chunk.text.length));
    strictEqual(chunk.totalBytes, new TextEncoder().encode(huge).byteLength);
    strictEqual(chunk.done, false);
    const tail = await client.conversationContentRead(locator, chunk.totalBytes - 999);
    strictEqual(tail.done, true);
    strictEqual(tail.text, huge.slice(-tail.text.length));
    strictEqual(core.coreRead().activeSessionId, sessionId);
  } finally {
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
