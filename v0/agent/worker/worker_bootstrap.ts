import { readContextBudget } from '../session/context_budget.ts';
import { captureFailureDetails } from '../core/failure_details.ts';
import type { AfterTurnSettlement } from '../core/hook_effect.ts';
import { WorkerProcessExecutor } from './worker_process_executor.ts';
import {
  type DataValue,
  parseWorkerHostCommand,
  type WorkerChildProgressMessage,
  type WorkerCorrelation,
  type WorkerEffectObservation,
  type WorkerHookFailure,
  type WorkerHostCommand,
  type WorkerReadyMessage,
  type WorkerRuntimeEvent,
  type WorkerRuntimeIdentityInput,
  type WorkerToHostMessage,
} from './worker_protocol.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type { ProviderDeclarationV1 } from '../provider/provider_declaration.ts';
import type { AsyncAgentRequest, AsyncAgentResponse } from '../tools/async_agents.ts';
import { setActiveProviderDeclarations } from '../provider/provider_runtime.ts';
import type { Model } from '../core/contracts.ts';
import { createConfiguredWorkerComposition } from './worker_configuration.ts';
import { resolveWorkerConfiguration } from '../configuration/configuration_resolver.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { ConfigurationRejection } from '../configuration/agent_configuration.ts';
import { WorkerGeneration, type WorkerGenerationPort } from './worker_runtime.ts';
import { createProductionPhysicalIo, createWorkerRequestCounter } from './worker_physical_io.ts';
import { createProviderFreePhysicalIo } from './worker_probe_physical_io.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { discoverAgentInstructionSnapshot } from '../definitions/agent_instructions.ts';
import { discoverSkills } from '../definitions/skills.ts';
import {
  type ModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import {
  builtinHenjiBaseInstruction,
  type SelectedHenjiBaseInstruction,
  verifySelectedHenjiBaseInstruction,
} from '../instructions/base_instruction.ts';
import { selectWorkerHenjiBaseInstruction } from '../instructions/worker_core_finalizer.ts';
import type { WorkerContextSnapshot } from '../history/context_attribution.ts';
import { recordWorkerStage, type WorkerStageName } from './worker_stage_probe.ts';
import { TurnCancelledError } from '../core/cancellation.ts';
import { createAgentDataPortClient } from '../data/agent_data_client.ts';
import type { AgentDataPortClient } from '../data/agent_data_contract.ts';
import type { HookRuntimeIdentity } from '../hook_api.ts';

type WorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => boolean | void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (message: WorkerToHostMessage) => void;
  close: () => void;
};

const scope = globalThis as unknown as WorkerScope;
let eventSequence = 0;
let activeCorrelation: WorkerCorrelation | undefined;
let processExecutor: WorkerProcessExecutor | undefined;
let processContext:
  | { correlation: WorkerCorrelation; executionId?: string }
  | undefined;
let generation: WorkerGeneration | undefined;
let diagnosticStageBuffer: SharedArrayBuffer | undefined;
let auxiliaryStageGapMs: number | undefined;
let agentDataClient: AgentDataPortClient | undefined;
const preparingTurns = new Map<
  string,
  { readonly correlation: WorkerCorrelation; cancelRequested: boolean }
>();
let activeTurnPromise: Promise<void> | undefined;

const reportAuxiliaryStage = (
  stage: WorkerStageName,
  expectedWorkerSequence = 0,
): void => {
  if (diagnosticStageBuffer === undefined) return;
  try {
    recordWorkerStage(
      diagnosticStageBuffer,
      stage,
      expectedWorkerSequence,
    );
  } catch {
    // Diagnostics never narrow or fail the product path.
  }
};

type PendingAcknowledgement = {
  readonly correlation: WorkerCorrelation;
  readonly finish: (value: boolean | AfterTurnSettlement) => void;
};

const acknowledgements = new Map<string, PendingAcknowledgement>();

const post = (message: WorkerToHostMessage): void => scope.postMessage(message);

const runtimeEvent = (
  correlation: WorkerCorrelation,
  event: WorkerRuntimeEvent,
): number => {
  eventSequence += 1;
  post({ kind: 'runtime_event', correlation, sequence: eventSequence, event });
  return eventSequence;
};

const requireAgentDataClient = (): AgentDataPortClient => {
  if (agentDataClient === undefined) {
    throw new Error('Agent Data port is required for Worker generation data');
  }
  return agentDataClient;
};

