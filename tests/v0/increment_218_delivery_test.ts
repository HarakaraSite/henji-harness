import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';

Deno.test('Increment 218 slow subscriber receives one frame at a time and resyncs to saved latest page', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i218-slow-' });
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
  let acknowledge: (() => void) | undefined;
  const frames: Record<string, unknown>[] = [];
  let slow = true;
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const subscription = await core.subscribeSession(sessionId, (bytes) => {
      if (bytes === undefined) return;
      frames.push(JSON.parse(new TextDecoder().decode(bytes)));
      if (slow) {
        return new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      }
    });
    for (let index = 0; index < 100; index++) {
      const result = await core.taskSubmit(sessionId, {
        commandId: `slow-${index}`,
        text: `${index} ${'body 日本語 '.repeat(1200)}`,
      });
      if (result.kind !== 'accepted') throw new Error('task rejected');
      const deadline = Date.now() + 10_000;
      while (
        (await core.executionRead(result.value.executionId)).execution.processSettlement !==
          'complete'
      ) {
        if (Date.now() > deadline) throw new Error('settlement timeout');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    strictEqual(frames.length, 1, 'no second in-flight frame without ack');
    slow = false;
    acknowledge?.();
    const deadline = Date.now() + 10_000;
    while (frames.length < 2) {
      if (Date.now() > deadline) throw new Error('resync timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    ok(frames.some((frame, index) => index > 0 && frame.kind === 'session.snapshot'));
    const latest = frames.findLast((frame) => frame.kind === 'session.snapshot')!;
    const conversation = (latest.snapshot as Record<string, unknown>).conversation as {
      page: { upperExecutionOrder: number };
      entities: Record<string, unknown>;
    };
    strictEqual(conversation.page.upperExecutionOrder, 99);
    ok(Object.keys(conversation.entities).length < 300);
    strictEqual(core.coreRead().activeSessionId, sessionId);
    subscription.unsubscribe();
  } finally {
    acknowledge?.();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
