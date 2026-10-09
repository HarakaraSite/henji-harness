import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Message, Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import type { ContextModelRequestDelta } from '../../v0/agent/history/context_attribution.ts';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import type {
  HistoryAppendResult,
  StoredExecutionEvent,
} from '../../v0/agent/history/history_store_contract.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_transport.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider/provider_profile.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type {
  WorkerCommitProposalMessage,
  WorkerCorrelation,
} from '../../v0/agent/worker/worker_protocol.ts';
import { validateFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import type { JsonValue } from '../../v0/agent/core/contracts.ts';
import {
  applyHistoryAppendResults,
  replaySessionConversation,
} from '../../v0/conversation/history_adapter.ts';
import {
  applyObservation,
  createConversationNormalizer,
} from '../../v0/conversation/normalizer.ts';
import {
  type ConversationEntity,
  type ConversationExecutionMetadata,
  createConversationState,
} from '../../v0/conversation/model.ts';
import { presentationFailureReason } from '../../v0/tui/state.ts';
import { KeyedConversationStore } from '../../v0/tui/keyed_conversation_store.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { conversationPosition, tuiClientState, tuiSnapshot } from './tui_entity_fixture.ts';
import type { UiLogEntry } from '../../v0/tui/state.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import { main as runtimeMain } from '../../v0/agent/cli/runtime_cli.ts';

const correlation: WorkerCorrelation = {
  session: '11111111-1111-4111-8111-111111111221',
  instanceCorrelation: 'diagnostics',
  workerGeneration: 'diagnostics-generation',
  baseStateRevision: 1,
  command: 'current',
};

const state = (text: string) => ({
  provider: 'openrouter-chat',
  model: PRODUCTION_PROFILE.model,
  reasoning: { field: 'reasoning' as const, text },
});

const createComposition = (
  model: Model,
  maxSteps = 1,
): WorkerAgentComposition => ({
  role: 'parent',
  maxSteps,
  systemInstruction: 'Diagnostics test instruction.',
  model,
  registry: new Registry([{
    name: 'read',
    description: 'Read a fixture result.',
    fileAccess: 'none',
    inputSchema: { type: 'object', properties: { bytes: { type: 'number' } } },
    execute: (input) => 'x'.repeat((input as { readonly bytes: number }).bytes),
  }]),
  manifest: {
    role: 'parent',
    maxSteps,
    profileId: 'increment-221-diagnostics',
    resources: [],
  },
} as unknown as WorkerAgentComposition);

const createHarness = (
  composition: WorkerAgentComposition,
  options: {
    readonly historyTokens: number;
    readonly inputCapacityTokens?: number;
    readonly initialNextTurn?: number;
    readonly savedTurn?: () =>
      | import('../../v0/agent/data/agent_data_contract.ts').ContextTurnRead
      | null;
  },
) => {
  const events: AgentEvent[] = [];
  const proposals: WorkerCommitProposalMessage[] = [];
  const failures: LoopOutcome[] = [];
  const deltas: ContextModelRequestDelta[] = [];
  let sequence = 0;
  const port: WorkerGenerationPort = {
    readContextTurn: (_correlation, beforeTurn) => {
      const saved = options.savedTurn?.();
      return Promise.resolve(
        saved !== undefined && saved !== null && saved.turn < beforeTurn ? saved : null,
      );
    },
    runtimeEvent: (_correlation, event) => {
      events.push(structuredClone(event));
      return ++sequence;
    },
    effectObservation: () => ++sequence,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, proposal) => {
      proposals.push(proposal);
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      failures.push(outcome);
    },
    contextObservation: (_correlation, delta) => {
      deltas.push(delta);
    },
  };
  const generation = new WorkerGeneration(
    composition,
    correlation.session,
    port,
    [],
    options.initialNextTurn ?? 1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    {
      defaults: {
        historyTokens: options.historyTokens,
        ...(options.inputCapacityTokens === undefined
          ? {}
          : { inputTokens: options.inputCapacityTokens }),
      },
    },
  );
  return { generation, events, proposals, failures, deltas };
};

const budgetObject = (event: Extract<AgentEvent, { kind: 'context_notice' }>) =>
  event.budget as Readonly<Record<string, JsonValue>> | undefined;

