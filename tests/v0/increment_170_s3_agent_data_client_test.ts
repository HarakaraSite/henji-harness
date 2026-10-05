import { deepStrictEqual, strictEqual } from 'node:assert';
import type {
  AgentDataPortRequest,
  AgentDataPortResponse,
  AgentFailureBarrier,
  AgentGenerationContextBasis,
  AgentProposalBarrier,
} from '../../v0/agent/data/agent_data_contract.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerReadyMessage,
  WorkerRuntimeEventMessage,
  WorkerTurnFailedMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { SemanticContextCheckpointV1 } from '../../v0/agent/session/session_store_contract.ts';

type ProbeResult =
  | Readonly<{ kind: 'basis'; basis: AgentGenerationContextBasis }>
  | Readonly<{
    kind: 'execution_markers';
    firstSequence: number;
    secondSequence: number;
    checkpointAccepted: boolean;
    marker: AgentProposalBarrier;
  }>
  | Readonly<{ kind: 'failure_marker'; marker: AgentFailureBarrier }>
  | Readonly<{ kind: 'pending_closed'; rejected: boolean; message?: string }>
  | Readonly<{ kind: 'probe_error'; message: string }>;

const correlation = (command: string): WorkerCorrelation => ({
  session: 'i170-s3-agent-data-session',
  instanceCorrelation: 'i170-s3-agent-data-instance',
  workerGeneration: 'i170-s3-agent-data-generation',
  baseStateRevision: 12,
  command,
});

const checkpointFor = (sessionId: string): SemanticContextCheckpointV1 => ({
  contextSchemaVersion: 1,
  sessionId,
  createdAt: '2026-10-03T00:00:00.000Z',
  sourceProfileId: 'test-profile',
  coveredThroughTurn: 1,
  retainedFromTurn: 2,
  summary: 'Agent Data port checkpoint.',
});

const workerRuntimeEvent = (
  correlationValue: WorkerCorrelation,
  sequence: number,
): WorkerRuntimeEventMessage => ({
  kind: 'runtime_event',
  correlation: correlationValue,
  sequence,
  event: { kind: 'ordered', sequence: sequence + 100 },
});

const waitForDataCount = (
  messages: readonly AgentDataPortRequest[],
  waiters: { readonly count: number; readonly resolve: () => void }[],
  count: number,
): Promise<void> => {
  if (messages.length >= count) return Promise.resolve();
  return new Promise<void>((resolve) => waiters.push({ count, resolve }));
};