const postChildProgress = (
  correlation: WorkerCorrelation,
  progress: WorkerChildProgressMessage['progress'],
): void => {
  if (correlation.command !== 'async-child') return;
  post({ kind: 'child_progress', correlation, progress });
};

const childProgressFromEffect = (
  effect: WorkerEffectObservation,
): WorkerChildProgressMessage['progress'] => {
  const requestCoordinates = effect.requestKey === undefined ? {} : {
    modelStep: effect.requestKey.modelStep,
    ...(effect.requestKey.requestOrdinal === undefined ? {} : {
      requestOrdinal: effect.requestKey.requestOrdinal,
    }),
  };
  if (effect.kind === 'tool_call') {
    return {
      phase: 'tool',
      ...requestCoordinates,
      lastTool: {
        name: effect.call.name,
        callId: effect.call.callId,
        state: 'running',
      },
    };
  }
  if (effect.kind === 'tool_progress') {
    return {
      phase: 'tool',
      ...requestCoordinates,
      lastTool: {
        name: effect.name,
        callId: effect.callId,
        state: 'running',
      },
    };
  }
  return {
    phase: 'between_steps',
    ...requestCoordinates,
    lastTool: {
      name: effect.result.name,
      callId: effect.result.callId,
      state: 'completed',
      outcome: effect.result.outcome,
    },
  };
};

const generationRuntimeEvent = (
  correlation: WorkerCorrelation,
  event: WorkerRuntimeEvent,
): number => {
  eventSequence += 1;
  const message = {
    kind: 'runtime_event' as const,
    correlation,
    sequence: eventSequence,
    event,
  };
  requireAgentDataClient().observation(message);
  if (
    event.kind === 'agent_event' && event.event.kind === 'steering_message'
  ) {
    post({
      kind: 'steering_applied',
      correlation,
      sequence: eventSequence,
      text: event.event.message.content.text,
    });
  }
  return eventSequence;
};

