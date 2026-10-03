import { deepStrictEqual, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

Deno.test('Increment 159 HTTP exposes the stored short failure reason in snapshot and execution read', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i159-outcome-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () => new Response('local provider unavailable', { status: 503 }),
  );
  const providerDeclarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
      : entry
  );
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    core = await createCoreService({
      workspaceRoot,
      configRoot,
      stateRoot: `${environment.XDG_STATE_HOME}/henji-harness/v1`,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      physicalIoMode: 'production',
      providerDeclarations,
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
      activation: { agent: 'default', maxSteps: 2, rootProvider: 'openrouter-responses' },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') return;
    const sessionId = opened.value.sessionId;
    const submitted = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Return a result',
    });
    strictEqual(submitted.kind, 'accepted');
    if (submitted.kind !== 'accepted') return;
    const executionId = submitted.value.executionId;
    const deadline = Date.now() + 8_000;
    while ((await client.executionRead(executionId)).execution.processSettlement !== 'complete') {
      if (Date.now() > deadline) throw new Error('local failure did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { execution } = await client.executionRead(executionId);
    strictEqual(execution.outcome, 'failed');
    strictEqual(execution.stopReason, 'contract_failure');
    deepStrictEqual(execution.diagnostic, { code: 'http_error', stage: 'http' });
    const snapshot = await client.sessionRead(sessionId);
    strictEqual(snapshot.runtime.execution?.stopReason, execution.stopReason);
    deepStrictEqual(snapshot.runtime.execution?.diagnostic, execution.diagnostic);
  } finally {
    await server?.shutdown();
    await core?.close();
    await provider.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
