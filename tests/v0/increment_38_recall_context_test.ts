import type { Message, Model, ModelRequest, ModelResult } from '../../v0/agent/core/contracts.ts';
import {
  FakeProviderEvidenceStore,
  ProviderEvidenceRecorder,
  type ProviderEvidenceV2,
  type ProviderEvidenceV3,
} from '../../v0/agent/provider/provider_evidence.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import {
  createWorkerSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
} from '../../v0/agent/worker/worker_host.ts';
import type {
  WorkerExecutionArtifactV2,
  WorkerExecutionArtifactV3,
} from '../../v0/agent/worker/worker_execution_artifact.ts';
import {
  FakeWorkerExecutionArtifactStore,
} from '../../v0/agent/worker/worker_execution_artifact_store.ts';
import {
  type RecalledExecutionContextV1,
  recalledExecutionProjectionText,
  resolveRecalledExecutionContext,
} from '../../v0/agent/worker/recalled_execution_context.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import { createTuiPresentationAdapter } from '../../v0/presentation/adapter.ts';
import type { SessionNavigationHost } from '../../v0/agent/session/session_navigation.ts';

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

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVIDENCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const correlation = (command: string) => ({
  session: SESSION_ID,
  instanceCorrelation: 'recall-test-instance',
  workerGeneration: 'recall-test-generation',
  baseStateRevision: 1,
  command,
});

