import type { Message, Model, ModelResult } from '../../v0/agent/core/contracts.ts';
import type { ContextModelRequestDelta } from '../../v0/agent/history/context_attribution.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerCommitProposalMessage } from '../../v0/agent/worker/worker_protocol.ts';

const assert: (
  condition: unknown,
  message?: string,
) => asserts condition = (
  condition: unknown,
  message = 'assertion failed',
): asserts condition => {
  if (!condition) throw new Error(message);
};

const assertEquals = (left: unknown, right: unknown): void => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
};

Deno.test('Increment 89 sends one initial context revision and suffix-only deltas', async () => {
  const longText = 'long committed context '.repeat(12_000);
  const initialTranscript: Message[] = [{
    role: 'user',
    content: { kind: 'text', text: 'prior task' },
  }, {
    role: 'assistant',
    content: { kind: 'text', text: longText },
  }, {
    role: 'user',
    content: { kind: 'text', text: 'prior task' },
  }, {
    role: 'assistant',
    content: { kind: 'text', text: longText },
  }];
  let step = 0;
  const model: Model = {
    generate(): ModelResult {
      step += 1;
      if (step < 3) {
        return {
          kind: 'tool_calls',
          calls: [{
            callId: `echo-${step}`,
            name: 'echo',
            arguments: { value: 'same result' },
          }],
        };
      }
      return { kind: 'final', text: 'done' };
    },
  };
  const echo = {
    name: 'echo',
    description: 'return a fixed result',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute: () => 'same result',
  };
  const composition = {
    role: 'parent',
    model,
    registry: new Registry([echo]),
    maxSteps: 3,
    manifest: {
      role: 'parent',
      maxSteps: 3,
      profileId: 'increment-89-provider-free',
      resources: ['tool:echo'],
    },
  } as unknown as WorkerAgentComposition;
  let sequence = 0;
  const deltas: ContextModelRequestDelta[] = [];
  let proposal: WorkerCommitProposalMessage | undefined;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => ++sequence,
    effectObservation: () => ++sequence,
    contextObservation: (_correlation, delta) => {
      deltas.push(structuredClone(delta));
      return ++sequence;
    },
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
  const generation = new WorkerGeneration(
    composition,
    '70000000-0000-4000-8000-000000000089',
    port,
    initialTranscript,
    3,
    undefined,
    undefined,
    ROOT_DEFAULT_MODEL_SELECTION,
  );
  await generation.runTurn({
    session: '70000000-0000-4000-8000-000000000089',
    instanceCorrelation: 'increment-89-instance',
    workerGeneration: 'increment-89-generation',
    baseStateRevision: 1,
    command: 'turn-3',
  }, 'current task');

  assertEquals(deltas.length, 3);
  assertEquals(deltas.map((delta) => delta.baseRevisionDigest), [
    undefined,
    deltas[0].revisionDigest,
    deltas[1].revisionDigest,
  ]);
  assertEquals(deltas.map((delta) => delta.resultItemCount), [6, 8, 10]);
  assertEquals(deltas.map((delta) => delta.splices[0].start), [0, 5, 7]);
  assertEquals(
    deltas.map((delta) => delta.occurrences.map((item) => item.kind)),
    [
      ['message', 'message', 'message', 'message', 'message', 'tool_contract'],
      ['message', 'message'],
      ['message', 'message'],
    ],
  );

  const initialLongOccurrences = deltas[0].occurrences.filter((occurrence) =>
    occurrence.content.byteLength > 200_000
  );
  assertEquals(initialLongOccurrences.length, 2);
  assertEquals(
    initialLongOccurrences[0].content.digest,
    initialLongOccurrences[1].content.digest,
  );
  assert(initialLongOccurrences[0].bytesBase64 !== undefined);
  assertEquals(initialLongOccurrences[1].bytesBase64, undefined);
  assert(
    deltas.slice(1).every((delta) =>
      delta.occurrences.every((occurrence) =>
        occurrence.content.digest !== initialLongOccurrences[0].content.digest
      )
    ),
    'a later delta resent the long committed context',
  );
  assertEquals(
    deltas.slice(1).flatMap((delta) => delta.occurrences)
      .filter((occurrence) => occurrence.kind === 'tool_contract').length,
    0,
  );
  const resultOccurrences = deltas.slice(1).map((delta) =>
    delta.occurrences.find((occurrence) =>
      occurrence.sourceRelations.some((source) =>
        source.logicalIdentity?.startsWith('tool-result:')
      )
    )
  );
  assert(resultOccurrences.every((occurrence) => occurrence !== undefined));
  assert(resultOccurrences[0]?.bytesBase64 !== undefined);
  assert(resultOccurrences[1]?.bytesBase64 !== undefined);

  const occurrenceIds = deltas.flatMap((delta) =>
    delta.occurrences.map((occurrence) => occurrence.occurrenceId)
  );
  assertEquals(new Set(occurrenceIds).size, occurrenceIds.length);
  const currentSources = deltas.flatMap((delta) => delta.occurrences)
    .flatMap((occurrence) => occurrence.sourceRelations)
    .filter((source) =>
      source.logicalIdentity?.startsWith('current-task:') ||
      source.logicalIdentity?.startsWith('current-execution:') ||
      source.logicalIdentity?.startsWith('tool-result:')
    );
  assert(currentSources.length > 0);
  assert(
    currentSources.every((source) => source.sourceWorkerSequence !== undefined),
    'a current-execution source lost its direct Worker sequence',
  );
  assertEquals(
    proposal?.contextManifest?.requests,
    deltas.map((delta) => ({
      requestOrdinal: delta.requestOrdinal,
      revisionDigest: delta.revisionDigest,
    })),
  );
});