Deno.test('Increment 221 emits one current-trim notice while retaining the full execution', async () => {
  const wire = new OpenRouterAgentModel();
  const requests: ModelRequest[] = [];
  const model: Model = {
    measureRequestWire: (request) => wire.measureRequestWire!(request),
    requestOutputReserve: wire.requestOutputReserve,
    generate(request) {
      requests.push(structuredClone(request));
      if (requests.length <= 4) {
        return {
          kind: 'tool_calls',
          calls: [{
            callId: 'read-' + requests.length,
            name: 'read',
            arguments: { bytes: 500 },
          }],
          providerState: state('reasoning-' + requests.length),
        };
      }
      return {
        kind: 'final',
        text: 'Finished.',
        providerState: state('final'),
      };
    },
  };
  const harness = createHarness(createComposition(model, 5), {
    historyTokens: 350,
  });
  await harness.generation.runTurn(correlation, 'Keep this task.');

  strictEqual(harness.failures.length, 0);
  strictEqual(requests.length, 5);
  const notices = harness.events.filter((event) => event.kind === 'context_notice');
  const trimmed = notices.filter((event) => event.notice === 'trimmed');
  strictEqual(trimmed.length, 1);
  ok(trimmed[0].text.includes('Older current-turn exchanges'));
  ok(trimmed[0].text.includes('full execution remains saved'));
  const trimBudget = budgetObject(trimmed[0])!;
  const current = trimBudget.currentProjection as {
    readonly status: string;
    readonly omittedUnits: number;
  };
  strictEqual(current.status, 'trimmed');
  ok(current.omittedUnits > 0);
  ok(
    notices.some((event) =>
      event.kind === 'context_notice' && event.notice === 'history_omitted' &&
      event.text.includes('any earlier turns remain saved')
    ),
  );
  ok(
    !requests[4].transcript.some((message) =>
      message.role === 'assistant' && Array.isArray(message.content) &&
      message.content.some((call) => call.callId === 'read-1')
    ),
  );
  const fullTranscript = harness.proposals[0].transcript;
  strictEqual(
    fullTranscript.filter((message) => message.role === 'tool').length,
    4,
  );
  ok(
    fullTranscript.some((message) =>
      message.role === 'tool' && message.content[0].text.length === 500
    ),
  );
});

Deno.test('Increment 221 reports partial prior-history selection with the full turn saved', async () => {
  const wire = new OpenRouterAgentModel();
  const model: Model = {
    measureRequestWire: (request) => wire.measureRequestWire!(request),
    requestOutputReserve: wire.requestOutputReserve,
    generate: () => ({ kind: 'final', text: 'Continued.' }),
  };
  const savedMessages: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'Previous task.' } },
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'old',
        name: 'read',
        arguments: { bytes: 1 },
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'old',
        name: 'read',
        text: 'x'.repeat(700),
        outcome: 'success',
      }],
    },
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'newer',
        name: 'read',
        arguments: { bytes: 1 },
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'newer',
        name: 'read',
        text: 'y'.repeat(700),
        outcome: 'success',
      }],
    },
    {
      role: 'assistant',
      content: { kind: 'text', text: 'Previous final answer.' },
    },
  ];
  const harness = createHarness(createComposition(model), {
    historyTokens: 400,
    initialNextTurn: 2,
    savedTurn: () => ({
      turn: 1,
      executionId: 'previous-execution',
      messages: savedMessages,
      messageStart: 0,
      source: 'canonical',
      byteLength: 0,
    }),
  });
  await harness.generation.runTurn(correlation, 'Continue from that result.');

  strictEqual(harness.failures.length, 0);
  const notice = harness.events.find((event) =>
    event.kind === 'context_notice' && event.notice === 'history_partial'
  );
  ok(notice?.kind === 'context_notice');
  ok(notice.text.includes('older messages from the previous turn'));
  ok(notice.text.includes('full turn remains saved'));
  const facts = budgetObject(notice)!;
  const history = facts.recentHistoryProjection as {
    readonly status: string;
    readonly omittedUnits: number;
  };
  strictEqual(history.status, 'partial');
  ok(history.omittedUnits > 0);
});

