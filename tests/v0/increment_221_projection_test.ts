import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { Message, Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { ContextModelRequestDelta } from '../../v0/agent/history/context_attribution.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_transport.ts';
import { OpenRouterResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
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
import type { ContextTurnRead } from '../../v0/agent/data/agent_data_contract.ts';
import { contextCost } from '../../v0/agent/session/context_budget.ts';
import type { JsonValue } from '../../v0/agent/core/contracts.ts';

const correlation: WorkerCorrelation = {
  session: '11111111-1111-4111-8111-111111111221',
  instanceCorrelation: 'projection',
  workerGeneration: 'projection-generation',
  baseStateRevision: 1,
  command: 'current',
};

const state = (text: string) => ({
  provider: 'openrouter-chat',
  model: PRODUCTION_PROFILE.model,
  reasoning: { field: 'reasoning' as const, text },
});

const createComposition = (model: Model, maxSteps = 1): WorkerAgentComposition => ({
  role: 'parent',
  maxSteps,
  systemInstruction: 'Projection test instruction.',
  model,
  registry: new Registry([{
    name: 'read',
    description: 'Read a fixture result.',
    fileAccess: 'none',
    inputSchema: { type: 'object', properties: { bytes: { type: 'number' } } },
    execute: (input) => 'x'.repeat((input as { readonly bytes: number }).bytes),
  }]),
  manifest: { role: 'parent', maxSteps, profileId: 'increment-221-projection', resources: [] },
} as unknown as WorkerAgentComposition);

const createPort = (
  options: {
    readonly savedTurn?: () => ContextTurnRead | null;
    readonly proposals?: WorkerCommitProposalMessage[];
    readonly deltas?: ContextModelRequestDelta[];
    readonly failures?: string[];
  } = {},
): WorkerGenerationPort => ({
  readContextTurn: (_correlation, beforeTurn) => {
    const savedTurn = options.savedTurn?.();
    return Promise.resolve(
      savedTurn !== undefined && savedTurn !== null && savedTurn.turn < beforeTurn
        ? savedTurn
        : null,
    );
  },
  runtimeEvent: () => 1,
  effectObservation: () => 1,
  checkpointProposal: () => Promise.resolve(false),
  commitProposal: (_correlation, proposal) => {
    options.proposals?.push(proposal);
    return Promise.resolve(true);
  },
  turnFailed: (_correlation, outcome) => {
    options.failures?.push(outcome.error ?? outcome.stopReason);
  },
  contextObservation: (_correlation, delta) => {
    options.deltas?.push(delta);
  },
});

const createGeneration = (
  composition: WorkerAgentComposition,
  port: WorkerGenerationPort,
  historyTokens: number,
  initialNextTurn = 1,
  inputCapacityTokens?: number,
) =>
  new WorkerGeneration(
    composition,
    correlation.session,
    port,
    [],
    initialNextTurn,
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
        historyTokens,
        ...(inputCapacityTokens === undefined ? {} : { inputTokens: inputCapacityTokens }),
      },
    },
  );

const callsIn = (messages: readonly Message[]): string[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.map((call) => call.callId)
      : []
  );

const resultsIn = (messages: readonly Message[]): string[] =>
  messages.flatMap((message) =>
    message.role === 'tool' ? message.content.map((result) => result.callId) : []
  );

const budgetObject = (delta: ContextModelRequestDelta) =>
  delta.budget as Readonly<Record<string, JsonValue>> | undefined;

