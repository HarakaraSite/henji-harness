import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { main as diagnostics } from '../../v0/agent/cli/failure_diagnostic_cli.ts';
import { startFailureProvider176 } from './helpers/increment_176_provider.ts';

Deno.test('Increment 176 production Worker saves provider and tool failures and diagnostics CLI reads them', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-176-http-' });
  const credential = 'increment-176-only-a-dummy-key';
  const provider = startFailureProvider176(credential);
  const environment = {
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const configRoot = `${root}/config/henji-harness`;
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, credential, { mode: 0o600 });
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
  const reader = new SqliteHistoryV7ProductionStore(`${root}/state`, root, { readOnly: true });
  try {
    await reader.initialize();
    const sessionId = core.coreRead().activeSessionId!;
    const submit = async (text: string) => {
      const receipt = await client.taskSubmit(sessionId, { commandId: crypto.randomUUID(), text });
      if (receipt.kind !== 'accepted') throw new Error('Task must be accepted');
      const deadline = Date.now() + 8_000;
      while (
        (await client.executionRead(receipt.value.executionId)).execution.processSettlement !==
          'complete'
      ) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for execution');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return reader.readExecution(receipt.value.executionId);
    };
    const cli = async (args: string[]) => {
      let output = '';
      let error = '';
      const result = await diagnostics(args, {
        workspaceRoot: root,
        stateRoot: `${root}/state`,
        writeStdout: (text) => {
          output += text;
        },
        writeStderr: (text) => {
          error += text;
        },
      });
      strictEqual(result, 0, error);
      ok(!output.includes(credential));
      return JSON.parse(output);
    };
    const failed = await submit('provider error');
    strictEqual(failed.outcome, 'failed');
    ok(failed.diagnosticId);
    const diagnostic = await cli(['show', '--id', failed.diagnosticId]);
    strictEqual(diagnostic.code, 'response_error');
    strictEqual(diagnostic.httpStatus, 200);
    strictEqual(diagnostic.details.exceptionType, 'APIError');
    strictEqual(diagnostic.details.errorType, 'invalid_request_error');
    strictEqual(diagnostic.details.requestId, 'i176-request');
    strictEqual(diagnostic.details.responseId, 'i176-response');
    strictEqual(diagnostic.details.completedReceived, false);
    const request = await cli([
      'executions',
      'request',
      '--id',
      failed.executionId,
      '--ordinal',
      '1',
    ]);
    const requestFailure = request.providerFacts.find((fact: { kind: string }) =>
      fact.kind === 'provider_request_failure'
    );
    deepStrictEqual(requestFailure.payload.observation.failure.details, diagnostic.details);

    const tool = await submit('tool error');
    strictEqual(tool.outcome, 'completed');
    strictEqual(tool.adoption, 'canonical');
    const saved = await reader.readWorker(sessionId);
    const result = saved.transcript.flatMap((message) =>
      message.role === 'tool' ? message.content : []
    )
      .find((result) => result.name === 'read');
    ok(result && !('terminal' in result));
    strictEqual(result.outcome, 'error');
    strictEqual(result.failure?.operation, 'tool_execute');
    strictEqual(result.failure?.message, 'file not found');
    const events = await cli(['executions', 'events', '--id', tool.executionId]);
    ok(JSON.stringify(events).includes('tool_execute'));

    const normal = await submit('normal success');
    strictEqual(normal.outcome, 'completed');
    strictEqual(normal.diagnosticId, undefined);
    const normalFacts = reader.listExecutionEvents(normal.executionId).filter((event) =>
      event.kind.startsWith('provider_')
    );
    deepStrictEqual(normalFacts.map((event) => event.kind), [
      'provider_request_start',
      'provider_response_start',
    ]);
    ok(!JSON.stringify(normalFacts).includes('"details"'));
    strictEqual(provider.requestCount(), 4);
  } finally {
    await server.shutdown();
    await core.close();
    await provider.server.shutdown();
    reader.close();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