Deno.test('Increment 221 protected overflow reports typed numeric diagnostic without a model request', async () => {
  const wire = new OpenRouterAgentModel();
  let modelCalls = 0;
  const model: Model = {
    measureRequestWire: (request) => wire.measureRequestWire!(request),
    requestOutputReserve: wire.requestOutputReserve,
    generate() {
      modelCalls += 1;
      return { kind: 'final', text: 'unreachable' };
    },
  };
  const harness = createHarness(createComposition(model), {
    historyTokens: 0,
    inputCapacityTokens: 100_000,
  });
  await harness.generation.runTurn(correlation, 'Protected task cannot fit.');

  strictEqual(modelCalls, 0);
  strictEqual(harness.failures.length, 1);
  const diagnostic = harness.failures[0].diagnostic;
  ok(diagnostic !== undefined);
  strictEqual(diagnostic.code, 'context_budget_exceeded');
  strictEqual(diagnostic.stage, 'request_build');
  ok(validateFailureDiagnostic(diagnostic));
  const overflow = harness.events.find((event) =>
    event.kind === 'context_notice' && event.notice === 'exceeded'
  );
  ok(overflow?.kind === 'context_notice');
  const facts = budgetObject(overflow)!;
  const estimate = facts.inputTokens;
  const inputLimit = facts.inputLimit;
  const messagesBytes = facts.messagesBytes;
  const bodyBytes = facts.bodyBytes;
  ok(typeof estimate === 'number' && estimate > 0);
  strictEqual(inputLimit, 100_000);
  ok(typeof messagesBytes === 'number' && messagesBytes > 0);
  ok(typeof bodyBytes === 'number' && bodyBytes > 0);
  ok(typeof facts.messageLimitBytes === 'number');
  ok(typeof facts.bodyLimitBytes === 'number');
  ok(diagnostic.details?.message?.includes('Estimated input ' + estimate));
  ok(
    diagnostic.details?.message?.includes(
      'messages ' + messagesBytes + ' bytes',
    ),
  );
  ok(diagnostic.details?.message?.includes('body ' + bodyBytes + ' bytes'));
  ok(diagnostic.details?.message?.includes('Full execution remains saved.'));
  strictEqual(
    presentationFailureReason(diagnostic),
    'context budget exceeded',
  );
});

Deno.test('Increment 221 context notices replay into execution metadata and survive settlement', () => {
  const executionId = 'execution-context-notice';
  const metadata: ConversationExecutionMetadata = {
    executionId,
    taskId: 'task-context-notice',
    task: 'Continue from saved history.',
    sessionId: correlation.session,
    turn: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    lifecycle: 'active',
    outcome: 'unknown',
    adoption: 'non_canonical',
    baseRevision: 1,
    agent: 'default',
    model: null,
  };
  const state = createConversationState(correlation.session);
  const normalizer = createConversationNormalizer();
  applyObservation(state, normalizer, {
    kind: 'execution',
    execution: metadata,
    executionOrder: 0,
  });
  const notice: AgentEvent = {
    kind: 'context_notice',
    turn: 1,
    notice: 'trimmed',
    text:
      'Older current-turn exchanges were omitted from the model request; the full execution remains saved.',
    budget: { inputTokens: 231, messagesBytes: 420, bodyBytes: 500 },
  };
  const stored: StoredExecutionEvent = {
    executionId,
    ordinal: 1,
    observedAt: '2026-10-09T00:00:01.000Z',
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'runtime_event',
    workerSequence: 1,
    payload: {
      kind: 'runtime_event',
      event: { kind: 'agent_event', event: notice },
    },
  };
  const appended: HistoryAppendResult = {
    event: stored,
    semanticOccurrenceId: 'semantic-context-notice',
  };
  applyHistoryAppendResults(state, normalizer, [appended], 2);
  applyHistoryAppendResults(state, normalizer, [appended], 2);
  const entityId = 'execution/' + encodeURIComponent(executionId);
  let entity = state.entities.get(entityId);
  ok(entity?.kind === 'execution');
  strictEqual(entity.execution.contextNotices?.length, 1);
  strictEqual(entity.execution.contextNotices?.[0].notice, 'trimmed');
  strictEqual(entity.execution.contextNotices?.[0].text, notice.text);

  applyObservation(state, normalizer, {
    kind: 'execution_settled',
    executionId,
    eventOrdinal: 3,
    outcome: 'failed',
    diagnostic: { code: 'context_budget_exceeded', stage: 'request_build' },
    adoption: 'non_canonical',
  });
  entity = state.entities.get(entityId);
  ok(entity?.kind === 'execution');
  strictEqual(entity.execution.lifecycle, 'settled');
  strictEqual(entity.execution.contextNotices?.length, 1);
});

