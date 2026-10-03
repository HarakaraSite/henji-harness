import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
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
  const promise = new Promise<void>((accept) => resolve = accept);
  return { promise, resolve };
};

const encoder = new TextEncoder();
const secondStepText = 'Slice 4 parent second response';
const steeringText = 'Slice 4 steer this active turn';
const queuedText = 'Slice 4 queued child task';
const parentFinalPartial = 'Slice 4 parent final partial';
const childFinalText = 'Slice 4 child final result';
const cancelPartial = 'Slice 4 cancelled parent partial';
const discardedText = 'Slice 4 discarded child task';
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

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Increment 142 task state');
};

const assertSteeringPosition = (
  snapshot: SessionSnapshot,
  executionId: string,
): void => {
  const messages = entities(snapshot, 'message').filter((message) =>
    message.executionId === executionId
  );
  const secondStep = messages.findIndex((message) =>
    message.role === 'assistant' && message.text === secondStepText
  );
  const steering = messages.findIndex((message) =>
    message.role === 'user' && message.text === steeringText
  );
  const finalPartial = messages.findIndex((message) =>
    message.role === 'assistant' && message.text === parentFinalPartial
  );
  ok(secondStep >= 0, JSON.stringify(messages));
  ok(steering >= 0, JSON.stringify(messages));
  ok(finalPartial >= 0, JSON.stringify(messages));
  ok(secondStep < steering);
  ok(steering < finalPartial);
};

