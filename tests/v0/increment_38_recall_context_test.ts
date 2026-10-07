import type { Message, Model, ModelRequest, ModelResult } from '../../v0/agent/core/contracts.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';
import { WorkerRecallSelectionError } from '../../v0/agent/worker/worker_host_session.ts';
import type { WorkerExecutionArtifactV1 } from '../../v0/agent/worker/worker_execution_artifact.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
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

Deno.test('Increment 113 restored steering answer survives the next live Worker turn', async () => {
  let committedTranscript: readonly Message[] | undefined;
  let requests = 0;
  const model: Model = {
    generate(): ModelResult {
      requests += 1;
      if (requests === 1) {
        return {
          kind: 'tool_calls',
          calls: [{
            callId: 'read-1',
            name: 'read',
            arguments: { path: 'source.txt' },
          }],
        };
      }
      return {
        kind: 'final',
        text: requests === 2 ? 'saved answer' : 'next answer',
      };
    },
  };
  const registry = new Registry([{
    name: 'read',
    fileAccess: 'none' as const,
    description: 'read source',
    inputSchema: {},
    execute: () => {
      assertEquals(
        generation.steerActiveTurn('use the new instruction'),
        'accepted',
      );
      return 'source contents';
    },
  }]);
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_eventCorrelation, proposal) => {
      committedTranscript = structuredClone(proposal.transcript);
      return Promise.resolve(true);
    },
    turnFailed: (_eventCorrelation, outcome) => {
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
      profileId: 'i113-steering',
      resources: [],
    },
    resolved: { model: { profile: { id: 'i113-steering' } } },
  } as unknown as WorkerAgentComposition;
  const generation = new WorkerGeneration(composition, SESSION_ID, port);
  await generation.runTurn(correlation('steered-turn'), 'original task');
  assert(committedTranscript !== undefined);
  assert(
    committedTranscript.some((message) =>
      message.role === 'user' &&
      message.content.text === 'use the new instruction'
    ),
  );
  await generation.runTurn(correlation('next-turn'), 'next task');
  assert(committedTranscript !== undefined);
  assert(
    committedTranscript.some((message) =>
      message.role === 'assistant' && 'kind' in message.content &&
      message.content.text === 'saved answer'
    ),
  );
  assert(
    committedTranscript.some((message) =>
      message.role === 'assistant' && 'kind' in message.content &&
      message.content.text === 'next answer'
    ),
  );
});