Deno.test('Increment 221 persists context notices as replayable context updates', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i221-context-notice-' });
  const workspaceRoot = root + '/workspace';
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(root + '/state', workspaceRoot);
  let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
  try {
    await store.initialize();
    handle = await store.allocateWorker('default', {});
    const sessionId = handle.id;
    const createdAt = '2026-10-09T00:00:00.000Z';
    const configuration = workerConfigurationFixture();
    handle.saveMetadata({
      sessionId,
      workspaceRoot,
      agentChoice: {},
      createdAt,
      updatedAt: createdAt,
      title: null,
      stateRevision: 1,
      nextTurn: 1,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChangesToAppend: [{
        effectiveFromTurn: 1,
        changedAt: createdAt,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
    });
    handle.close();
    handle = undefined;

    const executionId = '22100000-0000-4000-8000-000000000001';
    await store.beginExecution({
      taskId: '22100000-0000-4000-8000-000000000002',
      executionId,
      createdAt,
      sessionCorrelation: sessionId,
      canonicalSessionId: sessionId,
      command: 'increment-221-context-notice',
      turn: 1,
      task: 'Long request',
      baseStateRevision: 1,
      agent: 'default',
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      configurationId: configuration.configurationId,
      configuration,
      maxSteps: 4,
      sessionMode: 'persistent',
    });
    const notice: AgentEvent = {
      kind: 'context_notice',
      turn: 1,
      notice: 'trimmed',
      text:
        'Older current-turn exchanges were omitted from the model request; the full execution remains saved.',
      budget: { inputTokens: 500, inputLimit: 800, messagesBytes: 1200, bodyBytes: 1400 },
    };
    const correlation = {
      session: sessionId,
      instanceCorrelation: 'i221-context-notice',
      workerGeneration: 'i221-context-notice-generation',
      baseStateRevision: 1,
      command: 'increment-221-context-notice',
    };
    const input: ExecutionEventInput = {
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'runtime_event',
        correlation,
        sequence: 1,
        event: { kind: 'agent_event', event: notice },
      },
    };
    const appended = store.appendExecutionEventsWithSemanticIds([input]);
    strictEqual(appended.length, 1);
    ok(
      store.listSemanticOccurrences(executionId).some((occurrence) =>
        occurrence.kind === 'context_update'
      ),
    );

    const replay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    const execution = [...replay.state.entities.values()].find((entity) =>
      entity.kind === 'execution' && entity.executionId === executionId
    );
    ok(execution?.kind === 'execution');
    strictEqual(execution.execution.contextNotices?.length, 1);
    strictEqual(execution.execution.contextNotices?.[0].notice, 'trimmed');
  } finally {
    handle?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 221 remote TUI retains active and completed context notices once across replay', () => {
  const executionId = 'execution-tui-context';
  const execution: ConversationExecutionMetadata = {
    executionId,
    taskId: 'task-tui-context',
    task: 'Long request',
    sessionId: 'tui-entity-session',
    turn: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    lifecycle: 'active',
    outcome: 'unknown',
    contextNotices: [{
      notice: 'trimmed',
      text: 'Older current-turn exchanges were omitted; the full execution remains saved.',
    }],
    adoption: 'non_canonical',
    baseRevision: 1,
    agent: 'default',
    model: null,
  };
  const entity: ConversationEntity = {
    kind: 'execution',
    id: 'execution-row-' + executionId,
    executionId,
    version: 1,
    position: conversationPosition(0, -1, -2),
    execution,
  };
  const rows = (store: KeyedConversationStore): readonly UiLogEntry[] =>
    store.window(0, store.size);
  const project = (
    projector: SnapshotConversationProjector,
    notices: RemoteSystemNotices,
    value: ConversationEntity,
    revision: number,
  ) => {
    const snapshot = tuiSnapshot(
      { [value.id]: value },
      [value.id],
      {
        cursor: {
          coreEpoch: 'context-notice',
          sessionId: execution.sessionId,
          revision,
        },
      },
    );
    const result = projector.project(
      tuiClientState(snapshot),
      'core/' + execution.sessionId,
    );
    notices.sync(tuiClientState(snapshot), result.store, {
      reset: result.reset,
      structureChanged: result.structureChanged,
    });
    return result.store;
  };

  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  let store = project(projector, notices, entity, 1);
  strictEqual(
    rows(store).filter((row) => row.text.includes('Older current-turn exchanges')).length,
    1,
  );
  const completed: ConversationEntity = {
    ...entity,
    version: 2,
    execution: { ...execution, lifecycle: 'settled', outcome: 'completed' },
  };
  store = project(projector, notices, completed, 2);
  strictEqual(
    rows(store).filter((row) => row.text.includes('Older current-turn exchanges')).length,
    1,
  );

  const reopened = project(
    new SnapshotConversationProjector(),
    new RemoteSystemNotices(),
    completed,
    2,
  );
  strictEqual(
    rows(reopened).filter((row) => row.text.includes('Older current-turn exchanges')).length,
    1,
  );
});

const successOutcome = (task: string, finalText: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText,
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const recorder = () => {
  const state = { stdout: '', stderr: '' };
  return {
    state,
    deps: {
      stdinIsTerminal: () => true,
      resolveAgent: (rawAgentName: string | undefined) =>
        Promise.resolve({
          choice: rawAgentName === undefined ? {} : { name: rawAgentName },
        }),
      writeStdout: (text: string) => {
        state.stdout += text;
      },
      writeStderr: (text: string) => {
        state.stderr += text;
      },
    },
  };
};

Deno.test('Increment 221 CLI JSON carries context notices and stream mode prints them to stderr', async () => {
  const notice: AgentEvent = {
    kind: 'context_notice',
    turn: 1,
    notice: 'history_partial',
    text: 'Some older messages from the previous turn were omitted; the full turn remains saved.',
    budget: { inputTokens: 512, inputLimit: 800 },
  };
  const events: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    notice,
    {
      kind: 'assistant_message',
      turn: 1,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: 'Continued.' },
      },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
  ];
  const run = (_task: string, sink?: (event: AgentEvent) => void) => {
    for (const event of events) sink?.(event);
    return Promise.resolve({
      outcome: successOutcome('Continue.', 'Continued.'),
      requestCount: 1,
    });
  };
  const json = recorder();
  const jsonExit = await runtimeMain(['--task', 'Continue.', '--json'], {
    ...json.deps,
    run,
  });
  strictEqual(jsonExit, 0);
  const records = json.state.stdout.split('\n').filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const record = records.find((value) => value.kind === 'context_notice');
  ok(record !== undefined);
  strictEqual(record.notice, 'history_partial');
  strictEqual(record.text, notice.text);
  deepStrictEqual(record.budget, { inputTokens: 512, inputLimit: 800 });

  const stream = recorder();
  const streamExit = await runtimeMain(['--task', 'Continue.', '--stream'], {
    ...stream.deps,
    run,
  });
  strictEqual(streamExit, 0);
  ok(stream.state.stderr.includes('context> ' + notice.text));
  ok(stream.state.stdout.includes('Continued.'));
});

Deno.test('Increment 221 default CLI prints only context notices to stderr and preserves final stdout', async () => {
  const { state: output, deps } = recorder();
  let sinkPresent = false;
  const notice = 'Older current-turn exchanges were omitted; the full execution remains saved.';
  const exit = await runtimeMain(['--task', 'Continue.'], {
    ...deps,
    run: (_task, sink) => {
      sinkPresent = sink !== undefined;
      const events: AgentEvent[] = [
        { kind: 'turn_start', turn: 1 },
        { kind: 'assistant_progress', turn: 1, text: 'working' },
        {
          kind: 'context_notice',
          turn: 1,
          notice: 'trimmed',
          text: notice,
        },
        {
          kind: 'tool_call',
          turn: 1,
          call: { callId: 'read-1', name: 'read', arguments: {} },
        },
      ];
      for (const event of events) sink?.(event);
      return Promise.resolve({
        outcome: successOutcome('Continue.', 'Continued.'),
        requestCount: 1,
      });
    },
  });
  strictEqual(exit, 0);
  strictEqual(sinkPresent, true);
  strictEqual(output.stdout, 'Continued.\n');
  strictEqual(output.stderr, 'context> ' + notice + '\n');
});
