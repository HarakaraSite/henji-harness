import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { renderSessionTimeline } from '../../v0/agent/history/history_view.ts';
import { TuiPresentationAdapter } from '../../v0/presentation/tui_presentation_adapter.ts';
import { restoredPresentationConversation } from '../../v0/presentation/adapter_projection.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const thinking = (step: number) => ({
  type: 'reasoning',
  id: `reasoning-${step}`,
  content: [{ type: 'reasoning_text', text: `Thinking ${step}.` }],
});

const message = (step: number, text: string) => ({
  type: 'message',
  id: `message-${step}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const call = (id: string) => ({
  type: 'function_call',
  id: `function-${id}`,
  status: 'completed',
  call_id: id,
  name: 'read',
  arguments: '{"path":"marker.txt"}',
});

// Match the observed reasoning/message/function-call output, with real text deltas and no
// helper-only top-level output_text. Step 2 has no accompanying text; step 3 is the final answer.
const outputs = [
  [thinking(1), message(1, 'I will read the marker.'), call('read-1'), call('read-2')],
  [thinking(2), call('read-3')],
  [thinking(3), message(3, 'Done.')],
];

const streamFor = (step: number): string => {
  const output = outputs[step - 1];
  const events: unknown[] = [{
    type: 'response.reasoning_text.delta',
    delta: `Thinking ${step}.`,
    item_id: `reasoning-${step}`,
    output_index: 0,
    content_index: 0,
  }];
  const text = step === 1 ? 'I will read the marker.' : step === 3 ? 'Done.' : undefined;
  if (text !== undefined) {
    for (const delta of [text.slice(0, 3), text.slice(3)]) {
      events.push({
        type: 'response.output_text.delta',
        delta,
        item_id: `message-${step}`,
        output_index: 1,
        content_index: 0,
      });
    }
  }
  events.push({
    type: 'response.completed',
    response: { id: `response-${step}`, status: 'completed', output },
  });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
};

Deno.test('Increment 137 Responses notes settle before later thinking and survive Host persistence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i137-' });
  const env = {
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = new Map(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${env.XDG_CONFIG_HOME}/henji-harness`;
  const stateRoot = `${env.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${workspaceRoot}/marker.txt`, 'marker');
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'local-test-key', { mode: 0o600 });
  const inputs: Record<string, unknown>[][] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    assert(new URL(request.url).pathname === '/v1/responses');
    const body = await request.json();
    inputs.push(body.input);
    assert(inputs.length <= outputs.length, 'unexpected extra model request');
    return new Response(streamFor(inputs.length), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${server.addr.port}/v1` }
      : entry
  );
  let adapter: TuiPresentationAdapter | undefined;
  let ui = createUiState();
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      configRoot,
      dataRoot: `${env.XDG_DATA_HOME}/henji-harness`,
      stateRoot,
      persistence: 'new',
      physicalIoMode: 'production',
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations: declarations,
      eventSink: (event) => adapter?.deliverCoreEvent(event),
    });
    adapter = new TuiPresentationAdapter(created.session, (event) => {
      ui = reduceUiEvent(ui, event);
    });
    const outcome = await adapter.submit('Read the marker and report.');
    assert(outcome.ok, JSON.stringify(outcome));
    assertEquals(inputs.length, 3);
    assertEquals(ui.log.entries.map((entry) => entry.kind), [
      'user',
      'thinking',
      'assistant',
      'tool',
      'tool',
      'thinking',
      'tool',
      'thinking',
      'assistant',
    ]);
    const notes = ui.log.entries.filter((entry) => entry.kind === 'assistant');
    assertEquals(notes.map((entry) => [entry.label, entry.text, entry.live]), [
      ['assistant note>', 'I will read the marker.', false],
      ['assistant>', 'Done.', false],
    ]);
    assertEquals(ui.activeAssistantId, undefined);
    assertEquals(inputs[1].slice(1), [
      ...outputs[0],
      { type: 'function_call_output', call_id: 'read-1', output: 'marker' },
      { type: 'function_call_output', call_id: 'read-2', output: 'marker' },
    ]);

    const sessionId = created.session.sessionId;
    await created.close();
    created = undefined;
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {});
    const record = await store.readWorker(sessionId);
    const assistants = record.transcript.filter((entry) => entry.role === 'assistant');
    assertEquals(assistants[0].text, 'I will read the marker.');
    assertEquals(assistants[1].text, undefined);
    const history = store.readSessionHistory(sessionId);
    const timeline = renderSessionTimeline(history);
    const order = [
      'Thinking 1.',
      'assistant note> I will read the marker.',
      'tool> read marker.txt',
      'Thinking 2.',
      'Thinking 3.',
      'assistant> Done.',
    ].map((text) => timeline.indexOf(text));
    assert(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), timeline);

    resumed = await createWorkerSession({
      workspaceRoot,
      configRoot,
      dataRoot: `${env.XDG_DATA_HOME}/henji-harness`,
      stateRoot,
      persistence: 'session',
      sessionId,
      physicalIoMode: 'production',
      providerDeclarations: declarations,
    });
    assert(resumed.restored !== undefined);
    const restored = restoredPresentationConversation(resumed.restored);
    const restoredUi = reduceUiEvent(createUiState(), { kind: 'restored_log', ...restored });
    assertEquals(
      restoredUi.log.entries.map((entry) => [entry.kind, entry.text]),
      ui.log.entries.map((entry) => [entry.kind, entry.text]),
    );
    assert(inputs.length === 3, 'restoring the Session must not make a model request');
  } finally {
    await resumed?.close();
    await created?.close();
    await server.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    setActiveProviderDeclarations([]);
    await Deno.remove(root, { recursive: true });
  }
});