const sourceArtifact = (): WorkerExecutionArtifactV1 => {
  const configuration = workerConfigurationFixture();
  const base: Omit<WorkerExecutionArtifactV1, 'schemaVersion'> = {
    executionId: SOURCE_ID,
    createdAt: '2026-09-12T00:00:00.000Z',
    settledAt: '2026-09-12T00:00:01.000Z',
    sessionId: SESSION_ID,
    turn: 1,
    agent: 'default',
    instanceCorrelation: 'recall-test-instance',
    workerGeneration: 'recall-test-generation',
    build: buildManifest(),
    configuration,
    configurationId: configuration.configurationId,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    maxSteps: 8,
    lifecycle: 'settled',
    normalizedOutcome: 'cancelled',
    adoption: 'non_canonical',
    contextCapture: 'none',
    command: {
      kind: 'turn',
      correlation: correlation('source-turn'),
      task: 'inspect source',
    },
    baseStateRevision: 1,
    protocolTrace: [{
      direction: 'host_to_worker',
      kind: 'turn',
      semanticSubtype: 'turn',
      sequence: 1,
      correlation: correlation('source-turn'),
    }],
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
  return { schemaVersion: 1, ...base };
};

const seedCancelledSource = async (
  created: Awaited<ReturnType<typeof createWorkerSession>>,
  executionId: string,
  createdAt: string,
): Promise<void> => {
  const sessionId = created.session.sessionId;
  const descriptor = await created.data.sessionDescriptor(sessionId);
  const sourceCorrelation = {
    session: sessionId,
    instanceCorrelation: crypto.randomUUID(),
    workerGeneration: crypto.randomUUID(),
    baseStateRevision: descriptor.stateRevision,
    command: crypto.randomUUID(),
  };
  const client = createAgentDataPortClient(
    await created.data.attachGeneration(sessionId, sourceCorrelation),
  );
  try {
    await client.ready({
      kind: 'ready',
      configuration: workerConfigurationFixture(),
      correlation: sourceCorrelation,
      manifest: {
        role: 'parent',
        maxSteps: 8,
        profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
        resources: [],
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
      },
    });
    await created.data.executionAdmit(sessionId, {
      executionId,
      taskId: executionId,
      createdAt,
      task: `source task ${executionId}`,
      correlation: sourceCorrelation,
    });
    await created.data.sealGeneration(sessionId, {
      executionId,
      decision: 'cancelled',
      reason: 'cancelled source execution',
    });
  } finally {
    client.close();
  }
};

Deno.test('Increment 38 retains latest accepted semantic progress', () => {
  const recorder = new ProviderEvidenceRecorder(
    EVIDENCE_ID,
    1,
    '2026-09-12T00:00:00.000Z',
  );
  recorder.recordAssistantProgress('first assistant prefix', 1, 'parent');
  recorder.recordAssistantProgress('latest assistant prefix', 1, 'parent');
  const attribution = Object.freeze({ modelStep: 1 });
  recorder.recordToolProgress(
    { callId: 'call-1', name: 'search' },
    'first tool prefix',
    0,
    attribution,
  );
  recorder.recordToolProgress(
    { callId: 'call-1', name: 'search' },
    'latest tool prefix',
    0,
    attribution,
  );
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
      callIndex: 0,
      modelStep: 1,
    },
  ]);
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
    fileAccess: 'none' as const,
    description: 'source tool',
    inputSchema: {},
    execute: () => {
      sourceDispatches += 1;
      return 'unexpected source replay';
    },
  }, {
    name: 'new_tool',
    fileAccess: 'none' as const,
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

  await generation.runTurn(
    correlation('target-turn'),
    'use recalled facts',
    recalled,
  );
  await generation.runTurn(correlation('next-turn'), 'ordinary next turn');

  const marker = '[henji-recalled-execution:v1]';
  assertEquals(requests.length, 3);
  for (const request of requests.slice(0, 2)) {
    const taskIndex = request.transcript.findIndex((message) =>
      message.role === 'user' && message.content.text === 'use recalled facts'
    );
    assert(taskIndex > 0);
    const projected = request.transcript[taskIndex - 1];
    assert(
      projected?.role === 'user' && projected.content.text.startsWith(marker),
    );
  }
  assert(!JSON.stringify(requests[2]).includes(marker));
  assertEquals({ sourceDispatches, newDispatches }, {
    sourceDispatches: 0,
    newDispatches: 1,
  });
  assertEquals(proposals.length, 2);
  assert(!JSON.stringify(proposals).includes(marker));
});

