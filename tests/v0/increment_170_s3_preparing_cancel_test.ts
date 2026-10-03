import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type { WorkerHostCommand } from '../../v0/agent/worker/worker_protocol.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

Deno.test('Increment 170 preparing reservation cancels through HTTP before Agent startup and preserves receipt identity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-preparing-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const commands: WorkerHostCommand[] = [];
  let releaseStart!: () => void;
  let startHeld!: () => void;
  const held = new Promise<void>((resolve) => startHeld = resolve);
  const startGate = new Promise<void>((resolve) => releaseStart = resolve);
  const core = await createCoreService({
    workspaceRoot,
    stateRoot: `${root}/state`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      return {
        send(command, transfer) {
          commands.push(command);
          if (command.kind === 'start') {
            startHeld();
            void startGate.then(() => capsule.send(command, transfer));
          } else capsule.send(command, transfer);
        },
        subscribe: (listener) => capsule.subscribe(listener),
        terminate: () => capsule.terminate(),
      };
    },
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  const sessionId = core.coreRead().activeSessionId!;
  const commandId = crypto.randomUUID();
  let task: ReturnType<HenjiApiClient['taskSubmit']> | undefined;
  try {
    task = client.taskSubmit(sessionId, { commandId, text: 'Cancel before preparation completes' });
    await held;
    const preparing = await client.sessionRead(sessionId);
    const reserved = preparing.pending.activeTask;
    ok(reserved);
    strictEqual(reserved.commandId, commandId);
    strictEqual(preparing.runtime.phase, 'preparing');
    strictEqual(preparing.runtime.reservation?.executionId, reserved.executionId);
    strictEqual(preparing.runtime.reservation?.commandId, commandId);
    ok(preparing.runtime.operations.includes('execution.cancel'));
    const cancellation = await client.executionCancel(sessionId, reserved.executionId, {
      commandId: crypto.randomUUID(),
    });
    strictEqual(cancellation.kind, 'accepted');
    if (cancellation.kind !== 'accepted') throw new Error('cancel rejected');
    strictEqual(cancellation.value.result, 'requested');
    const repeated = await client.executionCancel(sessionId, reserved.executionId, {
      commandId: crypto.randomUUID(),
    });
    ok(repeated.kind === 'accepted');
    strictEqual(repeated.value.result, 'already_requested');
    strictEqual(commands.filter((command) => command.kind === 'turn').length, 0);
    releaseStart();
    const receipt = await task;
    strictEqual(receipt.kind, 'accepted');
    if (receipt.kind !== 'accepted') throw new Error('admission rejected');
    strictEqual(receipt.value.executionId, reserved.executionId);
    const deadline = Date.now() + 5_000;
    while (true) {
      const saved = await client.executionRead(reserved.executionId);
      if (saved.execution.processSettlement === 'complete') {
        strictEqual(saved.execution.lifecycle, 'settled');
        strictEqual(saved.execution.outcome, 'cancelled');
        strictEqual(saved.execution.adoption, 'non_canonical');
        strictEqual(saved.execution.submittedByCommandId, commandId);
        break;
      }
      if (Date.now() > deadline) throw new Error('cancelled admission did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    strictEqual(commands.filter((command) => command.kind === 'turn').length, 0);
    const settled = await client.sessionRead(sessionId);
    strictEqual(settled.runtime.phase, 'idle');
    strictEqual(settled.pending.activeTask, undefined);
    strictEqual(settled.session.position.committedTurn, 0);
    const next = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Continue after cancelled preparation',
    });
    ok(next.kind === 'accepted');
    strictEqual(commands.filter((command) => command.kind === 'turn').length, 1);
  } finally {
    releaseStart();
    await task?.catch(() => undefined);
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