const sourceArtifact = async (
  schemaVersion: 2 | 3 = 3,
): Promise<WorkerExecutionArtifactV2 | WorkerExecutionArtifactV3> => {
  const definition = await readDefinitionRevision(
    workerBuiltinModulePath('default'),
    'builtin',
    'default',
  );
  const base: Omit<WorkerExecutionArtifactV2, 'schemaVersion'> = {
    executionId: SOURCE_ID,
    createdAt: '2026-09-12T00:00:00.000Z',
    settledAt: '2026-09-12T00:00:01.000Z',
    sessionId: SESSION_ID,
    turn: 1,
    agent: 'default',
    instanceCorrelation: 'recall-test-instance',
    workerGeneration: 'recall-test-generation',
    build: buildManifest(),
    definition,
    manifest: {
      role: 'parent',
      maxSteps: 8,
      profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
      resources: [],
      rootModel: ROOT_DEFAULT_MODEL_SELECTION,
    },
    command: { kind: 'turn', correlation: correlation('source-turn'), task: 'inspect source' },
    baseStateRevision: 1,
    protocolTrace: [{
      direction: 'host_to_worker',
      kind: 'turn',
      semanticSubtype: 'turn',
      sequence: 1,
      correlation: correlation('source-turn'),
    }],
    providerEvidenceId: EVIDENCE_ID,
    providerEvidenceDurability: 'yes',
    storeResult: 'not_attempted',
    acknowledgement: 'not_sent',
    settlement: 'uncommitted',
    outcome: {
      ok: false,
      outcome: 'cancelled',
      stopReason: 'cancelled',
      steps: 1,
      toolCallCount: 2,
      toolResultCount: 1,
    },
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  return schemaVersion === 2 ? { schemaVersion: 2, ...base } : { schemaVersion: 3, ...base };
};

const sourceArtifactFor = async (
  sessionId: string,
  executionId: string,
  settledAt: string,
): Promise<WorkerExecutionArtifactV3> => {
  const source = await sourceArtifact(3);
  const sourceCorrelation = {
    ...source.command.correlation,
    session: sessionId,
    command: `source-${executionId.slice(0, 8)}`,
  };
  const { providerEvidenceId: _evidenceId, providerEvidenceDurability: _durability, ...rest } =
    source;
  return {
    ...rest,
    schemaVersion: 3,
    executionId,
    settledAt,
    sessionId,
    command: {
      kind: 'turn',
      correlation: sourceCorrelation,
      task: `source task ${executionId.slice(0, 8)}`,
    },
    protocolTrace: source.protocolTrace.map((entry) => ({
      ...entry,
      correlation: sourceCorrelation,
    })),
  };
};

const sourceEvidence = async (
  schemaVersion: 2 | 3 = 3,
): Promise<ProviderEvidenceV2 | ProviderEvidenceV3> => {
  const artifact = await sourceArtifact(schemaVersion);
  const calls = [{ callId: 'done-1', name: 'read', arguments: { path: 'done.txt' } }, {
    callId: 'slow-1',
    name: 'search',
    arguments: { query: 'unfinished' },
  }] as const;
  const lane = schemaVersion === 2 ? {} : { lane: 'parent' as const };
  const base: Omit<ProviderEvidenceV2, 'schemaVersion'> = {
    evidenceId: EVIDENCE_ID,
    sessionId: SESSION_ID,
    turnNumber: 1,
    createdAt: '2026-09-12T00:00:00.000Z',
    build: artifact.build,
    definition: artifact.definition,
    requests: [],
    runtimeEvents: [
      {
        kind: 'model_result',
        modelStep: 1,
        ...lane,
        result: {
          kind: 'tool_calls',
          calls,
          text: 'I started the requested inspection.',
        },
      },
      { kind: 'tool_call', modelStep: 1, ...lane, call: calls[0] },
      {
        kind: 'tool_result',
        modelStep: 1,
        ...lane,
        result: {
          kind: 'tool_result',
          callId: 'done-1',
          name: 'read',
          text: 'exact completed result',
          outcome: 'success',
        },
      },
      { kind: 'tool_call', modelStep: 1, ...lane, call: calls[1] },
      ...(schemaVersion === 2 ? [] : [{
        kind: 'tool_progress' as const,
        modelStep: 1,
        lane: 'parent' as const,
        callId: 'slow-1',
        name: 'search',
        text: 'partial search output',
      }]),
      { kind: 'turn_outcome', outcome: 'cancelled' },
    ],
    outcome: 'cancelled',
  };
  return schemaVersion === 2 ? { schemaVersion: 2, ...base } : { schemaVersion: 3, ...base };
};

Deno.test('Increment 38 retains latest accepted progress and reads evidence v2 and v3', async () => {
  const recorder = new ProviderEvidenceRecorder(EVIDENCE_ID, 1, '2026-09-12T00:00:00.000Z');
  recorder.recordAssistantProgress('first assistant prefix', 1, 'parent');
  recorder.recordAssistantProgress('latest assistant prefix', 1, 'parent');
  recorder.recordToolProgress({ callId: 'call-1', name: 'search' }, 'first tool prefix', 1);
  recorder.recordToolProgress({ callId: 'call-1', name: 'search' }, 'latest tool prefix', 1);
  assertEquals(recorder.snapshot().runtimeEvents, [
    {
      kind: 'assistant_progress',
      text: 'latest assistant prefix',
      modelStep: 1,
      lane: 'parent',
    },
    {
      kind: 'tool_progress',
      callId: 'call-1',
      name: 'search',
      text: 'latest tool prefix',
      modelStep: 1,
    },
  ]);

  const store = new FakeProviderEvidenceStore();
  await store.write(await sourceEvidence(2));
  assertEquals((await store.read(EVIDENCE_ID)).schemaVersion, 2);
  await store.write(await sourceEvidence(3));
  assertEquals((await store.read(EVIDENCE_ID)).schemaVersion, 3);
});

Deno.test('Increment 38 resolves exact completed and incomplete source observations', async () => {
  const artifacts = new FakeWorkerExecutionArtifactStore();
  const evidence = new FakeProviderEvidenceStore();
  await artifacts.write(await sourceArtifact());
  await evidence.write(await sourceEvidence());

  const recalled = await resolveRecalledExecutionContext({
    sessionId: SESSION_ID,
    executionId: SOURCE_ID,
    executionArtifactStore: artifacts,
    providerEvidenceStore: evidence,
  });
  if (recalled.schemaVersion !== 1) throw new Error('expected legacy recall context');
  assertEquals({
    task: recalled.task,
    stopReason: recalled.stopReason,
    evidence: recalled.evidence,
    observations: recalled.observations,
    replay: recalled.automaticReplay,
  }, {
    task: 'inspect source',
    stopReason: 'cancelled',
    evidence: 'available',
    observations: [
      {
        kind: 'assistant_completed',
        modelStep: 1,
        text: 'I started the requested inspection.',
        lane: 'parent',
      },
      {
        kind: 'tool_completed',
        modelStep: 1,
        call: { callId: 'done-1', name: 'read', arguments: { path: 'done.txt' } },
        result: {
          kind: 'tool_result',
          callId: 'done-1',
          name: 'read',
          text: 'exact completed result',
          outcome: 'success',
        },
        lane: 'parent',
      },
      {
        kind: 'tool_incomplete',
        modelStep: 1,
        call: {
          callId: 'slow-1',
          name: 'search',
          arguments: { query: 'unfinished' },
        },
        progress: 'partial search output',
        lane: 'parent',
      },
    ],
    replay: false,
  });
  assert(recalledExecutionProjectionText(recalled).includes('exact completed result'));
  assert(recalledExecutionProjectionText(recalled).includes('partial search output'));

  const legacyArtifacts = new FakeWorkerExecutionArtifactStore();
  const legacyEvidence = new FakeProviderEvidenceStore();
  await legacyArtifacts.write(await sourceArtifact(2));
  await legacyEvidence.write(await sourceEvidence(2));
  const legacy = await resolveRecalledExecutionContext({
    sessionId: SESSION_ID,
    executionId: SOURCE_ID,
    executionArtifactStore: legacyArtifacts,
    providerEvidenceStore: legacyEvidence,
  });
  assertEquals(legacy.evidence, 'available');
  assertEquals(legacy.observations.map((observation) => observation.kind), [
    'assistant_completed',
    'tool_completed',
    'tool_incomplete',
  ]);

  const artifactOnly = await resolveRecalledExecutionContext({
    sessionId: SESSION_ID,
    executionId: SOURCE_ID,
    executionArtifactStore: legacyArtifacts,
  });
  assertEquals({ evidence: artifactOnly.evidence, observations: artifactOnly.observations }, {
    evidence: 'unavailable',
    observations: [],
  });
});

Deno.test('Increment 38 projects recall for one Worker turn without transcript adoption or replay', async () => {
  const recalled: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: SOURCE_ID,
    sessionId: SESSION_ID,
    turn: 1,
    settlement: 'uncommitted',
    stopReason: 'cancelled',
    task: 'source task',
    evidence: 'available',
    observations: [{
      kind: 'tool_completed',
      modelStep: 1,
      call: { callId: 'source-call', name: 'source_tool', arguments: {} },
      result: {
        kind: 'tool_result',
        callId: 'source-call',
        name: 'source_tool',
        text: 'source fact',
        outcome: 'success',
      },
    }],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  const requests: ModelRequest[] = [];
  const results: ModelResult[] = [
    {
      kind: 'tool_calls',
      calls: [{ callId: 'new-call', name: 'new_tool', arguments: {} }],
    },
    { kind: 'final', text: 'used recalled fact' },
    { kind: 'final', text: 'next turn' },
  ];
  const model: Model = {
    generate(request): ModelResult {
      requests.push(structuredClone(request));
      const result = results.shift();
      if (result === undefined) throw new Error('unexpected model request');
      return result;
    },
  };
  let sourceDispatches = 0;
  let newDispatches = 0;
  const registry = new Registry([{
    name: 'source_tool',
    description: 'source tool',
    inputSchema: {},
    execute: () => {
      sourceDispatches += 1;
      return 'unexpected source replay';
    },
  }, {
    name: 'new_tool',
    description: 'new tool',
    inputSchema: {},
    execute: () => {
      newDispatches += 1;
      return 'new result';
    },
  }]);
  const proposals: readonly Message[][] = [];
  const mutableProposals = proposals as Message[][];
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, proposal) => {
      mutableProposals.push(structuredClone(proposal.transcript) as Message[]);
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      throw new Error(`unexpected failed turn: ${outcome.stopReason}`);
    },
  };
  const composition = {
    role: 'parent',
    model,
    registry,
    maxSteps: 3,
    systemInstruction: undefined,
    manifest: {
      role: 'parent',
      maxSteps: 3,
      profileId: 'provider-free-recall',
      resources: [],
    },
    resolved: { model: { profile: { id: 'provider-free-recall' } } },
  } as unknown as WorkerAgentComposition;
  const generation = new WorkerGeneration(composition, SESSION_ID, port);

  await generation.runTurn(correlation('target-turn'), 'use recalled facts', recalled);
  await generation.runTurn(correlation('next-turn'), 'ordinary next turn');

  const marker = '[henji-recalled-execution:v1]';
  assertEquals(requests.length, 3);
  for (const request of requests.slice(0, 2)) {
    const taskIndex = request.transcript.findIndex((message) =>
      message.role === 'user' && message.content.text === 'use recalled facts'
    );
    assert(taskIndex > 0);
    const projected = request.transcript[taskIndex - 1];
    assert(projected?.role === 'user' && projected.content.text.startsWith(marker));
  }
  assert(!JSON.stringify(requests[2]).includes(marker));
  assertEquals({ sourceDispatches, newDispatches }, { sourceDispatches: 0, newDispatches: 1 });
  assertEquals(proposals.length, 2);
  assert(!JSON.stringify(proposals).includes(marker));
});

