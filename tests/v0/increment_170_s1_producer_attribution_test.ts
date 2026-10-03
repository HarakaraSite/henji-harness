import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Model, ModelResult } from '../../v0/agent/core/contracts.ts';
import { createTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import type { AgentCapabilityDeclaration } from '../../v0/agent/definitions/agent_definition.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import {
  type ExecutionEventInput,
  type StoredExecutionEvent,
} from '../../v0/agent/history/history_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  type ProviderEvidenceRuntimeEvent,
} from '../../v0/agent/provider/provider_evidence.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { createDeclaredRegistry } from '../../v0/agent/tools/registries.ts';
import type { Tool } from '../../v0/agent/tools/tools.ts';
import { createWebSearchTool, ExaWebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import type { ToolComponent } from '../../v0/agent/tools/tool_components.ts';
import {
  applyHistoryAppendResults,
  historyExecutionMetadata,
  replaySessionConversation,
} from '../../v0/conversation/history_adapter.ts';
import {
  applyObservation,
  createConversationNormalizer,
} from '../../v0/conversation/normalizer.ts';
import {
  type ConversationPosition,
  type ConversationRequestKey,
  createConversationState,
  orderedConversationEntities,
} from '../../v0/conversation/model.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';

const runtimeEvent = (
  event: StoredExecutionEvent,
): ProviderEvidenceRuntimeEvent | undefined => {
  const payload = event.payload as {
    readonly kind?: string;
    readonly observation?: {
      readonly kind?: string;
      readonly event?: ProviderEvidenceRuntimeEvent;
    };
  };
  return payload.kind === 'provider_observation' &&
      payload.observation?.kind === 'runtime_event'
    ? payload.observation.event
    : undefined;
};

Deno.test('Increment 170 S1 producer fixes tool attribution before an auxiliary request', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-producer-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let handle: Awaited<ReturnType<typeof store.allocateWorker>> | undefined;
  let registry: ReturnType<typeof createDeclaredRegistry> | undefined;
  try {
    await store.initialize();
    const definition = await builtinDefinitionRef('default', buildManifest());
    handle = await store.allocateWorker('default', definition);
    const createdAt = '2026-10-02T00:00:00.000Z';
    const record: StoredSessionRecord = {
      schemaVersion: 6,
      sessionId: handle.id,
      workspaceRoot,
      agent: 'default',
      createdAt,
      updatedAt: createdAt,
      title: null,
      stateRevision: 1,
      nextTurn: 1,
      transcript: [],
      definition,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: createdAt,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [],
      turnExecutions: [],
    };
    handle.commit(record);
    handle.close();
    handle = undefined;

    const sessionId = record.sessionId;
    const executionId = '17000000-0000-4000-8000-000000000071';
    const taskId = '17000000-0000-4000-8000-000000000072';
    const input = {
      taskId,
      executionId,
      createdAt,
      sessionCorrelation: sessionId,
      canonicalSessionId: sessionId,
      turn: 1,
      task: 'Research and then inspect a marker.',
      baseStateRevision: record.stateRevision,
      agent: 'default' as const,
      model: ROOT_DEFAULT_MODEL_SELECTION,
      build: buildManifest(),
      definition,
    };
    await store.beginExecution({ ...input, sessionMode: 'persistent' });

    const state = createConversationState(sessionId);
    const normalizer = createConversationNormalizer();
    applyObservation(state, normalizer, {
      kind: 'execution',
      execution: historyExecutionMetadata(store.readExecution(executionId)),
      executionOrder: 0,
    });
    const correlation = {
      session: sessionId,
      instanceCorrelation: 'i170-producer-instance',
      workerGeneration: 'i170-producer-generation',
      baseStateRevision: record.stateRevision,
      command: 'i170-producer-task',
    };
    let sequence = 0;
    let firstToolDeclaration:
      | readonly Readonly<{
        id: string;
        position: ConversationPosition;
        requestKey: ConversationRequestKey;
      }>[]
      | undefined;
    const recorder = new ProviderEvidenceRecorder(
      '17000000-0000-4000-8000-000000000073',
      1,
      createdAt,
      (observation: ProviderEvidenceObservation) => {
        const currentSequence = ++sequence;
        const kind = observation.kind === 'request_start'
          ? 'provider_request_start'
          : observation.kind === 'response_start'
          ? 'provider_response_start'
          : observation.kind === 'parser_transition'
          ? 'provider_parser_transition'
          : observation.kind === 'request_failure'
          ? 'provider_request_failure'
          : 'runtime_event';
        const event = {
          executionId,
          direction: 'worker_to_host',
          source: 'worker',
          kind,
          workerSequence: currentSequence,
          payload: {
            kind: 'provider_observation',
            correlation,
            sequence: currentSequence,
            turn: 1,
            observation,
          },
        } as ExecutionEventInput;
        const appended = store.appendExecutionEventsWithSemanticIds([event]);
        applyHistoryAppendResults(state, normalizer, appended);
        if (
          observation.kind === 'runtime_event' &&
          observation.event.kind === 'model_result' &&
          firstToolDeclaration === undefined
        ) {
          firstToolDeclaration = orderedConversationEntities(state).flatMap((
            entity,
          ) =>
            entity.kind === 'tool' && entity.declarationIndex !== undefined
              ? [{
                id: entity.id,
                position: entity.position,
                requestKey: entity.requestKey,
              }]
              : []
          );
        }
        return currentSequence;
      },
      true,
    );
    const execution = createTurnExecutionContext(
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recorder,
    );

    const backend = new ExaWebSearchBackend({
      credential: 'local-test-credential',
      endpoint: 'https://provider.invalid/search',
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [{
                title: 'Marker reference',
                url: 'https://source.invalid/marker',
                text: 'The marker is blue.',
              }],
            }),
            { status: 200 },
          ),
        ),
    });
    const declaredSearchTool = createWebSearchTool(backend);
    const searchIdentity = createAgentResourceIdentity(
      'tool:external_research',
    );
    const readIdentity = createAgentResourceIdentity(
      'tool:bespoke_marker_reader',
    );
    const component = (
      identity: typeof searchIdentity,
      materialize: ToolComponent['materialize'],
    ): ToolComponent => ({ identity, materialize });
    const externalSearchComponent = component(searchIdentity, () => {
      const tool: Tool = {
        name: 'external_research',
        description: declaredSearchTool.description,
        inputSchema: declaredSearchTool.inputSchema,
        execute: (argumentsValue, context) => {
          if (context !== undefined && 'reportProgress' in context) {
            context.reportProgress?.('Searching the marker source.');
          }
          return declaredSearchTool.execute(argumentsValue, context);
        },
      };
      return tool;
    });
    const externalReadComponent = component(readIdentity, () => ({
      name: 'bespoke_marker_reader',
      description: 'Read the marker after research.',
      inputSchema: { type: 'object' },
      execute(_argumentsValue, context) {
        if (context !== undefined && 'reportProgress' in context) {
          context.reportProgress?.('Inspecting the marker.');
        }
        return 'marker file says blue';
      },
    }));
    const declaration: AgentCapabilityDeclaration = {
      instructions: [],
      skills: [],
      tools: [searchIdentity, readIdentity],
      asyncAgents: [],
    };
    registry = createDeclaredRegistry(declaration, {
      workspace: { root: workspaceRoot },
      skillCatalog: emptySkillCatalog(),
      toolDefinitions: [externalSearchComponent, externalReadComponent],
    });

    let generation = 0;
    const model: Model = {
      generate(_request, options): ModelResult {
        generation += 1;
        const modelStep = options?.modelStep ?? generation;
        if (generation === 1) {
          options?.providerEvidence?.startRequestMetadata({
            lane: options.providerEvidenceLane ?? 'parent',
            modelStep,
            endpoint: 'https://provider.invalid/model',
            method: 'POST',
            requestMetadata: { origin: 'root_model' },
          });
          return {
            kind: 'tool_calls',
            calls: [
              {
                callId: 'research-call',
                name: 'external_research',
                arguments: { query: 'marker color' },
              },
              {
                callId: 'reader-call',
                name: 'bespoke_marker_reader',
                arguments: { path: 'marker.txt' },
              },
            ],
          };
        }
        if (generation === 2) {
          return {
            kind: 'tool_calls',
            calls: [{
              callId: 'unattributed-research-call',
              name: 'external_research',
              arguments: { query: 'marker revision' },
            }],
          };
        }
        options?.providerEvidence?.startRequestMetadata({
          lane: options.providerEvidenceLane ?? 'parent',
          modelStep,
          endpoint: 'https://provider.invalid/model',
          method: 'POST',
          requestMetadata: { origin: 'root_model' },
        });
        return { kind: 'final', text: 'The marker is blue.' };
      },
    };
    const delivered: string[] = [];
    const outcome = await runAgentTurn(
      input.task,
      [],
      model,
      registry,
      {
        maxSteps: 3,
        executionContext: execution,
        eventSink: (event) => {
          if (event.kind === 'tool_progress') {
            delivered.push(`progress:${event.callId}`);
          }
          if (event.kind === 'tool_result') {
            delivered.push(`result:${event.result.callId}`);
          }
        },
      },
    );
    ok(outcome.ok);
    strictEqual(outcome.finalText, 'The marker is blue.');
    deepStrictEqual(delivered, [
      'progress:research-call',
      'result:research-call',
      'progress:reader-call',
      'result:reader-call',
      'progress:unattributed-research-call',
      'result:unattributed-research-call',
    ]);

    const liveTools = orderedConversationEntities(state).filter((entity) => entity.kind === 'tool');
    strictEqual(liveTools.length, 3);
    const search = liveTools.find((entity) =>
      entity.kind === 'tool' && entity.callId === 'research-call'
    );
    const reader = liveTools.find((entity) =>
      entity.kind === 'tool' && entity.callId === 'reader-call'
    );
    const unattributedSearch = liveTools.find((entity) =>
      entity.kind === 'tool' && entity.callId === 'unattributed-research-call'
    );
    ok(search?.kind === 'tool');
    ok(reader?.kind === 'tool');
    strictEqual(search.name, 'external_research');
    strictEqual(search.started, true);
    strictEqual(search.requestKey.requestOrdinal, 1);
    strictEqual(search.progress, 'Searching the marker source.');
    strictEqual(search.result?.text.includes('The marker is blue.'), true);
    strictEqual(reader.name, 'bespoke_marker_reader');
    strictEqual(reader.requestKey.requestOrdinal, 1);
    strictEqual(reader.progress, 'Inspecting the marker.');
    strictEqual(reader.result?.text, 'marker file says blue');
    ok(unattributedSearch?.kind === 'tool');
    strictEqual(unattributedSearch.callIndex, 0);
    strictEqual(unattributedSearch.requestKey.modelStep, 2);
    strictEqual(unattributedSearch.requestKey.requestOrdinal, undefined);
    strictEqual(unattributedSearch.progress, 'Searching the marker source.');
    strictEqual(
      unattributedSearch.result?.text.includes('The marker is blue.'),
      true,
    );
    ok(firstToolDeclaration !== undefined);
    strictEqual(firstToolDeclaration.length, 2);
    deepStrictEqual(
      [search.id, reader.id],
      firstToolDeclaration.map((entity) => entity.id),
    );
    deepStrictEqual(
      [search.position, reader.position],
      firstToolDeclaration.map((entity) => entity.position),
    );

    const stored = store.listExecutionEvents(executionId);
    const runtimeEvents = stored.flatMap((event) => {
      const value = runtimeEvent(event);
      return value === undefined ? [] : [value];
    });
    const modelResults = runtimeEvents.filter((event) => event.kind === 'model_result');
    strictEqual(modelResults.length, 3);
    ok(modelResults[0]?.kind === 'model_result');
    strictEqual(modelResults[0].requestOrdinal, 1);
    ok(modelResults[1]?.kind === 'model_result');
    strictEqual(modelResults[1].requestOrdinal, undefined);
    const physicalStarts = stored.filter((event) => event.kind === 'provider_request_start');
    strictEqual(physicalStarts.length, 4);
    const requestOrigins = physicalStarts.map((event) => {
      const payload = event.payload as {
        readonly observation?: {
          readonly request?: {
            readonly requestMetadata?: {
              readonly origin?: string;
              readonly provider?: string;
              readonly api?: string;
              readonly modelId?: string;
              readonly effort?: string;
            };
          };
        };
      };
      return payload.observation?.request?.requestMetadata?.origin;
    });
    deepStrictEqual(requestOrigins, [
      'root_model',
      'web_search',
      'web_search',
      'root_model',
    ]);
    const searchRequests = physicalStarts.slice(1, 3).map((event) => {
      const payload = event.payload as {
        readonly observation?: {
          readonly request?: {
            readonly requestMetadata?: Record<string, unknown>;
          };
        };
      };
      return payload.observation?.request?.requestMetadata;
    });
    deepStrictEqual(searchRequests.map((metadata) => metadata?.provider), [
      'exa',
      'exa',
    ]);
    deepStrictEqual(searchRequests.map((metadata) => metadata?.api), [
      'exa-search',
      'exa-search',
    ]);
    for (const metadata of searchRequests) {
      strictEqual(metadata?.modelId, undefined);
      strictEqual(metadata?.effort, undefined);
    }
    const toolEvents = runtimeEvents.filter((event): event is Extract<
      ProviderEvidenceRuntimeEvent,
      { kind: 'tool_call' | 'tool_progress' | 'tool_result' }
    > =>
      event.kind === 'tool_call' || event.kind === 'tool_progress' ||
      event.kind === 'tool_result'
    );
    strictEqual(toolEvents.length, 9);
    strictEqual(
      toolEvents.slice(0, 6).every((event) => event.modelStep === 1),
      true,
    );
    strictEqual(
      toolEvents.slice(0, 6).every((event) => event.requestOrdinal === 1),
      true,
    );
    strictEqual(
      toolEvents.slice(6).every((event) => event.modelStep === 2),
      true,
    );
    strictEqual(
      toolEvents.slice(6).every((event) => event.requestOrdinal === undefined),
      true,
    );
    deepStrictEqual(
      toolEvents.map((event) => event.callIndex),
      [0, 0, 0, 1, 1, 1, 0, 0, 0],
    );
    const finalModelResult = modelResults.at(-1);
    ok(finalModelResult?.kind === 'model_result');
    strictEqual(finalModelResult.requestOrdinal, 4);

    const replay = replaySessionConversation(
      sessionId,
      store.readSessionConversationFacts(sessionId),
    );
    deepStrictEqual(
      orderedConversationEntities(replay.state),
      orderedConversationEntities(state),
    );
  } finally {
    await registry?.close();
    handle?.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
