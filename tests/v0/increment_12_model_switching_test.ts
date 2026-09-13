import type { Message, ModelRequest } from '../../v0/agent/core/contracts.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_model.ts';
import {
  OPENROUTER_MODEL_CATALOG,
  openRouterProfileFor,
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
  searchOpenRouterModels,
  selectOpenRouterModel,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_host.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

Deno.test('Increment 12 curated catalog has the approved defaults and searchable choices', () => {
  assertEquals(OPENROUTER_MODEL_CATALOG.map((entry) => entry.modelId), [
    'qwen/qwen3.8-max-0902',
    'qwen/qwen3.8-flash',
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-pro-0813',
    'deepseek/deepseek-v4-flash-0731',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-luna',
    'z-ai/glm-5.3',
    'z-ai/glm-5.3-flash',
    'google/gemini-3.8-flash',
    'meta/muse-spark-1.3',
    'x-ai/grok-4.6',
  ]);
  assertEquals(ROOT_DEFAULT_MODEL_SELECTION, {
    provider: 'openrouter',
    api: 'openrouter-chat-completions',
    authProfile: 'openrouter-api-key',
    modelId: 'deepseek/deepseek-v4.1-flash',
    effort: 'high',
  });
  assertEquals(PLANNER_DEFAULT_MODEL_SELECTION, ROOT_DEFAULT_MODEL_SELECTION);
  assertEquals(
    searchOpenRouterModels('FLASH').map((entry) => entry.modelId),
    [
      'qwen/qwen3.8-flash',
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4-flash-0731',
      'z-ai/glm-5.3-flash',
      'google/gemini-3.8-flash',
    ],
  );
  assertEquals(selectOpenRouterModel('openai/gpt-5.6-sol').effort, 'medium');
});

Deno.test('Increment 12 provider wire sends effort and replays reasoning details for a tool continuation', async () => {
  const bodies: Record<string, unknown>[] = [];
  let request = 0;
  const fetcher: typeof fetch = (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    request += 1;
    const payload = request === 1
      ? {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            reasoning_details: [{ type: 'reasoning.text', text: 'internal continuity' }],
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'probe', arguments: '{"value":1}' },
            }],
          },
        }],
      }
      : { choices: [{ message: { role: 'assistant', content: 'done' } }] };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const selection = selectOpenRouterModel('openai/gpt-5.6-sol', 'high');
  const model = new OpenRouterAgentModel({
    credential: 'dummy-test-credential',
    fetcher,
    profile: openRouterProfileFor(selection),
  });
  const firstRequest: ModelRequest = {
    transcript: [{ role: 'user', content: { kind: 'text', text: 'use the probe' } }],
    tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }],
  };
  const first = await model.generate(firstRequest);
  assert(first.kind === 'tool_calls');
  assert(first.providerState !== undefined);
  const transcript: Message[] = [
    ...firstRequest.transcript,
    {
      role: 'assistant',
      content: first.calls.map((call) => ({ kind: 'tool_call' as const, ...call })),
      providerState: first.providerState,
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'call-1',
        name: 'probe',
        text: 'ok',
        outcome: 'success',
      }],
    },
  ];
  const second = await model.generate({ ...firstRequest, transcript });
  assert(second.kind === 'final');
  assertEquals(bodies[0]?.model, selection.modelId);
  assertEquals(bodies[0]?.reasoning, { effort: 'high' });
  const messages = bodies[1]?.messages as Record<string, unknown>[];
  assertEquals(messages[1]?.reasoning_details, [
    { type: 'reasoning.text', text: 'internal continuity' },
  ]);

  const autoBodies: Record<string, unknown>[] = [];
  const autoModel = new OpenRouterAgentModel({
    credential: 'dummy-test-credential',
    profile: openRouterProfileFor(selectOpenRouterModel('qwen/qwen3.8-flash')),
    fetcher: (_input, init) => {
      autoBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'done' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  await autoModel.generate({
    transcript: [{ role: 'user', content: { kind: 'text', text: 'hello' } }],
    tools: [],
  });
  assert(!Object.hasOwn(autoBodies[0]!, 'reasoning'));
});

Deno.test('Increment 12 switches and restores the root model while planner stays fixed', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-model-switch-' });
  const workspaceRoot = Deno.cwd();
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let first: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let planner: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    first = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    assertEquals(first.session.modelSelectionSnapshot(), ROOT_DEFAULT_MODEL_SELECTION);
    const qwen = selectOpenRouterModel('qwen/qwen3.8-max-0902');
    assertEquals(await first.session.selectModel(qwen), 'selected');
    const sessionId = first.session.currentPosition().sessionId;
    assert(typeof sessionId === 'string');
    const selectedBeforeTurn = await store.readWorker(sessionId);
    assert(selectedBeforeTurn.schemaVersion === 6);
    assertEquals(selectedBeforeTurn.activeModel, qwen);
    assertEquals(selectedBeforeTurn.nextTurn, 1);
    assertEquals(selectedBeforeTurn.turnModels, []);
    const listedBeforeTurn = await store.listWorker();
    assertEquals(
      listedBeforeTurn.sessions.find((item) => item.id === sessionId)?.modelSelection,
      qwen,
    );
    assert((await first.session.submit('first model-attributed turn')).ok);

    const gpt = selectOpenRouterModel('openai/gpt-5.6-sol', 'none');
    assertEquals(await first.session.selectModel(gpt), 'selected');
    assert((await first.session.submit('delegate this small task')).ok);
    const record = await store.readWorker(sessionId);
    assert(record.schemaVersion === 6);
    assertEquals(record.activeModel, gpt);
    assertEquals(record.turnModels, [
      { turn: 1, selection: qwen },
      { turn: 2, selection: gpt },
    ]);
    const listed = await store.listWorker();
    assertEquals(listed.sessions.find((item) => item.id === sessionId)?.modelSelection, gpt);
    const execution = (await store.executionArtifacts.list()).at(-1);
    assert(execution !== undefined);
    assertEquals(execution.manifest.rootModel, gpt);
    assertEquals(execution.manifest.plannerModel, PLANNER_DEFAULT_MODEL_SELECTION);

    await first.close();
    first = undefined;
    resumed = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    assertEquals(resumed.session.modelSelectionSnapshot(), gpt);
    assertEquals(resumed.displayState.model.modelId, gpt.modelId);
    assertEquals(resumed.displayState.model.effort, gpt.effort);
    await resumed.close();
    resumed = undefined;

    planner = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'none',
      agent: 'planner',
      physicalIoMode: 'provider-free',
    });
    assertEquals(await planner.session.selectModel(gpt), 'selected');
    const plannerOutcome = await planner.session.submit('standalone planner turn');
    assertEquals(plannerOutcome.finalText, 'worker planner result');
  } finally {
    await planner?.close();
    await resumed?.close();
    await first?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
