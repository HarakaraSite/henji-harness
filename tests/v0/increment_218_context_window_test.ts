import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Message, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { ContextModelRequestDelta } from '../../v0/agent/history/context_attribution.ts';
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
import { contextCost } from '../../v0/agent/session/context_budget.ts';
import type { RecalledExecutionContextV1 } from '../../v0/agent/worker/recalled_execution_context.ts';

const correlation: WorkerCorrelation = {
  session: '11111111-1111-4111-8111-111111111218',
  instanceCorrelation: 'context-window',
  workerGeneration: 'window-generation',
  baseStateRevision: 1,
  command: 'current',
};
const prior: Message[] = [1, 2].flatMap((turn) => [
  { role: 'user' as const, content: { kind: 'text' as const, text: `prior-${turn}` } },
  { role: 'assistant' as const, content: { kind: 'text' as const, text: 'a'.repeat(2000) } },
]);

Deno.test('Increment 218 checkpoint and recall use input capacity while H retains completed and current turns', async () => {
  const { OpenRouterAgentModel } = await import('../../v0/agent/provider/openrouter_transport.ts');
  const wireModel = new OpenRouterAgentModel();
  const requests: ModelRequest[] = [];
  const deltas: ContextModelRequestDelta[] = [];
  const failures: string[] = [];
  const composition = {
    role: 'parent',
    maxSteps: 1,
    model: {
      measureRequestWire: wireModel.measureRequestWire,
      generate(request: ModelRequest) {
        requests.push(structuredClone(request));
        return { kind: 'final', text: 'Done.' };
      },
    },
    registry: new Registry([]),
    manifest: { role: 'parent', maxSteps: 1, profileId: 'prefix-budget', resources: [] },
  } as unknown as WorkerAgentComposition;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: () => Promise.resolve(true),
    turnFailed: (_correlation, outcome) => {
      failures.push(outcome.error ?? outcome.stopReason);
    },
    contextObservation: (_correlation, delta) => {
      deltas.push(delta);
    },
  };
  const checkpoint = {
    contextSchemaVersion: 1 as const,
    sessionId: correlation.session,
    createdAt: '2026-10-09T00:00:00.000Z',
    sourceProfileId: 'prefix-budget',
    coveredThroughTurn: 1,
    retainedFromTurn: 2,
    summary: 's'.repeat(12_000),
  };
  const recall: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: '22222222-2222-4222-8222-222222222218',
    sessionId: correlation.session,
    turn: 2,
    settlement: 'uncommitted',
    stopReason: 'cancelled',
    task: 'r'.repeat(12_000),
    evidence: 'unavailable',
    observations: [],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  const createGeneration = (inputTokens: number) =>
    new WorkerGeneration(
      composition,
      correlation.session,
      port,
      prior,
      3,
      checkpoint,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { defaults: { historyTokens: 2000, inputTokens } },
    );
  const generation = createGeneration(16_384);
  await generation.runTurn(correlation, 'Current task.', recall);
  strictEqual(failures.length, 0);
  strictEqual(requests.length, 1);
  ok(JSON.stringify(requests[0].transcript).includes(checkpoint.summary));
  ok(JSON.stringify(requests[0].transcript).includes(recall.task));
  deepStrictEqual(deltas[0].budget?.selectedTurns, [2]);
  const conversation = requests[0].transcript.filter((message) =>
    message.role !== 'user' || !message.content.text.startsWith('[henji-')
  );
  const expected = contextCost(composition.model, requests[0], conversation);
  strictEqual(deltas[0].budget?.historyUsedTokens, expected.historyUsedTokens);
  ok(expected.historyUsedTokens < 2000);
  ok(expected.prefixTokens > 8000);
  await createGeneration(2000).runTurn(correlation, 'Current task.', recall);
  strictEqual(requests.length, 1);
  ok(failures.some((failure) => failure.includes('context_budget_exceeded')));
});