Deno.test('Increment 221 current trimming removes whole exchanges monotonically and commits the full transcript', async () => {
  const wireModel = new OpenRouterAgentModel();
  const requests: ModelRequest[] = [];
  const proposals: WorkerCommitProposalMessage[] = [];
  const deltas: ContextModelRequestDelta[] = [];
  const failures: string[] = [];
  let savedTurn: ContextTurnRead | null = null;
  let followupMode = false;
  const followupRequests: ModelRequest[] = [];
  const generationRef: { current?: WorkerGeneration } = {};
  const model: Model = {
    measureRequestWire: wireModel.measureRequestWire,
    requestOutputReserve: wireModel.requestOutputReserve,
    generate(request) {
      if (followupMode) {
        followupRequests.push(structuredClone(request));
        return { kind: 'final', text: 'Continued.' };
      }
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        strictEqual(
          generationRef.current?.steerActiveTurn('Keep this accepted steering.'),
          'accepted',
        );
        return {
          kind: 'tool_calls',
          calls: [
            { callId: 'batch-a', name: 'read', arguments: { bytes: 300 } },
            { callId: 'batch-b', name: 'read', arguments: { bytes: 300 } },
          ],
          providerState: state('batch-reasoning'),
        };
      }
      if (requests.length === 2) {
        return {
          kind: 'tool_calls',
          calls: [{ callId: 'middle', name: 'read', arguments: { bytes: 300 } }],
          providerState: state('middle-reasoning'),
        };
      }
      if (requests.length === 3) {
        return {
          kind: 'tool_calls',
          calls: [{ callId: 'latest', name: 'read', arguments: { bytes: 60 } }],
          providerState: state('latest-reasoning'),
        };
      }
      return { kind: 'final', text: 'Finished.', providerState: state('final-reasoning') };
    },
  };
  const port = createPort({ savedTurn: () => savedTurn, proposals, deltas, failures });
  const generation = createGeneration(createComposition(model, 4), port, 450, 1, 9000);
  generationRef.current = generation;

  await generation.runTurn(correlation, 'Keep this task.');

  ok(failures.length === 0, failures.join('\n'));
  strictEqual(requests.length, 4);
  ok(requests[1].transcript.some((message) => message.role === 'user' && message.steering));
  deepStrictEqual(callsIn(requests[2].transcript), ['middle']);
  deepStrictEqual(resultsIn(requests[2].transcript), ['middle']);
  ok(!callsIn(requests[3].transcript).includes('batch-a'));
  ok(!callsIn(requests[3].transcript).includes('batch-b'));
  ok(requests[3].transcript.some((message) => message.role === 'user' && message.steering));
  ok(callsIn(requests[3].transcript).includes('latest'));
  const currentFacts = budgetObject(deltas[2])?.currentProjection as {
    readonly status: string;
    readonly omittedMessageRanges: readonly (readonly [number, number])[];
  };
  strictEqual(currentFacts.status, 'trimmed');
  deepStrictEqual(currentFacts.omittedMessageRanges, [[1, 2]]);
  strictEqual(budgetObject(deltas[2])?.inputCapacityTokens, 9000);
  ok(budgetObject(deltas[2])?.inputTokens !== 9000);
  ok(proposals[0]);
  const fullTranscript = proposals[0].transcript;
  deepStrictEqual(callsIn(fullTranscript), ['batch-a', 'batch-b', 'middle', 'latest']);
  deepStrictEqual(resultsIn(fullTranscript), ['batch-a', 'batch-b', 'middle', 'latest']);
  strictEqual(
    fullTranscript.filter((message) => message.role === 'user' && message.steering).length,
    1,
  );
  strictEqual(generation.transcriptSnapshot().length, 0);

  savedTurn = {
    turn: 1,
    executionId: 'long-execution',
    messages: fullTranscript,
    messageStart: 41,
    source: 'canonical',
    byteLength: 0,
  };
  followupMode = true;
  await generation.runTurn(correlation, 'Continue from the saved result.');
  strictEqual(followupRequests.length, 1);
  const sameWorkerHistoryFact = budgetObject(deltas[4])?.recentHistoryProjection as {
    readonly status: string;
    readonly keptMessageRanges: readonly (readonly [number, number])[];
  };
  strictEqual(sameWorkerHistoryFact.status, 'partial');
  ok(followupRequests[0].transcript.some((message) => message.role === 'user' && message.steering));
  ok(
    followupRequests[0].transcript.some((message) =>
      message.role === 'user' && message.content.text === 'Keep this task.'
    ),
  );
  ok(callsIn(followupRequests[0].transcript).includes('latest'));
  ok(!callsIn(followupRequests[0].transcript).includes('batch-a'));
  ok(resultsIn(followupRequests[0].transcript).includes('latest'));
  ok(
    followupRequests[0].transcript.some((message) =>
      message.role === 'assistant' && !Array.isArray(message.content) &&
      'text' in message.content && message.content.text === 'Finished.'
    ),
  );

  const reopenedRequests: ModelRequest[] = [];
  const reopenedDeltas: ContextModelRequestDelta[] = [];
  const reopenedFailures: string[] = [];
  const reopenedModel: Model = {
    measureRequestWire: wireModel.measureRequestWire,
    requestOutputReserve: wireModel.requestOutputReserve,
    generate(request) {
      reopenedRequests.push(structuredClone(request));
      return { kind: 'final', text: 'Continued.' };
    },
  };
  const reopenedGeneration = createGeneration(
    createComposition(reopenedModel, 4),
    createPort({ savedTurn: () => savedTurn, deltas: reopenedDeltas, failures: reopenedFailures }),
    450,
    2,
    9000,
  );
  await reopenedGeneration.runTurn(correlation, 'Continue from the saved result.');
  strictEqual(reopenedFailures.length, 0);
  strictEqual(reopenedRequests.length, 1);
  deepStrictEqual(reopenedRequests[0].transcript, followupRequests[0].transcript);
  const reopenedHistoryFact = budgetObject(reopenedDeltas[0])?.recentHistoryProjection as {
    readonly status: string;
    readonly keptMessageRanges: readonly (readonly [number, number])[];
  };
  strictEqual(reopenedHistoryFact.status, 'partial');
  deepStrictEqual(reopenedHistoryFact.keptMessageRanges, sameWorkerHistoryFact.keptMessageRanges);
});