Deno.test('Increment 38 recall remains immediately before the task after checkpoint projection', async () => {
  const recalled: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: SOURCE_ID,
    sessionId: SESSION_ID,
    turn: 2,
    settlement: 'uncommitted',
    stopReason: 'contract_failure',
    task: 'failed source task',
    error: 'provider failed',
    evidence: 'unavailable',
    observations: [],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  const initialTranscript: Message[] = [{
    role: 'user',
    content: { kind: 'text', text: 'old task one' },
  }, {
    role: 'assistant',
    content: { kind: 'text', text: 'old answer one' },
  }, {
    role: 'user',
    content: { kind: 'text', text: 'old task two' },
  }, {
    role: 'assistant',
    content: { kind: 'text', text: 'old answer two' },
  }];
  let request: ModelRequest | undefined;
  let proposal: readonly Message[] | undefined;
  const model: Model = {
    generate(value): ModelResult {
      request = structuredClone(value);
      return { kind: 'final', text: 'checkpoint recall answer' };
    },
  };
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, value) => {
      proposal = structuredClone(value.transcript);
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      throw new Error(`unexpected failed turn: ${outcome.stopReason}`);
    },
  };
  const composition = {
    role: 'parent',
    model,
    registry: new Registry([]),
    maxSteps: 1,
    systemInstruction: undefined,
    manifest: {
      role: 'parent',
      maxSteps: 1,
      profileId: 'provider-free-recall-checkpoint',
      resources: [],
    },
    resolved: { model: { profile: { id: 'provider-free-recall-checkpoint' } } },
  } as unknown as WorkerAgentComposition;
  const generation = new WorkerGeneration(
    composition,
    SESSION_ID,
    port,
    initialTranscript,
    3,
    {
      contextSchemaVersion: 1,
      sessionId: SESSION_ID,
      createdAt: '2026-09-12T00:00:00.000Z',
      sourceProfileId: 'provider-free-recall-checkpoint',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: 'old task one and answer one',
    },
  );

  await generation.runTurn(correlation('checkpoint-target'), 'current checkpoint task', recalled);

  assert(request !== undefined);
  const taskIndex = request.transcript.findIndex((message) =>
    message.role === 'user' && message.content.text === 'current checkpoint task'
  );
  assert(taskIndex > 0);
  const projectedRecall = request.transcript[taskIndex - 1];
  assert(
    projectedRecall?.role === 'user' &&
      projectedRecall.content.text.startsWith('[henji-recalled-execution:v1]'),
  );
  assert(
    request.transcript[0]?.role === 'user' &&
      request.transcript[0].content.text.startsWith('[henji-context-checkpoint:v1]'),
  );
  assert(proposal !== undefined);
  assertEquals(proposal.slice(0, initialTranscript.length), initialTranscript);
  assert(!JSON.stringify(proposal).includes('[henji-recalled-execution:v1]'));
});

