import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { requestKeyIdentity } from '../../v0/api/reducer.ts';
import type { SessionSnapshot, SessionStreamFrame } from '../../v0/api/contract.ts';
import type { ConversationEntity } from '../../v0/conversation/model.ts';

const entities = <K extends ConversationEntity['kind']>(
  snapshot: SessionSnapshot,
  kind: K,
): Extract<ConversationEntity, { kind: K }>[] =>
  snapshot.conversation.order.map((id) => snapshot.conversation.entities[id]).filter(
    (entity): entity is Extract<ConversationEntity, { kind: K }> => entity.kind === kind,
  );

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = () => accept(undefined);
    reject = fail;
  });
  return { promise, resolve, reject };
};

const encoder = new TextEncoder();
const liveThought = 'Slice 3 live thought marker';
const toolLeadText = 'Slice 3 text before tool output';
const cancelledPartialText = 'Slice 3 cancellation in progress';
const completedText = 'Slice 3 no-session final result';
const frame = (value: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

const sseResponse = (...events: readonly unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(frame(event));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const completedResponse = (text: string) => ({
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
});

const neverEnding = (
  text: string,
  started: ReturnType<typeof deferred>,
  canceled: ReturnType<typeof deferred>,
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({
          type: 'response.reasoning_summary_text.delta',
          delta: liveThought,
        }));
        controller.enqueue(
          frame({ type: 'response.output_text.delta', delta: text }),
        );
        started.resolve();
      },
      cancel() {
        canceled.resolve();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Slice 3 execution state');
};

const assertToolThenPartialOrder = (
  snapshot: SessionSnapshot,
  executionId: string,
  toolId: string,
): void => {
  const order = snapshot.conversation.order;
  const messages = entities(snapshot, 'message').filter((item) => item.executionId === executionId);
  const lead = messages.find((item) => item.role === 'assistant' && item.text === toolLeadText);
  const partial = messages.find((item) =>
    item.role === 'assistant' && item.text === cancelledPartialText
  );
  ok(lead && partial);
  ok(order.indexOf(lead.id) < order.indexOf(toolId));
  ok(order.indexOf(toolId) < order.indexOf(partial.id));
  strictEqual(
    messages.filter((item) => item.role === 'assistant' && item.toolIds?.includes(toolId)).length,
    1,
  );
  strictEqual(entities(snapshot, 'tool').filter((item) => item.id === toolId).length, 1);
};

const assertThoughtRequest = (snapshot: SessionSnapshot, executionId: string): void => {
  const thought = entities(snapshot, 'thinking').find((item) =>
    item.text === liveThought && item.executionId === executionId
  );
  const message = entities(snapshot, 'message').find((item) =>
    item.executionId === executionId && item.text === cancelledPartialText
  );
  ok(thought && message?.requestKey);
  strictEqual(requestKeyIdentity(message.requestKey), requestKeyIdentity(thought.requestKey));
  ok(
    snapshot.conversation.order.indexOf(thought.id) <
      snapshot.conversation.order.indexOf(message.id),
  );
};

Deno.test('Increment 141 HTTP admission survives detach, correlates duplicate commands, and settles cancel', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice3-http-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) {
    Deno.env.set(key, value);
  }
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(
    `${workspaceRoot}/sample.txt`,
    'Slice 3 tool result marker',
  );
  await Deno.writeTextFile(
    `${configRoot}/openrouter-api-key`,
    'localhost-test-key',
    {
      mode: 0o600,
    },
  );

  const cancelStarted = deferred();
  const providerCanceled = deferred();
  let providerRequests = 0;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      providerRequests += 1;
      if (providerRequests === 1) {
        return sseResponse(
          { type: 'response.output_text.delta', delta: toolLeadText },
          {
            type: 'response.completed',
            response: {
              id: crypto.randomUUID(),
              output: [{
                type: 'message',
                id: 'slice3-assistant-message',
                role: 'assistant',
                status: 'completed',
                content: [{
                  type: 'output_text',
                  text: toolLeadText,
                  annotations: [],
                }],
              }, {
                type: 'function_call',
                id: 'slice3-read-function',
                status: 'completed',
                call_id: 'slice3-read-call',
                name: 'read',
                arguments: JSON.stringify({ path: 'sample.txt' }),
              }],
            },
          },
        );
      }
      if (providerRequests === 2) {
        return neverEnding(
          cancelledPartialText,
          cancelStarted,
          providerCanceled,
        );
      }
      if (providerRequests === 3) {
        return sseResponse(
          { type: 'response.output_text.delta', delta: completedText },
          completedResponse(completedText),
        );
      }
      throw new Error(`unexpected provider request ${providerRequests}`);
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
    agent: 'default' as const,
    agentChoice: {},
    rootMaxSteps: 3,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    providerDeclarations: declarations,
  };

  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let detached: AsyncGenerator<SessionStreamFrame> | undefined;
  let reconnected: AsyncGenerator<SessionStreamFrame> | undefined;
  const statuses: number[] = [];
  try {
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url, async (input, init) => {
      const response = await fetch(input, init);
      if (
        String(input).includes('/tasks') || String(input).includes('/cancel')
      ) {
        statuses.push(response.status);
      }
      return response;
    });
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'none' },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') return;
    const sessionId = opened.value.sessionId;

    detached = client.sessionSubscribe(sessionId)[Symbol.asyncIterator]();
    const firstFrame = await detached.next();
    ok(!firstFrame.done);
    const commandId = crypto.randomUUID();
    const submitInput = {
      commandId,
      text: 'Read sample.txt, then return the result after reconnect',
    };
    const [accepted, duplicate] = await Promise.all([
      client.taskSubmit(sessionId, submitInput),
      client.taskSubmit(sessionId, submitInput),
    ]);
    strictEqual(accepted.kind, 'accepted');
    strictEqual(duplicate.kind, 'accepted');
    if (accepted.kind !== 'accepted' || duplicate.kind !== 'accepted') return;
    const executionId = accepted.value.executionId;
    strictEqual(duplicate.value.executionId, executionId);
    strictEqual(statuses.filter((status) => status === 202).length, 2);
    const command = await client.commandRead(commandId);
    strictEqual(command.kind, 'accepted');
    if (command.kind !== 'accepted') return;
    ok('executionId' in command.value);
    strictEqual(command.value.executionId, executionId);

    await cancelStarted.promise;
    await waitFor(async () => {
      const snapshot = await client.sessionRead(sessionId);
      return entities(snapshot, 'message').some((message) =>
        message.role === 'assistant' &&
        message.executionId === executionId &&
        message.text === cancelledPartialText
      ) && entities(snapshot, 'thinking').some((item) =>
        item.requestKey.executionId === executionId && item.text === liveThought
      );
    });
    const inProgress = await client.sessionRead(sessionId);
    strictEqual(inProgress.runtime.execution?.executionId, executionId);
    strictEqual(inProgress.runtime.execution?.submittedByCommandId, commandId);
    strictEqual(inProgress.runtime.execution?.processSettlement, 'running');
    ok(
      entities(inProgress, 'message').some((message) =>
        message.role === 'user' && message.executionId === executionId
      ),
    );
    const call = entities(inProgress, 'tool').find((tool) => tool.executionId === executionId);
    ok(call !== undefined);
    ok(call.result?.text.includes('Slice 3 tool result marker'));
    assertToolThenPartialOrder(
      inProgress,
      executionId,
      call.id,
    );
    assertThoughtRequest(inProgress, executionId);

    await detached.return?.(undefined);
    detached = undefined;
    reconnected = client.sessionSubscribe(sessionId)[Symbol.asyncIterator]();
    const resumedFrame = await reconnected.next();
    ok(!resumedFrame.done);
    if (!resumedFrame.done && resumedFrame.value.kind === 'session.snapshot') {
      strictEqual(
        resumedFrame.value.snapshot.runtime.execution?.executionId,
        executionId,
      );
      ok(
        entities(resumedFrame.value.snapshot, 'tool').some((tool) =>
          tool.id === call.id &&
          tool.result !== undefined
        ),
      );
      assertToolThenPartialOrder(
        resumedFrame.value.snapshot,
        executionId,
        call.id,
      );
    } else {
      throw new Error('reconnect did not begin with a snapshot');
    }
    await reconnected.return?.(undefined);
    reconnected = undefined;

    const cancelResult = await client.executionCancel(
      sessionId,
      executionId,
      { commandId: crypto.randomUUID() },
    );
    strictEqual(cancelResult.kind, 'accepted');
    if (cancelResult.kind !== 'accepted') return;
    strictEqual(cancelResult.value.result, 'requested');
    await providerCanceled.promise;
    await waitFor(async () =>
      (await client.executionRead(executionId)).execution
        .processSettlement === 'complete'
    );
    const cancelled = await client.executionRead(executionId);
    strictEqual(cancelled.execution.outcome, 'cancelled');
    strictEqual(cancelled.execution.stopReason, 'cancelled');
    strictEqual(cancelled.execution.adoption, 'non_canonical');
    strictEqual(cancelled.execution.processSettlement, 'complete');
    strictEqual(statuses.includes(200), true);
    const afterCancel = await client.sessionRead(sessionId);
    strictEqual(afterCancel.runtime.execution?.executionId, executionId);
    strictEqual(afterCancel.runtime.execution?.outcome, 'cancelled');
    strictEqual(afterCancel.runtime.execution?.stopReason, cancelled.execution.stopReason);
    strictEqual(
      JSON.stringify(afterCancel.runtime.execution?.diagnostic),
      JSON.stringify(cancelled.execution.diagnostic),
    );
    ok(
      entities(afterCancel, 'message').some((message) =>
        message.role === 'user' && message.executionId === executionId
      ),
    );
    ok(
      entities(afterCancel, 'message').some((message) =>
        message.role === 'assistant' &&
        message.executionId === executionId &&
        message.text === cancelledPartialText
      ),
      JSON.stringify({
        runtime: afterCancel.runtime,
        messages: entities(afterCancel, 'message'),
        entities: afterCancel.conversation.entities,
      }),
    );
    assertThoughtRequest(afterCancel, executionId);

    assertToolThenPartialOrder(
      afterCancel,
      executionId,
      call.id,
    );

    const finalSession = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'none' },
    });
    strictEqual(finalSession.kind, 'accepted');
    if (finalSession.kind !== 'accepted') return;
    strictEqual(
      (await client.sessionRead(finalSession.value.sessionId)).session.persistence,
      'none',
    );
    const finalSubmit = await client.taskSubmit(finalSession.value.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Return a short final result',
    });
    strictEqual(finalSubmit.kind, 'accepted');
    if (finalSubmit.kind !== 'accepted') return;
    strictEqual(statuses.filter((status) => status === 202).length, 3);
    await waitFor(async () =>
      (await client.executionRead(finalSubmit.value.executionId)).execution
        .processSettlement === 'complete'
    );
    const finalExecution = await client.executionRead(finalSubmit.value.executionId);
    strictEqual(finalExecution.execution.outcome, 'completed');
    strictEqual(finalExecution.execution.adoption, 'non_canonical');
    const finalSnapshot = await client.sessionRead(finalSession.value.sessionId);
    strictEqual(entities(finalSnapshot, 'request').length, 1);
    strictEqual(
      entities(finalSnapshot, 'message').filter((message) =>
        message.role === 'assistant' && message.text === completedText
      ).length,
      1,
    );
  } finally {
    await detached?.return?.(undefined);
    await reconnected?.return?.(undefined);
    await server?.shutdown();
    server = undefined;
    await core?.close();
    core = undefined;
    await provider.shutdown();
    await provider.finished;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