const sendRequestCount = (
  correlation: WorkerCorrelation,
  outcome: import('../core/contracts.ts').LoopOutcome,
): void => {
  eventSequence += 1;
  post({
    kind: 'request_count',
    correlation,
    sequence: eventSequence,
    ...(processContext?.executionId === undefined
      ? {}
      : { executionId: processContext.executionId }),
    ...(outcome.turnProviderRequestCount === undefined ? {} : {
      turnProviderRequestCount: outcome.turnProviderRequestCount,
    }),
    ...(outcome.runtimeProviderRequestCount === undefined ? {} : {
      runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
    }),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const acknowledgementKey = (
  kind: 'commit' | 'checkpoint',
  correlation: WorkerCorrelation,
): string =>
  `${kind}:${correlation.session}:${correlation.workerGeneration}:${correlation.command}`;

const preparingTurnKey = (correlation: WorkerCorrelation): string => JSON.stringify(correlation);

const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const waitForAcknowledgement = (
  kind: 'commit' | 'checkpoint',
  correlation: WorkerCorrelation,
  signal?: AbortSignal,
): Promise<boolean | AfterTurnSettlement> => {
  const key = acknowledgementKey(kind, correlation);
  return new Promise<boolean | AfterTurnSettlement>((resolve) => {
    let settled = false;
    const finish = (value: boolean | AfterTurnSettlement): void => {
      if (settled) return;
      settled = true;
      acknowledgements.delete(key);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    acknowledgements.set(key, { correlation, finish });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const awaitCheckpointAcknowledgement = (
  acknowledgement: Promise<boolean | AfterTurnSettlement>,
  signal: AbortSignal,
): Promise<boolean> => {
  if (signal.aborted) {
    void acknowledgement.catch(() => {});
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(accepted);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    acknowledgement.then((value) => {
      finish(typeof value === 'boolean' ? value : value.accepted);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
};

const makeGenerationPort = (): WorkerGenerationPort => ({
  readContextTurn: (correlation, beforeTurn) =>
    requireAgentDataClient().readContextTurn(correlation, beforeTurn),
  runtimeEvent: (correlation, event) => {
    const sequence = generationRuntimeEvent(correlation, {
      kind: 'agent_event',
      event,
    });
    if (event.kind === 'turn_start') {
      postChildProgress(correlation, { phase: 'model' });
    } else if (event.kind === 'assistant_thinking') {
      postChildProgress(correlation, {
        phase: 'model',
        modelStep: event.modelStep,
        ...(event.requestKey?.requestOrdinal === undefined ? {} : {
          requestOrdinal: event.requestKey.requestOrdinal,
        }),
      });
    }
    return sequence;
  },
  effectObservation: (correlation, effect) => {
    eventSequence += 1;
    const sequence = eventSequence;
    requireAgentDataClient().observation({
      kind: 'effect_observation',
      correlation,
      sequence,
      effect,
    });
    postChildProgress(correlation, childProgressFromEffect(effect));
    return sequence;
  },
  providerObservation: (
    correlation: WorkerCorrelation,
    observation: ProviderEvidenceObservation,
    turn: number,
  ) => {
    const nextSequence = eventSequence + 1;
    if (observation.kind === 'request_start') {
      reportAuxiliaryStage('provider_start_post_entered', nextSequence);
    }
    eventSequence = nextSequence;
    requireAgentDataClient().observation({
      kind: 'provider_observation',
      correlation,
      sequence: eventSequence,
      turn,
      observation,
    });
    if (observation.kind === 'runtime_event') {
      const event = observation.event;
      if (event.kind === 'tool_call') {
        postChildProgress(correlation, {
          phase: 'tool',
          modelStep: event.modelStep,
          ...(event.requestOrdinal === undefined ? {} : {
            requestOrdinal: event.requestOrdinal,
          }),
          lastTool: {
            name: event.call.name,
            callId: event.call.callId,
            state: 'running',
          },
        });
      } else if (event.kind === 'tool_progress') {
        postChildProgress(correlation, {
          phase: 'tool',
          modelStep: event.modelStep,
          ...(event.requestOrdinal === undefined ? {} : {
            requestOrdinal: event.requestOrdinal,
          }),
          lastTool: {
            name: event.name,
            callId: event.callId,
            state: 'running',
          },
        });
      } else if (event.kind === 'tool_result') {
        postChildProgress(correlation, {
          phase: 'between_steps',
          modelStep: event.modelStep,
          ...(event.requestOrdinal === undefined ? {} : {
            requestOrdinal: event.requestOrdinal,
          }),
          lastTool: {
            name: event.result.name,
            callId: event.result.callId,
            state: 'completed',
            outcome: event.result.outcome,
          },
        });
      }
    }
    if (observation.kind === 'request_start') {
      post({
        kind: 'request_started',
        correlation,
        sequence: eventSequence,
        requestOrdinal: observation.request.ordinal,
        modelStep: observation.request.modelStep,
      });
      reportAuxiliaryStage('provider_start_post_returned', eventSequence);
    }
    return eventSequence;
  },
  contextObservation: (correlation, observation) => {
    const nextSequence = eventSequence + 1;
    if (observation.purpose === 'web_search') {
      reportAuxiliaryStage('aux_context_post_entered', nextSequence);
    }
    eventSequence = nextSequence;
    requireAgentDataClient().observation({
      kind: 'context_observation',
      correlation,
      sequence: eventSequence,
      observation: { kind: 'model_request_delta', delta: observation },
    });
    if (observation.purpose === 'web_search') {
      reportAuxiliaryStage('aux_context_post_returned', eventSequence);
    }
    return eventSequence;
  },
  checkpointProposal: async (_correlation, proposal, signal) => {
    return await awaitCheckpointAcknowledgement(
      requireAgentDataClient().checkpoint(proposal),
      signal,
    );
  },
  commitProposal: async (correlation, proposal, _signal) => {
    if (proposal.outcome !== undefined) {
      sendRequestCount(correlation, proposal.outcome);
    }
    const barrier = requireAgentDataClient().sendProposal(proposal);
    post({ kind: 'proposal_ready', ...barrier });
    return await waitForAcknowledgement('commit', correlation);
  },
  afterTurnContext: (update) => requireAgentDataClient().afterTurn(update),
  postSettlementHook: (update) => requireAgentDataClient().postSettlementHook(update),
  settlementFailure: (correlation, error) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      kind: 'worker_error',
      correlation,
      stage: 'turn',
      message: `after_turn context save failed: ${message}`,
      details: captureFailureDetails(error, {
        operation: 'after_turn_context',
      }),
    });
  },
  turnFailed: async (correlation, outcome, contextManifest) => {
    sendRequestCount(correlation, outcome);
    const executionId = processContext?.executionId;
    if (executionId === undefined) {
      throw new Error('Worker execution id is required for Agent Data failure');
    }
    const barrier = requireAgentDataClient().sendFailure({
      kind: 'turn_failed',
      correlation,
      outcome,
      ...(contextManifest === undefined ? {} : { contextManifest }),
      ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    });
    post({ kind: 'failure_ready', executionId, ...barrier });
    return await waitForAcknowledgement('commit', correlation);
  },
  turnSettled: (correlation) => post({ kind: 'turn_settled', correlation }),
});

class WorkerConfigurationRejectedError extends Error {
  constructor(
    readonly rejections: readonly ConfigurationRejection[],
  ) {
    super('Worker Agent configuration was rejected');
    this.name = 'WorkerConfigurationRejectedError';
  }
}

const createGeneration = async (
  correlation: WorkerCorrelation,
  agentChoice: AgentConfigurationChoice,
  workspaceRoot: string,
  configRoot: string,
  credentialRoot: string,
  physicalIoMode: 'provider-free' | 'production',
  rootMaxSteps?: number,
  providerTimeoutMs?: number,
  initialTranscript: readonly import('../core/contracts.ts').Message[] = [],
  nextTurn = 1,
  checkpoint?: import('../session/session_store.ts').SemanticContextCheckpointV1,
  initialModelSelection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
  baseInstruction: SelectedHenjiBaseInstruction = builtinHenjiBaseInstruction(),
  providerDeclarations: readonly ProviderDeclarationV1[] = [],
  toolFilter: readonly string[] | undefined = undefined,
  privateStateFromTurn = 1,
  enableAsyncAgents = true,
  runtimeIdentityInput: WorkerRuntimeIdentityInput = { role: 'root' },
): Promise<WorkerGeneration> => {
  const workspace = await resolveWorkspace(workspaceRoot);
  const instructionSnapshot = await discoverAgentInstructionSnapshot(
    workspace.root,
  );
  const skillCatalog = await discoverSkills(workspace.root);
  const requestCounter = createWorkerRequestCounter();
  const physicalIo = physicalIoMode === 'production'
    ? createProductionPhysicalIo(requestCounter, {
      credentialRoot,
      providerTimeoutMs,
      providerDeclarations,
      reportAuxiliaryStage,
      sessionId: correlation.session,
    })
    : createProviderFreePhysicalIo();
  const asyncAgentRpc = (
    request: AsyncAgentRequest,
    callId?: string,
    signal?: AbortSignal,
  ) => requestAsyncAgent(correlation, request, callId, signal);
  let rootModel = physicalIo.createModel('parent', initialModelSelection);
  const rootRouter: Model = {
    get measureRequestWire() {
      return rootModel.measureRequestWire;
    },
    get requestOutputReserve() {
      return rootModel.requestOutputReserve;
    },
    generate: (request, options) => rootModel.generate(request, options),
  };
  processExecutor = new WorkerProcessExecutor(
    post,
    () => processContext ?? { correlation },
  );
  const routedPhysicalIo = {
    processExecutor,
    ...physicalIo,
    ...(enableAsyncAgents ? { asyncAgentRpc } : {}),
    createModel: (_role: 'parent', _selection?: ModelSelection): Model => rootRouter,
  };
  if (!await verifySelectedHenjiBaseInstruction(baseInstruction)) {
    throw new Error('Worker Henji base instruction is invalid');
  }
  selectWorkerHenjiBaseInstruction(baseInstruction);
  const selection = await resolveWorkerConfiguration(configRoot, agentChoice);
  const configured = await createConfiguredWorkerComposition(selection, {
    workspace,
    configRoot,
    credentialRoot,
    agentInstructions: instructionSnapshot?.formatted,
    skillCatalog,
    physicalIo: routedPhysicalIo,
    ...(toolFilter === undefined ? {} : { toolFilter: Object.freeze([...toolFilter]) }),
  }, rootMaxSteps);
  if (!configured.ok) {
    throw new WorkerConfigurationRejectedError(configured.rejections);
  }
  const composition = configured.composition;
  const contextSnapshot: WorkerContextSnapshot = Object.freeze({
    schemaVersion: 1,
    workspaceRoot: workspace.root,
    ...(instructionSnapshot === undefined ? {} : {
      workspaceInstruction: structuredClone(instructionSnapshot),
    }),
    skillCatalog: Object.freeze({
      ...(skillCatalog.manifest === undefined ? {} : { manifest: skillCatalog.manifest }),
      skills: Object.freeze(
        skillCatalog.skills.map((skill) => structuredClone(skill)),
      ),
    }),
    instructionComponents: Object.freeze(
      (composition.instructionComponents ?? []).map((component) => structuredClone(component)),
    ),
    ...(composition.systemInstruction === undefined ? {} : {
      systemInstruction: composition.systemInstruction,
    }),
    toolDefinitions: Object.freeze(
      composition.registry.definitions().map((definition) => structuredClone(definition)),
    ),
    runtimeFacts: Object.freeze({ cwd: workspace.root }),
  });
  const runtimeIdentity: HookRuntimeIdentity = runtimeIdentityInput.role === 'child'
    ? Object.freeze({
      component: 'agent',
      agentName: configured.snapshot.agent.name,
      role: 'child',
      workspaceRoot: workspace.root,
      sessionId: correlation.session,
      workerGeneration: correlation.workerGeneration,
      parentExecutionId: runtimeIdentityInput.parentExecutionId,
      ...(runtimeIdentityInput.spawnCallId === undefined
        ? {}
        : { spawnCallId: runtimeIdentityInput.spawnCallId }),
    })
    : Object.freeze({
      component: 'agent',
      agentName: configured.snapshot.agent.name,
      role: 'root',
      workspaceRoot: workspace.root,
      sessionId: correlation.session,
      workerGeneration: correlation.workerGeneration,
    });
  return new WorkerGeneration(
    composition,
    correlation.session,
    makeGenerationPort(),
    initialTranscript,
    nextTurn,
    checkpoint,
    requestCounter,
    initialModelSelection,
    (selection) => {
      rootModel = physicalIo.createModel('parent', selection);
    },
    physicalIo.credentialAvailability,
    Object.freeze({
      ...(instructionSnapshot?.source === undefined
        ? {}
        : { instructionSource: instructionSnapshot.source }),
      skillNames: Object.freeze(skillCatalog.skills.map((skill) => skill.name)),
      context: contextSnapshot,
    }),
    reportAuxiliaryStage,
    privateStateFromTurn,
    configured.snapshot,
    configured.hooks,
    runtimeIdentity,
    configured.hookProviderEvidenceScope,
    await readContextBudget(configRoot),
  );
};

const handlePermission = async (
  command: Extract<WorkerHostCommand, { kind: 'permission' }>,
): Promise<void> => {
  let read: 'allowed' | 'denied' = 'denied';
  let environment: 'allowed' | 'denied' = 'denied';
  try {
    await Deno.readTextFile(new URL(command.readSpecifier));
    read = 'allowed';
  } catch {
    read = 'denied';
  }
  try {
    Deno.env.get(command.envKey);
    environment = 'allowed';
  } catch {
    environment = 'denied';
  }
  runtimeEvent(command.correlation, { kind: 'permission', read, environment });
};

const mutateClone = (payload: DataValue): DataValue => {
  if (isRecord(payload) && !Array.isArray(payload)) {
    (payload as Record<string, DataValue>).workerMutated = true;
  }
  return payload;
};

const pendingAsyncAgentRequests = new Map<
  string,
  {
    readonly resolve: (response: AsyncAgentResponse) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }
>();

const requestAsyncAgent = (
  correlation: WorkerCorrelation,
  request: AsyncAgentRequest,
  callId?: string,
  signal?: AbortSignal,
): Promise<AsyncAgentResponse> =>
  new Promise<AsyncAgentResponse>((resolve, reject) => {
    const requestId = crypto.randomUUID().toLowerCase();
    if (signal?.aborted) {
      reject(new TurnCancelledError());
      return;
    }
    const onAbort = signal === undefined ? undefined : () => {
      pendingAsyncAgentRequests.delete(requestId);
      reject(new TurnCancelledError());
    };
    pendingAsyncAgentRequests.set(requestId, {
      resolve,
      ...(signal === undefined ? {} : { signal }),
      ...(onAbort === undefined ? {} : { onAbort }),
    });
    if (signal !== undefined && onAbort !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    post({
      kind: 'async_agent_request',
      correlation,
      requestId,
      request,
      ...(callId === undefined ? {} : { callId }),
    });
  });

const handleTurn = async (
  command: Extract<WorkerHostCommand, { kind: 'turn' }>,
): Promise<void> => {
  if (generation === undefined) {
    post({
      kind: 'worker_error',
      correlation: command.correlation,
      stage: 'worker_command',
      message: 'Worker generation is not started',
    });
    return;
  }
  if (agentDataClient === undefined || command.executionId === undefined) {
    post({
      kind: 'worker_error',
      correlation: command.correlation,
      stage: 'worker_command',
      message: 'Worker generation requires an execution id and Agent Data port',
    });
    return;
  }
  const dataClient = agentDataClient;
  const workerGeneration = generation;
  const preparationKey = preparingTurnKey(command.correlation);
  const preparation = {
    correlation: command.correlation,
    cancelRequested: false,
  };
  preparingTurns.set(preparationKey, preparation);
  processContext = {
    correlation: command.correlation,
    executionId: command.executionId,
  };
  try {
    const generationBasis = await dataClient.generationContext(
      command.correlation,
    );
    dataClient.beginExecution(
      command.executionId,
      command.correlation,
      diagnosticStageBuffer,
      auxiliaryStageGapMs,
    );
    preparingTurns.delete(preparationKey);
    await workerGeneration.runTurn(
      command.correlation,
      command.task,
      generationBasis.recalledContext,
      command.chatgptRegistrationId,
      generationBasis,
      preparation.cancelRequested,
      command.executionId,
    );
  } catch (error) {
    post({
      kind: 'worker_error',
      correlation: command.correlation,
      stage: 'turn',
      message: error instanceof Error ? error.message : String(error),
      details: captureFailureDetails(error, { operation: 'worker_turn' }),
    });
  } finally {
    preparingTurns.delete(preparationKey);
    processContext = undefined;
  }
};

const handle = async (command: WorkerHostCommand): Promise<void> => {
  if (command.kind === 'process_response' || command.kind === 'process_event') {
    processExecutor?.receive(command);
    return;
  }
  activeCorrelation = command.correlation;
  switch (command.kind) {
    case 'async_agent_response': {
      const pending = pendingAsyncAgentRequests.get(command.requestId);
      if (pending !== undefined) {
        pendingAsyncAgentRequests.delete(command.requestId);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        pending.resolve(command.response);
      }
      return;
    }
    case 'start': {
      diagnosticStageBuffer = command.diagnosticStageBuffer instanceof SharedArrayBuffer
        ? command.diagnosticStageBuffer
        : undefined;
      auxiliaryStageGapMs = command.auxiliaryStageGapMs;
      agentDataClient?.close();
      agentDataClient = command.dataPort === undefined
        ? undefined
        : createAgentDataPortClient(command.dataPort);
      const startsGeneration = command.workspaceRoot !== undefined;
      if (startsGeneration && agentDataClient === undefined) {
        post({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: 'Agent Data port is required for Worker generation startup',
        });
        return;
      }
      let generationBasis:
        | Awaited<
          ReturnType<AgentDataPortClient['generationContext']>
        >
        | undefined;
      if (!startsGeneration) {
        generation = undefined;
        post({ kind: 'ready', correlation: command.correlation });
        return;
      }
      try {
        generationBasis = await requireAgentDataClient().generationContext(
          command.correlation,
        );
      } catch (error) {
        post({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
          details: captureFailureDetails(error, {
            operation: 'worker_composition',
          }),
        });
        return;
      }
      let workerGeneration: WorkerGeneration;
      try {
        if (generationBasis === undefined) {
          throw new Error('Agent Data generation context is unavailable');
        }
        setActiveProviderDeclarations(command.providerDeclarations ?? []);
        workerGeneration = await createGeneration(
          command.correlation,
          command.agentChoice,
          command.workspaceRoot,
          command.configRoot,
          command.credentialRoot,
          command.physicalIoMode ?? 'provider-free',
          command.rootMaxSteps,
          command.providerTimeoutMs,
          generationBasis.initialTranscript,
          generationBasis.nextTurn,
          generationBasis.checkpoint,
          generationBasis.modelSelection,
          command.baseInstruction,
          command.providerDeclarations ?? [],
          command.toolFilter,
          generationBasis.privateStateFromTurn,
          command.enableAsyncAgents ?? true,
          command.runtimeIdentity ?? { role: 'root' },
        );
        if (command.notifyStartupPrepared) {
          const startupConfiguration = workerGeneration.configuration;
          const startupContext = workerGeneration.startupSnapshot;
          if (
            startupConfiguration === undefined ||
            startupContext.context === undefined
          ) {
            throw new Error(
              'Worker startup composition snapshot is unavailable',
            );
          }
          post({
            kind: 'startup_prepared',
            correlation: command.correlation,
            configuration: startupConfiguration,
            manifest: workerGeneration.manifest,
            startupSnapshot: startupContext,
          });
        }
        workerGeneration.setContextBasis(
          command.correlation,
          generationBasis.canonicalMessageCount,
          generationBasis.historySource,
        );
        await workerGeneration.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof WorkerConfigurationRejectedError) {
          post({
            kind: 'worker_error',
            correlation: command.correlation,
            stage: 'configuration',
            message,
            configurationRejections: structuredClone(error.rejections),
          });
          return;
        }
        post({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message,
          details: captureFailureDetails(error, {
            operation: 'worker_composition',
          }),
        });
        return;
      }
      generation = workerGeneration;
      const credentialAvailability = await workerGeneration
        .rootCredentialAvailability();
      const ready: WorkerReadyMessage = {
        kind: 'ready',
        correlation: command.correlation,
        configuration: workerGeneration.configuration,
        manifest: workerGeneration.manifest,
        startupSnapshot: workerGeneration.startupSnapshot,
        ...(credentialAvailability === undefined ? {} : { credentialAvailability }),
      };
      if (agentDataClient !== undefined) {
        try {
          await agentDataClient.ready(ready);
        } catch (error) {
          post({
            kind: 'worker_error',
            correlation: command.correlation,
            stage: 'composition',
            message: error instanceof Error ? error.message : String(error),
            details: captureFailureDetails(error, {
              operation: 'worker_composition',
            }),
          });
          return;
        }
      }
      post({
        ...ready,
        ...(ready.startupSnapshot === undefined ? {} : {
          startupSnapshot: {
            ...(ready.startupSnapshot.instructionSource === undefined ? {} : {
              instructionSource: ready.startupSnapshot.instructionSource,
            }),
            skillNames: ready.startupSnapshot.skillNames,
          },
        }),
      });
      return;
    }
    case 'select_model': {
      const accepted = generation !== undefined &&
        isModelSelection(command.selection) &&
        generation.selectRootModel(
          command.selection,
          command.privateStateFromTurn,
        );
      const credentialAvailability = accepted
        ? await generation?.rootCredentialAvailability()
        : undefined;
      if (
        accepted && generation !== undefined && agentDataClient !== undefined
      ) {
        try {
          await agentDataClient.ready({
            kind: 'ready',
            correlation: command.correlation,
            configuration: generation.configuration,
            manifest: generation.manifest,
            startupSnapshot: generation.startupSnapshot,
            ...(credentialAvailability === undefined ? {} : { credentialAvailability }),
          });
        } catch (error) {
          post({
            kind: 'worker_error',
            correlation: command.correlation,
            stage: 'worker_command',
            message: error instanceof Error ? error.message : String(error),
            details: captureFailureDetails(error, {
              operation: 'worker_worker_command',
            }),
          });
          return;
        }
      }
      post({
        kind: 'model_selected',
        correlation: command.correlation,
        accepted,
        ...(accepted && generation !== undefined ? { manifest: generation.manifest } : {}),
        ...(credentialAvailability === undefined ? {} : { credentialAvailability }),
      });
      return;
    }
    case 'turn': {
      const currentTurn = handleTurn(command);
      activeTurnPromise = currentTurn;
      try {
        await currentTurn;
      } finally {
        if (activeTurnPromise === currentTurn) activeTurnPromise = undefined;
      }
      return;
    }
    case 'steer': {
      const result = processContext !== undefined &&
          sameCorrelation(processContext.correlation, command.correlation)
        ? generation?.steerActiveTurn(command.text) ?? 'idle'
        : 'idle';
      post({
        kind: 'steering_received',
        correlation: command.correlation,
        requestId: command.requestId,
        result,
      });
      return;
    }
    case 'cancel': {
      const observedAt = new Date().toISOString();
      const preparation = preparingTurns.get(
        preparingTurnKey(command.correlation),
      );
      const result = preparation !== undefined &&
          sameCorrelation(preparation.correlation, command.correlation)
        ? preparation.cancelRequested
          ? 'already_requested'
          : (preparation.cancelRequested = true, 'requested')
        : generation?.cancelActiveTurn() ?? 'idle';
      eventSequence += 1;
      post({
        kind: 'cancel_received',
        correlation: command.correlation,
        sequence: eventSequence,
        observedAt,
        result,
      });
      return;
    }
    case 'ordered':
      runtimeEvent(command.correlation, {
        kind: 'ordered',
        sequence: command.sequence,
      });
      return;
    case 'echo':
      runtimeEvent(command.correlation, {
        kind: 'echo',
        payload: mutateClone(command.payload),
      });
      return;
    case 'large_transfer':
      runtimeEvent(command.correlation, {
        kind: 'large_transfer',
        byteLength: new TextEncoder().encode(command.payload).byteLength,
        payload: command.payload,
      });
      return;
    case 'permission':
      await handlePermission(command);
      return;
    case 'worker_error':
      runtimeEvent(command.correlation, {
        kind: 'worker_error_observed',
        message: 'worker-originated command error',
      });
      post({
        kind: 'worker_error',
        correlation: command.correlation,
        stage: 'worker_command',
        message: 'worker-originated command error',
      });
      return;
    case 'uncaught_error':
      queueMicrotask(() => {
        throw new Error(
          `uncaught Worker probe for ${command.correlation.command}`,
        );
      });
      return;
    case 'commit_acknowledgement': {
      const key = acknowledgementKey('commit', command.correlation);
      const acknowledgement = acknowledgements.get(key);
      if (
        acknowledgement !== undefined &&
        sameCorrelation(acknowledgement.correlation, command.correlation)
      ) {
        acknowledgement.finish(command.settlement ?? command.accepted);
      }
      return;
    }
    case 'checkpoint_acknowledgement': {
      const key = acknowledgementKey('checkpoint', command.correlation);
      const acknowledgement = acknowledgements.get(key);
      if (
        acknowledgement !== undefined &&
        sameCorrelation(acknowledgement.correlation, command.correlation)
      ) {
        acknowledgement.finish(command.accepted);
      }
      return;
    }
    case 'close': {
      for (const preparation of preparingTurns.values()) {
        preparation.cancelRequested = true;
      }
      generation?.cancelActiveTurn();
      await activeTurnPromise?.catch(() => {});
      const hookFailures: WorkerHookFailure[] = [];
      try {
        hookFailures.push(...await (generation?.stop('normal_close') ?? []));
      } catch (error) {
        hookFailures.push({
          name: 'worker-runtime',
          phase: 'runtime_stop',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const cleanupFailures: {
        readonly resource: string;
        readonly reason: string;
      }[] = [];
      try {
        await processExecutor?.close();
      } catch (error) {
        cleanupFailures.push({
          resource: 'process executor',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await generation?.close();
      } catch (error) {
        cleanupFailures.push({
          resource: 'tool registry',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        agentDataClient?.close();
      } catch (error) {
        cleanupFailures.push({
          resource: 'Agent Data port',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      agentDataClient = undefined;
      post({
        kind: 'closed',
        correlation: command.correlation,
        ...(hookFailures.length === 0 ? {} : { hookFailures }),
        ...(generation?.runtimeStopResult === undefined ? {} : {
          runtimeStopResult: generation.runtimeStopResult,
        }),
        ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
      });
      scope.close();
      return;
    }
  }
};

scope.onmessage = (event: MessageEvent<unknown>): void => {
  const command = parseWorkerHostCommand(event.data);
  if (command === undefined) {
    post({
      kind: 'worker_error',
      stage: 'worker_command',
      message: 'unknown Worker command',
    });
    return;
  }
  void handle(command);
};

scope.onerror = (event: ErrorEvent): boolean => {
  agentDataClient?.close();
  agentDataClient = undefined;
  post({
    kind: 'worker_error',
    ...(activeCorrelation === undefined ? {} : { correlation: activeCorrelation }),
    stage: 'uncaught',
    message: event.message || 'uncaught Worker error',
    details: captureFailureDetails(event.error ?? event.message, {
      operation: 'worker_uncaught',
    }),
  });
  return true;
};
