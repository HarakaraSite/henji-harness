import {
  defaultModelSelectionFor,
  modelCatalogEntryFor,
  searchModelsFor,
  selectModelFor,
} from '../../v0/agent/provider/model_catalog.ts';
import type { Message, Model, ModelRequest, ModelResult } from '../../v0/agent/core/contracts.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import {
  openRouterProfileFor,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_model.ts';
import type { OpenAIModelSelection } from '../../v0/agent/provider/model_selection.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { privateStateFromTurn } from '../../v0/agent/worker/worker_host_coordinator.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { createUiState, setUiProjection } from '../../v0/tui/state.ts';

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

const openAiDefaultSelection = defaultModelSelectionFor('openai-responses');

Deno.test('Increment 119 model switch back starts a new private-state segment', () => {
  const modelA = ROOT_DEFAULT_MODEL_SELECTION;
  const modelB = { ...modelA, modelId: 'another-model' };
  assertEquals(
    privateStateFromTurn([
      { effectiveFromTurn: 1, changedAt: '2026-09-24T00:00:00Z', selection: modelA },
      { effectiveFromTurn: 2, changedAt: '2026-09-24T00:01:00Z', selection: modelB },
      { effectiveFromTurn: 3, changedAt: '2026-09-24T00:02:00Z', selection: modelA },
    ]),
    3,
  );
});