Deno.test('Increment 38 recalls consumed steering without provider replay state from persisted Worker facts', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-i38-recall-journal-',
  });
  const workspaceRoot = `${stateRoot}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(
    stateRoot,
    workspaceRoot,
    {},
  );
  try {
    const artifact = await sourceArtifact();
    const task = 'inspect source with steering';
    const input = {
      taskId: crypto.randomUUID(),
      executionId: SOURCE_ID,
      createdAt: '2026-09-23T00:00:00.000Z',
      sessionCorrelation: SESSION_ID,
      turn: 1,
      task,
      baseStateRevision: 1,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: artifact.build,
      configuration: artifact.configuration,
      configurationId: artifact.configurationId,
      maxSteps: 8,
      command: artifact.command.correlation.command,
    };
    await store.beginExecution({ ...input, sessionMode: 'no_session' });
    let sequence = 0;
    let failedOutcome:
      | import('../../v0/agent/core/contracts.ts').LoopOutcome
      | undefined;
    const sourceRequests: ModelRequest[] = [];
    const sourceModel: Model = {
      generate(request): ModelResult {
        sourceRequests.push(structuredClone(request));
        if (sourceRequests.length === 1) {
          return {
            kind: 'tool_calls',
            calls: [{
              callId: 'source-read',
              name: 'read',
              arguments: { path: 'src.ts' },
            }],
            text: 'I will read the source.',
            providerState: {
              provider: 'openrouter-chat',
              reasoningDetails: [{ trace: 'provider replay detail' }],
            },
          };
        }
        return { kind: 'final', text: 'stopped after reading' };
      },
    };
    const registry = new Registry([{
      name: 'read',
      fileAccess: 'none' as const,
      description: 'read source',
      inputSchema: {},
      execute: () => {
        assertEquals(
          sourceGeneration.steerActiveTurn('use the new instruction'),
          'accepted',
        );
        return 'exact source contents';
      },
    }]);
    const sourcePort: WorkerGenerationPort = {
      runtimeEvent: (eventCorrelation, event) => {
        sequence += 1;
        store.appendExecutionEvent({
          executionId: SOURCE_ID,
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'runtime_event',
          workerSequence: sequence,
          payload: {
            kind: 'runtime_event',
            correlation: eventCorrelation,
            sequence,
            event: { kind: 'agent_event', event },
          },
        });
        return sequence;
      },
      effectObservation: (eventCorrelation, effect) => {
        sequence += 1;
        store.appendExecutionEvent({
          executionId: SOURCE_ID,
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'effect_observation',
          workerSequence: sequence,
          payload: {
            kind: 'effect_observation',
            correlation: eventCorrelation,
            sequence,
            effect,
          },
        });
        return sequence;
      },
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: () => Promise.resolve(false),
      turnFailed: (_correlation, outcome) => {
        failedOutcome = outcome;
      },
    };
    const sourceComposition = {
      role: 'parent',
      model: sourceModel,
      registry,
      maxSteps: 2,
      systemInstruction: undefined,
      manifest: {
        role: 'parent',
        maxSteps: 2,
        profileId: 'i38-source',
        resources: [],
      },
      resolved: { model: { profile: { id: 'i38-source' } } },
    } as unknown as WorkerAgentComposition;
    const sourceGeneration = new WorkerGeneration(
      sourceComposition,
      SESSION_ID,
      sourcePort,
    );
    await sourceGeneration.runTurn(correlation('persisted-source'), task);
    assert(failedOutcome !== undefined);
    assert(sourceRequests.length === 2);
    assert(
      JSON.stringify(sourceRequests[1]).includes('use the new instruction'),
    );
    const { transcript: messageSuffix, ...outcomeMetadata } = failedOutcome;
    store.settleNonCanonicalExecution({
      ...input,
      messageSuffix,
      outcome: outcomeMetadata,
    });

    const journal = JSON.stringify(store.listExecutionEvents(SOURCE_ID));
    assert(journal.includes('provider replay detail'));
    assert(journal.includes('use the new instruction'));
    const recalled = await resolveRecalledExecutionContext({
      sessionId: SESSION_ID,
      executionId: SOURCE_ID,
      historyPersistence: store,
    });
    assert(recalled.schemaVersion === 2);
    assertEquals(
      recalled.journalObservations.filter((item) => item.kind === 'steering_message').length,
      1,
    );
    const projection = recalledExecutionProjectionText(recalled);
    assert(projection.includes('I will read the source.'));
    assert(projection.includes('exact source contents'));
    assert(projection.includes('use the new instruction'));
    assert(!projection.includes('provider replay detail'));
    assert(!projection.includes('providerState'));

    let targetRequest: ModelRequest | undefined;
    const targetComposition = {
      ...sourceComposition,
      model: {
        generate(request: ModelRequest): ModelResult {
          targetRequest = structuredClone(request);
          return { kind: 'final', text: 'answered with recalled facts' };
        },
      },
      registry: new Registry([]),
      maxSteps: 1,
    } as unknown as WorkerAgentComposition;
    const targetPort: WorkerGenerationPort = {
      runtimeEvent: () => {},
      effectObservation: () => {},
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: () => Promise.resolve(true),
      turnFailed: (_correlation, outcome) => {
        throw new Error(`unexpected target failure: ${outcome.stopReason}`);
      },
    };
    await new WorkerGeneration(targetComposition, SESSION_ID, targetPort)
      .runTurn(
        correlation('recalled-target'),
        'what happened?',
        recalled,
      );
    assert(targetRequest !== undefined);
    const targetText = JSON.stringify(targetRequest);
    assertEquals(targetText.split('use the new instruction').length - 1, 1);
    assert(targetText.includes('exact source contents'));
    assert(!targetText.includes('provider replay detail'));
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
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

  await generation.runTurn(
    correlation('checkpoint-target'),
    'current checkpoint task',
    recalled,
  );

  assert(request !== undefined);
  const taskIndex = request.transcript.findIndex((message) =>
    message.role === 'user' &&
    message.content.text === 'current checkpoint task'
  );
  assert(taskIndex > 0);
  const projectedRecall = request.transcript[taskIndex - 1];
  assert(
    projectedRecall?.role === 'user' &&
      projectedRecall.content.text.startsWith('[henji-recalled-execution:v1]'),
  );
  assert(
    request.transcript[0]?.role === 'user' &&
      request.transcript[0].content.text.startsWith(
        '[henji-context-checkpoint:v1]',
      ),
  );
  assert(proposal !== undefined);
  assertEquals(proposal.slice(0, initialTranscript.length), initialTranscript);
  assert(!JSON.stringify(proposal).includes('[henji-recalled-execution:v1]'));
});

Deno.test('Increment 38 target artifact retains exact recall attribution', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-recall-attribution-',
  });
  const reader = new SqliteHistoryStore(stateRoot, Deno.cwd(), {
    readOnly: true,
  });
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'none',

      physicalIoMode: 'provider-free',
    });
    const sessionId = created.session.currentPosition().sessionId;
    await seedCancelledSource(created, SOURCE_ID, '2026-09-12T00:00:01.000Z');
    await created.session.prepareRecall(SOURCE_ID);
    await reader.initialize();
    assertEquals(
      reader.readExecutionRecallFacts(SOURCE_ID).eventCount,
      reader.listExecutionEvents(SOURCE_ID).length,
    );
    const context = await resolveRecalledExecutionContext({
      sessionId,
      executionId: SOURCE_ID,
      historyPersistence: reader,
    });
    const outcome = await created.session.submit('read worker protocol');
    assert(outcome.ok);
    const artifact = (await reader.executionArtifacts.list()).find((item) =>
      item.command.task === 'read worker protocol'
    );
    assert(
      artifact?.schemaVersion === 1,
      JSON.stringify(
        reader.listExecutions().map((row) => ({
          task: row.task,
          capture: row.artifactCapture,
        })),
      ),
    );
    assertEquals(artifact.recall, {
      schemaVersion: 1,
      sourceExecutionId: SOURCE_ID,
      projectedContext: recalledExecutionProjectionText(context),
    });
    const descriptor = await created.data.sessionDescriptor(sessionId);
    const currentCorrelation = {
      session: sessionId,
      instanceCorrelation: crypto.randomUUID(),
      workerGeneration: crypto.randomUUID(),
      baseStateRevision: descriptor.stateRevision,
      command: crypto.randomUUID(),
    };
    const basisReader = createAgentDataPortClient(
      await created.data.attachGeneration(sessionId, currentCorrelation),
    );
    try {
      const basis = await basisReader.generationContext(currentCorrelation);
      assert(
        !JSON.stringify(basis.initialTranscript).includes(
          '[henji-recalled-execution:v',
        ),
      );
      assert(basis.recalledContext === undefined);
    } finally {
      basisReader.close();
    }
  } finally {
    await created?.close();
    reader.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 38 selects latest or explicit current-Session execution and consumes once', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-recall-selection-',
  });
  const reader = new SqliteHistoryStore(stateRoot, Deno.cwd(), {
    readOnly: true,
  });
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'none',

      physicalIoMode: 'provider-free',
    });
    const olderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const latestId = 'aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await seedCancelledSource(created, olderId, '2026-09-12T00:00:01.000Z');
    await seedCancelledSource(created, latestId, '2026-09-12T00:00:02.000Z');
    assertEquals(await created.session.prepareRecall(), {
      sourceExecutionId: latestId,
      evidence: 'unavailable',
    });
    let ambiguous = false;
    try {
      await created.session.prepareRecall('aaaaaaaa');
    } catch (error) {
      ambiguous = error instanceof WorkerRecallSelectionError &&
        error.code === 'ambiguous';
      if (!ambiguous) throw error;
    }
    assert(ambiguous, 'ambiguous execution prefix was accepted');
    const first = await created.session.submit('use latest source');
    assert(first.ok);
    const firstTarget = (await reader.executionArtifacts.list()).find((
      artifact,
    ) => artifact.command.task === 'use latest source');
    assert(firstTarget?.schemaVersion === 1);
    assertEquals(firstTarget.recall?.sourceExecutionId, latestId);

    assertEquals(await created.session.prepareRecall('aaaaaaaa-aaaa'), {
      sourceExecutionId: olderId,
      evidence: 'unavailable',
    });
    const second = await created.session.submit('use explicit source');
    assert(second.ok);
    const secondTarget = (await reader.executionArtifacts.list()).find((
      artifact,
    ) => artifact.command.task === 'use explicit source');
    assert(secondTarget?.schemaVersion === 1);
    assertEquals(secondTarget.recall?.sourceExecutionId, olderId);

    const third = await created.session.submit('ordinary next task');
    assert(third.ok);
    const thirdTarget = (await reader.executionArtifacts.list()).find((
      artifact,
    ) => artifact.command.task === 'ordinary next task');
    assert(thirdTarget?.schemaVersion === 1);
    assertEquals(thirdTarget.recall, undefined);

    assertEquals(await created.session.prepareRecall(), {
      sourceExecutionId: latestId,
      evidence: 'unavailable',
    });
    assert(await created.session.clearPendingRecall());
    const afterClear = await created.session.submit('task after recall clear');
    assert(afterClear.ok);
    const clearedTarget = (await reader.executionArtifacts.list()).find((
      artifact,
    ) => artifact.command.task === 'task after recall clear');
    assert(clearedTarget?.schemaVersion === 1);
    assertEquals(clearedTarget.recall, undefined);
  } finally {
    await created?.close();
    reader.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});
