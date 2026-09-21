import {
  defaultModelSelectionFor,
  modelCatalogEntryFor,
  type ModelSelection,
  type ReasoningEffort,
  searchModelsFor,
  selectModelFor,
} from '../../v0/agent/provider/model_catalog.ts';
import type { Message, ModelRequest } from '../../v0/agent/core/contracts.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import {
  OPENAI_DEFAULT_MODEL_SELECTION,
  OPENAI_MODEL_CATALOG,
} from '../../v0/agent/provider/openai_model_catalog.ts';
import {
  openRouterProfileFor,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../../v0/agent/provider/model_catalog.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_model.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import type {
  PresentationIntent,
  PresentationIntentResult,
} from '../../v0/presentation/contract.ts';
import { TuiPresentationAdapter } from '../../v0/presentation/tui_presentation_adapter.ts';
import { ControllerOverlay } from '../../v0/tui/controller_overlay.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import type { TuiRenderer } from '../../v0/tui/render.ts';
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

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
};

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
  assertEquals(OPENAI_MODEL_CATALOG.map((entry) => [entry.modelId, entry.defaultEffort]), [
    ['gpt-5.6-sol', 'medium'],
    ['gpt-5.6-luna', 'medium'],
    ['gpt-5.6-terra', 'medium'],
    ['gpt-6-astra', 'low'],
  ]);
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
  assertEquals(defaultModelSelectionFor('openai-responses'), OPENAI_DEFAULT_MODEL_SELECTION);
});

Deno.test('Increment 15 presentation applies provider defaults atomically and scopes model changes', async () => {
  let selection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION;
  const events: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.reject(new Error('not used')),
      modelSelectionSnapshot: () => selection,
      selectModel: (next) => {
        selection = next;
        return Promise.resolve('selected');
      },
    },
    (event) => events.push(event),
  );
  const providerResult = await adapter.dispatch({
    kind: 'select_provider',
    provider: 'openai-responses',
  });
  assertEquals(selection, OPENAI_DEFAULT_MODEL_SELECTION);
  assertEquals(providerResult, {
    kind: 'model_selection',
    status: 'selected',
    selection: { provider: 'openai-responses', modelId: 'gpt-5.6-sol', effort: 'medium' },
  });

  const modelResult = await adapter.dispatch({
    kind: 'select_model',
    provider: 'openai-responses',
    modelId: 'gpt-6-astra',
    effort: 'low',
  });
  assertEquals(modelResult, {
    kind: 'model_selection',
    status: 'selected',
    selection: { provider: 'openai-responses', modelId: 'gpt-6-astra', effort: 'low' },
  });
  assertEquals(
    await adapter.dispatch({
      kind: 'select_model',
      provider: 'openrouter-chat',
      modelId: ROOT_DEFAULT_MODEL_SELECTION.modelId,
      effort: ROOT_DEFAULT_MODEL_SELECTION.effort,
    }),
    { kind: 'rejected', reason: 'invalid' },
  );
  assertEquals(events.length, 2);
});

Deno.test('Increment 15 provider picker drives provider-scoped model and effort pickers', async () => {
  const rendered: string[][] = [];
  const statuses: string[] = [];
  let selection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION;
  const dispatch = (intent: PresentationIntent): PresentationIntentResult => {
    if (intent.kind === 'select_provider') {
      selection = defaultModelSelectionFor(intent.provider);
    } else if (intent.kind === 'select_model') {
      selection = selectModelFor(
        intent.provider,
        intent.modelId,
        intent.effort as ReasoningEffort,
      );
    } else return { kind: 'accepted' };
    return {
      kind: 'model_selection',
      status: 'selected',
      selection: {
        provider: selection.provider,
        modelId: selection.modelId,
        effort: selection.effort,
      },
    };
  };
  const renderer = {
    renderChoicePicker: (lines: readonly string[]) => rendered.push([...lines]),
    clearModal: () => {},
    setStatus: (status: string) => statuses.push(status),
  } as unknown as TuiRenderer;
  const overlay = new ControllerOverlay({
    renderer,
    dispatch,
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => selection,
    fail: (error) => Promise.reject(error),
  });

  overlay.openProviderPicker();
  assert(rendered.at(-1)?.some((line) => line === '> openrouter-chat'));
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.provider === 'openrouter-responses');
  assertEquals(selection, defaultModelSelectionFor('openrouter-responses'));
  await overlay.settle();

  overlay.openProviderPicker();
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.provider === 'openai-responses');
  assertEquals(selection, OPENAI_DEFAULT_MODEL_SELECTION);
  await overlay.settle();

  overlay.openModelPicker();
  overlay.process({ kind: 'paste', text: 'terra' });
  assert(rendered.at(-1)?.some((line) => line.includes('gpt-5.6-terra')));
  assert(!rendered.at(-1)?.some((line) => line.includes('deepseek/')));
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.modelId === 'gpt-5.6-terra');
  assertEquals(selection.effort, 'medium');
  await overlay.settle();

  overlay.openEffortPicker();
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.effort === 'max');
  assert(statuses.some((status) => status.includes('provider openai-responses')));
  await overlay.settle();
});

