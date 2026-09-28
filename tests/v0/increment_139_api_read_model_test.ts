import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { restoredConversationFromSnapshot } from '../../v0/tui/snapshot_presentation.ts';

const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const completedResponse = (output: unknown[]) => ({
  type: 'response.completed',
  response: { id: crypto.randomUUID(), output },
});
const message = (text: string) => ({
  type: 'message',
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const providerResponse = (output: unknown[]) =>
  new Response(frame(completedResponse(output)), {
    headers: { 'content-type': 'text/event-stream' },
  });
const streamedFinal = (text: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: 'response.output_text.delta', delta: text }));
        controller.enqueue(frame(completedResponse([message(text)])));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Core HTTP task history');
};

Deno.test('Increment 139 HTTP keeps reused provider tool IDs distinct across two executions and resume', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-increment-139-http-' });
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
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${workspaceRoot}/sample.txt`, 'shared query sample');
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });

  let requestCount = 0;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      requestCount += 1;
      if (requestCount % 2 === 1) {
        return providerResponse([{
          type: 'message',
          id: `assistant-${requestCount}`,
          role: 'assistant',
          status: 'completed',
          content: [{
            type: 'output_text',
            text: 'I will read the sample file.',
            annotations: [],
          }],
        }, {
          type: 'function_call',
          id: `function-${requestCount}`,
          status: 'completed',
          // Providers may reuse this identifier; each execution must retain its own occurrence.
          call_id: 'same-provider-call',
          name: 'read',
          arguments: JSON.stringify({ path: 'sample.txt' }),
        }]);
      }
      return streamedFinal(`RESULT ${requestCount / 2}`);
    },
  );
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
      : entry
  );
  const options = {
    workspaceRoot,
    configRoot,
    stateRoot,
    dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
    physicalIoMode: 'production' as const,
    providerDeclarations: declarations,
  };
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let resumedCore: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let resumedServer: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
      activation: {
        agent: 'default',
        maxSteps: 3,
        providerTimeoutMs: 5_000,
        rootProvider: 'openrouter-responses',
      },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') return;
    const sessionId = opened.value.snapshot.session.id;

    for (
      const [index, text] of [
        'Read sample.txt and return result one',
        'Read sample.txt and return result two',
      ].entries()
    ) {
      const submitted = await client.taskSubmit(sessionId, {
        commandId: crypto.randomUUID(),
        text,
      });
      strictEqual(submitted.kind, 'accepted');
      if (submitted.kind !== 'accepted') return;
      const executionId = submitted.value.executionId;
      await waitFor(async () =>
        (await client.executionRead(executionId)).execution.processSettlement === 'complete'
      );
      const execution = await client.executionRead(executionId);
      strictEqual(execution.execution.outcome, 'completed', JSON.stringify(execution));
      const visible = await client.sessionRead(sessionId);
      strictEqual(
        visible.conversation.messages.filter((item) => item.text === `RESULT ${index + 1}`).length,
        1,
      );
    }

    strictEqual(requestCount, 4);
    let snapshot = await client.sessionRead((await client.coreRead()).activeSessionId!);
    strictEqual(snapshot.conversation.tools.length, 2);
    const toolIds = snapshot.conversation.tools.map((tool) => tool.toolOccurrenceId);
    strictEqual(new Set(toolIds).size, 2);
    strictEqual(
      new Set(snapshot.conversation.tools.map((tool) => tool.executionId)).size,
      2,
    );
    for (const tool of snapshot.conversation.tools) {
      strictEqual(tool.result?.outcome, 'success');
      ok(tool.result?.text.includes('shared query sample'));
    }
    for (const text of ['RESULT 1', 'RESULT 2']) {
      strictEqual(
        snapshot.conversation.messages.filter((item) => item.text === text).length,
        1,
      );
    }
    strictEqual(snapshot.conversation.requests.length, 0);
    const visible = restoredConversationFromSnapshot(snapshot);
    const visibleToolIds = visible.messages.flatMap((item) =>
      item.role === 'tool' ? item.content.map((result) => result.callId) : []
    );
    strictEqual(visibleToolIds.length, 2);
    strictEqual(new Set(visibleToolIds).size, 2);

    await server.shutdown();
    server = undefined;
    await core.close();
    core = undefined;

    resumedCore = await createCoreService(options);
    resumedServer = await startCoreServer(resumedCore);
    const resumedClient = new HenjiApiClient(resumedServer.url);
    const resumed = await resumedClient.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'exact', sessionId: snapshot.session.id },
    });
    strictEqual(resumed.kind, 'accepted');
    if (resumed.kind !== 'accepted') return;
    snapshot = resumed.value.snapshot;
    strictEqual(
      snapshot.conversation.tools.map((tool) => tool.toolOccurrenceId).join(','),
      toolIds.join(','),
    );
    strictEqual(snapshot.conversation.requests.length, 0);
    strictEqual(requestCount, 4, 'resuming the Session must not call the provider');
    strictEqual(
      restoredConversationFromSnapshot(snapshot).messages.flatMap((item) =>
        item.role === 'tool' ? item.content.map((result) => result.callId) : []
      ).join(','),
      visibleToolIds.join(','),
    );
  } finally {
    await resumedServer?.shutdown();
    await resumedCore?.close();
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