Deno.test('Increment 221 newest prior turn is partially projected with original message locators on Worker reopen', async () => {
  const selection = {
    provider: 'openrouter-responses' as const,
    api: 'openrouter-responses' as const,
    authProfile: 'openrouter-api-key' as const,
    modelId: 'fixture-model',
    effort: 'high' as const,
  };
  const wireModel = new OpenRouterResponsesModel({
    selection,
    credentialSource: () => Promise.resolve('unused'),
  });
  const history: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'Prior task.' } },
    {
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: 'old', name: 'read', arguments: {} }],
      providerState: {
        provider: selection.provider,
        model: selection.modelId,
        replayItems: [
          { type: 'reasoning', id: 'old-reasoning' },
          { type: 'function_call', call_id: 'old', name: 'read', arguments: '{}' },
        ],
      },
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'old',
        name: 'read',
        text: 'o'.repeat(2400),
        outcome: 'success',
      }],
    },
    { role: 'user', content: { kind: 'text', text: 'Prior steering.' }, steering: true },
    {
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: 'latest', name: 'read', arguments: {} }],
      providerState: {
        provider: selection.provider,
        model: selection.modelId,
        replayItems: [
          { type: 'reasoning', id: 'latest-reasoning' },
          { type: 'function_call', call_id: 'latest', name: 'read', arguments: '{}' },
        ],
      },
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'latest',
        name: 'read',
        text: 'latest result',
        outcome: 'success',
      }],
    },
    {
      role: 'assistant',
      content: { kind: 'text', text: 'Prior final.' },
      providerState: {
        provider: selection.provider,
        model: selection.modelId,
        replayItems: [
          { type: 'reasoning', id: 'final-reasoning' },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Prior final.' }],
          },
        ],
      },
    },
  ];
  const currentTask: Message = {
    role: 'user',
    content: { kind: 'text', text: 'Continue that result.' },
  };
  const protectedHistory = [history[0], history[3], history[4], history[5], history[6]];
  const fullCost = contextCost(
    wireModel,
    {
      systemInstruction: 'Projection test instruction.',
      transcript: [...history, currentTask],
      tools: [],
    },
    [...history, currentTask],
  );
  const protectedCost = contextCost(
    wireModel,
    {
      systemInstruction: 'Projection test instruction.',
      transcript: [...protectedHistory, currentTask],
      tools: [],
    },
    [...protectedHistory, currentTask],
  );
  ok(protectedCost.historyUsedTokens < fullCost.historyUsedTokens);
  const historyTokens = Math.floor(
    (protectedCost.historyUsedTokens + fullCost.historyUsedTokens) / 2,
  );
  const savedTurn: ContextTurnRead = {
    turn: 1,
    executionId: 'responses-execution',
    messages: history,
    messageStart: 91,
    source: 'canonical',
    byteLength: 0,
  };
  const createResponsesWorker = (requests: ModelRequest[], deltas: ContextModelRequestDelta[]) => {
    const model: Model = {
      measureRequestWire: wireModel.measureRequestWire,
      generate(request) {
        requests.push(structuredClone(request));
        return { kind: 'final', text: 'Continued.' };
      },
    };
    const port = createPort({ savedTurn: () => savedTurn, deltas, failures: [] });
    return createGeneration(createComposition(model), port, historyTokens, 2);
  };
  const sameWorkerRequests: ModelRequest[] = [];
  const sameWorkerDeltas: ContextModelRequestDelta[] = [];
  const sameWorker = createResponsesWorker(sameWorkerRequests, sameWorkerDeltas);
  await sameWorker.runTurn(correlation, 'Continue that result.');
  const reopenedRequests: ModelRequest[] = [];
  const reopenedDeltas: ContextModelRequestDelta[] = [];
  const reopenedWorker = createResponsesWorker(reopenedRequests, reopenedDeltas);
  await reopenedWorker.runTurn(correlation, 'Continue that result.');

  strictEqual(sameWorkerRequests.length, 1);
  strictEqual(reopenedRequests.length, 1);
  const sameProjection = sameWorkerRequests[0].transcript;
  const reopenedProjection = reopenedRequests[0].transcript;
  deepStrictEqual(reopenedProjection, sameProjection);
  ok(callsIn(sameProjection).includes('latest'));
  ok(!callsIn(sameProjection).includes('old'));
  ok(resultsIn(sameProjection).includes('latest'));
  ok(!resultsIn(sameProjection).includes('old'));
  ok(
    sameProjection.some((message) =>
      message.role === 'user' && message.content.text === 'Prior task.'
    ),
  );
  ok(sameProjection.some((message) => message.role === 'user' && message.steering));
  ok(
    sameProjection.some((message) =>
      message.role === 'user' && message.content.text === 'Continue that result.'
    ),
  );
  const latestCall = sameProjection.find((message) =>
    message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some((call) => call.callId === 'latest')
  );
  ok(latestCall?.role === 'assistant' && latestCall.providerState !== undefined);
  const finalMessage = sameProjection.find((message) =>
    message.role === 'assistant' && !Array.isArray(message.content) &&
    'text' in message.content &&
    message.content.text === 'Prior final.'
  );
  ok(finalMessage?.role === 'assistant' && finalMessage.providerState !== undefined);
  const historyFact = budgetObject(sameWorkerDeltas[0])?.recentHistoryProjection as {
    readonly status: string;
    readonly sourceMessageStart: number;
    readonly keptMessageRanges: readonly (readonly [number, number])[];
    readonly omittedMessageRanges: readonly (readonly [number, number])[];
  };
  strictEqual(historyFact.status, 'partial');
  strictEqual(historyFact.sourceMessageStart, 91);
  deepStrictEqual(historyFact.keptMessageRanges, [[0, 0], [3, 6]]);
  deepStrictEqual(historyFact.omittedMessageRanges, [[1, 2]]);
  const sourceLocators = sameWorkerDeltas[0].occurrences.flatMap((occurrence) =>
    occurrence.sourceRelations.map((source) => source.sourceLocator).filter((value) =>
      value !== undefined
    )
  );
  ok(sourceLocators.includes('execution:responses-execution#message=5'));
  ok(sourceLocators.includes('execution:responses-execution#message=6'));
  ok(sourceLocators.includes('execution:responses-execution#message=7'));
  ok(sourceLocators.includes('execution:responses-execution#message=1'));
  ok(!sourceLocators.includes('execution:responses-execution#message=2'));
  const withReplayState = wireModel.measureRequestWire!(sameWorkerRequests[0]).bodyBytes;
  const withoutReplayState = wireModel.measureRequestWire!({
    ...sameWorkerRequests[0],
    transcript: sameWorkerRequests[0].transcript.map((message) => {
      if (message.role !== 'assistant' || message.providerState === undefined) return message;
      const { providerState: _providerState, ...semantic } = message;
      return semantic;
    }),
  }).bodyBytes;
  ok(withReplayState > withoutReplayState);
  const reopenedHistoryFact = budgetObject(reopenedDeltas[0])?.recentHistoryProjection as {
    readonly status: string;
    readonly keptMessageRanges: readonly (readonly [number, number])[];
  };
  strictEqual(reopenedHistoryFact.status, 'partial');
  deepStrictEqual(reopenedHistoryFact.keptMessageRanges, historyFact.keptMessageRanges);
});
