import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

Deno.test('181 Core stays available with rejected Agent JSON, admits nothing, and recovers through new Worker', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-core-config-' });
  const configRoot = `${root}/config`;
  const file = `${configRoot}/root.json`;
  await Deno.mkdir(configRoot);
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({ schemaVersion: 1, default: 'root.json', agents: {} }),
  );
  await Deno.writeTextFile(file, '{invalid json');
  const core = await createCoreService({
    workspaceRoot: root,
    configRoot,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  const reader = new SqliteHistoryStore(`${root}/state`, root, { readOnly: true });
  try {
    const original = core.coreRead().activeSessionId!;
    ok((await client.coreRead()).implementedOperations.includes('history.read'));
    const receipt = await client.taskSubmit(original, {
      commandId: crypto.randomUUID(),
      text: 'draft must remain available',
    });
    strictEqual(receipt.kind, 'rejected');
    if (receipt.kind !== 'rejected') throw new Error('Expected rejected task');
    strictEqual(receipt.reason, 'configurationRejected');
    const snapshot = await client.sessionRead(original);
    const configuration = snapshot.runtime.effectiveConfig?.configuration as {
      status: string;
      rejections: { file: string; reason: string }[];
    };
    strictEqual(configuration.status, 'rejected');
    strictEqual(configuration.rejections[0].file, file);
    ok(configuration.rejections[0].reason);
    strictEqual(snapshot.runtime.active, false);
    strictEqual(snapshot.session.position.committedTurn, 0);
    await reader.initialize();
    strictEqual(reader.listExecutions().length, 0);
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        name: 'fixed-root',
        revision: 'same label',
        instruction: '',
        tools: [],
        agents: [],
      }),
    );
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    if (opened.kind !== 'accepted') throw new Error(JSON.stringify(opened));
    const recovered = await client.taskSubmit(opened.value.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'run after file repair',
    });
    if (recovered.kind !== 'accepted') throw new Error(JSON.stringify(recovered));
    const deadline = Date.now() + 10000;
    while (
      (await client.executionRead(recovered.value.executionId)).execution.processSettlement !==
        'complete'
    ) {
      if (Date.now() > deadline) throw new Error('repaired task did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    strictEqual(
      (await client.executionRead(recovered.value.executionId)).execution.outcome,
      'completed',
    );
    strictEqual(
      (await client.sessionRead(opened.value.sessionId)).session.position.agent,
      'fixed-root',
    );
    const renamed = await client.sessionRename(opened.value.sessionId, {
      commandId: crypto.randomUUID(),
      title: 'named root still supports title changes',
    });
    strictEqual(renamed.kind, 'accepted', JSON.stringify(renamed));
  } finally {
    reader.close();
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
