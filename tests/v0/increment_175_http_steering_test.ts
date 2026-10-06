import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import {
  originalAnswer,
  startFinalSteeringProvider,
  steeredAnswer,
} from './helpers/increment_175_provider.ts';

Deno.test('Increment 175 production Worker applies steering from a final response and saves the continued answer', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-175-http-' });
  const provider = startFinalSteeringProvider();
  const environment = {
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const configRoot = `${root}/config/henji-harness`;
  const credentialRoot = `${root}/state/credentials`;
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.mkdir(credentialRoot, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${credentialRoot}/openrouter-api-key`, 'increment-175-dummy-key', {
    mode: 0o600,
  });
  const core = await createCoreService({
    workspaceRoot: root,
    configRoot,
    dataRoot: `${root}/data`,
    stateRoot: `${root}/state`,
    physicalIoMode: 'production',
    initialSession: { kind: 'new' },
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    providerDeclarations: builtinProviderDeclarations().map((entry) =>
      entry.providerId === 'openrouter-responses'
        ? { ...entry, endpoint: `${provider.origin}/v1` }
        : entry
    ),
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const task = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Original task',
    });
    strictEqual(task.kind, 'accepted');
    if (task.kind !== 'accepted') throw new Error('Task must be accepted');
    const startedDeadline = Date.now() + 8_000;
    while (provider.requests.length === 0) {
      const execution = (await client.executionRead(task.value.executionId)).execution;
      if (execution.processSettlement === 'complete') {
        throw new Error(`Execution ended before the local request: ${execution.outcome}`);
      }
      if (Date.now() > startedDeadline) throw new Error('Timed out waiting for the local request');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await provider.firstStarted;
    const steeringText = 'Research the web before answering.';
    const steeringCommandId = crypto.randomUUID();
    const receipt = await client.steeringSubmit(sessionId, task.value.executionId, {
      commandId: steeringCommandId,
      text: steeringText,
    });
    strictEqual(receipt.kind, 'accepted');
    const pending = await client.sessionRead(sessionId);
    strictEqual(pending.pending.steering?.text, steeringText);
    provider.releaseFirst();
    const deadline = Date.now() + 8_000;
    while (
      (await client.executionRead(task.value.executionId)).execution.processSettlement !==
        'complete'
    ) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the continued execution');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    strictEqual(provider.requests.length, 2);
    const secondInput = provider.requests[1].input as Array<Record<string, unknown>>;
    const firstAssistant = secondInput.findIndex((item) => item.type === 'message');
    const steeringIndex = secondInput.findIndex((item) =>
      item.role === 'user' && item.content === steeringText
    );
    ok(firstAssistant >= 0 && steeringIndex > firstAssistant);
    const snapshot = await client.sessionRead(sessionId);
    const messages = snapshot.conversation.order.map((id) => snapshot.conversation.entities[id])
      .filter((entity) =>
        entity.kind === 'message' && entity.executionId === task.value.executionId
      )
      .map((entity) =>
        entity.kind === 'message' ? { role: entity.role, text: entity.text } : undefined
      );
    deepStrictEqual(messages, [
      { role: 'user', text: 'Original task' },
      { role: 'assistant', text: originalAnswer },
      { role: 'user', text: steeringText },
      { role: 'assistant', text: steeredAnswer },
    ]);
    strictEqual(snapshot.pending.steering, undefined);
    const execution = await client.executionRead(task.value.executionId);
    strictEqual(execution.execution.outcome, 'completed', JSON.stringify(execution));
    strictEqual(execution.execution.adoption, 'canonical');
    strictEqual(execution.execution.stopReason, 'final');
    strictEqual(execution.execution.requestCount, 2);
    const nextTask = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Continue from the saved answer.',
    });
    if (nextTask.kind !== 'accepted') throw new Error('Next task must be accepted');
    const nextDeadline = Date.now() + 8_000;
    while (
      (await client.executionRead(nextTask.value.executionId)).execution.processSettlement !==
        'complete'
    ) {
      if (Date.now() > nextDeadline) throw new Error('Timed out waiting for the next task');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const nextExecution = (await client.executionRead(nextTask.value.executionId)).execution;
    strictEqual(nextExecution.turn, 2);
    strictEqual(nextExecution.outcome, 'completed');
    strictEqual(nextExecution.adoption, 'canonical');
  } finally {
    provider.releaseFirst();
    await server.shutdown();
    await core.close();
    await provider.server.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
