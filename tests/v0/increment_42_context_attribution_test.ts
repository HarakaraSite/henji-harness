import { DatabaseSync } from 'node:sqlite';
import {
  MAX_COMPLETE_MODEL_REQUEST_BYTES,
  MAX_SERIALIZED_MODEL_MESSAGES_BYTES,
} from '../../v0/resource_limits.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import {
  canonicalJson,
  contextManifestDigest,
  type ContextModelRequestRecord,
  createExecutionContextManifest,
  jsonBlob,
  textBlob,
  validateContextModelRequestRecord,
  type WorkerContextSnapshot,
} from '../../v0/agent/history/context_attribution.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import {
  HistoryStoreError,
  type StoredExecutionEvent,
  type StoredExecutionRow,
} from '../../v0/agent/history/history_store_contract.ts';
import {
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { resolveRecalledExecutionContext } from '../../v0/agent/worker/recalled_execution_context.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { OpenRouterSonarWebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { main as failureDiagnosticMain } from '../../v0/agent/cli/failure_diagnostic_cli.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  validateProviderEvidence,
} from '../../v0/agent/provider/provider_evidence.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { createTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { Message, Model, ModelRequest, ModelResult } from '../../v0/agent/core/contracts.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import type { RecalledExecutionContextV1 } from '../../v0/agent/worker/recalled_execution_context.ts';
import {
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';

class MissingManifestCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  turnDispatches = 0;

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest,
        startupSnapshot: {
          skillNames: [],
          context: snapshot(command.workspaceRoot!),
        },
        credentialAvailability: {
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
    } else if (command.kind === 'turn') {
      this.turnDispatches += 1;
      queueMicrotask(() =>
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          transcript: [
            { role: 'user', content: { kind: 'text', text: command.task } },
            { role: 'assistant', content: { kind: 'text', text: 'committed' } },
          ],
          nextTurn: 2,
          outcome: {
            ok: true,
            task: command.task,
            outcome: 'final',
            stopReason: 'final',
            finalText: 'committed',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            turnProviderRequestCount: 3,
            transcript: [
              { role: 'user', content: { kind: 'text', text: command.task } },
              {
                role: 'assistant',
                content: { kind: 'text', text: 'committed' },
              },
            ],
          },
          providerEvidence: {
            schemaVersion: 1,
            evidenceId: '40000000-0000-4000-8000-000000000050',
            turnNumber: 1,
            createdAt: '2026-09-12T00:00:00.000Z',
            requests: [],
            runtimeEvents: [],
            outcome: 'final',
          },
        })
      );
    } else if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

class SkillCanonicalCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  private sequence = 0;
  private commitResolve: ((accepted: boolean) => void) | undefined;
  private readonly generation: WorkerGeneration;

  private readonly maxSteps: number;
  private readonly manifestResources: readonly string[];

  constructor(
    private readonly context: WorkerContextSnapshot,
    model?: Model,
    registry?: Registry,
    maxSteps = 2,
    manifestResources: readonly string[] = ['tool:skill'],
    initialTranscript: readonly Message[] = [],
    nextTurn = 1,
  ) {
    this.maxSteps = maxSteps;
    this.manifestResources = manifestResources;
    let skillModelStep = 0;
    const skillModel: Model = {
      generate() {
        skillModelStep += 1;
        return skillModelStep === 1
          ? {
            kind: 'tool_calls',
            calls: [{
              callId: 'skill-canonical-call',
              name: 'skill',
              arguments: { name: 'second' },
            }],
          }
          : { kind: 'final', text: 'canonical answer' };
      },
    };
    const skillTool = {
      name: 'skill',
      description: 'load a skill',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: () => 'shared skill body',
    };
    const generationModel = model ?? skillModel;
    const generationRegistry = registry ?? new Registry([skillTool]);
    const composition = {
      role: 'parent' as const,
      model: generationModel,
      registry: generationRegistry,
      maxSteps,
      systemInstruction: undefined,
      manifest: {
        role: 'parent' as const,
        maxSteps,
        profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
        resources: manifestResources,
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
        plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
      },
    } as unknown as WorkerAgentComposition;
    const correlationPort = (event: WorkerToHostMessage): void => {
      for (const listener of this.listeners) listener(event);
    };
    const port: WorkerGenerationPort = {
      runtimeEvent: (correlation, event) =>
        correlationPort({
          kind: 'runtime_event',
          correlation,
          sequence: ++this.sequence,
          event: { kind: 'agent_event', event },
        }),
      effectObservation: (correlation, effect) =>
        correlationPort({
          kind: 'effect_observation',
          correlation,
          sequence: ++this.sequence,
          effect,
        }),
      providerObservation: (
        correlation,
        observation: ProviderEvidenceObservation,
      ) =>
        correlationPort({
          kind: 'provider_observation',
          correlation,
          sequence: ++this.sequence,
          observation,
        }),
      contextObservation: (correlation, observation) =>
        correlationPort({
          kind: 'context_observation',
          correlation,
          sequence: ++this.sequence,
          observation: { kind: 'model_request', request: observation },
        }),
      checkpointProposal: (
        _correlation: WorkerCorrelation,
        _proposal: WorkerCheckpointProposalMessage,
        _signal: AbortSignal,
      ) => Promise.resolve(false),
      commitProposal: (
        _correlation,
        proposal: WorkerCommitProposalMessage,
        _signal: AbortSignal,
      ) =>
        new Promise<boolean>((resolve) => {
          this.commitResolve = resolve;
          correlationPort(proposal);
        }),
      turnFailed: (correlation, outcome, providerEvidence, contextManifest) =>
        correlationPort({
          kind: 'turn_failed',
          correlation,
          outcome,
          ...(providerEvidence === undefined ? {} : { providerEvidence }),
          ...(contextManifest === undefined ? {} : { contextManifest }),
        }),
    };
    this.generation = new WorkerGeneration(
      composition,
      '30000000-0000-4000-8000-000000000042',
      port,
      initialTranscript,
      nextTurn,
      undefined,
      undefined,
      ROOT_DEFAULT_MODEL_SELECTION,
      () => {},
      async () => await Promise.resolve('unknown' as const),
      {
        skillNames: context.skillCatalog.skills.map((skill) => skill.name),
        context,
      },
    );
  }

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: this.maxSteps,
          profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
          resources: this.manifestResources,
          rootModel: ROOT_DEFAULT_MODEL_SELECTION,
          plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
        },
        startupSnapshot: {
          skillNames: this.context.skillCatalog.skills.map((skill) => skill.name),
          context: this.context,
        },
        credentialAvailability: {
          authProfile: 'openrouter-api-key',
          status: 'unknown',
        },
      });
    } else if (command.kind === 'turn') {
      void this.generation.runTurn(command.correlation, command.task);
    } else if (command.kind === 'commit_acknowledgement') {
      const resolve = this.commitResolve;
      this.commitResolve = undefined;
      resolve?.(command.accepted);
    } else if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
};

const jsonByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const sessionId = '30000000-0000-4000-8000-000000000042';
const definition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: 'a'.repeat(64) },
};
const manifest = {
  role: 'parent' as const,
  maxSteps: 8,
  profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
  resources: [],
  rootModel: ROOT_DEFAULT_MODEL_SELECTION,
  plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
};

const snapshot = (workspaceRoot: string): WorkerContextSnapshot => ({
  schemaVersion: 1,
  workspaceRoot,
  workspaceInstruction: {
    source: 'AGENTS.md',
    text: 'workspace instructions',
    formatted: 'workspace instructions',
  },
  skillCatalog: {
    manifest: 'available skills',
    skills: [{
      name: 'inspect',
      description: 'inspect files',
      sourceDirectory: `${workspaceRoot}/.agents/skills/inspect`,
      body: 'inspect instructions',
      toolResult: 'inspect instructions',
    }, {
      name: 'unused',
      description: 'unused skill',
      sourceDirectory: `${workspaceRoot}/.agents/skills/unused`,
      body: 'unused instructions',
      toolResult: 'unused instructions',
    }],
  },
  instructionComponents: [{
    identity: createAgentResourceIdentity('instruction:workspace'),
    text: 'workspace instructions',
  }],
  systemInstruction: 'system instructions',
  toolDefinitions: [{
    name: 'skill',
    description: 'load a skill',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  }],
  runtimeFacts: { cwd: workspaceRoot },
});

const makeInput = (root: string, executionId: string, taskId: string) => ({
  taskId,
  executionId,
  createdAt: '2026-09-12T00:00:00.000Z',
  sessionCorrelation: sessionId,
  sessionMode: 'no_session' as const,
  turn: 1,
  task: 'capture exact context',
  baseStateRevision: 1,
  agent: 'default' as const,
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition,
  manifest,
  instanceCorrelation: 'instance-42',
  workerGeneration: 'generation-42',
  contextSnapshot: snapshot(root),
});