const openAICompletedStream = (text: string): string => {
  const response = {
    id: 'resp_increment_15_cross_provider',
    object: 'response',
    created_at: 1_788_800_100,
    status: 'completed',
    model: 'gpt-5.6-sol',
    output: [{
      id: 'msg_increment_15_cross_provider',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
  };
  return `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
};

Deno.test('Increment 15 exposes the approved provider-scoped curated catalogs', () => {
  assertEquals(
    searchModelsFor('openai-responses', '').map((entry) => [entry.modelId, entry.defaultEffort]),
    [
      ['gpt-5.6-sol', 'medium'],
      ['gpt-5.6-luna', 'medium'],
      ['gpt-5.6-terra', 'medium'],
      ['gpt-6-astra', 'low'],
    ],
  );
  assertEquals(
    searchModelsFor('openai-responses', '5.6').map((entry) => entry.modelId),
    ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  );
  assertEquals(searchModelsFor('openrouter-chat', 'glm').map((entry) => entry.modelId), [
    'z-ai/glm-5.3',
    'z-ai/glm-5.3-flash',
  ]);
  assertEquals(selectModelFor('openai-responses', 'gpt-5.6-terra', 'max').effort, 'max');
  assertEquals(modelCatalogEntryFor('openai-responses', 'gpt-6-astra')?.efforts, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assertEquals(defaultModelSelectionFor('openai-responses'), openAiDefaultSelection);
});

Deno.test('Increment 15 keeps provider explicit in the fixed identity footer', () => {
  const state = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 3,
    workspace: '/home/masat.guest/src/forgejo-agent',
    model: openAiDefaultSelection,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canCompact: true },
    generation: 0,
  });
  const wide = layoutUi(state, 160, 24).footer;
  assertEquals(wide.length, 3);
  assertEquals(
    wide[1].text,
    ' /home/masat.guest/src/forgejo-agent'.padEnd(140) + 'untitled · abcdef12',
  );
  assertEquals(
    wide[2].text,
    ' openai-responses / gpt-5.6-sol'.padEnd(153) + 'medium',
  );
  const narrow = layoutUi(state, 80, 24).footer[2].text;
  assert(narrow.includes('openai-responses / '));
  assert(narrow.includes(' / gpt-5.6-sol '));
  assert(narrow.endsWith('   medium'));
  const degradedSession = layoutUi(state, 40, 10).footer[1].text;
  assert(degradedSession.includes('abcdef12'));
  const degradedModel = layoutUi(state, 40, 10).footer[2].text;
  assert(degradedModel.includes('openai-responses'));
  assert(degradedModel.includes('-sol'));
  assert(degradedModel.endsWith('   medium'));
});

Deno.test('Increment 15 rebuilds foreign provider history from semantic messages', async () => {
  const openRouterBodies: Record<string, unknown>[] = [];
  const openRouter = new OpenRouterAgentModel({
    credential: 'router-test-credential',
    profile: openRouterProfileFor(ROOT_DEFAULT_MODEL_SELECTION),
    responseMode: 'json',
    fetcher: (_input, init) => {
      openRouterBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const ordinal = openRouterBodies.length;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: ordinal === 1 ? 'router answer' : 'router again',
                reasoning_details: [{ type: 'reasoning.text', text: 'router-private-replay' }],
              },
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  let openAIBody: Record<string, unknown> | undefined;
  const openAI = new OpenAIResponsesModel({
    selection: openAiDefaultSelection as OpenAIModelSelection,
    credentialSource: () => Promise.resolve('openai-test-credential'),
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      openAIBody = JSON.parse(await request.clone().text()) as Record<string, unknown>;
      return new Response(openAICompletedStream('openai answer'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const transcript: Message[] = [{
    role: 'user',
    content: { kind: 'text', text: 'first' },
  }, {
    role: 'assistant',
    content: [{
      kind: 'tool_call',
      callId: 'read-cross-provider',
      name: 'read',
      arguments: { path: 'README.md' },
    }],
    text: 'I will inspect the current source.',
  }, {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'read-cross-provider',
      name: 'read',
      text: 'contents',
      outcome: 'success',
    }],
  }];
  const baseRequest = (messages: readonly Message[]): ModelRequest => ({
    transcript: messages,
    tools: [],
  });
  const routerResult = await openRouter.generate(baseRequest(transcript));
  assert(routerResult.kind === 'final');
  transcript.push({
    role: 'assistant',
    content: { kind: 'text', text: routerResult.text },
    providerState: routerResult.providerState,
  });
  transcript.push({ role: 'user', content: { kind: 'text', text: 'second' } });

  const openAIResult = await openAI.generate(baseRequest(transcript));
  assert(openAIResult.kind === 'final');
  assert(JSON.stringify(openAIBody).includes('router answer'));
  assert(JSON.stringify(openAIBody).includes('I will inspect the current source.'));
  assert(JSON.stringify(openAIBody).includes('read-cross-provider'));
  assert(!JSON.stringify(openAIBody).includes('router-private-replay'));
  transcript.push({
    role: 'assistant',
    content: { kind: 'text', text: openAIResult.text },
    providerState: openAIResult.providerState,
  });
  transcript.push({ role: 'user', content: { kind: 'text', text: 'third' } });

  const routerAgain = await openRouter.generate(baseRequest(transcript));
  assert(routerAgain.kind === 'final');
  assertEquals(routerAgain.text, 'router again');
  const thirdWire = JSON.stringify(openRouterBodies[1]);
  assert(thirdWire.includes('openai answer'));
  assert(!thirdWire.includes('resp_increment_15_cross_provider'));
});

Deno.test('Increment 116 Worker projects private state from the latest provider segment', async () => {
  const oldRouterState = {
    provider: 'openrouter-chat',
    reasoningDetails: [{ text: 'old router private' }],
  };
  const openAIState = { provider: 'openai-responses', replayItems: [{ id: 'foreign private' }] };
  const currentRouterState = {
    provider: 'openrouter-chat',
    reasoningDetails: [{ text: 'current router private' }],
  };
  const initialTranscript: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'turn one' } },
    {
      role: 'assistant',
      content: { kind: 'text', text: 'router one' },
      providerState: oldRouterState,
    },
    { role: 'user', content: { kind: 'text', text: 'turn two' } },
    {
      role: 'assistant',
      content: { kind: 'text', text: 'openai two' },
      providerState: openAIState,
    },
    { role: 'user', content: { kind: 'text', text: 'turn three' } },
    {
      role: 'assistant',
      content: { kind: 'text', text: 'router three' },
      providerState: currentRouterState,
    },
  ];
  let seenRequest: ModelRequest | undefined;
  const model: Model = {
    generate(request): ModelResult {
      seenRequest = structuredClone(request);
      return { kind: 'final', text: 'router four' };
    },
  };
  const composition = {
    role: 'parent',
    model,
    registry: new Registry([]),
    maxSteps: 1,
    manifest: { role: 'parent', maxSteps: 1, profileId: 'provider-free', resources: [] },
  } as unknown as WorkerAgentComposition;
  let committed: readonly Message[] | undefined;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, proposal) => {
      committed = structuredClone(proposal.transcript);
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      throw new Error(`unexpected turn failure: ${outcome.error ?? outcome.stopReason}`);
    },
  };
  const generation = new WorkerGeneration(
    composition,
    '70000000-0000-4000-8000-000000000116',
    port,
    initialTranscript,
    4,
  );
  assert(generation.selectRootModel(ROOT_DEFAULT_MODEL_SELECTION, 3));
  await generation.runTurn({
    session: '70000000-0000-4000-8000-000000000116',
    instanceCorrelation: 'increment-116-instance',
    workerGeneration: 'increment-116-generation',
    baseStateRevision: 1,
    command: 'turn-4',
  }, 'turn four');
  assert(seenRequest !== undefined);
  assertEquals(
    seenRequest.transcript.slice(0, 6).map((message) =>
      message.role === 'assistant' ? message.providerState : undefined
    ),
    [undefined, undefined, undefined, undefined, undefined, currentRouterState],
  );
  assert(JSON.stringify(seenRequest).includes('router one'));
  assert(JSON.stringify(seenRequest).includes('openai two'));
  assert(!JSON.stringify(seenRequest).includes('old router private'));
  assert(!JSON.stringify(seenRequest).includes('foreign private'));
  assert(initialTranscript[1].role === 'assistant');
  assertEquals(initialTranscript[1].providerState, oldRouterState);
  assertEquals(committed?.length, 2);
  assertEquals(committed?.[1], {
    role: 'assistant',
    content: { kind: 'text', text: 'router four' },
  });
});

Deno.test('Increment 15 persists OpenRouter to OpenAI to OpenRouter in one Session', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-15-' });
  const workspaceRoot = Deno.cwd();
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let first: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    first = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'new',
      physicalIoMode: 'provider-free',
    });
    assert((await first.session.submit('turn on OpenRouter')).ok);
    await store.initialize();
    assertEquals(await first.session.selectModel(openAiDefaultSelection), 'selected');
    assertEquals(first.session.credentialAvailabilitySnapshot(), {
      authProfile: 'openai-api-key',
      status: 'unknown',
    });
    assert((await first.session.submit('turn on OpenAI')).ok);
    assertEquals(await first.session.selectModel(ROOT_DEFAULT_MODEL_SELECTION), 'selected');
    assertEquals(first.session.credentialAvailabilitySnapshot(), {
      authProfile: 'openrouter-api-key',
      status: 'unknown',
    });
    assert((await first.session.submit('back on OpenRouter')).ok);

    const sessionId = first.session.sessionId;
    const record = await store.readWorker(sessionId);
    assert(record.schemaVersion === 1);
    assertEquals(record.activeModel, ROOT_DEFAULT_MODEL_SELECTION);
    assertEquals(record.modelChanges.map((change) => change.selection), [
      ROOT_DEFAULT_MODEL_SELECTION,
      openAiDefaultSelection,
      ROOT_DEFAULT_MODEL_SELECTION,
    ]);
    assertEquals(record.turnModels, [
      { turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION },
      { turn: 2, selection: openAiDefaultSelection },
      { turn: 3, selection: ROOT_DEFAULT_MODEL_SELECTION },
    ]);
    assertEquals(
      record.transcript.filter((message) => message.role === 'user').map((
        message,
      ) => message.role === 'user' ? message.content.text : ''),
      ['turn on OpenRouter', 'turn on OpenAI', 'back on OpenRouter'],
    );

    const savedArtifacts = store.listExecutionsForSession(sessionId);
    assertEquals(savedArtifacts.map((artifact) => artifact.model), [
      ROOT_DEFAULT_MODEL_SELECTION,
      openAiDefaultSelection,
      ROOT_DEFAULT_MODEL_SELECTION,
    ]);

    await first.close();
    first = undefined;
    resumed = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      physicalIoMode: 'provider-free',
      initialModelSelection: openAiDefaultSelection,
    });
    assertEquals(resumed.session.modelSelectionSnapshot(), ROOT_DEFAULT_MODEL_SELECTION);
    assertEquals(resumed.session.currentPosition().committedTurn, 3);
  } finally {
    await resumed?.close();
    await first?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