Deno.test('Increment 170 S3 Agent Data client transfers context and execution data through a Worker port', async () => {
  const temporaryRoot = await Deno.makeTempDir({
    prefix: 'henji-i170-s3-agent-data-',
  });
  const clientModule = new URL(
    '../../v0/agent/data/agent_data_client.ts',
    import.meta.url,
  ).href;
  const workerSource = `
import { createAgentDataPortClient } from ${JSON.stringify(clientModule)};
self.onmessage = async (event) => {
  const input = event.data;
  const client = createAgentDataPortClient(input.port);
  try {
    const basis = await client.generationContext(input.contextCorrelation);
    self.postMessage({ kind: 'basis', basis });
    await client.ready(input.ready);
    await client.ready(input.updatedReady);
    client.beginExecution(input.executionId, input.executionCorrelation);
    const firstSequence = client.observation(input.observationOne);
    const checkpointAccepted = await client.checkpoint(input.checkpoint);
    const secondSequence = client.observation(input.observationTwo);
    const marker = client.sendProposal(input.proposal);
    self.postMessage({
      kind: 'execution_markers',
      firstSequence,
      secondSequence,
      checkpointAccepted,
      marker,
    });
    client.beginExecution(input.failureExecutionId, input.failureCorrelation);
    const failureMarker = client.sendFailure(input.failure);
    self.postMessage({ kind: 'failure_marker', marker: failureMarker });
    const pending = client.generationContext(input.pendingCorrelation);
    client.close();
    try {
      await pending;
      self.postMessage({ kind: 'pending_closed', rejected: false });
    } catch (error) {
      self.postMessage({
        kind: 'pending_closed',
        rejected: true,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    client.close();
    self.postMessage({
      kind: 'probe_error',
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
`;
  const workerScriptPath = `${temporaryRoot}/agent_data_client_probe.ts`;
  await Deno.writeTextFile(workerScriptPath, workerSource);

  const contextCorrelation = correlation('generation-context');
  const executionCorrelation = correlation('execution-one');
  const failureCorrelation = correlation('execution-two');
  const initialTranscript = [{
    role: 'user' as const,
    content: { kind: 'text' as const, text: 'loaded directly from Data' },
  }];
  const basis: AgentGenerationContextBasis = {
    initialTranscript,
    nextTurn: 4,
    stateRevision: 17,
    checkpoint: checkpointFor(contextCorrelation.session),
    modelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    privateStateFromTurn: 2,
  };
  const ready: WorkerReadyMessage = {
    kind: 'ready',
    correlation: contextCorrelation,
    manifest: {
      role: 'parent',
      maxSteps: 8,
      profileId: 'openrouter-chat:test-profile',
      resources: [],
      rootModel: ROOT_DEFAULT_MODEL_SELECTION,
    },
    startupSnapshot: {
      skillNames: [],
      context: {
        schemaVersion: 1,
        workspaceRoot: '/workspace',
        skillCatalog: { skills: [] },
        instructionComponents: [],
        toolDefinitions: [],
        systemInstruction: 'Full context snapshot delivered to Data.',
        runtimeFacts: { cwd: '/workspace' },
      },
    },
  };
  const updatedReady: WorkerReadyMessage = {
    ...ready,
    manifest: {
      ...ready.manifest!,
      profileId: 'local-chat:test-profile',
      rootModel: {
        provider: 'openai-responses',
        api: 'openai-responses',
        modelId: 'gpt-4.1-mini',
        authProfile: 'openai-api-key',
        effort: 'auto',
      },
    },
  };
  const observationOne = workerRuntimeEvent(executionCorrelation, 41);
  const observationTwo = workerRuntimeEvent(executionCorrelation, 42);
  const checkpoint: WorkerCheckpointProposalMessage = {
    kind: 'checkpoint_proposal',
    correlation: executionCorrelation,
    checkpoint: checkpointFor(executionCorrelation.session),
    heldUserText: 'held until checkpoint ACK',
  };
  const proposal: WorkerCommitProposalMessage = {
    kind: 'commit_proposal',
    correlation: executionCorrelation,
    transcript: [
      ...initialTranscript,
      {
        role: 'assistant',
        content: { kind: 'text', text: 'full proposal remains on Data port' },
      },
    ],
    nextTurn: 5,
  };
  const failure: WorkerTurnFailedMessage = {
    kind: 'turn_failed',
    correlation: failureCorrelation,
    outcome: {
      ok: false,
      task: 'provider-free failure fixture',
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      error: 'fixture failure',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: initialTranscript,
    },
  };

  const channel = new MessageChannel();
  const dataMessages: AgentDataPortRequest[] = [];
  const dataCountWaiters: {
    readonly count: number;
    readonly resolve: () => void;
  }[] = [];
  const workerMessages: ProbeResult[] = [];
  const workerWaiters: {
    readonly predicate: (message: ProbeResult) => boolean;
    readonly resolve: (message: ProbeResult) => void;
  }[] = [];
  const worker = new Worker(new URL(`file://${workerScriptPath}`), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<ProbeResult>): void => {
    const message = event.data;
    workerMessages.push(message);
    const waiterIndex = workerWaiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = workerWaiters.splice(waiterIndex, 1);
      waiter?.resolve(message);
    }
  };
  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    const message: ProbeResult = {
      kind: 'probe_error',
      message: event.message,
    };
    workerMessages.push(message);
    for (const waiter of workerWaiters.splice(0)) waiter.resolve(message);
  };
  channel.port2.onmessage = (
    event: MessageEvent<AgentDataPortRequest>,
  ): void => {
    const message = event.data;
    dataMessages.push(message);
    for (let index = dataCountWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = dataCountWaiters[index]!;
      if (dataMessages.length >= waiter.count) {
        dataCountWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
    if (message.kind === 'generation_context' && message.requestId === 1) {
      const response: AgentDataPortResponse = {
        kind: 'generation_context_result',
        requestId: message.requestId,
        correlation: message.correlation,
        basis,
      };
      channel.port2.postMessage(response);
    } else if (message.kind === 'ready') {
      const response: AgentDataPortResponse = {
        kind: 'ready_acknowledgement',
        requestId: message.requestId,
        correlation: message.message.correlation,
      };
      channel.port2.postMessage(response);
    } else if (message.kind === 'checkpoint_proposal') {
      const response: AgentDataPortResponse = {
        kind: 'checkpoint_acknowledgement',
        requestId: message.requestId,
        correlation: message.message.correlation,
        accepted: true,
      };
      channel.port2.postMessage(response);
    }
  };
  channel.port2.start();

  const waitForWorker = async (
    predicate: (message: ProbeResult) => boolean,
  ): Promise<ProbeResult> => {
    const queued = workerMessages.find(predicate);
    if (queued !== undefined) return queued;
    return await new Promise<ProbeResult>((resolve) => {
      workerWaiters.push({ predicate, resolve });
    });
  };

  try {
    worker.postMessage({
      port: channel.port1,
      contextCorrelation,
      ready,
      updatedReady,
      executionId: 'i170-execution-one',
      executionCorrelation,
      observationOne,
      checkpoint,
      observationTwo,
      proposal,
      failureExecutionId: 'i170-execution-two',
      failureCorrelation,
      failure,
      pendingCorrelation: correlation('pending-context-before-close'),
    }, [channel.port1]);

    const basisResult = await waitForWorker((message) => message.kind === 'basis');
    strictEqual(basisResult.kind, 'basis');
    if (basisResult.kind !== 'basis') {
      throw new Error('Worker returned no context basis');
    }
    deepStrictEqual(basisResult.basis, basis);

    const executionResult = await waitForWorker((message) => message.kind === 'execution_markers');
    strictEqual(executionResult.kind, 'execution_markers');
    if (executionResult.kind !== 'execution_markers') {
      throw new Error('Worker returned no proposal marker');
    }
    deepStrictEqual({
      firstSequence: executionResult.firstSequence,
      secondSequence: executionResult.secondSequence,
      checkpointAccepted: executionResult.checkpointAccepted,
    }, { firstSequence: 1, secondSequence: 3, checkpointAccepted: true });
    strictEqual('transcript' in executionResult.marker, false);
    strictEqual(executionResult.marker.finalDataSequence, 4);

    const failureResult = await waitForWorker((message) => message.kind === 'failure_marker');
    strictEqual(failureResult.kind, 'failure_marker');
    if (failureResult.kind !== 'failure_marker') {
      throw new Error('Worker returned no failure marker');
    }
    deepStrictEqual(failureResult.marker, {
      correlation: failureCorrelation,
      finalDataSequence: 1,
    });

    const closedResult = await waitForWorker((message) => message.kind === 'pending_closed');
    strictEqual(closedResult.kind, 'pending_closed');
    if (closedResult.kind !== 'pending_closed') {
      throw new Error('Worker did not close a pending request');
    }
    strictEqual(closedResult.rejected, true);
    strictEqual(closedResult.message, 'Agent Data port closed');

    await waitForDataCount(dataMessages, dataCountWaiters, 10);
    const [
      contextRequest,
      readyMessage,
      updatedReadyMessage,
      beginOne,
      dataOne,
      checkpointMessage,
      dataTwo,
      proposalMessage,
      beginTwo,
      failureMessage,
    ] = dataMessages;
    strictEqual(contextRequest?.kind, 'generation_context');
    deepStrictEqual(readyMessage, {
      kind: 'ready',
      requestId: 2,
      message: ready,
    });
    deepStrictEqual(updatedReadyMessage, {
      kind: 'ready',
      requestId: 3,
      message: updatedReady,
    });
    deepStrictEqual(beginOne, {
      kind: 'begin_execution',
      executionId: 'i170-execution-one',
      correlation: executionCorrelation,
    });
    deepStrictEqual(dataOne, {
      kind: 'execution_data',
      executionId: 'i170-execution-one',
      sequence: 1,
      message: observationOne,
    });
    deepStrictEqual(checkpointMessage, {
      kind: 'checkpoint_proposal',
      requestId: 4,
      executionId: 'i170-execution-one',
      sequence: 2,
      message: checkpoint,
    });
    deepStrictEqual(dataTwo, {
      kind: 'execution_data',
      executionId: 'i170-execution-one',
      sequence: 3,
      message: observationTwo,
    });
    strictEqual(proposalMessage?.kind, 'proposal');
    if (proposalMessage?.kind !== 'proposal') {
      throw new Error('Data did not receive proposal');
    }
    deepStrictEqual(proposalMessage.message, proposal);
    strictEqual(proposalMessage.sequence, 4);
    strictEqual(proposalMessage.proposalId, executionResult.marker.proposalId);
    deepStrictEqual(beginTwo, {
      kind: 'begin_execution',
      executionId: 'i170-execution-two',
      correlation: failureCorrelation,
    });
    deepStrictEqual(failureMessage, {
      kind: 'failure',
      executionId: 'i170-execution-two',
      sequence: 1,
      message: failure,
    });
  } finally {
    channel.port2.close();
    worker.terminate();
    await Deno.remove(temporaryRoot, { recursive: true });
  }
});