const eventCorrelation = {
  session: sessionId,
  instanceCorrelation: 'instance-42',
  workerGeneration: 'generation-42',
  baseStateRevision: 1,
  command: 'turn-1',
};

const contextRequest = async (): Promise<ContextModelRequestRecord> => {
  const message = await jsonBlob(
    { role: 'user', content: { kind: 'text', text: 'capture exact context' } },
    'application/vnd.henji.message+json',
  );
  const tool = await jsonBlob(
    {
      name: 'skill',
      description: 'load a skill',
      inputSchema: { type: 'object' },
    },
    'application/vnd.henji.tool+json',
  );
  const system = await textBlob('system instructions');
  return {
    requestOrdinal: 1,
    lane: 'parent',
    purpose: 'user_turn',
    modelStep: 1,
    modelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    request: {
      systemInstruction: 'system instructions',
      transcript: [{
        role: 'user',
        content: { kind: 'text', text: 'capture exact context' },
      }],
      tools: [{
        name: 'skill',
        description: 'load a skill',
        inputSchema: { type: 'object' },
      }],
    },
    items: [{
      ordinal: 1,
      kind: 'system',
      content: {
        digest: system.digest,
        byteLength: system.byteLength,
        mediaType: system.mediaType,
      },
      relationOrdinals: [],
      bytesBase64: system.bytes.toBase64(),
    }, {
      ordinal: 2,
      kind: 'message',
      content: {
        digest: message.digest,
        byteLength: message.byteLength,
        mediaType: message.mediaType,
      },
      relationOrdinals: [],
      bytesBase64: message.bytes.toBase64(),
    }, {
      ordinal: 3,
      kind: 'tool_contract',
      content: {
        digest: tool.digest,
        byteLength: tool.byteLength,
        mediaType: tool.mediaType,
      },
      relationOrdinals: [],
      bytesBase64: tool.bytes.toBase64(),
    }],
  };
};

const largeActiveContextRequest = async (): Promise<ContextModelRequestRecord> => {
  const base = await contextRequest();
  const message = await jsonBlob({
    role: 'user',
    content: { kind: 'text', text: 'x'.repeat(5 * 1024 * 1024) },
  }, 'application/vnd.henji.message+json');
  return {
    ...base,
    request: {
      ...base.request!,
      transcript: [{
        role: 'user',
        content: { kind: 'text', text: 'x'.repeat(5 * 1024 * 1024) },
      }],
    },
    items: base.items.map((item) =>
      item.kind === 'message'
        ? {
          ...item,
          content: {
            digest: message.digest,
            byteLength: message.byteLength,
            mediaType: message.mediaType,
          },
          bytesBase64: message.bytes.toBase64(),
        }
        : item
    ),
  };
};

const appendContextRequest = (
  store: SqliteHistoryStore,
  executionId: string,
  request: ContextModelRequestRecord,
  sequence = 1,
): void => {
  store.appendExecutionEvent({
    executionId,
    direction: 'worker_to_host',
    source: 'worker',
    kind: 'context_observation',
    workerSequence: sequence,
    payload: {
      kind: 'context_observation',
      correlation: eventCorrelation,
      sequence,
      observation: { kind: 'model_request', request },
    },
  });
};

const settled = {
  ok: false,
  task: 'capture exact context',
  outcome: 'cancelled' as const,
  stopReason: 'cancelled' as const,
  error: 'cancelled',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
};

Deno.test('Increment 42 canonicalizes context bytes and strictly validates model requests', async () => {
  assertEquals(
    canonicalJson({ z: 1, a: [true, null] }),
    '{"a":[true,null],"z":1}',
  );
  const record = await contextRequest();
  assert(validateContextModelRequestRecord(record));
  assert(!validateContextModelRequestRecord({ ...record, unexpected: true }));
  assert(
    !validateContextModelRequestRecord({
      ...record,
      items: [{ ...record.items[0], bytesBase64: 'not-base64' }],
    }),
  );
});

Deno.test('Increment 42 awaits context observation before entering model.generate', async () => {
  const order: string[] = [];
  const model: Model = {
    generate() {
      order.push('generate');
      return { kind: 'final', text: 'done' };
    },
  };
  const executionContext = createTurnExecutionContext(
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      order.push('context:start');
      await Promise.resolve();
      order.push('context:sent');
      return 1;
    },
  );
  const outcome = await runAgentTurn(
    'observe first',
    [],
    model,
    new Registry([]),
    { executionContext },
  );
  assert(outcome.ok);
  assertEquals(order, ['context:start', 'context:sent', 'generate']);
});

Deno.test('Increment 42 preserves duplicate message occurrences with explicit source sidecars', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-provenance-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000049';
  const taskId = '10000000-0000-4000-8000-000000000049';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const original = await contextRequest();
    const message = original.items[1];
    const duplicate = {
      ...message,
      ordinal: 3,
      sourceRelations: [{
        stage: 'projected' as const,
        resourceKind: 'message' as const,
        logicalIdentity: 'canonical:session:revision:1:message:2',
        lane: 'parent' as const,
        modelStep: 1,
        requestOrdinal: 1,
      }],
    };
    const request: ContextModelRequestRecord = {
      ...original,
      items: [
        original.items[0],
        {
          ...message,
          sourceRelations: [{
            stage: 'projected',
            resourceKind: 'message',
            logicalIdentity: 'current-task:session:turn:1',
            lane: 'parent',
            modelStep: 1,
            requestOrdinal: 1,
          }],
        },
        duplicate,
        { ...original.items[2], ordinal: 4 },
      ],
    };
    appendContextRequest(store, executionId, request);
    const validManifest = await createExecutionContextManifest([request]);
    const movedItems = validManifest.requests[0].items.map((item, index) =>
      index === 1
        ? validManifest.requests[0].items[2]
        : index === 2
        ? validManifest.requests[0].items[1]
        : item
    );
    const movedSourceRelations = movedItems.flatMap((item) => item.relations);
    const movedBody = {
      schemaVersion: validManifest.schemaVersion,
      requestCount: validManifest.requestCount,
      requests: [{
        ...validManifest.requests[0],
        items: movedItems,
        sourceRelations: movedSourceRelations,
      }],
      relations: movedSourceRelations,
      externalRelations: validManifest.externalRelations,
    } as const;
    const movedManifest = {
      ...movedBody,
      digest: await contextManifestDigest(movedBody),
    };
    let movedRejected = false;
    try {
      store.settleNonCanonicalExecution({
        ...input,
        contextManifest: movedManifest,
        outcome: settled,
      });
    } catch (error) {
      movedRejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      movedRejected,
      'moving a source relation between item boundaries was accepted',
    );
    assertEquals(store.readExecution(executionId).lifecycle, 'active');
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: validManifest,
      outcome: settled,
    });
    const context = store.listExecutionContext(executionId);
    const messages = context.requests[0].items.filter((item) => item.kind === 'message');
    assertEquals(messages.map((item) => item.content.digest), [
      messages[0].content.digest,
      messages[0].content.digest,
    ]);
    const identities = context.relations
      .filter((relation) => relation.resourceKind === 'message' && relation.logicalIdentity)
      .map((relation) => relation.logicalIdentity);
    assert(identities.includes('current-task:session:turn:1'));
    assert(identities.includes('canonical:session:revision:1:message:2'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 carries checkpoint and recall provenance with projected message order', async () => {
  const initialTranscript: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'first task' } },
    { role: 'assistant', content: { kind: 'text', text: 'first answer' } },
    { role: 'user', content: { kind: 'text', text: 'second task' } },
    { role: 'assistant', content: { kind: 'text', text: 'second answer' } },
  ];
  const recalled: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: '40000000-0000-4000-8000-000000000042',
    sessionId,
    turn: 2,
    settlement: 'uncommitted',
    stopReason: 'contract_failure',
    task: 'failed task',
    evidence: 'unavailable',
    observations: [],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  let proposal:
    | import('../../v0/agent/worker/worker_protocol.ts').WorkerCommitProposalMessage
    | undefined;
  const model: Model = {
    generate(): ModelResult {
      return { kind: 'final', text: 'answer' };
    },
  };
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, value) => {
      proposal = structuredClone(value);
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
    manifest: {
      role: 'parent',
      maxSteps: 1,
      profileId: 'provider-free-context-provenance',
      resources: [],
    },
    resolved: {
      model: { profile: { id: 'provider-free-context-provenance' } },
    },
  } as unknown as WorkerAgentComposition;
  const generation = new WorkerGeneration(
    composition,
    sessionId,
    port,
    initialTranscript,
    3,
    {
      contextSchemaVersion: 1,
      sessionId,
      createdAt: '2026-09-12T00:00:00.000Z',
      sourceProfileId: 'provider-free-context-provenance',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: 'first task and answer',
    },
  );
  await generation.runTurn(
    {
      session: sessionId,
      instanceCorrelation: 'instance-context-provenance',
      workerGeneration: 'generation-context-provenance',
      baseStateRevision: 1,
      command: 'turn-3',
    },
    'current task',
    recalled,
  );
  assert(proposal?.contextManifest !== undefined);
  const sourceIdentities = proposal.contextManifest.relations.map((relation) =>
    relation.logicalIdentity
  );
  assert(
    sourceIdentities.some((identity) => identity?.startsWith('checkpoint:')),
  );
  assert(sourceIdentities.some((identity) => identity?.startsWith('recall:')));
  assert(
    sourceIdentities.some((identity) => identity?.startsWith('canonical:')),
  );
  assert(
    sourceIdentities.some((identity) => identity?.startsWith('current-task:')),
  );
  const request = proposal.contextManifest.requests[0];
  assert(request !== undefined);
  assertEquals(
    request.sourceRelations.map((relation) => relation.logicalIdentity),
    proposal.contextManifest.relations.map((relation) => relation.logicalIdentity),
  );
});