Deno.test('Increment 38 target artifact retains exact recall attribution', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-recall-attribution-' });
  const artifacts = new FakeWorkerExecutionArtifactStore();
  const evidence = new FakeProviderEvidenceStore();
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'none',
      agent: 'default',
      physicalIoMode: 'provider-free',
      providerEvidenceStore: evidence,
      executionArtifactStore: artifacts,
    });
    const sessionId = created.session.currentPosition().sessionId;
    const context: RecalledExecutionContextV1 = {
      schemaVersion: 1,
      sourceExecutionId: SOURCE_ID,
      sessionId,
      turn: 1,
      settlement: 'uncommitted',
      stopReason: 'cancelled',
      task: 'source task',
      evidence: 'unavailable',
      observations: [],
      effectCommitRelation: 'not_transactional',
      automaticReplay: false,
    };
    const outcome = await created.session.submit('read worker protocol', context);
    assert(outcome.ok);
    const artifact = (await artifacts.list())[0];
    assert(artifact?.schemaVersion === 7);
    assertEquals(artifact.recall, {
      schemaVersion: 1,
      sourceExecutionId: SOURCE_ID,
      projectedContext: recalledExecutionProjectionText(context),
    });
    const retainedEvidence = (await evidence.list())[0];
    assert(retainedEvidence?.schemaVersion === 5);
    assert(retainedEvidence.runtimeEvents.some((event) => event.kind === 'assistant_progress'));
    assert(
      !JSON.stringify(created.session.transcriptSnapshot()).includes(
        '[henji-recalled-execution:v1]',
      ),
    );
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 38 selects latest or explicit current-Session execution and consumes once', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-recall-selection-' });
  const artifacts = new FakeWorkerExecutionArtifactStore();
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'none',
      agent: 'default',
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
    });
    const sessionId = created.session.sessionId;
    const olderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const latestId = 'aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await artifacts.write(
      await sourceArtifactFor(
        sessionId,
        olderId,
        '2026-09-12T00:00:01.000Z',
      ),
    );
    await artifacts.write(
      await sourceArtifactFor(
        sessionId,
        latestId,
        '2026-09-12T00:00:02.000Z',
      ),
    );
    const adapter = createTuiPresentationAdapter(
      created.session,
      undefined,
      { persistent: true } as SessionNavigationHost,
    );

    assertEquals(await adapter.dispatch({ kind: 'recall_execution' }), {
      kind: 'recall',
      sourceExecutionId: latestId,
      evidence: 'unavailable',
    });
    assertEquals(await adapter.dispatch({ kind: 'recall_execution', id: 'aaaaaaaa' }), {
      kind: 'rejected',
      reason: 'ambiguous',
    });
    const first = await adapter.dispatch({ kind: 'ordinary_submit', text: 'use latest source' });
    assert(first.kind === 'outcome' && first.outcome.ok);
    const firstTarget = (await artifacts.list()).find((artifact) =>
      artifact.command.task === 'use latest source'
    );
    assert(firstTarget?.schemaVersion === 7);
    assertEquals(firstTarget.recall?.sourceExecutionId, latestId);

    assertEquals(await adapter.dispatch({ kind: 'recall_execution', id: 'aaaaaaaa-aaaa' }), {
      kind: 'recall',
      sourceExecutionId: olderId,
      evidence: 'unavailable',
    });
    const second = await adapter.dispatch({ kind: 'ordinary_submit', text: 'use explicit source' });
    assert(second.kind === 'outcome' && second.outcome.ok);
    const secondTarget = (await artifacts.list()).find((artifact) =>
      artifact.command.task === 'use explicit source'
    );
    assert(secondTarget?.schemaVersion === 7);
    assertEquals(secondTarget.recall?.sourceExecutionId, olderId);

    const third = await adapter.dispatch({ kind: 'ordinary_submit', text: 'ordinary next task' });
    assert(third.kind === 'outcome' && third.outcome.ok);
    const thirdTarget = (await artifacts.list()).find((artifact) =>
      artifact.command.task === 'ordinary next task'
    );
    assert(thirdTarget?.schemaVersion === 7);
    assertEquals(thirdTarget.recall, undefined);

    assert((await adapter.dispatch({ kind: 'recall_execution' })).kind === 'recall');
    assertEquals(await adapter.dispatch({ kind: 'clear_recall' }), { kind: 'accepted' });
    const afterClear = await adapter.dispatch({
      kind: 'ordinary_submit',
      text: 'task after recall clear',
    });
    assert(afterClear.kind === 'outcome' && afterClear.outcome.ok);
    const clearedTarget = (await artifacts.list()).find((artifact) =>
      artifact.command.task === 'task after recall clear'
    );
    assert(clearedTarget?.schemaVersion === 7);
    assertEquals(clearedTarget.recall, undefined);

    const noSession = createTuiPresentationAdapter(created.session);
    assertEquals(await noSession.dispatch({ kind: 'recall_execution' }), {
      kind: 'rejected',
      reason: 'unavailable',
    });
  } finally {
    await created?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
