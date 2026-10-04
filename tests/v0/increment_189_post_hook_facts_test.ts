import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Model, ModelResult } from '../../v0/agent/core/contracts.ts';
import { HOOK_API_CONTRACT } from '../../v0/agent/hook_api.ts';
import { defineInstructionComponent } from '../../v0/agent/instructions/component.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { DataSessionOwner } from '../../v0/agent/data/session_data_owner.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import {
  createHookScopedProviderRequest,
  createProviderRequestDispatcher,
  type HookProviderEvidenceScope,
} from '../../v0/agent/provider/auxiliary_request.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';
import { loadWorkerHooks } from '../../v0/hooks/hook_loader.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const makeCorrelation = (
  sessionId: string,
  stateRevision: number,
): WorkerCorrelation => ({
  session: sessionId,
  instanceCorrelation: 'increment-189-post-hook-facts-instance',
  workerGeneration: 'increment-189-post-hook-facts-generation',
  baseStateRevision: stateRevision,
  command: 'post-hook-facts',
});

Deno.test('Increment 189 persists auxiliary after_turn/runtime_stop request facts after settlement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-post-hook-facts-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
    async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      });
      await request.arrayBuffer();
      return new Response('local auxiliary response', { status: 202 });
    },
  );
  const executionId = '18900000-0000-4000-8000-000000000189';
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const writer = new ConversationWriter(store);
  let owner: DataSessionOwner | undefined;
  let generation: WorkerGeneration | undefined;
  try {
    await store.initialize();
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
    });
    const correlation = makeCorrelation(
      owner.sessionId,
      owner.descriptor().stateRevision,
    );
    const hookPath = `${root}/post-hook-facts.ts`;
    const endpoint = `http://127.0.0.1:${server.addr.port}`;
    await Deno.writeTextFile(
      hookPath,
      `const evidenceMetadata = {
        provider: 'aux-index', api: 'compact-v1', modelId: 'aux-compact',
        contentType: 'application/json', responseMode: 'json', protocol: 'json',
      };
      const request = async (requestProvider, endpoint, path) => {
        await requestProvider({
          authProfile: 'local-auxiliary', endpoint: endpoint + path, method: 'POST',
          body: new TextEncoder().encode('private hook body'), evidenceMetadata,
        });
      };
      export default ({ requestProvider }) => ({
        after_turn: async () => await request(requestProvider, ${
        JSON.stringify(endpoint)
      }, '/after-turn'),
        runtime_stop: async () => await request(requestProvider, ${
        JSON.stringify(endpoint)
      }, '/runtime-stop'),
      });\n`,
    );
    const evidenceScope: HookProviderEvidenceScope = {};
    const dispatcher = createProviderRequestDispatcher({
      resolveCredential: () => 'dummy-hook-secret',
    });
    const hooks = await loadWorkerHooks([{
      name: 'post-hook-facts',
      path: hookPath,
      contract: HOOK_API_CONTRACT,
    }], {
      workspace: { root },
      workTools: {},
      requestProvider: createHookScopedProviderRequest(dispatcher, evidenceScope),
    });
    deepStrictEqual(hooks.rejections, []);
    const configuration = workerConfigurationFixture({
      hooks: [{
        name: 'post-hook-facts',
        path: hookPath,
        contract: HOOK_API_CONTRACT,
        handlers: ['after_turn', 'runtime_stop'],
      }],
    });
    await owner.admit({
      executionId,
      taskId: 'increment-189-post-hook-facts-task',
      task: 'Run one deterministic local turn',
      correlation,
      configuration,
      maxSteps: 1,
    });

    let modelCalls = 0;
    const model: Model = {
      generate(): ModelResult {
        modelCalls += 1;
        return { kind: 'final', text: 'completed without a live provider' };
      },
    };
    const composition: WorkerAgentComposition = {
      role: 'parent',
      model,
      registry: new Registry([]),
      maxSteps: 1,
      systemInstruction: 'post settlement fact fixture',
      instructionComponents: [
        defineInstructionComponent('instruction:post-hook-facts', 'post settlement fact fixture'),
      ],
      manifest: {
        role: 'parent',
        maxSteps: 1,
        profileId: 'increment-189-post-hook-facts',
        resources: [],
      },
      resolved: {
        model: { profile: { id: 'increment-189-post-hook-facts' } },
        systemInstruction: 'post settlement fact fixture',
        capabilities: { instructions: ['instruction:post-hook-facts'] },
        resourceSelection: { resources: ['instruction:post-hook-facts'], maxSteps: 1 },
      },
    } as unknown as WorkerAgentComposition;

    let postSettlementSequence = 1;
    const port: WorkerGenerationPort = {
      runtimeEvent: () => postSettlementSequence++,
      effectObservation: () => postSettlementSequence++,
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: async (_receivedCorrelation, proposal) => {
        const token = await owner!.prepareProposal({
          proposalId: 'increment-189-post-hook-facts-proposal',
          executionId,
          finalDataSequence: 0,
          message: proposal,
        });
        const terminal = owner!.authorizeCommit(token, { accepted: true });
        return {
          accepted: terminal.accepted,
          adopted: terminal.canonical,
          durable: terminal.durable,
          stateRevision: terminal.stateRevision,
          terminalOutcome: {
            ok: terminal.outcome.ok,
            outcome: terminal.outcome.outcome,
            stopReason: terminal.outcome.stopReason,
            ...(terminal.outcome.error === undefined ? {} : {
              error: terminal.outcome.error,
            }),
          },
        };
      },
      afterTurnContext: async (update) => {
        const sequence = postSettlementSequence;
        postSettlementSequence += 1 + (update.providerObservations?.length ?? 0);
        return await owner!.installAfterTurnContext(update, sequence);
      },
      postSettlementHook: async (update) => {
        const sequence = postSettlementSequence;
        postSettlementSequence += 1 + (update.providerObservations?.length ?? 0);
        return await owner!.installPostSettlementHook(update, sequence);
      },
      turnFailed: (_receivedCorrelation, outcome) => {
        throw new Error(`unexpected turn failure: ${outcome.error ?? outcome.stopReason}`);
      },
    };
    generation = new WorkerGeneration(
      composition,
      owner.sessionId,
      port,
      [],
      1,
      undefined,
      undefined,
      ROOT_DEFAULT_MODEL_SELECTION,
      () => {},
      () => Promise.resolve('unknown'),
      { skillNames: [] },
      undefined,
      1,
      configuration,
      hooks.accepted,
      {
        component: 'agent',
        agentName: 'default',
        role: 'root',
        workspaceRoot,
        sessionId: owner.sessionId,
        workerGeneration: correlation.workerGeneration,
      },
      evidenceScope,
    );
    await generation.start();
    await generation.runTurn(
      correlation,
      'Run one deterministic local turn',
      undefined,
      undefined,
      undefined,
      false,
      executionId,
    );
    strictEqual(modelCalls, 1);
    strictEqual(owner.descriptor().nextTurn, 2);
    deepStrictEqual(await generation.stop('normal_close'), []);
    strictEqual(generation.runtimeStopResult?.effect.phase, 'runtime_stop');
    strictEqual(generation.runtimeStopResult?.providerObservations.length, 2);
    deepStrictEqual(requests.map(({ method, path }) => [method, path]), [
      ['POST', '/after-turn'],
      ['POST', '/runtime-stop'],
    ]);
    ok(requests.every(({ authorization }) => authorization === 'Bearer dummy-hook-secret'));

    const occurrences = store.listSemanticOccurrences(executionId);
    const providerFacts: Record<string, unknown>[] = occurrences.flatMap((occurrence) => {
      const payload = occurrence.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
      const storedEvent = (payload as Record<string, unknown>).event;
      if (typeof storedEvent !== 'object' || storedEvent === null || Array.isArray(storedEvent)) {
        return [];
      }
      const workerMessage = (storedEvent as Record<string, unknown>).payload;
      if (
        typeof workerMessage !== 'object' || workerMessage === null ||
        Array.isArray(workerMessage)
      ) return [];
      const workerMessageRecord = workerMessage as Record<string, unknown>;
      if (workerMessageRecord.kind !== 'provider_observation') return [];
      const observation = workerMessageRecord.observation;
      return typeof observation === 'object' && observation !== null && !Array.isArray(observation)
        ? [observation as Record<string, unknown>]
        : [];
    });
    const requestFacts = providerFacts.filter((fact) => fact.kind === 'request_start');
    const responseFacts = providerFacts.filter((fact) => fact.kind === 'response_start');
    strictEqual(requestFacts.length, 2);
    strictEqual(responseFacts.length, 2);
    const requestDescriptions = requestFacts.map((fact) => {
      const request = fact.request as Record<string, unknown>;
      const metadata = request.requestMetadata as Record<string, unknown>;
      return {
        ordinal: request.ordinal,
        endpoint: request.endpoint,
        method: request.method,
        phase: request.phase,
        modelStep: request.modelStep,
        provider: metadata.provider,
        api: metadata.api,
        modelId: metadata.modelId,
        origin: metadata.origin,
      };
    });
    deepStrictEqual(requestDescriptions, [
      {
        ordinal: 1,
        endpoint: `${endpoint}/after-turn`,
        method: 'POST',
        phase: 'hook',
        modelStep: 0,
        provider: 'aux-index',
        api: 'compact-v1',
        modelId: 'aux-compact',
        origin: 'hook',
      },
      {
        ordinal: 2,
        endpoint: `${endpoint}/runtime-stop`,
        method: 'POST',
        phase: 'hook',
        modelStep: 0,
        provider: 'aux-index',
        api: 'compact-v1',
        modelId: 'aux-compact',
        origin: 'hook',
      },
    ]);
    strictEqual(
      responseFacts.every((fact, index) => {
        const response = fact.response as Record<string, unknown>;
        return response.status === 202 && fact.requestOrdinal === index + 1;
      }),
      true,
    );
    const stopEffects = occurrences.filter((occurrence) => {
      const payload = occurrence.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
      const storedEvent = (payload as Record<string, unknown>).event;
      if (typeof storedEvent !== 'object' || storedEvent === null || Array.isArray(storedEvent)) {
        return false;
      }
      const workerMessage = (storedEvent as Record<string, unknown>).payload;
      if (
        typeof workerMessage !== 'object' || workerMessage === null ||
        Array.isArray(workerMessage)
      ) return false;
      const runtimeEvent = (workerMessage as Record<string, unknown>).event;
      if (
        typeof runtimeEvent !== 'object' || runtimeEvent === null || Array.isArray(runtimeEvent)
      ) {
        return false;
      }
      const agentEvent = (runtimeEvent as Record<string, unknown>).event;
      return typeof agentEvent === 'object' && agentEvent !== null && !Array.isArray(agentEvent) &&
        (agentEvent as Record<string, unknown>).kind === 'hook_lifecycle_update';
    });
    strictEqual(stopEffects.length, 1);
    const persisted = JSON.stringify(occurrences);
    ok(!persisted.includes('dummy-hook-secret'));
    ok(!persisted.includes('private hook body'));
    ok(!persisted.toLowerCase().includes('authorization'));
  } finally {
    await generation?.close();
    await owner?.close();
    writer.close();
    store.close();
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
