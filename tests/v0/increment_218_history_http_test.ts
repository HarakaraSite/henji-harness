import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

Deno.test('Increment 218 HTTP history streams full saved text at one read cut while conversation continues', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-history-http-' });
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
  const client = new HenjiApiClient(server.url);
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const huge = 'original 日本語\n'.repeat(40000);
    const settle = async (text: string, commandId: string) => {
      const result = await core.taskSubmit(sessionId, { commandId, text });
      if (result.kind !== 'accepted') throw new Error('task rejected');
      const deadline = Date.now() + 10000;
      while (
        (await core.executionRead(result.value.executionId)).execution.processSettlement !==
          'complete'
      ) {
        if (Date.now() > deadline) throw new Error('settlement timeout');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return result.value.executionId;
    };
    const firstId = await settle(huge, 'history-large');
    const opened = await client.historyStream({ sessionRef: sessionId, view: 'session' });
    strictEqual(opened.sessionId, sessionId);
    const reader = opened.stream.getReader();
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    ok(!first.done);
    chunks.push(first.value);
    await settle('later than read cut', 'history-later');
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    const text = new TextDecoder().decode(all);
    ok(text.includes(huge));
    ok(text.includes(firstId));
    strictEqual(text.includes('later than read cut'), false);
    const abandoned = await client.historyStream({ sessionRef: sessionId, view: 'detail' });
    const abandonedReader = abandoned.stream.getReader();
    await abandonedReader.read();
    await abandonedReader.cancel();
    const finalId = await settle('continue after export disconnect', 'history-after-close');
    strictEqual((await core.executionRead(finalId)).execution.outcome, 'completed');
    const canonical = await client.historyRead({ sessionRef: sessionId, view: 'canonical' });
    ok(canonical.text.includes('continue after export disconnect'));
  } finally {
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