Deno.test('Increment 218 growing current tool result replaces a newest whole-turn window and saves only the current suffix', async () => {
  const requests: ModelRequest[] = [];
  const deltas: ContextModelRequestDelta[] = [];
  let proposal: WorkerCommitProposalMessage | undefined;
  const composition = {
    role: 'parent',
    maxSteps: 2,
    model: {
      generate: (request: ModelRequest) => {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? { kind: 'tool_calls', calls: [{ callId: 'read-1', name: 'read', arguments: {} }] }
          : { kind: 'final', text: 'Done.' };
      },
    },
    registry: new Registry([{
      name: 'read',
      description: 'Read the original text',
      fileAccess: 'none',
      inputSchema: {},
      execute: () => 'b'.repeat(4000),
    }]),
    manifest: { role: 'parent', maxSteps: 2, profileId: 'window-model', resources: [] },
  } as unknown as WorkerAgentComposition;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: (_correlation, value) => {
      proposal = value;
      return Promise.resolve(true);
    },
    turnFailed: (_correlation, outcome) => {
      throw new Error(outcome.error ?? outcome.stopReason);
    },
    contextObservation: (_correlation, delta) => {
      deltas.push(delta);
    },
  };
  const generation = new WorkerGeneration(
    composition,
    correlation.session,
    port,
    prior,
    3,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { defaults: { historyTokens: 2400, inputTokens: 8192 } },
  );
  await generation.runTurn(correlation, 'Read the text.');
  strictEqual(requests.length, 2);
  ok(JSON.stringify(requests[0].transcript).includes('prior-1'));
  ok(!JSON.stringify(requests[1].transcript).includes('prior-1'));
  ok(JSON.stringify(requests[1].transcript).includes('prior-2'));
  const result = requests[1].transcript.find((message) => message.role === 'tool');
  ok(result?.role === 'tool');
  strictEqual(result.content[0].text, 'b'.repeat(4000));
  deepStrictEqual(deltas.map((delta) => delta.budget?.selectedTurns), [[1, 2], [2]]);
  ok(deltas[1].splices.some((splice) => splice.deleteCount > 0));
  ok(proposal);
  strictEqual(proposal.transcript.length, 4);
  ok(!JSON.stringify(proposal.transcript).includes('prior-'));
  strictEqual(generation.transcriptSnapshot().length, 0);
});

Deno.test('Increment 218 Chat byte ceiling removes an old whole turn even with a larger token allowance', async () => {
  const wireModel = new (await import('../../v0/agent/provider/openrouter_transport.ts'))
    .OpenRouterAgentModel();
  const requests: ModelRequest[] = [];
  const composition = {
    role: 'parent',
    maxSteps: 1,
    model: {
      measureRequestWire: wireModel.measureRequestWire,
      generate(request: ModelRequest) {
        requests.push(request);
        return { kind: 'final', text: 'Done.' };
      },
    },
    registry: new Registry([]),
    manifest: { role: 'parent', maxSteps: 1, profileId: 'byte-limit', resources: [] },
  } as unknown as WorkerAgentComposition;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: () => Promise.resolve(true),
    turnFailed: (_correlation, outcome) => {
      throw new Error(outcome.error ?? outcome.stopReason);
    },
  };
  const generation = new WorkerGeneration(
    composition,
    correlation.session,
    port,
    [{ role: 'user', content: { kind: 'text', text: 'original large turn' } }, {
      role: 'assistant',
      content: { kind: 'text', text: '過去'.repeat(1_000_000) },
    }],
    2,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { defaults: { historyTokens: 4_000_000, inputTokens: 4_000_000 } },
  );
  await generation.runTurn(correlation, 'Current small request.');
  strictEqual(requests.length, 1);
  strictEqual(requests[0].transcript.length, 1);
  strictEqual(requests[0].transcript[0].role, 'user');
});

Deno.test('Increment 218 a normal Worker request saves its actual input estimate beside observed usage', async () => {
  const observations:
    import('../../v0/agent/provider/provider_evidence.ts').ProviderEvidenceObservation[] = [];
  const { OpenRouterAgentModel } = await import('../../v0/agent/provider/openrouter_transport.ts');
  let sent = '';
  const model = new OpenRouterAgentModel({
    credentialSource: () => Promise.resolve('fixture-key'),
    fetcher: (_url, init) => {
      sent = String(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 65, completion_tokens: 2, total_tokens: 67 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  const composition = {
    role: 'parent',
    maxSteps: 1,
    model,
    registry: new Registry([]),
    manifest: { role: 'parent', maxSteps: 1, profileId: 'usage-model', resources: [] },
  } as unknown as WorkerAgentComposition;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => 1,
    effectObservation: () => 1,
    providerObservation: (_correlation, observation) => {
      observations.push(observation);
      return 1;
    },
    checkpointProposal: () => Promise.resolve(false),
    commitProposal: () => Promise.resolve(true),
    turnFailed: (_correlation, outcome) => {
      throw new Error(outcome.error ?? outcome.stopReason);
    },
  };
  const generation = new WorkerGeneration(composition, correlation.session, port);
  await generation.runTurn(correlation, 'A normal request.');
  const fact = observations.find((value) => value.kind === 'request_usage');
  ok(fact?.kind === 'request_usage');
  const expected = Math.ceil(new TextEncoder().encode(sent).byteLength / 3) + 16 +
    8 * JSON.parse(sent).messages.length;
  strictEqual(fact.usage.estimatedInputTokens, expected);
  strictEqual(fact.usage.inputEstimateDifference, 65 - expected);
});
