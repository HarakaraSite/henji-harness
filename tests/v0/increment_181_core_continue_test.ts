import { strictEqual } from 'node:assert';
import { decodeSessionSnapshot } from '../../v0/api/codec.ts';
import { createCoreService } from '../../v0/agent/host/core_service.ts';

Deno.test('181 initial continue reopens the latest named root using its saved JSON choice', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-181-continue-' });
  const options = {
    workspaceRoot: root,
    configRoot: `${root}/config`,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    physicalIoMode: 'provider-free' as const,
  };
  await Deno.mkdir(options.configRoot);
  await Deno.writeTextFile(
    `${options.configRoot}/root.json`,
    JSON.stringify({
      name: 'custom-root',
      revision: 'same-label',
      tools: [],
      agents: [],
    }),
  );
  await Deno.writeTextFile(
    `${options.configRoot}/agents.json`,
    JSON.stringify({
      schemaVersion: 1,
      default: 'root.json',
      agents: {},
    }),
  );
  let core = await createCoreService({ ...options, initialSession: { kind: 'new' } });
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const receipt = await core.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'persist named root',
    });
    if (receipt.kind !== 'accepted') throw new Error(JSON.stringify(receipt));
    const deadline = Date.now() + 10000;
    while (
      (await core.executionRead(receipt.value.executionId)).execution.processSettlement !==
        'complete'
    ) {
      if (Date.now() > deadline) throw new Error('task did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await core.close();
    await Deno.writeTextFile(
      `${options.configRoot}/root.json`,
      JSON.stringify({
        name: 'current-root',
        revision: 'same-label',
        tools: [],
        agents: [],
      }),
    );
    core = await createCoreService({ ...options, initialSession: { kind: 'continue' } });
    strictEqual(core.coreRead().activeSessionId, sessionId);
    strictEqual(
      decodeSessionSnapshot(
        JSON.parse(new TextDecoder().decode((await core.sessionRead(sessionId)).bytes)),
      ).session.position.committedTurn,
      1,
    );
    const rename = await core.sessionRename(sessionId, {
      commandId: crypto.randomUUID(),
      title: 'current file reopened',
    });
    strictEqual(rename.kind, 'accepted');
    const snapshot = decodeSessionSnapshot(
      JSON.parse(new TextDecoder().decode((await core.sessionRead(sessionId)).bytes)),
    );
    strictEqual(snapshot.session.position.agent, 'current-root');
    strictEqual(
      (snapshot.runtime.effectiveConfig?.configuration as { source: { file: string } }).source.file,
      `${options.configRoot}/root.json`,
    );
  } finally {
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