Deno.test('Increment 42 attributes delegated planner requests and internal skill/tool relations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-planner-context-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
    });
    const outcome = await host.submit('delegate planner');
    assert(outcome.ok, outcome.error);
    const execution = store.listExecutions()[0];
    assert(execution !== undefined);
    const context = store.listExecutionContext(execution.executionId);
    assert(context.requests.some((request) => request.lane === 'planner'));
    assert(
      context.relations.some((relation) =>
        relation.lane === 'planner' &&
        (relation.stage === 'projected' || relation.stage === 'loaded' ||
          relation.stage === 'observed')
      ),
      'planner context relations were not attributed to the child lane',
    );
    assert(
      context.relations.some((relation) =>
        relation.lane === 'planner' &&
        relation.logicalIdentity?.includes(':lane:planner:call:') &&
        relation.callId !== undefined
      ),
      'planner task provenance did not retain its delegation call identity',
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 completes canonical skill provenance across two model requests', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-skill-canonical-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    const sharedSkill = (name: string, sourceDirectory: string) => ({
      name,
      description: `${name} skill`,
      sourceDirectory,
      body: 'shared skill body',
      toolResult: 'shared skill body',
    });
    const context: WorkerContextSnapshot = {
      schemaVersion: 1,
      workspaceRoot,
      skillCatalog: {
        skills: [
          sharedSkill('first', `${workspaceRoot}/.agents/skills/first`),
          sharedSkill('second', `${workspaceRoot}/.agents/skills/second`),
        ],
      },
      instructionComponents: [],
      toolDefinitions: [{
        name: 'skill',
        description: 'load a skill',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      }],
      runtimeFacts: { cwd: workspaceRoot },
    };
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => new SkillCanonicalCapsule(context),
    });
    const outcome = await host.submit('load the second skill');
    assert(outcome.ok, outcome.error);
    const execution = store.listExecutions()[0];
    assert(execution !== undefined);
    assertEquals(execution.lifecycle, 'settled');
    assertEquals(execution.adoption, 'canonical');
    assertEquals(execution.contextCapture, 'complete');
    const relations = store.listExecutionContext(execution.executionId).relations;
    const observed = relations.filter((relation) =>
      relation.stage === 'observed' && relation.resourceKind === 'tool_result'
    );
    const loaded = relations.filter((relation) =>
      relation.stage === 'loaded' && relation.resourceKind === 'skill'
    );
    const projected = relations.filter((relation) =>
      relation.stage === 'projected' && relation.resourceKind === 'skill'
    );
    assertEquals(observed.length, 1);
    assertEquals(loaded.length, 1);
    assertEquals(projected.length, 1);
    assertEquals(loaded[0]?.logicalIdentity, 'skill:second');
    assertEquals(projected[0]?.logicalIdentity, 'skill:second');
    assertEquals(loaded[0]?.callId, 'skill-canonical-call');
    assertEquals(projected[0]?.callId, 'skill-canonical-call');
    assertEquals(loaded[0]?.contentDigest, projected[0]?.contentDigest);
    assertEquals(observed[0]?.contentDigest, loaded[0]?.contentDigest);
    assertEquals(
      relations.filter((relation) =>
        relation.resourceKind === 'skill' &&
        relation.logicalIdentity === 'first'
      ).map((relation) => relation.stage),
      ['discovered'],
    );
    assertEquals(
      relations.filter((relation) =>
        relation.resourceKind === 'skill' &&
        relation.logicalIdentity === 'second'
      ).map((relation) => relation.stage),
      ['discovered'],
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 preserves the exact external tool contract on every request', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i42-tool-replacement-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  const presentedTool = {
    name: 'replaceable',
    description: 'The replacement contract actually presented to the model.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  };
  const modelRequests: ModelRequest[] = [];
  let modelStep = 0;
  const model: Model = {
    generate(request): ModelResult {
      modelRequests.push(structuredClone(request));
      modelStep += 1;
      return modelStep === 1
        ? {
          kind: 'tool_calls',
          calls: [{
            callId: 'replacement-call',
            name: 'replaceable',
            arguments: { query: 'exact contract' },
          }],
        }
        : { kind: 'final', text: 'replacement complete' };
    },
  };
  const tool = {
    ...presentedTool,
    execute: () => 'replacement result',
  };
  const context: WorkerContextSnapshot = {
    schemaVersion: 1,
    workspaceRoot,
    skillCatalog: { skills: [] },
    instructionComponents: [],
    toolDefinitions: [presentedTool],
    runtimeFacts: { cwd: workspaceRoot },
  };
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () =>
        new SkillCanonicalCapsule(
          context,
          model,
          new Registry([tool]),
          2,
          ['tool:replaceable'],
        ),
    });
    const outcome = await host.submit('use the replacement tool');
    assert(outcome.ok, outcome.error);
    assertEquals(modelRequests.length, 2);
    assertEquals(modelRequests.map((request) => request.tools), [
      [presentedTool],
      [presentedTool],
    ]);
    const execution = store.listExecutions()[0];
    assert(execution !== undefined);
    let requestOutput = '';
    assertEquals(
      await failureDiagnosticMain(
        [
          'executions',
          'request',
          '--id',
          execution.executionId,
          '--ordinal',
          '2',
        ],
        {
          workspaceRoot,
          stateRoot,
          writeStdout: (text) => {
            requestOutput += text;
          },
        },
      ),
      0,
    );
    const payload = JSON.parse(requestOutput) as {
      readonly request: ContextModelRequestRecord;
    };
    assertEquals(payload.request.request?.tools, [presentedTool]);
    const relations = store.listExecutionContext(execution.executionId).relations;
    assertEquals(
      relations.filter((relation) =>
        relation.callId === 'replacement-call' &&
        relation.stage === 'observed' &&
        relation.resourceKind === 'tool_result'
      ).length,
      1,
    );
    assertEquals(
      relations.filter((relation) =>
        relation.callId === 'replacement-call' &&
        relation.stage === 'projected' &&
        relation.resourceKind === 'tool_result'
      ).length,
      1,
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 keeps one observed skill occurrence across repeated projections', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-repeated-skill-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  let step = 0;
  const model: Model = {
    generate: () => {
      step += 1;
      return step === 1
        ? {
          kind: 'tool_calls',
          calls: [{
            callId: 'repeated-skill-call',
            name: 'skill',
            arguments: { name: 'second' },
          }],
        }
        : step === 2
        ? {
          kind: 'tool_calls',
          calls: [{
            callId: 'repeated-generic-call',
            name: 'echo',
            arguments: { value: 'next' },
          }],
        }
        : { kind: 'final', text: 'repeated skill complete' };
    },
  };
  const skillTool = {
    name: 'skill',
    description: 'load a skill',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    execute: () => 'shared repeated skill body',
  };
  const echoTool = {
    name: 'echo',
    description: 'echo a value',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    execute: () => 'generic repeated result',
  };
  const context: WorkerContextSnapshot = {
    schemaVersion: 1,
    workspaceRoot,
    skillCatalog: {
      skills: [{
        name: 'first',
        description: 'first skill',
        sourceDirectory: `${workspaceRoot}/.agents/skills/first`,
        body: 'shared repeated skill body',
        toolResult: 'shared repeated skill body',
      }, {
        name: 'second',
        description: 'second skill',
        sourceDirectory: `${workspaceRoot}/.agents/skills/second`,
        body: 'shared repeated skill body',
        toolResult: 'shared repeated skill body',
      }],
    },
    instructionComponents: [],
    toolDefinitions: [
      {
        name: 'skill',
        description: 'load a skill',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      {
        name: 'echo',
        description: 'echo a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    ],
    runtimeFacts: { cwd: workspaceRoot },
  };
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () =>
        new SkillCanonicalCapsule(
          context,
          model,
          new Registry([skillTool, echoTool]),
          3,
          ['tool:skill', 'tool:echo'],
        ),
    });
    const outcome = await host.submit('repeat the selected skill context');
    assert(outcome.ok, outcome.error);
    const execution = store.listExecutions()[0];
    assert(execution !== undefined);
    assertEquals(execution.lifecycle, 'settled');
    assertEquals(execution.adoption, 'canonical');
    assertEquals(execution.contextCapture, 'complete');
    const relations = store.listExecutionContext(execution.executionId).relations;
    const skillObserved = relations.filter((relation) =>
      relation.callId === 'repeated-skill-call' &&
      relation.stage === 'observed' &&
      relation.resourceKind === 'tool_result'
    );
    const skillLoaded = relations.filter((relation) =>
      relation.callId === 'repeated-skill-call' &&
      relation.stage === 'loaded' &&
      relation.resourceKind === 'skill'
    );
    const skillProjected = relations.filter((relation) =>
      relation.callId === 'repeated-skill-call' &&
      relation.stage === 'projected' &&
      relation.resourceKind === 'skill'
    );
    const genericObserved = relations.filter((relation) =>
      relation.callId === 'repeated-generic-call' &&
      relation.stage === 'observed' &&
      relation.resourceKind === 'tool_result'
    );
    const genericProjected = relations.filter((relation) =>
      relation.callId === 'repeated-generic-call' &&
      relation.stage === 'projected' &&
      relation.resourceKind === 'tool_result'
    );
    assertEquals(skillObserved.length, 1);
    assertEquals(skillLoaded.length, 1);
    assertEquals(skillObserved[0]?.requestOrdinal, 1);
    assertEquals(skillLoaded[0]?.requestOrdinal, 1);
    assertEquals(skillProjected.length, 2);
    assertEquals(skillProjected.map((relation) => relation.requestOrdinal), [
      2,
      3,
    ]);
    assertEquals(genericObserved.length, 1);
    assertEquals(genericProjected.length, 1);
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 captures maximum model context and exposes diagnostic readback', async () => {
  const root = await Deno.makeTempDir({
    dir: `${Deno.cwd()}/tests/v0`,
    prefix: '.henji-i42-context-size-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  const task = 'capture the maximum context';
  const initialMessageText = 'm'.repeat(
    Math.floor((MAX_SERIALIZED_MODEL_MESSAGES_BYTES - 1000) / 6),
  );
  const initialTranscript: readonly Message[] = [
    { role: 'user', content: { kind: 'text', text: initialMessageText } },
    { role: 'assistant', content: { kind: 'text', text: initialMessageText } },
    { role: 'user', content: { kind: 'text', text: initialMessageText } },
    { role: 'assistant', content: { kind: 'text', text: initialMessageText } },
    { role: 'user', content: { kind: 'text', text: initialMessageText } },
    { role: 'assistant', content: { kind: 'text', text: initialMessageText } },
  ];
  const presentedTool = {
    name: 'large-contract',
    description: 'd'.repeat(
      MAX_COMPLETE_MODEL_REQUEST_BYTES - MAX_SERIALIZED_MODEL_MESSAGES_BYTES -
        512,
    ),
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  };
  const context: WorkerContextSnapshot = {
    schemaVersion: 1,
    workspaceRoot,
    skillCatalog: { skills: [] },
    instructionComponents: [],
    toolDefinitions: [presentedTool],
    runtimeFacts: { cwd: workspaceRoot },
  };
  const model: Model = {
    generate: () => ({ kind: 'final', text: 'large context captured' }),
  };
  const startedAt = performance.now();
  const capturedRssBefore = Deno.memoryUsage().rss;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      // The size probe deliberately exercises the no-session lock/reconcile path so the
      // committed transcript is not constrained by the Session display budget.
      durableCanonicalHistory: false,
      capsuleFactory: () =>
        new SkillCanonicalCapsule(
          context,
          model,
          new Registry([{
            ...presentedTool,
            execute: () => 'not called',
          }]),
          1,
          ['tool:large-contract'],
          initialTranscript,
          4,
        ),
    });
    const capturedOutcome = await host.submit(task);
    assert(capturedOutcome.ok, capturedOutcome.error);
    const execution = store.listExecutions()[0];
    assert(execution !== undefined);
    const contextRecord = store.listExecutionContext(execution.executionId);
    const request = contextRecord.requests[0];
    assert(request !== undefined);
    assert(request.request !== undefined);
    const messageBytes = jsonByteLength({
      transcript: request.request.transcript,
    });
    const requestBytes = jsonByteLength(request.request);
    console.info(JSON.stringify({ messageBytes, requestBytes }));
    assert(messageBytes <= MAX_SERIALIZED_MODEL_MESSAGES_BYTES);
    assert(messageBytes >= MAX_SERIALIZED_MODEL_MESSAGES_BYTES - 1024);
    assert(requestBytes <= MAX_COMPLETE_MODEL_REQUEST_BYTES);
    assert(requestBytes >= MAX_COMPLETE_MODEL_REQUEST_BYTES - 1024);
    const messageItem = request.items.find((item) => item.kind === 'message');
    assert(messageItem !== undefined);
    assertEquals(
      messageItem.content.byteLength,
      jsonByteLength(request.request.transcript[0]),
    );
    let contextOutput = '';
    assertEquals(
      await failureDiagnosticMain(
        ['executions', 'context', '--id', execution.executionId],
        {
          workspaceRoot,
          stateRoot,
          writeStdout: (text) => {
            contextOutput += text;
          },
        },
      ),
      0,
    );
    const contextPayload = JSON.parse(contextOutput) as {
      readonly capture: string;
      readonly requests: readonly ContextModelRequestRecord[];
    };
    assertEquals(contextPayload.capture, 'complete');
    assertEquals(contextPayload.requests.length, 1);
    assertEquals(contextPayload.requests[0]?.items[0]?.kind, 'message');
    let requestOutput = '';
    assertEquals(
      await failureDiagnosticMain(
        [
          'executions',
          'request',
          '--id',
          execution.executionId,
          '--ordinal',
          '1',
        ],
        {
          workspaceRoot,
          stateRoot,
          writeStdout: (text) => {
            requestOutput += text;
          },
        },
      ),
      0,
    );
    const requestPayload = JSON.parse(requestOutput) as {
      readonly request: ContextModelRequestRecord;
    };
    assertEquals(requestPayload.request.request?.tools, [presentedTool]);
    assertEquals(requestPayload.request.request?.transcript.at(-1), {
      role: 'user',
      content: { kind: 'text', text: task },
    });
  } finally {
    const capturedElapsedMs = performance.now() - startedAt;
    const capturedRssAfter = Deno.memoryUsage().rss;
    // Keep the resource observation visible without turning a VM-local measurement into a
    // product threshold. The provider-free control below is intentionally non-capturing.
    console.info(JSON.stringify({
      increment: 42,
      capturedElapsedMs,
      capturedRssDelta: capturedRssAfter - capturedRssBefore,
    }));
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
  const controlStartedAt = performance.now();
  const controlRssBefore = Deno.memoryUsage().rss;
  const controlOutcome = await runAgentTurn(
    task,
    initialTranscript,
    model,
    new Registry([{
      ...presentedTool,
      execute: () => 'not called',
    }]),
  );
  const controlElapsedMs = performance.now() - controlStartedAt;
  const controlRssAfter = Deno.memoryUsage().rss;
  assert(controlOutcome.ok, controlOutcome.error);
  console.info(JSON.stringify({
    increment: 42,
    controlElapsedMs,
    controlRssDelta: controlRssAfter - controlRssBefore,
    capture: 'none',
  }));
});

