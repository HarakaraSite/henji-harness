import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerHostCommand } from '../../v0/agent/worker/worker_protocol.ts';

Deno.test('Increment 170 shutdown cancels preparing reservation before joining admission and never sends its turn', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-shutdown-' });
  const stateRoot = `${root}/state`;
  const commands: WorkerHostCommand[] = [];
  let releaseStart!: () => void;
  let startHeld!: () => void;
  const held = new Promise<void>((resolve) => startHeld = resolve);
  const gate = new Promise<void>((resolve) => releaseStart = resolve);
  const reader = new SqliteHistoryV7ProductionStore(stateRoot, root, { readOnly: true });
  const core = await createCoreService({
    workspaceRoot: root,
    stateRoot,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      return {
        send(command, transfer) {
          commands.push(command);
          if (command.kind === 'start') {
            startHeld();
            void gate.then(() => capsule.send(command, transfer));
          } else capsule.send(command, transfer);
        },
        subscribe: (listener) => capsule.subscribe(listener),
        terminate: () => capsule.terminate(),
      };
    },
  });
  const sessionId = core.coreRead().activeSessionId!;
  let task: ReturnType<typeof core.taskSubmit> | undefined;
  try {
    task = core.taskSubmit(sessionId, { commandId: crypto.randomUUID(), text: 'Stop preparation' });
    await held;
    strictEqual(core.coreRead().phase, 'preparing');
    const closing = core.close();
    releaseStart();
    const receipt = await task;
    ok(receipt.kind === 'accepted');
    await closing;
    strictEqual(commands.filter((command) => command.kind === 'turn').length, 0);
    await reader.initialize();
    const rows = reader.listExecutions();
    strictEqual(rows.length, 1);
    strictEqual(rows[0].executionId, receipt.value.executionId);
    strictEqual(rows[0].lifecycle, 'settled');
    strictEqual(rows[0].outcome, 'cancelled');
    strictEqual(rows[0].adoption, 'non_canonical');
  } finally {
    releaseStart();
    await task?.catch(() => undefined);
    await core.close();
    reader.close();
    await Deno.remove(root, { recursive: true });
  }
});