Deno.test('Increment 15 keeps provider explicit in the fixed identity footer', () => {
  const state = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 3,
    workspace: '/home/masat.guest/src/forgejo-agent',
    model: OPENAI_DEFAULT_MODEL_SELECTION,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canHistory: true, canCompact: true },
    generation: 0,
  });
  const wide = layoutUi(state, 160, 24).footer;
  assertEquals(wide.length, 3);
  assertEquals(
    wide[1].text,
    '[/home/masat.guest/src/forgejo-agent session:abcdef12 untitled]',
  );
  assertEquals(
    wide[2].text,
    '[provider:openai-responses model:gpt-5.6-sol medium]',
  );
  const narrow = layoutUi(state, 80, 24).footer[2].text;
  assert(narrow.includes('provider:openai-responses'));
  assert(narrow.includes('model:gpt-5.6-sol'));
  assert(narrow.endsWith(' medium]'));
  const degradedSession = layoutUi(state, 40, 10).footer[1].text;
  assert(degradedSession.includes('session:abcdef12'));
  const degradedModel = layoutUi(state, 40, 10).footer[2].text;
  assert(degradedModel.includes('openai-responses'));
  assert(degradedModel.includes('-sol'));
  assert(degradedModel.endsWith(' medium]'));
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
    selection: OPENAI_DEFAULT_MODEL_SELECTION,
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

Deno.test('Increment 15 persists OpenRouter to OpenAI to OpenRouter in one Session', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-15-' });
  const workspaceRoot = Deno.cwd();
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let first: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    first = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    assert((await first.session.submit('turn on OpenRouter')).ok);
    assertEquals(await first.session.selectModel(OPENAI_DEFAULT_MODEL_SELECTION), 'selected');
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
    assert(record.schemaVersion === 6);
    assertEquals(record.activeModel, ROOT_DEFAULT_MODEL_SELECTION);
    assertEquals(record.modelChanges.map((change) => change.selection), [
      ROOT_DEFAULT_MODEL_SELECTION,
      OPENAI_DEFAULT_MODEL_SELECTION,
      ROOT_DEFAULT_MODEL_SELECTION,
    ]);
    assertEquals(record.turnModels, [
      { turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION },
      { turn: 2, selection: OPENAI_DEFAULT_MODEL_SELECTION },
      { turn: 3, selection: ROOT_DEFAULT_MODEL_SELECTION },
    ]);
    assertEquals(
      first.session.transcriptSnapshot().filter((message) => message.role === 'user').map((
        message,
      ) => message.role === 'user' ? message.content.text : ''),
      ['turn on OpenRouter', 'turn on OpenAI', 'back on OpenRouter'],
    );

    const savedArtifacts = store.listExecutionsForSession(sessionId);
    assert(savedArtifacts.every((artifact) => artifact.manifest !== undefined));
    assertEquals(savedArtifacts.map((artifact) => artifact.manifest!.rootModel), [
      ROOT_DEFAULT_MODEL_SELECTION,
      OPENAI_DEFAULT_MODEL_SELECTION,
      ROOT_DEFAULT_MODEL_SELECTION,
    ]);
    assert(
      savedArtifacts.every((artifact) =>
        JSON.stringify(artifact.manifest!.plannerModel) ===
          JSON.stringify(roleDefaultModelSelection('subagent:planner'))
      ),
    );
    assert(
      savedArtifacts[1]?.manifest?.resources.some((resource) =>
        resource.startsWith('model:openai-responses:')
      ),
    );

    await first.close();
    first = undefined;
    resumed = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
      initialModelSelection: OPENAI_DEFAULT_MODEL_SELECTION,
    });
    assertEquals(resumed.session.modelSelectionSnapshot(), ROOT_DEFAULT_MODEL_SELECTION);
    assertEquals(resumed.session.currentPosition().committedTurn, 3);
  } finally {
    await resumed?.close();
    await first?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
