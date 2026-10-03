import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { reduceSessionStreamFrame, type SessionClientState } from '../../v0/api/reducer.ts';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { startFinalSteeringProvider } from './helpers/increment_175_provider.ts';

Deno.test('Increment 180 accepted HTTP receipt identifies the published execution without a second refresh', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-180-receipt-' });
  const provider = startFinalSteeringProvider();
  const environment = {
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const configRoot = `${root}/config/henji-harness`;
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'increment-180-dummy-key', {
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
  const sessionId = core.coreRead().activeSessionId!;
  const snapshots = new Map<number, SessionSnapshot>();
  const abort = new AbortController();
  let ready!: () => void;
  const streamReady = new Promise<void>((resolve) => ready = resolve);
  const reading = (async () => {
    let state: SessionClientState | undefined;
    try {
      for await (const frame of client.sessionSubscribe(sessionId, { signal: abort.signal })) {
        state = reduceSessionStreamFrame(state, frame);
        snapshots.set(state.snapshot.cursor.revision, state.snapshot);
        ready();
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  try {
    await streamReady;
    const commandId = crypto.randomUUID();
    const receipt = await client.taskSubmit(sessionId, { commandId, text: 'Publish this receipt' });
    if (receipt.kind !== 'accepted') throw new Error('Task must be accepted');
    ok(receipt.cursor);
    await provider.firstStarted;
    const deadline = Date.now() + 8_000;
    while (!snapshots.has(receipt.cursor.revision)) {
      if (Date.now() > deadline) {
        throw new Error('Receipt cursor was not published to the API stream');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const published = snapshots.get(receipt.cursor.revision)!;
    deepStrictEqual(published.cursor, receipt.cursor);
    strictEqual(published.pending.activeTask?.executionId, receipt.value.executionId);
    strictEqual(published.pending.activeTask?.commandId, commandId);
    strictEqual(published.runtime.active, true);
    ok(!published.runtime.operations.includes('task.submit'));
    provider.releaseFirst();
    while (
      (await client.executionRead(receipt.value.executionId)).execution.processSettlement !==
        'complete'
    ) {
      if (Date.now() > deadline) throw new Error('Receipt execution did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settled = (await client.executionRead(receipt.value.executionId)).execution;
    strictEqual(settled.submittedByCommandId, commandId);
    strictEqual(settled.outcome, 'completed');
    strictEqual(settled.adoption, 'canonical');
  } finally {
    provider.releaseFirst();
    abort.abort();
    await reading;
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
