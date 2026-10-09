import { deepStrictEqual, strictEqual } from 'node:assert';
import type {
  AgentDataPortRequest,
  AgentDataPortResponse,
  AgentGenerationContextBasis,
  ContextTurnRead,
} from '../../v0/agent/data/agent_data_contract.ts';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import type {
  WorkerCancelReceivedMessage,
  WorkerCorrelation,
  WorkerErrorMessage,
  WorkerFailureReadyMessage,
  WorkerProposalReadyMessage,
  WorkerReadyMessage,
  WorkerRequestCountMessage,
  WorkerRuntimeEventMessage,
  WorkerToHostMessage,
  WorkerTurnSettledMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { SemanticContextCheckpointV1 } from '../../v0/agent/session/session_store_contract.ts';
import type { RecalledExecutionContext } from '../../v0/agent/worker/recalled_execution_context.ts';

const workerUrl = new URL(
  '../../v0/agent/worker/worker_bootstrap.ts',
  import.meta.url,
);

const persistedMessageBytes = (messages: readonly Message[]): number =>
  messages.reduce(
    (total, message) => total + new TextEncoder().encode(JSON.stringify(message)).byteLength,
    0,
  );

const correlation = (
  command: string,
  stateRevision = 17,
): WorkerCorrelation => ({
  session: 'i170-s3-commit-waiter-session',
  instanceCorrelation: 'i170-s3-commit-waiter-instance',
  workerGeneration: 'i170-s3-commit-waiter-generation',
  baseStateRevision: stateRevision,
  command,
});

const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const isReadyOrError = (
  message: WorkerToHostMessage,
): message is WorkerReadyMessage | WorkerErrorMessage =>
  message.kind === 'ready' || message.kind === 'worker_error';

const isProposalReadyFor = (
  message: WorkerToHostMessage,
  expectedCorrelation: WorkerCorrelation,
): message is WorkerProposalReadyMessage =>
  message.kind === 'proposal_ready' &&
  sameCorrelation(message.correlation, expectedCorrelation);

const isFailureReadyFor = (
  message: WorkerToHostMessage,
  expectedCorrelation: WorkerCorrelation,
): message is WorkerFailureReadyMessage =>
  message.kind === 'failure_ready' &&
  sameCorrelation(message.correlation, expectedCorrelation);

const isCancelReceivedFor = (
  message: WorkerToHostMessage,
  expectedCorrelation: WorkerCorrelation,
): message is WorkerCancelReceivedMessage =>
  message.kind === 'cancel_received' &&
  sameCorrelation(message.correlation, expectedCorrelation);

const isTurnSettledFor = (
  message: WorkerToHostMessage,
  expectedCorrelation: WorkerCorrelation,
): message is WorkerTurnSettledMessage =>
  message.kind === 'turn_settled' &&
  sameCorrelation(message.correlation, expectedCorrelation);

const isOrdered = (
  message: WorkerToHostMessage,
  expectedCorrelation: WorkerCorrelation,
  sequence: number,
): message is WorkerRuntimeEventMessage =>
  message.kind === 'runtime_event' &&
  sameCorrelation(message.correlation, expectedCorrelation) &&
  message.event.kind === 'ordered' && message.event.sequence === sequence;

const checkpointFor = (sessionId: string): SemanticContextCheckpointV1 => ({
  contextSchemaVersion: 1,
  sessionId,
  createdAt: '2026-10-03T00:00:00.000Z',
  sourceProfileId: 'test-profile',
  coveredThroughTurn: 1,
  retainedFromTurn: 2,
  summary: 'Core-supplied checkpoint must be ignored.',
});

interface DataWaiter {
  readonly predicate: (message: AgentDataPortRequest) => boolean;
  readonly resolve: (message: AgentDataPortRequest) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ControlWaiter {
  readonly predicate: (message: WorkerToHostMessage) => boolean;
  readonly resolve: (message: WorkerToHostMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

Deno.test('Increment 170 S3 Worker sends generation data through Data while Core owns the commit decision', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-commit-waiter-' });
  const capsule = new WorkerCapsule(workerUrl);
  const messages: WorkerToHostMessage[] = [];
  const dataMessages: AgentDataPortRequest[] = [];
  const dataWaiters: DataWaiter[] = [];
  const controlWaiters: ControlWaiter[] = [];
  const unsubscribe = capsule.subscribe((message) => {
    messages.push(message);
    for (let index = controlWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = controlWaiters[index]!;
      if (!waiter.predicate(message)) continue;
      controlWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const dataChannel = new MessageChannel();
  const dataTranscript = [
    {
      role: 'user' as const,
      content: { kind: 'text' as const, text: 'Data-owned previous task' },
    },
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: 'Data-owned previous answer' },
    },
  ];
  const canonicalTurns: ContextTurnRead[] = [{
    turn: 1,
    executionId: 'execution-data-owned-turn-1',
    messages: dataTranscript,
    messageStart: 0,
    source: 'canonical',
    byteLength: persistedMessageBytes(dataTranscript),
  }];
  let canonicalMessageCount = dataTranscript.length;
  let canonicalNextTurn = 2;
  let canonicalStateRevision = 17;
  const recalledContext: RecalledExecutionContext = {
    schemaVersion: 1,
    sourceExecutionId: 'execution-recalled-from-data',
    sessionId: correlation('start').session,
    turn: 1,
    settlement: 'uncommitted',
    stopReason: 'cancelled',
    task: 'prior interrupted task',
    evidence: 'available',
    observations: [{
      kind: 'assistant_completed',
      modelStep: 1,
      text: 'recalled context must arrive through Data',
    }],
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  const generationBasisFor = (
    requestCorrelation: WorkerCorrelation,
  ): AgentGenerationContextBasis => ({
    initialTranscript: [],
    nextTurn: canonicalNextTurn,
    stateRevision: canonicalStateRevision,
    canonicalMessageCount,
    historySource: 'canonical',
    modelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    privateStateFromTurn: 1,
    ...(requestCorrelation.command === 'accepted-after-cancel' ? { recalledContext } : {}),
  });
  const receiveData = (message: AgentDataPortRequest): void => {
    dataMessages.push(message);
    for (let index = dataWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = dataWaiters[index]!;
      if (!waiter.predicate(message)) continue;
      dataWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    if (message.kind === 'generation_context') {
      const response: AgentDataPortResponse = {
        kind: 'generation_context_result',
        requestId: message.requestId,
        correlation: message.correlation,
        basis: generationBasisFor(message.correlation),
      };
      dataChannel.port2.postMessage(response);
    } else if (message.kind === 'context_turn_read') {
      const found = [...canonicalTurns].reverse().find((turn) => turn.turn < message.beforeTurn) ??
        null;
      const response: AgentDataPortResponse = {
        kind: 'context_turn_result',
        requestId: message.requestId,
        correlation: message.correlation,
        turn: found,
      };
      dataChannel.port2.postMessage(response);
    } else if (message.kind === 'ready') {
      const response: AgentDataPortResponse = {
        kind: 'ready_acknowledgement',
        requestId: message.requestId,
        correlation: message.message.correlation,
      };
      dataChannel.port2.postMessage(response);
    } else if (message.kind === 'checkpoint_proposal') {
      dataChannel.port2.postMessage(
        {
          kind: 'checkpoint_acknowledgement',
          requestId: message.requestId,
          correlation: message.message.correlation,
          accepted: true,
        } satisfies AgentDataPortResponse,
      );
    }
  };
  dataChannel.port2.onmessage = (
    event: MessageEvent<AgentDataPortRequest>,
  ): void => {
    receiveData(event.data);
  };
  dataChannel.port2.start();
  const waitForControl = <T extends WorkerToHostMessage>(
    predicate: (message: WorkerToHostMessage) => message is T,
  ): Promise<T> => {
    const found = messages.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = controlWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) controlWaiters.splice(index, 1);
        reject(new Error('timed out waiting for Worker control message'));
      }, 5_000);
      controlWaiters.push({
        predicate,
        resolve: (message) => resolve(message as T),
        reject,
        timer,
      });
    });
  };
  const waitForData = (
    predicate: (message: AgentDataPortRequest) => boolean,
  ): Promise<AgentDataPortRequest> => {
    const found = dataMessages.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = dataWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) dataWaiters.splice(index, 1);
        reject(new Error('timed out waiting for Worker Data message'));
      }, 5_000);
      dataWaiters.push({ predicate, resolve, reject, timer });
    });
  };

  try {
    const readyPromise = waitForControl(isReadyOrError);
    capsule.send({
      kind: 'start',
      correlation: correlation('start'),
      dataPort: dataChannel.port1,
      agentChoice: {},
      configRoot: `${root}/config`,
      credentialRoot: `${root}/credentials`,
      workspaceRoot: root,
      physicalIoMode: 'provider-free',
      // These stale Core-owned basis values must not seed the real Worker generation.
      initialTranscript: [{
        role: 'user',
        content: {
          kind: 'text',
          text: 'Core-owned transcript must be ignored',
        },
      }],
      nextTurn: 99,
      checkpoint: checkpointFor(correlation('start').session),
      privateStateFromTurn: 99,
    }, [dataChannel.port1]);
    const startupMessage = await readyPromise;
    if (startupMessage.kind !== 'ready') {
      throw new Error(`Worker startup failed: ${startupMessage.message}`);
    }
    const ready = startupMessage;
    const dataReady = await waitForData((message) => message.kind === 'ready');
    if (dataReady.kind !== 'ready') {
      throw new Error('Agent Data did not receive Worker ready');
    }
    strictEqual(ready.startupSnapshot?.context, undefined);
    strictEqual(dataReady.message.startupSnapshot?.context?.schemaVersion, 1);

    const acceptedTurn = correlation('accepted-after-cancel');
    const acceptedExecutionId = 'execution-accepted-after-cancel';
    capsule.send({
      kind: 'turn',
      executionId: acceptedExecutionId,
      correlation: acceptedTurn,
      task: 'read the Data-owned basis',
    });
    const acceptedProposalRequest = await waitForData((message) =>
      message.kind === 'proposal' && message.executionId === acceptedExecutionId
    );
    if (acceptedProposalRequest.kind !== 'proposal') {
      throw new Error('Agent Data did not receive the full proposal');
    }
    const acceptedProposal = acceptedProposalRequest.message;
    const historyRead = await waitForData((message) =>
      message.kind === 'context_turn_read' &&
      message.beforeTurn === 2 &&
      sameCorrelation(message.correlation, acceptedTurn)
    );
    if (historyRead.kind !== 'context_turn_read') {
      throw new Error('Worker did not request Data-owned history context');
    }
    strictEqual(historyRead.beforeTurn, 2);
    deepStrictEqual(
      canonicalTurns.find((turn) => turn.turn < historyRead.beforeTurn)?.messages,
      dataTranscript,
    );
    strictEqual(acceptedProposal.nextTurn, 3);
    const acceptedBarrier = await waitForControl(
      (message): message is WorkerProposalReadyMessage => isProposalReadyFor(message, acceptedTurn),
    );
    strictEqual(acceptedBarrier.proposalId, acceptedProposalRequest.proposalId);
    strictEqual(
      acceptedBarrier.finalDataSequence,
      acceptedProposalRequest.sequence,
    );
    strictEqual('transcript' in acceptedBarrier, false);
    strictEqual('outcome' in acceptedBarrier, false);

    const requestCount = await waitForControl(
      (message): message is WorkerRequestCountMessage =>
        message.kind === 'request_count' &&
        sameCorrelation(message.correlation, acceptedTurn),
    );
    strictEqual(requestCount.executionId, acceptedExecutionId);
    strictEqual(
      requestCount.turnProviderRequestCount,
      acceptedProposal.outcome?.turnProviderRequestCount,
    );
    const preCommitExecutionData = dataMessages.filter((message) =>
      (message.kind === 'execution_data' || message.kind === 'proposal') &&
      message.executionId === acceptedExecutionId
    );
    const contextBytes: string[] = [];
    const contextDeltas: string[] = [];
    for (const message of preCommitExecutionData) {
      if (
        message.kind !== 'execution_data' ||
        message.message.kind !== 'context_observation'
      ) {
        continue;
      }
      contextDeltas.push(JSON.stringify(message.message.observation.delta));
      for (const occurrence of message.message.observation.delta.occurrences) {
        if (occurrence.bytesBase64 !== undefined) {
          contextBytes.push(
            new TextDecoder().decode(
              Uint8Array.fromBase64(occurrence.bytesBase64),
            ),
          );
        }
      }
    }
    strictEqual(
      contextDeltas.some((value) => value.includes('recall:execution-recalled-from-data')),
      true,
    );
    strictEqual(
      contextBytes.some((value) => value.includes('Core-supplied checkpoint must be ignored.')),
      false,
    );

    // The producer has completed normally before proposing. Cancel while the explicit Core
    // decision is pending, and verify the proposal waiter stays open for that decision.
    const cancelCorrelation = correlation('cancel-after-proposal');
    capsule.send({ kind: 'cancel', correlation: cancelCorrelation });
    await waitForControl((message): message is WorkerCancelReceivedMessage =>
      isCancelReceivedFor(message, cancelCorrelation)
    );
    const cancellationBarrier = correlation('after-cancel-barrier');
    capsule.send({
      kind: 'ordered',
      correlation: cancellationBarrier,
      sequence: 1,
    });
    await waitForControl((message): message is WorkerRuntimeEventMessage =>
      isOrdered(message, cancellationBarrier, 1)
    );
    strictEqual(
      messages.some((message) =>
        (message.kind === 'failure_ready' || message.kind === 'turn_failed') &&
        sameCorrelation(message.correlation, acceptedTurn)
      ),
      false,
    );

    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: acceptedTurn,
      accepted: true,
    });
    const acceptedMessages = acceptedProposal.transcript;
    canonicalTurns.push({
      turn: canonicalNextTurn,
      executionId: acceptedExecutionId,
      messages: acceptedMessages,
      messageStart: canonicalMessageCount,
      source: 'canonical',
      byteLength: persistedMessageBytes(acceptedMessages),
    });
    canonicalMessageCount += acceptedProposal.transcript.length;
    canonicalNextTurn = acceptedProposal.nextTurn;
    canonicalStateRevision += 1;
    const acceptedTerminalData = await waitForData((message) =>
      message.kind === 'execution_data' &&
      message.executionId === acceptedExecutionId &&
      message.message.kind === 'runtime_event' &&
      message.message.event.kind === 'agent_event' &&
      message.message.event.event.kind === 'turn_end'
    );
    if (acceptedTerminalData.kind !== 'execution_data') {
      throw new Error('accepted commit terminal fact was not sent to Data');
    }
    if (
      acceptedTerminalData.message.kind !== 'runtime_event' ||
      acceptedTerminalData.message.event.kind !== 'agent_event' ||
      acceptedTerminalData.message.event.event.kind !== 'turn_end'
    ) throw new Error('accepted commit terminal fact has an unexpected shape');
    strictEqual(acceptedTerminalData.message.event.event.committed, true);
    await waitForControl((message): message is WorkerTurnSettledMessage =>
      isTurnSettledFor(message, acceptedTurn)
    );
    const acceptedBarrierCorrelation = correlation('after-accepted-barrier');
    capsule.send({
      kind: 'ordered',
      correlation: acceptedBarrierCorrelation,
      sequence: 2,
    });
    await waitForControl((message): message is WorkerRuntimeEventMessage =>
      isOrdered(message, acceptedBarrierCorrelation, 2)
    );

    const acceptedExecutionData = dataMessages.filter((message) =>
      (message.kind === 'execution_data' || message.kind === 'proposal') &&
      message.executionId === acceptedExecutionId
    );
    deepStrictEqual(
      acceptedExecutionData.map((message) => 'sequence' in message ? message.sequence : -1),
      acceptedExecutionData.map((_, index) => index + 1),
    );
    strictEqual(acceptedExecutionData.at(-1)?.kind, 'execution_data');
    const acceptedObservationKinds = new Set<string>(
      acceptedExecutionData.flatMap((message) =>
        message.kind === 'execution_data' ? [message.message.kind] : []
      ),
    );
    deepStrictEqual(
      ['context_observation', 'provider_observation', 'runtime_event']
        .filter((kind) => !acceptedObservationKinds.has(kind)),
      [],
    );
    strictEqual(
      acceptedExecutionData.some((message) =>
        message.kind === 'execution_data' &&
        message.message.kind === 'provider_observation' &&
        message.message.observation.kind === 'runtime_event' &&
        (message.message.observation.event.kind === 'tool_call' ||
          message.message.observation.event.kind === 'tool_result')
      ),
      true,
    );
    strictEqual(
      messages.some((message) =>
        message.kind === 'runtime_event' &&
        message.event.kind === 'agent_event' &&
        sameCorrelation(message.correlation, acceptedTurn)
      ),
      false,
    );
    strictEqual(
      messages.some((message) =>
        message.kind === 'effect_observation' ||
        message.kind === 'provider_observation' ||
        message.kind === 'context_observation'
      ),
      false,
    );

    const rejectedTurn = correlation('explicit-rejection', 18);
    const rejectedExecutionId = 'execution-explicit-rejection';
    capsule.send({
      kind: 'turn',
      executionId: rejectedExecutionId,
      correlation: rejectedTurn,
      task: 'commit waiter provider-free rejection',
    });
    const rejectedProposalRequest = await waitForData((message) =>
      message.kind === 'proposal' && message.executionId === rejectedExecutionId
    );
    if (rejectedProposalRequest.kind !== 'proposal') {
      throw new Error('Agent Data did not receive the rejected proposal');
    }
    const rejectedBarrier = await waitForControl(
      (message): message is WorkerProposalReadyMessage => isProposalReadyFor(message, rejectedTurn),
    );
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: rejectedTurn,
      accepted: false,
    });
    const failureRequest = await waitForData((message) =>
      message.kind === 'failure' && message.executionId === rejectedExecutionId
    );
    if (failureRequest.kind !== 'failure') {
      throw new Error('Agent Data did not receive the full rejected failure');
    }
    strictEqual(failureRequest.message.outcome.stopReason, 'contract_failure');
    const failureBarrier = await waitForControl(
      (message): message is WorkerFailureReadyMessage => isFailureReadyFor(message, rejectedTurn),
    );
    strictEqual(failureBarrier.finalDataSequence, failureRequest.sequence);
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: rejectedTurn,
      accepted: false,
      settlement: {
        accepted: false,
        adopted: false,
        durable: true,
        stateRevision: canonicalStateRevision,
        terminalOutcome: {
          ok: failureRequest.message.outcome.ok,
          outcome: failureRequest.message.outcome.outcome,
          stopReason: failureRequest.message.outcome.stopReason,
          ...(failureRequest.message.outcome.error === undefined ? {} : {
            error: failureRequest.message.outcome.error,
          }),
        },
      },
    });
    strictEqual(rejectedBarrier.correlation.command, rejectedTurn.command);
    const rejectedBarrierCorrelation = correlation('after-rejected-barrier');
    capsule.send({
      kind: 'ordered',
      correlation: rejectedBarrierCorrelation,
      sequence: 3,
    });
    await waitForControl((message): message is WorkerRuntimeEventMessage =>
      isOrdered(message, rejectedBarrierCorrelation, 3)
    );
    strictEqual(
      messages.some((message) =>
        message.kind === 'turn_failed' &&
        sameCorrelation(message.correlation, rejectedTurn)
      ),
      false,
    );
    strictEqual(
      dataMessages.some((message) =>
        message.kind === 'execution_data' &&
        message.executionId === rejectedExecutionId &&
        message.message.kind === 'runtime_event' &&
        message.message.event.kind === 'agent_event' &&
        message.message.event.event.kind === 'turn_end'
      ),
      false,
    );
    await waitForControl((message): message is WorkerTurnSettledMessage =>
      isTurnSettledFor(message, rejectedTurn)
    );

    // Rejected acknowledgement cleanup includes asynchronous context finalization. A task
    // admitted after this receipt must see an idle runtime rather than report itself busy.
    const followupTurn = correlation('after-rejection-idle', 18);
    const followupExecutionId = 'execution-after-rejection-idle';
    capsule.send({
      kind: 'turn',
      executionId: followupExecutionId,
      correlation: followupTurn,
      task: 'run after rejected acknowledgement cleanup',
    });
    const followupProposal = await waitForData((message) =>
      message.kind === 'proposal' && message.executionId === followupExecutionId
    );
    if (followupProposal.kind !== 'proposal') {
      throw new Error('Worker stayed busy after rejected turn settled');
    }
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: followupTurn,
      accepted: true,
    });
    await waitForControl((message): message is WorkerTurnSettledMessage =>
      isTurnSettledFor(message, followupTurn)
    );
    deepStrictEqual(
      dataMessages.filter((message) => message.kind === 'generation_context')
        .map(
          (message) => message.correlation.command,
        ),
      [
        'start',
        'accepted-after-cancel',
        'explicit-rejection',
        'after-rejection-idle',
      ],
    );
  } finally {
    unsubscribe();
    dataChannel.port2.close();
    capsule.terminate();
    await Deno.remove(root, { recursive: true });
  }
});