Deno.test('Increment 42 reads active journal context as read-only partial diagnostics', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-active-context-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000057';
  const taskId = '10000000-0000-4000-8000-000000000057';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const countsBefore = (() => {
      const db = new DatabaseSync(`${paths.root}/history.sqlite3`);
      try {
        return {
          modelRequests: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM model_requests WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
          contextRelations: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM execution_context_relations WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
        };
      } finally {
        db.close();
      }
    })();
    let output = '';
    assertEquals(
      await failureDiagnosticMain(
        ['executions', 'context', '--id', executionId],
        {
          workspaceRoot,
          stateRoot,
          writeStdout: (text) => {
            output += text;
          },
        },
      ),
      0,
    );
    const payload = JSON.parse(output) as {
      readonly execution: StoredExecutionRow;
      readonly capture: string;
      readonly requests: readonly ContextModelRequestRecord[];
      readonly relations: readonly { readonly stage: string }[];
    };
    assertEquals(payload.execution.lifecycle, 'active');
    assertEquals(payload.execution.contextCapture, 'partial');
    assertEquals(payload.capture, 'partial');
    assertEquals(payload.requests.length, 1);
    assert(payload.requests[0]?.request !== undefined);
    assert(payload.relations.some((relation) => relation.stage === 'projected'));
    assertEquals(store.readExecution(executionId).lifecycle, 'active');
    assertEquals(store.readExecution(executionId).contextCapture, 'none');
    const countsAfter = (() => {
      const db = new DatabaseSync(`${paths.root}/history.sqlite3`);
      try {
        return {
          modelRequests: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM model_requests WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
          contextRelations: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM execution_context_relations WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
        };
      } finally {
        db.close();
      }
    })();
    assertEquals(countsAfter, countsBefore);
    store.reconcileExecution({ executionId, settlement: 'unknown' });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 permits a concurrent active journal append during diagnostics', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-active-concurrent-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000058';
  const taskId = '10000000-0000-4000-8000-000000000058';
  const historyModuleUrl = new URL(
    '../../v0/agent/history/sqlite_history_store.ts',
    import.meta.url,
  ).href;
  const workerSource = `
    import { SqliteHistoryStore } from ${JSON.stringify(historyModuleUrl)};
    globalThis.onmessage = async (message) => {
      try {
        const data = message.data;
        const history = new SqliteHistoryStore(data.stateRoot, data.workspaceRoot);
        await history.initialize();
        history.appendExecutionEvent({
          executionId: data.executionId,
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'runtime_event',
          workerSequence: 2,
          payload: {
            kind: 'runtime_event',
            correlation: data.correlation,
            sequence: 2,
            event: {
              kind: 'agent_event',
              event: { kind: 'assistant_progress', turn: 1, text: 'concurrent append' },
            },
          },
        });
        globalThis.postMessage({ kind: 'result', ok: true });
      } catch (error) {
        globalThis.postMessage({
          kind: 'result',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    globalThis.postMessage({ kind: 'ready' });
  `;
  const workerUrl = URL.createObjectURL(
    new Blob([workerSource], { type: 'application/typescript' }),
  );
  const worker = new Worker(workerUrl, { type: 'module' });
  const workerWaiters = new Map<
    'ready' | 'result',
    ((message: Record<string, unknown>) => void)[]
  >();
  worker.onmessage = (event) => {
    const message = event.data as Record<string, unknown>;
    const waiters = workerWaiters.get(message.kind as 'ready' | 'result');
    waiters?.shift()?.(message);
  };
  const waitForWorker = (kind: 'ready' | 'result'): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const waiters = workerWaiters.get(kind) ?? [];
      waiters.push(resolve);
      workerWaiters.set(kind, waiters);
    });
  const readyPromise = waitForWorker('ready');
  try {
    await store.initialize();
    await store.beginExecution(makeInput(workspaceRoot, executionId, taskId));
    appendContextRequest(store, executionId, await largeActiveContextRequest());
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const contextCounts = () => {
      const db = new DatabaseSync(`${paths.root}/history.sqlite3`);
      try {
        return {
          modelRequests: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM model_requests WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
          relations: Number(
            (db.prepare(
              'SELECT count(*) AS count FROM execution_context_relations WHERE execution_id = ?',
            ).get(executionId) as { readonly count: number }).count,
          ),
        };
      } finally {
        db.close();
      }
    };
    const countsBefore = contextCounts();
    const ready = await readyPromise;
    assertEquals(ready.kind, 'ready');
    worker.postMessage({
      stateRoot,
      workspaceRoot,
      executionId,
      correlation: eventCorrelation,
    });
    const context = store.listExecutionContext(executionId);
    const append = await waitForWorker('result');
    assert(append.ok, String(append.error ?? 'concurrent append failed'));
    assertEquals(context.requests.length, 1);
    assertEquals(store.readExecution(executionId).lifecycle, 'active');
    assertEquals(store.readExecution(executionId).contextCapture, 'none');
    assertEquals(contextCounts(), countsBefore);
    assert(
      store.listExecutionEvents(executionId).some((event) =>
        event.kind === 'runtime_event' && event.workerSequence === 2
      ),
      'concurrent worker append was not durably journaled',
    );
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    try {
      store.reconcileExecution({ executionId, settlement: 'unknown' });
    } catch {
      // Cleanup is best effort when setup failed before execution admission.
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 missing final manifest leaves the live row unsettled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-manifest-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000050';
  const taskId = '10000000-0000-4000-8000-000000000050';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    let rejected = false;
    try {
      store.settleNonCanonicalExecution({ ...input, outcome: settled });
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(rejected, 'missing final context manifest was accepted');
    assertEquals(store.readExecution(executionId).lifecycle, 'active');
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([request]),
      outcome: settled,
    });
    assertEquals(store.readExecution(executionId).contextCapture, 'complete');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 settles a Worker missing-manifest proposal as failed without reconciliation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-host-manifest-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  let host: WorkerHostSession | undefined;
  try {
    await store.initialize();
    const handle = await store.allocateWorker('default', definition);
    const capsule = new MissingManifestCapsule();
    host = await WorkerHostSession.open({
      handle,
      workspaceRoot,
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      historyPersistence: store,
      durableCanonicalHistory: true,
      capsuleFactory: () => capsule,
    });
    const outcome = await host.submit('missing final manifest');
    assert(!outcome.ok);
    assertEquals(outcome.stopReason, 'contract_failure');
    assert(outcome.diagnostic !== undefined);
    assertEquals(outcome.diagnostic.providerRequestCount, 3);
    assertEquals(capsule.turnDispatches, 1);
    const row = store.listExecutions()[0];
    assert(row !== undefined);
    assertEquals({
      lifecycle: row.lifecycle,
      outcome: row.outcome,
      adoption: row.adoption,
      contextCapture: row.contextCapture,
    }, {
      lifecycle: 'settled',
      outcome: 'failed',
      adoption: 'non_canonical',
      contextCapture: 'failed',
    });
    assertEquals(row.evidenceCapture, 'yes');
    assertEquals((await store.providerEvidence.list()).length, 1);
    assertEquals(
      store.listExecutions().filter((entry) => entry.lifecycle === 'active')
        .length,
      0,
    );
  } finally {
    await host?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 stores immutable basis, ordered request items, and projected relations in schema v3', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-context-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000042';
  const taskId = '10000000-0000-4000-8000-000000000042';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([request]),
      outcome: settled,
    });
    const context = store.listExecutionContext(executionId);
    assert(context.snapshot !== undefined);
    assertEquals(
      context.snapshot.workspaceInstruction?.text,
      'workspace instructions',
    );
    assertEquals(context.requests.length, 1);
    assertEquals(context.requests[0].items.map((item) => item.kind), [
      'system',
      'message',
      'tool_contract',
    ]);
    assertEquals(store.readExecution(executionId).contextCapture, 'complete');
    assert(
      context.relations.some((relation) =>
        relation.stage === 'discovered' && relation.resourceKind === 'skill'
      ),
    );
    assert(
      context.relations.some((relation) =>
        relation.stage === 'resolved' &&
        relation.resourceKind === 'tool_contract'
      ),
    );
    assert(
      context.relations.filter((relation) => relation.stage === 'projected')
        .length >= 3,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 rejects a tampered context blob without mutable-source fallback', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-context-tamper-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000051';
  const taskId = '10000000-0000-4000-8000-000000000051';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([request]),
      outcome: settled,
    });
    const path = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history.sqlite3`;
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare(
        'SELECT digest, raw_bytes FROM context_blobs ORDER BY digest LIMIT 1',
      ).get() as
        | { readonly digest: string; readonly raw_bytes: Uint8Array }
        | undefined;
      assert(row !== undefined);
      const tampered = row.raw_bytes.slice();
      tampered[0] = tampered[0] ^ 1;
      db.prepare('UPDATE context_blobs SET raw_bytes = ? WHERE digest = ?').run(
        tampered,
        row.digest,
      );
    } finally {
      db.close();
    }
    let invalid = false;
    try {
      store.listExecutionContext(executionId);
    } catch (error) {
      invalid = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      invalid,
      'tampered context bytes were accepted or reconstructed from mutable source',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 refuses malformed context events and schema-v2 evidence without partial settlement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-invalid-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000043';
  const taskId = '10000000-0000-4000-8000-000000000043';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    let rejected = false;
    try {
      appendContextRequest(
        store,
        executionId,
        {
          ...request,
          items: [{ ...request.items[0], unknown: true }],
        } as never,
      );
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(rejected, 'malformed context event was accepted');
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([]),
      outcome: settled,
    });
    const secondExecutionId = '20000000-0000-4000-8000-000000000044';
    const secondTaskId = '10000000-0000-4000-8000-000000000044';
    const second = makeInput(workspaceRoot, secondExecutionId, secondTaskId);
    await store.beginExecution(second);
    const legacyEvidence = {
      schemaVersion: 4 as const,
      evidenceId: '40000000-0000-4000-8000-000000000042',
      sessionId,
      build: second.build,
      definition,
      turnNumber: 1,
      createdAt: second.createdAt,
      requests: [],
      runtimeEvents: [],
      capture: 'complete' as const,
      normalizedOutcome: 'completed' as const,
      outcome: 'final' as const,
    };
    rejected = false;
    try {
      store.settleNonCanonicalExecution({
        ...second,
        outcome: settled,
        evidence: legacyEvidence,
      });
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(rejected, 'schema-v2 evidence was accepted by schema-v3 SQLite');
    assertEquals(store.readExecution(secondExecutionId).lifecycle, 'active');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 rejects complete evidence with logical requests but no provider rows', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-i42-no-provider-rows-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000046';
  const taskId = '10000000-0000-4000-8000-000000000046';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    const evidence = {
      schemaVersion: 5 as const,
      evidenceId: '40000000-0000-4000-8000-000000000046',
      sessionId,
      build: input.build,
      definition,
      turnNumber: 1,
      createdAt: input.createdAt,
      requests: [],
      runtimeEvents: [],
      capture: 'complete' as const,
      normalizedOutcome: 'failed' as const,
      outcome: 'contract_failure' as const,
    };
    let rejected = false;
    try {
      store.settleNonCanonicalExecution({
        ...input,
        contextManifest: await createExecutionContextManifest([request]),
        outcome: settled,
        evidence,
      });
    } catch (error) {
      rejected = error instanceof HistoryStoreError &&
        error.code === 'history_invalid';
    }
    assert(
      rejected,
      'complete evidence omitted provider rows for a logical request',
    );
    assertEquals(store.readExecution(executionId).lifecycle, 'active');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 only marks a skill loaded for its accepted skill call', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-skill-relation-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000047';
  const taskId = '10000000-0000-4000-8000-000000000047';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const inspect = input.contextSnapshot!.skillCatalog.skills.find((skill) =>
      skill.name === 'inspect'
    )!;
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 2,
      payload: {
        kind: 'effect_observation',
        correlation: eventCorrelation,
        sequence: 2,
        effect: {
          kind: 'tool_call',
          turn: 1,
          call: {
            callId: 'skill-call',
            name: 'skill',
            arguments: { name: 'unused' },
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 3,
      payload: {
        kind: 'effect_observation',
        correlation: eventCorrelation,
        sequence: 3,
        effect: {
          kind: 'tool_result',
          turn: 1,
          result: {
            kind: 'tool_result',
            callId: 'skill-call',
            name: 'skill',
            text: inspect.toolResult,
            outcome: 'success',
          },
        },
      },
    });
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([request], [{
        stage: 'observed',
        resourceKind: 'tool_result',
        contentDigest: (await textBlob(inspect.toolResult)).digest,
        callId: 'skill-call',
        lane: 'parent',
      }]),
      outcome: settled,
    });
    assert(
      !store.listExecutionContext(executionId).relations.some((relation) =>
        relation.stage === 'loaded'
      ),
      'skill result from a different accepted argument must not be loaded',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 materializes planner provider tool and loaded-skill relations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-planner-skill-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000048';
  const taskId = '10000000-0000-4000-8000-000000000048';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const inspect = input.contextSnapshot!.skillCatalog.skills.find((skill) =>
      skill.name === 'inspect'
    )!;
    const request = await contextRequest();
    appendContextRequest(store, executionId, request);
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 2,
      payload: {
        kind: 'provider_observation',
        correlation: eventCorrelation,
        sequence: 2,
        observation: {
          kind: 'runtime_event',
          event: {
            kind: 'tool_call',
            call: {
              callId: 'planner-skill-call',
              name: 'skill',
              arguments: { name: 'inspect' },
            },
            modelStep: 1,
            lane: 'planner',
            requestOrdinal: 1,
          },
        },
      },
    });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 3,
      payload: {
        kind: 'provider_observation',
        correlation: eventCorrelation,
        sequence: 3,
        observation: {
          kind: 'runtime_event',
          event: {
            kind: 'tool_result',
            result: {
              kind: 'tool_result',
              callId: 'planner-skill-call',
              name: 'skill',
              text: inspect.toolResult,
              outcome: 'success',
            },
            modelStep: 1,
            lane: 'planner',
            requestOrdinal: 1,
          },
        },
      },
    });
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest: await createExecutionContextManifest([request], [{
        stage: 'observed',
        resourceKind: 'tool_result',
        contentDigest: (await textBlob(inspect.toolResult)).digest,
        callId: 'planner-skill-call',
        lane: 'planner',
        modelStep: 1,
      }, {
        stage: 'loaded',
        resourceKind: 'skill',
        logicalIdentity: 'skill:inspect',
        sourceLocator: inspect.sourceDirectory,
        contentDigest: (await textBlob(inspect.toolResult)).digest,
        callId: 'planner-skill-call',
        lane: 'planner',
        modelStep: 1,
      }]),
      outcome: settled,
    });
    const loaded = store.listExecutionContext(executionId).relations.find((
      relation,
    ) => relation.stage === 'loaded' && relation.resourceKind === 'skill');
    assert(loaded !== undefined);
    assertEquals(loaded?.logicalIdentity, 'skill:inspect');
    assertEquals(loaded?.lane, 'planner');
    assertEquals(loaded?.callId, 'planner-skill-call');
    const relations = store.listExecutionContext(executionId).relations;
    assertEquals(
      relations.filter((relation) =>
        relation.stage === 'observed' &&
        relation.callId === 'planner-skill-call'
      ).length,
      1,
    );
    assertEquals(
      relations.filter((relation) =>
        relation.stage === 'loaded' && relation.callId === 'planner-skill-call'
      ).length,
      1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 keys provider tool attribution by lane and call identity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i42-lane-call-key-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const executionId = '20000000-0000-4000-8000-000000000053';
  const taskId = '10000000-0000-4000-8000-000000000053';
  try {
    await store.initialize();
    const input = makeInput(workspaceRoot, executionId, taskId);
    await store.beginExecution(input);
    const inspect = input.contextSnapshot!.skillCatalog.skills.find((skill) =>
      skill.name === 'inspect'
    )!;
    const unused = input.contextSnapshot!.skillCatalog.skills.find((skill) =>
      skill.name === 'unused'
    )!;
    const parentRequest = await contextRequest();
    const plannerRequest: ContextModelRequestRecord = {
      ...parentRequest,
      requestOrdinal: 2,
      lane: 'planner',
      modelStep: 2,
    };
    appendContextRequest(store, executionId, parentRequest, 1);
    appendContextRequest(store, executionId, plannerRequest, 2);
    const providerEvents = [
      {
        kind: 'tool_call' as const,
        call: {
          callId: 'shared-lane-call',
          name: 'skill',
          arguments: { name: 'inspect' },
        },
        modelStep: 1,
        lane: 'parent' as const,
        requestOrdinal: 1,
      },
      {
        kind: 'tool_result' as const,
        result: {
          kind: 'tool_result' as const,
          callId: 'shared-lane-call',
          name: 'skill',
          text: inspect.toolResult,
          outcome: 'success' as const,
        },
        modelStep: 1,
        lane: 'parent' as const,
        requestOrdinal: 1,
      },
      {
        kind: 'tool_call' as const,
        call: {
          callId: 'shared-lane-call',
          name: 'skill',
          arguments: { name: 'unused' },
        },
        modelStep: 2,
        lane: 'planner' as const,
        requestOrdinal: 2,
      },
      {
        kind: 'tool_result' as const,
        result: {
          kind: 'tool_result' as const,
          callId: 'shared-lane-call',
          name: 'skill',
          text: unused.toolResult,
          outcome: 'success' as const,
        },
        modelStep: 2,
        lane: 'planner' as const,
        requestOrdinal: 2,
      },
    ];
    for (const [sequence, event] of providerEvents.entries()) {
      const workerSequence = sequence + 3;
      store.appendExecutionEvent({
        executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence,
        payload: {
          kind: 'provider_observation',
          correlation: eventCorrelation,
          sequence: workerSequence,
          observation: { kind: 'runtime_event', event },
        },
      });
    }
    // Effect observations do not carry a lane in the effect contract. They are parent facts by
    // default and must resolve the parent key rather than the planner's same call ID.
    for (
      const [sequence, effect] of [[7, {
        kind: 'tool_call' as const,
        turn: 1,
        call: {
          callId: 'shared-lane-call',
          name: 'skill',
          arguments: { name: 'inspect' },
        },
      }], [8, {
        kind: 'tool_result' as const,
        turn: 1,
        result: {
          kind: 'tool_result' as const,
          callId: 'shared-lane-call',
          name: 'skill',
          text: inspect.toolResult,
          outcome: 'success' as const,
        },
      }]] as const
    ) {
      store.appendExecutionEvent({
        executionId,
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
    }
    const inspectDigest = (await textBlob(inspect.toolResult)).digest;
    const unusedDigest = (await textBlob(unused.toolResult)).digest;
    const contextManifest = await createExecutionContextManifest([
      parentRequest,
      plannerRequest,
    ], [
      {
        stage: 'observed',
        resourceKind: 'tool_result',
        contentDigest: inspectDigest,
        callId: 'shared-lane-call',
        lane: 'parent',
        modelStep: 1,
        requestOrdinal: 1,
      },
      {
        stage: 'loaded',
        resourceKind: 'skill',
        logicalIdentity: 'skill:inspect',
        sourceLocator: inspect.sourceDirectory,
        contentDigest: inspectDigest,
        callId: 'shared-lane-call',
        lane: 'parent',
        modelStep: 1,
        requestOrdinal: 1,
      },
      {
        stage: 'observed',
        resourceKind: 'tool_result',
        contentDigest: unusedDigest,
        callId: 'shared-lane-call',
        lane: 'planner',
        modelStep: 2,
        requestOrdinal: 2,
      },
      {
        stage: 'loaded',
        resourceKind: 'skill',
        logicalIdentity: 'skill:unused',
        sourceLocator: unused.sourceDirectory,
        contentDigest: unusedDigest,
        callId: 'shared-lane-call',
        lane: 'planner',
        modelStep: 2,
        requestOrdinal: 2,
      },
    ]);
    store.settleNonCanonicalExecution({
      ...input,
      contextManifest,
      outcome: settled,
    });
    const relations = store.listExecutionContext(executionId).relations.filter((
      relation,
    ) => relation.callId === 'shared-lane-call');
    assertEquals(
      relations.filter((relation) =>
        relation.stage === 'observed' && relation.resourceKind === 'tool_result'
      ).length,
      2,
    );
    assertEquals(
      relations.filter((relation) => relation.stage === 'loaded').length,
      2,
    );
    assertEquals(
      relations
        .filter((relation) => relation.stage === 'observed')
        .map((
          relation,
        ) => [relation.lane, relation.modelStep, relation.requestOrdinal]),
      [['parent', 1, 1], ['planner', 2, 2]],
    );
    assertEquals(
      relations
        .filter((relation) => relation.stage === 'loaded')
        .map((
          relation,
        ) => [
          relation.lane,
          relation.logicalIdentity,
          relation.requestOrdinal,
        ]),
      [['parent', 'skill:inspect', 1], ['planner', 'skill:unused', 2]],
    );
    assertEquals(store.readExecution(executionId).contextCapture, 'complete');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 42 rejects incomplete or conflicting final tool relations', async () => {
  const relationCases: readonly {
    readonly name: string;
    readonly mutate: (
      manifest: Awaited<ReturnType<typeof createExecutionContextManifest>>,
    ) => Promise<Awaited<ReturnType<typeof createExecutionContextManifest>>>;
  }[] = [
    {
      name: 'missing',
      mutate: async () => await createExecutionContextManifest([await contextRequest()]),
    },
    {
      name: 'duplicate',
      mutate: async (manifest) => {
        const externalRelations = [
          ...manifest.externalRelations,
          manifest.externalRelations[1],
        ];
        const body = {
          schemaVersion: manifest.schemaVersion,
          requestCount: manifest.requestCount,
          requests: manifest.requests,
          relations: [
            ...manifest.relations,
            manifest.externalRelations[1],
          ],
          externalRelations,
        } as const;
        return { ...body, digest: await contextManifestDigest(body) };
      },
    },
    {
      name: 'wrong-stage',
      mutate: async (manifest) => {
        const externalRelations = manifest.externalRelations.map((
          relation,
          index,
        ) => index === 1 ? { ...relation, stage: 'observed' as const } : relation);
        const body = {
          schemaVersion: manifest.schemaVersion,
          requestCount: manifest.requestCount,
          requests: manifest.requests,
          relations: externalRelations,
          externalRelations,
        } as const;
        return { ...body, digest: await contextManifestDigest(body) };
      },
    },
    {
      name: 'wrong-digest',
      mutate: async (manifest) => {
        const externalRelations = manifest.externalRelations.map((
          relation,
          index,
        ) => index === 1 ? { ...relation, contentDigest: `sha256:${'b'.repeat(64)}` } : relation);
        const body = {
          schemaVersion: manifest.schemaVersion,
          requestCount: manifest.requestCount,
          requests: manifest.requests,
          relations: externalRelations,
          externalRelations,
        } as const;
        return { ...body, digest: await contextManifestDigest(body) };
      },
    },
    {
      name: 'wrong-ordinal',
      mutate: async (manifest) => {
        const externalRelations = manifest.externalRelations.map((
          relation,
          index,
        ) => index === 0 ? { ...relation, requestOrdinal: 2 } : relation);
        const body = {
          schemaVersion: manifest.schemaVersion,
          requestCount: manifest.requestCount,
          requests: manifest.requests,
          relations: [
            ...manifest.relations.slice(0, -manifest.externalRelations.length),
            ...externalRelations,
          ],
          externalRelations,
        } as const;
        return { ...body, digest: await contextManifestDigest(body) };
      },
    },
  ];
  for (const [index, relationCase] of relationCases.entries()) {
    const root = await Deno.makeTempDir({
      prefix: `henji-i42-relation-${relationCase.name}-`,
    });
    const workspaceRoot = `${root}/workspace`;
    const stateRoot = `${root}/state`;
    await Deno.mkdir(workspaceRoot);
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    const executionId = `20000000-0000-4000-8000-0000000000${60 + index}`;
    const taskId = `10000000-0000-4000-8000-0000000000${60 + index}`;
    try {
      await store.initialize();
      const input = makeInput(workspaceRoot, executionId, taskId);
      await store.beginExecution(input);
      const request = await contextRequest();
      appendContextRequest(store, executionId, request);
      const inspect = input.contextSnapshot!.skillCatalog.skills.find((skill) =>
        skill.name === 'inspect'
      )!;
      const call = {
        kind: 'tool_call' as const,
        call: {
          callId: `manifest-skill-${index}`,
          name: 'skill',
          arguments: { name: 'inspect' },
        },
        modelStep: 1,
        lane: 'parent' as const,
        requestOrdinal: 1,
      };
      const result = {
        kind: 'tool_result' as const,
        result: {
          kind: 'tool_result' as const,
          callId: call.call.callId,
          name: 'skill',
          text: inspect.toolResult,
          outcome: 'success' as const,
        },
        modelStep: 1,
        lane: 'parent' as const,
        requestOrdinal: 1,
      };
      for (const [sequence, event] of [[2, call], [3, result]] as const) {
        store.appendExecutionEvent({
          executionId,
          direction: 'worker_to_host',
          source: 'worker',
          kind: 'runtime_event',
          workerSequence: sequence,
          payload: {
            kind: 'provider_observation',
            correlation: eventCorrelation,
            sequence,
            observation: { kind: 'runtime_event', event },
          },
        });
      }
      const observed = {
        stage: 'observed' as const,
        resourceKind: 'tool_result' as const,
        contentDigest: (await textBlob(inspect.toolResult)).digest,
        callId: call.call.callId,
        lane: 'parent' as const,
        modelStep: 1,
        requestOrdinal: 1,
      };
      const loaded = {
        stage: 'loaded' as const,
        resourceKind: 'skill' as const,
        logicalIdentity: 'skill:inspect',
        sourceLocator: inspect.sourceDirectory,
        contentDigest: (await textBlob(inspect.toolResult)).digest,
        callId: call.call.callId,
        lane: 'parent' as const,
        modelStep: 1,
        requestOrdinal: 1,
      };
      const validManifest = await createExecutionContextManifest([request], [
        observed,
        loaded,
      ]);
      const malformed = await relationCase.mutate(validManifest);
      let rejected = false;
      try {
        store.settleNonCanonicalExecution({
          ...input,
          contextManifest: malformed,
          outcome: settled,
        });
      } catch (error) {
        rejected = error instanceof HistoryStoreError &&
          error.code === 'history_invalid';
      }
      assert(
        rejected,
        `${relationCase.name} final relation manifest was accepted`,
      );
      assertEquals(store.readExecution(executionId).lifecycle, 'active');
      store.settleNonCanonicalExecution({
        ...input,
        contextManifest: validManifest,
        outcome: settled,
      });
      assertEquals(store.readExecution(executionId).contextCapture, 'complete');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 42 selects a duplicate-content skill by call argument and exact source digest', async () => {
  let proposal:
    | import('../../v0/agent/worker/worker_protocol.ts').WorkerCommitProposalMessage
    | undefined;
  let step = 0;
  const model: Model = {
    generate(): ModelResult {
      step += 1;
      return step === 1
        ? {
          kind: 'tool_calls',
          calls: [{
            callId: 'skill-duplicate-call',
            name: 'skill',
            arguments: { name: 'second' },
          }],
        }
        : { kind: 'final', text: 'done' };
    },
  };
  const skillTool = {
    name: 'skill',
    description: 'load a skill',
    inputSchema: { type: 'object' },
    execute: () => 'shared skill body',
  };
  const context: WorkerContextSnapshot = {
    ...snapshot('/tmp/i42-duplicate-skill'),
    skillCatalog: {
      skills: [{
        name: 'first',
        description: 'first',
        sourceDirectory: '/tmp/i42-duplicate-skill/first',
        body: 'shared skill body',
        toolResult: 'shared skill body',
      }, {
        name: 'second',
        description: 'second',
        sourceDirectory: '/tmp/i42-duplicate-skill/second',
        body: 'shared skill body',
        toolResult: 'shared skill body',
      }],
    },
  };
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, value) => {
      proposal = structuredClone(value);
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      throw new Error(
        `unexpected failure: ${outcome.error ?? outcome.stopReason}`,
      );
    },
  };
  const composition = {
    role: 'parent',
    model,
    registry: new Registry([skillTool]),
    maxSteps: 2,
    systemInstruction: 'system instructions',
    manifest: {
      role: 'parent',
      maxSteps: 2,
      profileId: 'provider-free-duplicate-skill',
      resources: ['tool:skill'],
    },
  } as unknown as WorkerAgentComposition;
  const generation = new WorkerGeneration(
    composition,
    sessionId,
    port,
    [],
    1,
    undefined,
    undefined,
    ROOT_DEFAULT_MODEL_SELECTION,
    () => {},
    async () => await Promise.resolve('unknown' as const),
    { skillNames: ['first', 'second'], context },
  );
  await generation.runTurn({
    session: sessionId,
    instanceCorrelation: 'instance-duplicate-skill',
    workerGeneration: 'generation-duplicate-skill',
    baseStateRevision: 1,
    command: 'turn-1',
  }, 'load second');
  assert(proposal?.contextManifest !== undefined);
  const loaded = proposal.contextManifest.relations.find((relation) => relation.stage === 'loaded');
  assertEquals(loaded?.logicalIdentity, 'skill:second');
  assertEquals(
    loaded?.contentDigest,
    (await textBlob('shared skill body')).digest,
  );
});

Deno.test('Increment 42 recall retains runtime and effect journal observations without replay', async () => {
  const events: StoredExecutionEvent[] = [
    {
      executionId: '20000000-0000-4000-8000-000000000045',
      ordinal: 1,
      observedAt: '2026-09-12T00:00:00.000Z',
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'runtime_event',
        correlation: eventCorrelation,
        sequence: 1,
        event: {
          kind: 'agent_event',
          event: {
            kind: 'user_message',
            turn: 1,
            message: { role: 'user', content: { kind: 'text', text: 'hello' } },
          },
        },
      },
    },
    {
      executionId: '20000000-0000-4000-8000-000000000045',
      ordinal: 2,
      observedAt: '2026-09-12T00:00:00.000Z',
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 2,
      payload: {
        kind: 'runtime_event',
        correlation: eventCorrelation,
        sequence: 2,
        event: {
          kind: 'agent_event',
          event: {
            kind: 'assistant_message',
            turn: 1,
            message: {
              role: 'assistant',
              content: { kind: 'text', text: 'answer' },
            },
          },
        },
      },
    },
    {
      executionId: '20000000-0000-4000-8000-000000000045',
      ordinal: 3,
      observedAt: '2026-09-12T00:00:00.000Z',
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 3,
      payload: {
        kind: 'effect_observation',
        correlation: eventCorrelation,
        sequence: 3,
        effect: {
          kind: 'tool_call',
          turn: 1,
          call: {
            kind: 'tool_call',
            callId: 'call-1',
            name: 'read',
            arguments: {},
          },
        },
      },
    },
    {
      executionId: '20000000-0000-4000-8000-000000000045',
      ordinal: 4,
      observedAt: '2026-09-12T00:00:00.000Z',
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'effect_observation',
      workerSequence: 4,
      payload: {
        kind: 'effect_observation',
        correlation: eventCorrelation,
        sequence: 4,
        effect: {
          kind: 'tool_result',
          turn: 1,
          result: {
            kind: 'tool_result',
            callId: 'call-1',
            name: 'read',
            text: 'done',
            outcome: 'success',
          },
        },
      },
    },
  ];
  const row = {
    executionId: '20000000-0000-4000-8000-000000000045',
    taskId: '10000000-0000-4000-8000-000000000045',
    task: 'recall',
    canonicalSessionId: sessionId,
    sessionCorrelation: sessionId,
    turn: 1,
    createdAt: '2026-09-12T00:00:00.000Z',
    settledAt: '2026-09-12T00:00:01.000Z',
    lifecycle: 'settled' as const,
    outcome: 'failed' as const,
    adoption: 'non_canonical' as const,
    baseRevision: 1,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition,
    acknowledgement: 'not_sent',
    generationAvailability: 'unknown',
    evidenceCapture: 'unknown',
    diagnosticCapture: 'unknown',
    artifactCapture: 'unknown',
    contextCapture: 'none' as const,
  } as StoredExecutionRow;
  const recalled = await resolveRecalledExecutionContext({
    sessionId,
    executionId: row.executionId,
    historyPersistence: {
      readExecution: () => row,
      listExecutionEvents: () => events,
      listExecutionEffects: () => [{
        executionId: row.executionId,
        callId: 'call-1',
        name: 'read',
        status: 'completed' as const,
      }],
    },
  });
  assertEquals(recalled.schemaVersion, 2);
  if (recalled.schemaVersion !== 2) return;
  assertEquals(recalled.journalObservations.map((item) => item.kind), [
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
  ]);
  assertEquals(
    recalled.journalObservations[3].kind === 'tool_result' &&
      recalled.journalObservations[3].result.text,
    'done',
  );
});

Deno.test('Increment 42 attributes the exact web-search call before credential and provider work', async () => {
  const evidence = new ProviderEvidenceRecorder(
    '40000000-0000-4000-8000-000000000043',
    1,
    '2026-09-12T00:00:00.000Z',
  );
  const observed: { callId: string; body: string; modelId?: string }[] = [];
  const backend = new OpenRouterSonarWebSearchBackend({
    credential: 'test-credential',
    fetcher: (_input, _init) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: 'verified answer',
                annotations: [{
                  type: 'url_citation',
                  url_citation: {
                    title: 'source',
                    url: 'https://example.test/source',
                  },
                }],
              },
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  const result = await backend.search('exact query', {
    callId: 'tool-call-42',
    modelStep: 2,
    modelExecution: {
      lane: 'parent',
      claimModelRequest: () => true,
      snapshot: () => ({ parent: 1, child: 0, aggregate: 1 }),
      persistDiagnostic: () => Promise.resolve(),
      observeAuxiliaryRequest: (observation) => {
        observed.push({
          callId: observation.callId,
          body: observation.body,
          modelId: observation.modelSelection?.modelId,
        });
        return 4;
      },
      providerEvidence: evidence,
    },
  });
  assertEquals(result.answer, 'verified answer');
  assertEquals(observed.length, 1);
  assertEquals(observed[0].callId, 'tool-call-42');
  assertEquals(observed[0].modelId, 'perplexity/sonar');
  assert(observed[0].body.includes('exact query'));
  assertEquals(
    evidence.snapshot().requests[0].request.contextRequestOrdinal,
    4,
  );
});

Deno.test('Increment 42 keeps the web-search logical request when credential resolution fails', async () => {
  const observed: string[] = [];
  const backend = new OpenRouterSonarWebSearchBackend({
    credentialSource: () => undefined,
    fetcher: () => {
      throw new Error('provider fetch must not start');
    },
  });
  let failed = false;
  try {
    await backend.search('credential failure query', {
      callId: 'credential-call-42',
      modelStep: 1,
      modelExecution: {
        lane: 'parent',
        claimModelRequest: () => true,
        snapshot: () => ({ parent: 1, child: 0, aggregate: 1 }),
        persistDiagnostic: () => Promise.resolve(),
        observeAuxiliaryRequest: async (observation) => {
          observed.push(observation.body);
          await Promise.resolve();
          return 1;
        },
      },
    });
  } catch {
    failed = true;
  }
  assert(failed);
  assertEquals(observed.length, 1);
  assert(observed[0].includes('credential failure query'));
});

Deno.test('Increment 42 keeps provider retries linked to one logical context request', () => {
  const recorder = new ProviderEvidenceRecorder(
    '40000000-0000-4000-8000-000000000044',
    1,
    '2026-09-12T00:00:00.000Z',
  );
  recorder.setContextRequestOrdinal(1);
  for (const status of [502, 200]) {
    recorder.startRequest({
      lane: 'parent',
      modelStep: 1,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      requestBody: '{}',
      requestMetadata: { provider: 'openrouter', responseMode: 'sse' },
    });
    recorder.recordResponse({ status, headers: {} });
  }
  recorder.finalize({
    outcome: {
      ok: true,
      task: 'retry',
      outcome: 'final',
      stopReason: 'final',
      finalText: 'done',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    },
  });
  const evidence = {
    ...recorder.snapshot(),
    schemaVersion: 5 as const,
    sessionId: sessionId,
    build: buildManifest(),
    definition,
    capture: 'complete' as const,
    normalizedOutcome: 'completed' as const,
    outcome: 'final' as const,
  };
  assertEquals(
    evidence.requests.map((item) => item.request.contextRequestOrdinal),
    [1, 1],
  );
  assert(
    validateProviderEvidence(evidence),
    'retry evidence must remain valid V5',
  );
});