Deno.test('Increment 142 HTTP owns steering and follow-up through detach, settlement, cancel, and slot replacement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice4-http-' });
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
  await Deno.writeTextFile(`${workspaceRoot}/sample.txt`, 'Slice 4 tool result marker');
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });

  const steerResponseStarted = deferred();
  const parentFinalStarted = deferred();
  const cancelResponseStarted = deferred();
  const providerCancelled = deferred();
  let releaseSteerResponse = (): void => {};
  let releaseParentFinal = (): void => {};
  let providerRequests = 0;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      providerRequests += 1;
      if (providerRequests === 1) {
        return sseResponse(
          { type: 'response.output_text.delta', delta: 'Slice 4 text before tool result' },
          {
            type: 'response.completed',
            response: {
              id: crypto.randomUUID(),
              output: [{
                type: 'message',
                id: 'slice4-parent-tool-message',
                role: 'assistant',
                status: 'completed',
                content: [{
                  type: 'output_text',
                  text: 'Slice 4 text before tool result',
                  annotations: [],
                }],
              }, {
                type: 'function_call',
                id: 'slice4-read-function',
                status: 'completed',
                call_id: 'slice4-read-call',
                name: 'read',
                arguments: JSON.stringify({ path: 'sample.txt' }),
              }],
            },
          },
        );
      }
      if (providerRequests === 2) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({
                type: 'response.output_text.delta',
                delta: secondStepText,
              }));
              releaseSteerResponse = () => {
                controller.enqueue(frame({
                  type: 'response.completed',
                  response: {
                    id: crypto.randomUUID(),
                    output: [{
                      type: 'message',
                      id: 'slice4-second-step-message',
                      role: 'assistant',
                      status: 'completed',
                      content: [{
                        type: 'output_text',
                        text: secondStepText,
                        annotations: [],
                      }],
                    }, {
                      type: 'function_call',
                      id: 'slice4-second-read-function',
                      status: 'completed',
                      call_id: 'slice4-second-read-call',
                      name: 'read',
                      arguments: JSON.stringify({ path: 'sample.txt' }),
                    }],
                  },
                }));
                controller.close();
              };
              steerResponseStarted.resolve();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (providerRequests === 3) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({
                type: 'response.output_text.delta',
                delta: parentFinalPartial,
              }));
              releaseParentFinal = () => {
                controller.enqueue(frame(completedResponse(parentFinalPartial)));
                controller.close();
              };
              parentFinalStarted.resolve();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (providerRequests === 4) {
        return sseResponse(
          { type: 'response.output_text.delta', delta: childFinalText },
          completedResponse(childFinalText),
        );
      }
      if (providerRequests === 5) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({
                type: 'response.output_text.delta',
                delta: cancelPartial,
              }));
              cancelResponseStarted.resolve();
            },
            cancel() {
              providerCancelled.resolve();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
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
    rootMaxSteps: 4,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    providerDeclarations: declarations,
  };

  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let detached: AsyncGenerator<SessionStreamFrame> | undefined;
  let reconnected: AsyncGenerator<SessionStreamFrame> | undefined;
  try {
    core = await createCoreService(options);
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const firstSession = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(firstSession.kind, 'accepted');
    if (firstSession.kind !== 'accepted') return;
    const firstSessionId = firstSession.value.sessionId;
    detached = client.sessionSubscribe(firstSessionId)[Symbol.asyncIterator]();
    const initial = await detached.next();
    ok(!initial.done);
    if (initial.done || initial.value.kind !== 'session.snapshot') {
      throw new Error('subscription did not begin with a snapshot');
    }

    const parentCommandId = crypto.randomUUID();
    const parentInput = { commandId: parentCommandId, text: 'Read sample.txt and finish' };
    const [parent, duplicateParent] = await Promise.all([
      client.taskSubmit(firstSessionId, parentInput),
      client.taskSubmit(firstSessionId, parentInput),
    ]);
    strictEqual(parent.kind, 'accepted');
    strictEqual(duplicateParent.kind, 'accepted');
    if (parent.kind !== 'accepted' || duplicateParent.kind !== 'accepted') return;
    const parentExecutionId = parent.value.executionId;
    strictEqual(duplicateParent.value.executionId, parentExecutionId);
    const parentCommand = await client.commandRead(parentCommandId);
    strictEqual(parentCommand.kind, 'accepted');
    if (parentCommand.kind !== 'accepted') return;
    ok('executionId' in parentCommand.value);
    strictEqual(parentCommand.value.executionId, parentExecutionId);

    await steerResponseStarted.promise;
    const steeringCommandId = crypto.randomUUID();
    const steeringInput = { commandId: steeringCommandId, text: steeringText };
    const steering = await client.steeringSubmit(
      firstSessionId,
      parentExecutionId,
      steeringInput,
    );
    strictEqual(steering.kind, 'accepted');
    if (steering.kind !== 'accepted') return;
    strictEqual(steering.value.executionId, parentExecutionId);
    const duplicateSteering = await client.steeringSubmit(
      firstSessionId,
      parentExecutionId,
      steeringInput,
    );
    strictEqual(duplicateSteering.kind, 'accepted');

    const queueCommandId = crypto.randomUUID();
    const queueInput = {
      commandId: queueCommandId,
      afterExecutionId: parentExecutionId,
      text: queuedText,
    };
    const queued = await client.followUpQueue(firstSessionId, queueInput);
    strictEqual(queued.kind, 'accepted');
    if (queued.kind !== 'accepted') return;
    const duplicateQueue = await client.followUpQueue(firstSessionId, queueInput);
    strictEqual(duplicateQueue.kind, 'accepted');
    if (duplicateQueue.kind !== 'accepted') return;
    const queueId = queued.value.queueId;
    strictEqual(duplicateQueue.value.queueId, queueId);
    const queueCommand = await client.commandRead(queueCommandId);
    strictEqual(queueCommand.kind, 'accepted');
    if (queueCommand.kind !== 'accepted') return;
    ok('queueId' in queueCommand.value);
    strictEqual(queueCommand.value.queueId, queueId);

    await detached.return?.(undefined);
    detached = undefined;
    releaseSteerResponse();
    await parentFinalStarted.promise;
    await waitFor(async () => {
      const snapshot = await client.sessionRead(firstSessionId);
      return entities(snapshot, 'message').some((message) =>
        message.executionId === parentExecutionId && message.text === parentFinalPartial
      ) && entities(snapshot, 'message').some((message) =>
        message.executionId === parentExecutionId &&
        message.role === 'user' && message.text === steeringText
      );
    });

    reconnected = client.sessionSubscribe(firstSessionId)[Symbol.asyncIterator]();
    const resumed = await reconnected.next();
    ok(!resumed.done);
    if (resumed.done || resumed.value.kind !== 'session.snapshot') {
      throw new Error('reconnect did not begin with a snapshot');
    }
    const parentSnapshot = resumed.value.snapshot;
    strictEqual(parentSnapshot.pending.followUp?.queueId, queueId);
    strictEqual(parentSnapshot.pending.followUp?.text, queuedText);
    assertSteeringPosition(parentSnapshot, parentExecutionId);
    const parentTool = entities(parentSnapshot, 'tool').find((tool) =>
      tool.executionId === parentExecutionId
    );
    ok(parentTool !== undefined);
    strictEqual(parentTool?.result?.text.includes('Slice 4 tool result marker'), true);
    await reconnected.return?.(undefined);
    reconnected = undefined;

    releaseParentFinal();
    await waitFor(async () => {
      const result = await client.followUpRead(firstSessionId, queueId);
      return result.followUp.status === 'started' &&
        result.followUp.executionId !== undefined &&
        (await client.executionRead(parentExecutionId)).execution.processSettlement === 'complete';
    });
    const started = await client.followUpRead(firstSessionId, queueId);
    strictEqual(started.followUp.status, 'started');
    strictEqual(started.followUp.text, queuedText);
    strictEqual(started.followUp.afterExecutionId, parentExecutionId);
    const childExecutionId = started.followUp.executionId;
    ok(childExecutionId !== undefined);
    if (childExecutionId === undefined) return;
    await waitFor(async () =>
      (await client.executionRead(childExecutionId)).execution.processSettlement === 'complete'
    );
    const firstAfterChild = await client.sessionRead(firstSessionId);
    const startedRecord = firstAfterChild.pending.followUps.find((record) =>
      record.queueId === queueId
    );
    strictEqual(startedRecord?.status, 'started');
    strictEqual(startedRecord?.executionId, childExecutionId);

    const secondSession = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(secondSession.kind, 'accepted');
    if (secondSession.kind !== 'accepted') return;
    const oldFirstSession = await client.sessionRead(firstSessionId);
    const retainedStarted = oldFirstSession.pending.followUps.find((record) =>
      record.queueId === queueId
    );
    strictEqual(retainedStarted?.status, 'started');
    strictEqual(retainedStarted?.text, queuedText);
    strictEqual(retainedStarted?.executionId, childExecutionId);
    strictEqual(
      (await client.followUpRead(firstSessionId, queueId)).followUp.queueId,
      queueId,
    );

    const cancelSubmit = await client.taskSubmit(secondSession.value.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Wait for cancellation',
    });
    strictEqual(cancelSubmit.kind, 'accepted');
    if (cancelSubmit.kind !== 'accepted') return;
    const cancelExecutionId = cancelSubmit.value.executionId;
    await cancelResponseStarted.promise;
    const discarded = await client.followUpQueue(secondSession.value.sessionId, {
      commandId: crypto.randomUUID(),
      afterExecutionId: cancelExecutionId,
      text: discardedText,
    });
    strictEqual(discarded.kind, 'accepted');
    if (discarded.kind !== 'accepted') return;
    const discardedQueueId = discarded.value.queueId;
    const cancel = await client.executionCancel(
      secondSession.value.sessionId,
      cancelExecutionId,
      { commandId: crypto.randomUUID() },
    );
    strictEqual(cancel.kind, 'accepted');
    if (cancel.kind !== 'accepted') return;
    strictEqual(cancel.value.result, 'requested');
    await providerCancelled.promise;
    await waitFor(async () =>
      (await client.executionRead(cancelExecutionId)).execution.processSettlement === 'complete'
    );
    const discardedRecord = await client.followUpRead(
      secondSession.value.sessionId,
      discardedQueueId,
    );
    strictEqual(discardedRecord.followUp.status, 'discarded');
    strictEqual(discardedRecord.followUp.reason, 'cancelled');
    strictEqual(discardedRecord.followUp.text, discardedText);

    await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    const oldSecondSession = await client.sessionRead(secondSession.value.sessionId);
    const retainedDiscard = oldSecondSession.pending.followUps.find((record) =>
      record.queueId === discardedQueueId
    );
    strictEqual(retainedDiscard?.status, 'discarded');
    strictEqual(retainedDiscard?.reason, 'cancelled');
    strictEqual(retainedDiscard?.text, discardedText);
    strictEqual(providerRequests, 5);
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
