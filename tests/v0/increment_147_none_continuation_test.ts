import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';

const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for none Session continuation');
};

Deno.test('Increment 147 none Session completes accepted follow-up and later task without canonical storage', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i147-none-' });
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
  await Deno.writeTextFile(`${workspaceRoot}/sample.txt`, 'NONE_PARENT_TOOL_RESULT');
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });

  const inputs: string[] = [];
  const outputs = ['NONE_PARENT_DONE', 'NONE_FOLLOW_UP_DONE', 'NONE_NEXT_TASK_DONE'];
  let releaseParent = () => {};
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.json();
      inputs.push(JSON.stringify(body.input));
      if (inputs.length === 1) {
        return new Response(
          frame({
            type: 'response.completed',
            response: {
              id: crypto.randomUUID(),
              output: [{
                type: 'function_call',
                id: 'none-parent-read',
                status: 'completed',
                call_id: 'none-parent-call',
                name: 'read',
                arguments: JSON.stringify({ path: 'sample.txt' }),
              }],
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const text = outputs[inputs.length - 2];
      ok(text !== undefined);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(frame({
              type: 'response.reasoning_summary_text.delta',
              delta: `Thinking about ${text}`,
            }));
            controller.enqueue(frame({ type: 'response.output_text.delta', delta: text }));
            const finish = () => {
              controller.enqueue(frame({
                type: 'response.completed',
                response: {
                  id: crypto.randomUUID(),
                  output: [{
                    type: 'message',
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text, annotations: [] }],
                  }],
                },
              }));
              controller.close();
            };
            if (inputs.length === 2) releaseParent = finish;
            else finish();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  const declarations = builtinProviderDeclarations().map((entry) =>
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
      stateRoot,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      physicalIoMode: 'production',

      rootMaxSteps: 4,
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations: declarations,
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'none' },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') return;
    const sessionId = opened.value.sessionId;
    deepStrictEqual((await client.contextRead(sessionId)).context, {});
    const parent = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Complete the none Session parent',
    });
    strictEqual(parent.kind, 'accepted');
    if (parent.kind !== 'accepted') return;
    await waitFor(() => inputs.length === 2);
    const queued = await client.followUpQueue(sessionId, {
      commandId: crypto.randomUUID(),
      afterExecutionId: parent.value.executionId,
      text: 'Continue the same none Session as a follow-up',
    });
    strictEqual(queued.kind, 'accepted');
    if (queued.kind !== 'accepted') return;
    releaseParent();
    await waitFor(async () => {
      const followUp = (await client.followUpRead(sessionId, queued.value.queueId)).followUp;
      return followUp.executionId !== undefined &&
        (await client.executionRead(followUp.executionId)).execution.processSettlement ===
          'complete';
    });
    const followUp = (await client.followUpRead(sessionId, queued.value.queueId)).followUp;
    strictEqual(followUp.status, 'started');
    ok(followUp.executionId !== undefined);
    strictEqual((await client.coreRead()).activeSessionId, sessionId);

    // Metadata can also advance the live Host's revision between ordinary admissions.
    const renamed = await client.sessionRename(sessionId, {
      commandId: crypto.randomUUID(),
      title: 'Live none Session after follow-up',
    });
    strictEqual(renamed.kind, 'accepted');
    const next = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Continue the same none Session with another ordinary task',
    });
    strictEqual(next.kind, 'accepted');
    if (next.kind !== 'accepted') return;
    await waitFor(async () =>
      (await client.executionRead(next.value.executionId)).execution.processSettlement ===
        'complete'
    );
    for (const id of [parent.value.executionId, followUp.executionId!, next.value.executionId]) {
      const execution = (await client.executionRead(id)).execution;
      strictEqual(execution.outcome, 'completed');
      strictEqual(execution.adoption, 'non_canonical');
      strictEqual(execution.committedRevision, undefined);
      strictEqual(execution.sessionId, sessionId);
    }
    const snapshot = await client.sessionRead(sessionId);
    strictEqual(snapshot.session.persistence, 'none');
    strictEqual(snapshot.session.canonicalSessionId, null);
    for (const text of outputs) {
      strictEqual(
        Object.values(snapshot.conversation.entities).filter((entity) =>
          entity.kind === 'message' && entity.text === text
        ).length,
        1,
      );
    }
    for (const text of outputs) {
      ok(
        Object.values(snapshot.conversation.entities).some((entity) =>
          entity.kind === 'thinking' && entity.text === `Thinking about ${text}`
        ),
      );
    }
    const parentTool = Object.values(snapshot.conversation.entities).find((entity) =>
      entity.kind === 'tool' && entity.executionId === parent.value.executionId
    );
    ok(parentTool !== undefined && parentTool.kind === 'tool');
    ok(parentTool.result?.text.includes('NONE_PARENT_TOOL_RESULT'));
    ok(parentTool.started);
    ok(parentTool.semanticOccurrenceId);
    ok(snapshot.conversation.order.includes(parentTool.id));
    deepStrictEqual((await client.contextRead(sessionId)).context, snapshot.context);
    strictEqual(inputs.length, 4);
    ok(inputs[2].includes(outputs[0]));
    ok(inputs[3].includes(outputs[1]));
    await server.shutdown();
    server = undefined;
    await core.close();
    core = undefined;
    const history = new SqliteHistoryStore(stateRoot, workspaceRoot);
    try {
      deepStrictEqual((await history.listWorker()).sessions, []);
      strictEqual(history.listExecutionsForSession(sessionId).length, 3);
    } finally {
      history.close();
    }
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
