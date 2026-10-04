import { captureFailureDetails, type FailureDetails } from '../core/failure_details.ts';
import { createFailureDiagnostic } from '../session/failure_diagnostic.ts';
import type { AgentEvent } from '../core/events.ts';
import { validateSteeringText } from '../core/steering.ts';
import type {
  ApiPosition,
  ContextView,
  EffectiveRuntimeConfig,
  ExecutionView,
  SessionActivation,
} from '../../api/contract.ts';
import type { SessionModelChange } from '../session/session_store.ts';
import type {
  DataExecutionControlInput,
  DataSessionDescriptor,
  DataSessionTerminalResult,
} from '../data/data_contract.ts';
import { DataRecallSelectionError } from '../data/session_data_owner.ts';
import type {
  WorkerClosedMessage,
  WorkerCorrelation,
  WorkerErrorMessage,
  WorkerFailureReadyMessage,
  WorkerModelSelectedMessage,
  WorkerProposalReadyMessage,
  WorkerReadyMessage,
  WorkerRequestCountMessage,
  WorkerRequestStartedMessage,
  WorkerToHostMessage,
  WorkerTurnSettledMessage,
} from './worker_protocol.ts';
import { isModelSelection } from '../provider/model_catalog.ts';
import { credentialAvailabilityFor } from '../provider/credential_file.ts';
import { type ChatGPTAuthService, createChatGPTAuthService } from '../provider/chatgpt_auth.ts';
import {
  type CredentialAvailability,
  modelRouteProfileId,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../worker_agent_api.ts';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../provider/openrouter_contract.ts';
import { ChildRunRegistry } from './worker_host_children.ts';
import { validCredentialAvailability, WorkerSupervisor } from './worker_host_supervisor.ts';
import { sameCorrelation, turnEndFromOutcome } from './worker_host_outcome.ts';
import type { DataCommitDecision } from '../data/session_data_owner.ts';
import type { WorkerExecutionTraceEntry } from './worker_execution_artifact.ts';
import type {
  ActiveWorkerExecution as ActiveExecution,
  PendingWorkerAdmission as PendingAdmission,
  WorkerAdmission as Admission,
  WorkerSmallOutcome as SmallOutcome,
} from './worker_host_types.ts';

const WORKER_SETTLEMENT_GRACE_MS = 5_000;

/** Kept as a small pure helper for provider-switching callers and tests. */
export const privateStateFromTurn = (
  changes: readonly SessionModelChange[],
): number => {
  let boundary = 1;
  for (let index = 1; index < changes.length; index++) {
    if (
      changes[index - 1].selection.provider !==
        changes[index].selection.provider ||
      changes[index - 1].selection.modelId !== changes[index].selection.modelId
    ) boundary = changes[index].effectiveFromTurn;
  }
  return boundary;
};

export type WorkerRecallSelectionErrorCode =
  | 'unavailable'
  | 'busy'
  | 'not_found'
  | 'ambiguous'
  | 'failed';

export class WorkerRecallSelectionError extends Error {
  constructor(readonly code: WorkerRecallSelectionErrorCode) {
    super(code);
    this.name = 'WorkerRecallSelectionError';
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const smallFailure = (
  task: string,
  message: string,
  cancelled = false,
): SmallOutcome => ({
  ok: false,
  task,
  outcome: cancelled ? 'cancelled' : 'contract_failure',
  stopReason: cancelled ? 'cancelled' : 'contract_failure',
  ...(cancelled ? {} : { error: message }),
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
});

const admissionError = (outcome: SmallOutcome): Error =>
  Object.assign(new Error(outcome.error ?? 'execution admission failed'), {
    code: 'admission_failed',
    outcome,
  });

const decodeAgentEvent = (
  bytes: Uint8Array<ArrayBuffer>,
): AgentEvent | undefined => {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof (value as { kind?: unknown }).kind !== 'string'
    ) return undefined;
    return value as AgentEvent;
  } catch {
    return undefined;
  }
};

type DataExecutionControlFact = DataExecutionControlInput extends infer Input
  ? Input extends { controlSequence: number } ? Omit<Input, 'controlSequence'>
  : never
  : never;

/**
 * Core-side execution control. Session data, transcript, context, proposal payloads, and durable
 * observations remain in Data; this class keeps only the current descriptor and execution index.
 */
export class ExecutionCoordinator {
  private readonly supervisor: WorkerSupervisor;
  private readonly children: ChildRunRegistry;
  private chatgptAuth: ChatGPTAuthService | undefined;
  private descriptorValue: DataSessionDescriptor;
  private runtimeRequestCount = 0;
  private generationRequestBase = 0;
  private generationRequestCount = 0;
  private active = false;
  private closed = false;
  private closeResult: WorkerClosedMessage | undefined;
  private pendingAdmission: PendingAdmission | undefined;
  private activeExecution: ActiveExecution | undefined;
  private admissionCompletion: Promise<SmallOutcome> | undefined;
  private unsubscribeWatch: (() => void) | undefined;
  private unsubscribeAgentEvents: (() => void) | undefined;

  private constructor(private readonly options: WorkerHostSessionOptions) {
    this.descriptorValue = structuredClone(options.descriptor);
    this.supervisor = new WorkerSupervisor({
      options,
      handleWorkerMessage: (message) => this.receive(message),
      projection: () => ({
        stateRevision: this.descriptorValue.stateRevision,
        modelSelection: this.descriptorValue.modelSelection,
      }),
      attachGeneration: (correlation) =>
        this.options.data.attachGeneration(this.sessionId, correlation),
      onGenerationReplaced: () => {
        this.generationRequestBase = this.runtimeRequestCount;
        this.generationRequestCount = 0;
      },
    });
    this.children = new ChildRunRegistry({
      options,
      currentCatalog: () => {
        const configuration = this.supervisor.currentConfiguration;
        return configuration?.agent.agents.filter((name) =>
          !configuration.rejections.some((entry) => entry.target === 'agent' && entry.name === name)
        ) ?? [];
      },
      currentModelSelection: () => this.descriptorValue.modelSelection,
      chatgptAuth: {
        selectedRegistrationId: () => this.chatgptAuthService().selectedRegistrationId(),
      },
    });
    if (this.options.eventSink !== undefined) {
      this.unsubscribeAgentEvents = this.options.data.subscribeAgentEvents(
        (sessionId, eventBytes) => {
          if (sessionId !== this.sessionId) return;
          const event = decodeAgentEvent(eventBytes);
          if (event === undefined || event.kind === 'turn_end') return;
          this.deliver(event);
        },
      );
    }
  }

  private chatgptAuthService(): ChatGPTAuthService {
    return this.chatgptAuth ??= createChatGPTAuthService({
      ...(this.options.configRoot === undefined ? {} : { configRoot: this.options.configRoot }),
    });
  }

  static async open(
    options: WorkerHostSessionOptions,
  ): Promise<ExecutionCoordinator> {
    const coordinator = new ExecutionCoordinator(options);
    try {
      const watch = await options.data.watchSession(
        options.descriptor.id,
        (update) => coordinator.acceptDescriptor(update.descriptor),
      );
      coordinator.unsubscribeWatch = watch.unsubscribe;
      await coordinator.supervisor.start();
      return coordinator;
    } catch (error) {
      coordinator.unsubscribeWatch?.();
      coordinator.unsubscribeAgentEvents?.();
      await coordinator.supervisor.terminate().catch(() => {});
      throw error;
    }
  }

  private acceptDescriptor(descriptor: DataSessionDescriptor): void {
    if (descriptor.id !== this.sessionId) return;
    this.descriptorValue = structuredClone(descriptor);
    this.publishRuntimeState();
  }

  get agentChoice(): DataSessionDescriptor['agentChoice'] {
    return structuredClone(this.descriptorValue.agentChoice);
  }

  get sessionId(): string {
    return this.descriptorValue.id;
  }

  modelSelectionSnapshot(): ModelSelection {
    return structuredClone(this.descriptorValue.modelSelection);
  }

  startupSnapshot(): NonNullable<WorkerReadyMessage['startupSnapshot']> {
    if (this.supervisor.currentStartupSnapshot === undefined) {
      throw new Error('Worker startup snapshot is unavailable');
    }
    return structuredClone(this.supervisor.currentStartupSnapshot);
  }

  effectiveConfigSnapshot(): EffectiveRuntimeConfig {
    const configuration = this.supervisor.currentConfiguration;
    const configuredMaxSteps = this.options.rootMaxSteps;
    const maxSteps = configuredMaxSteps ??
      this.supervisor.currentManifest?.maxSteps ??
      DEFAULT_AGENT_MAX_STEPS;
    const maxStepsSource: EffectiveRuntimeConfig['maxStepsSource'] =
      configuredMaxSteps === undefined ? 'default' : 'activation';
    const activation: SessionActivation = {
      ...(this.options.activation ?? {}),
      ...(this.options.rootMaxSteps === undefined ? {} : { maxSteps: this.options.rootMaxSteps }),
      ...(this.options.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: this.options.providerTimeoutMs }),
    };
    return {
      configuration: {
        status: configuration === undefined ? 'pending' : 'ready',
        choice: { ...this.descriptorValue.agentChoice },
        name: configuration?.agent.name ?? this.descriptorValue.agent,
        ...(configuration === undefined ? {} : {
          configurationId: configuration.configurationId,
          revision: configuration.agent.revision,
          source: { ...configuration.source },
          rejections: structuredClone(
            configuration.rejections,
          ) as unknown as import('../../api/contract.ts').ApiJson,
        }),
      },
      maxSteps,
      maxStepsSource,
      providerTimeoutMs: this.options.providerTimeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS,
      activation,
    };
  }

  pendingRecallSnapshot(): ContextView['pendingRecall'] {
    const recall = this.descriptorValue.context.pendingRecall;
    return recall === undefined ? undefined : structuredClone(recall);
  }

  contextSnapshot(): ContextView {
    return structuredClone(this.descriptorValue.context);
  }

  executionSnapshot(): ExecutionView | undefined {
    const latest = this.descriptorValue.latestExecution;
    const active = this.activeExecution;
    if (
      latest === undefined || active === undefined ||
      latest.executionId !== active.executionId
    ) {
      return latest === undefined ? undefined : structuredClone(latest);
    }
    return {
      ...structuredClone(latest),
      processSettlement: active.settling ? 'settling' : 'running',
      requestCount: active.requestCount,
    };
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    const credential = this.supervisor.credentialAvailability;
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async refreshCredentialAvailability(): Promise<
    CredentialAvailability | undefined
  > {
    if (this.closed) return undefined;
    const selection = this.descriptorValue.modelSelection;
    const profile = selection.authProfile;
    const registrationId = 'registrationId' in selection ? selection.registrationId : undefined;
    const status = profile === 'openai-chatgpt'
      ? registrationId === null
        ? 'missing'
        : await this.chatgptAuthService().presence(registrationId)
      : (await credentialAvailabilityFor(profile)).status;
    const availability = Object.freeze({ authProfile: profile, status });
    if (
      this.closed || this.descriptorValue.modelSelection.authProfile !== profile
    ) return undefined;
    this.supervisor.setCredentialAvailability(structuredClone(availability));
    return availability;
  }

  requestCount(): number {
    return this.runtimeRequestCount;
  }

  runtimeSnapshot(): {
    readonly active: boolean;
    readonly phase:
      | 'idle'
      | 'running'
      | 'cancelling'
      | 'settling'
      | 'unavailable';
  } {
    if (!this.active) {
      return {
        active: false,
        phase: this.closed ||
            (this.supervisor.isUnavailable &&
              !this.supervisor.generationNeedsReplacement)
          ? 'unavailable'
          : 'idle',
      };
    }
    const execution = this.activeExecution;
    const reservation = this.pendingAdmission;
    const cancelling = execution?.cancelled === true ||
      reservation?.cancelled === true ||
      execution?.forced === true;
    return {
      active: true,
      phase: cancelling ? 'cancelling' : execution?.settling === true ? 'settling' : 'running',
    };
  }

  private publishRuntimeState(): void {
    try {
      this.options.applicationObservationSink?.({
        kind: 'runtime_state',
        sessionId: this.sessionId,
        ...this.runtimeSnapshot(),
      });
    } catch {
      // Runtime read-model updates do not alter Data settlement.
    }
  }

  async consumeAutoCompactionNotice(): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  > {
    return await this.options.data.consumeAutoCompactionNotice(this.sessionId);
  }

  async selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    if (this.closed || this.supervisor.isUnavailable) return 'unavailable';
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
      return 'busy';
    }
    if (!isModelSelection(selection)) {
      throw new RangeError('invalid model selection');
    }
    if (sameModelSelection(this.descriptorValue.modelSelection, selection)) {
      return 'unchanged';
    }
    try {
      await this.ensureGeneration();
      const correlation: WorkerCorrelation = {
        ...this.supervisor.correlation(
          `select-model-${crypto.randomUUID().toLowerCase()}`,
        ),
        baseStateRevision: this.descriptorValue.stateRevision,
      };
      this.supervisor.setCurrentCorrelation(correlation);
      const response = this.supervisor.messages.wait(
        (value): value is WorkerModelSelectedMessage | WorkerErrorMessage =>
          (value.kind === 'model_selected' || value.kind === 'worker_error') &&
          (value.kind === 'worker_error' ||
            sameCorrelation(value.correlation, correlation)),
        this.workerResponseTimeoutMs(),
      );
      this.send({
        kind: 'select_model',
        correlation,
        selection,
        privateStateFromTurn: this.descriptorValue.privateStateFromTurn,
      });
      const message = await response;
      if (
        message.kind === 'worker_error' || !message.accepted ||
        message.manifest === undefined ||
        !sameModelSelection(message.manifest.rootModel, selection) ||
        message.manifest.profileId !== modelRouteProfileId(selection) ||
        !validCredentialAvailability(message.credentialAvailability, selection)
      ) throw new Error('Worker rejected model selection');
      const mutation = await this.options.data.updateModelSelection(
        this.sessionId,
        selection,
      );
      this.acceptDescriptor(mutation.descriptor);
      this.supervisor.setManifest(message.manifest);
      this.supervisor.setCredentialAvailability(
        structuredClone(message.credentialAvailability),
      );
      return mutation.result;
    } catch {
      this.supervisor.markUnavailableForReplacement();
      return 'unavailable';
    } finally {
      this.supervisor.setCurrentCorrelation(undefined);
    }
  }

  async renameTitle(
    value: string,
  ): Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'> {
    if (this.closed || this.supervisor.isUnavailable) return 'unavailable';
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
      return 'busy';
    }
    try {
      const result = await this.options.data.updateTitle(this.sessionId, value);
      this.acceptDescriptor(result.descriptor);
      return result.result;
    } catch {
      return 'unavailable';
    }
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    if (this.closed || this.supervisor.isUnavailable) {
      throw new WorkerRecallSelectionError('unavailable');
    }
    if (this.active || this.supervisor.currentCorrelation !== undefined) {
      throw new WorkerRecallSelectionError('busy');
    }
    try {
      const result = await this.options.data.prepareRecall(this.sessionId, id);
      this.acceptDescriptor(
        await this.options.data.sessionDescriptor(this.sessionId),
      );
      return result;
    } catch (error) {
      const code = error instanceof DataRecallSelectionError
        ? error.code
        : typeof error === 'object' && error !== null && 'code' in error &&
            typeof error.code === 'string'
        ? error.code
        : 'failed';
      throw new WorkerRecallSelectionError(
        code === 'unavailable' || code === 'busy' || code === 'not_found' ||
          code === 'ambiguous'
          ? code
          : 'failed',
      );
    }
  }

  async clearPendingRecall(): Promise<boolean> {
    if (this.closed) return false;
    const cleared = await this.options.data.clearPendingRecall(this.sessionId);
    this.acceptDescriptor(
      await this.options.data.sessionDescriptor(this.sessionId),
    );
    return cleared;
  }

  currentPosition(): ApiPosition {
    return {
      ...structuredClone(this.descriptorValue.currentPosition),
      agent: this.supervisor.currentConfiguration?.agent.name ??
        this.descriptorValue.currentPosition.agent,
    };
  }

  isAvailable(): boolean {
    return !this.closed &&
      (!this.supervisor.isUnavailable ||
        this.supervisor.generationNeedsReplacement) &&
      !this.active;
  }

  async submit(task: string): Promise<SmallOutcome> {
    if (
      this.closed ||
      (this.supervisor.isUnavailable &&
        !this.supervisor.generationNeedsReplacement)
    ) throw new Error('agent session unavailable');
    try {
      const admission = await this.admit(task);
      return await admission.completion;
    } catch (error) {
      if (
        typeof error === 'object' && error !== null && 'code' in error &&
        error.code === 'admission_failed' && 'outcome' in error
      ) return error.outcome as SmallOutcome;
      return smallFailure(task, errorText(error));
    }
  }

  admit(
    task: string,
    executionId = crypto.randomUUID().toLowerCase(),
    initiallyCancelled = false,
  ): Promise<Admission> {
    if (this.pendingAdmission !== undefined || this.active) {
      return Promise.reject(new Error('agent session is busy'));
    }
    if (
      this.closed ||
      (this.supervisor.isUnavailable &&
        !this.supervisor.generationNeedsReplacement)
    ) {
      return Promise.reject(new Error('agent session unavailable'));
    }
    if (typeof task !== 'string' || task.trim().length === 0) {
      return Promise.reject(new RangeError('user text must not be blank'));
    }
    const reservation: PendingAdmission = {
      task,
      taskId: crypto.randomUUID().toLowerCase(),
      executionId,
      createdAt: new Date().toISOString(),
      cancelled: initiallyCancelled,
      admitted: false,
      controlSequence: 0,
      controlWrites: Promise.resolve(),
      pendingControlFacts: [],
      processCleanupRecorded: false,
    };
    this.pendingAdmission = reservation;
    this.active = true;
    this.publishRuntimeState();
    const receipt = new Promise<Admission>((resolve, reject) => {
      reservation.resolve = resolve;
      reservation.reject = reject;
    });
    const completion = this.runReservation(reservation);
    reservation.completion = completion;
    this.admissionCompletion = completion;
    void completion.then((outcome) => {
      if (!reservation.admitted) reservation.reject?.(admissionError(outcome));
    }, (error) => {
      if (!reservation.admitted) {
        reservation.reject?.(new Error(errorText(error)));
      }
    });
    void completion.catch(() => {});
    return receipt;
  }

  private async runReservation(
    reservation: PendingAdmission,
  ): Promise<SmallOutcome> {
    let execution: ActiveExecution | undefined;
    let operation = 'worker_execution';
    try {
      await this.ensureGeneration();
      const correlation = this.supervisor.correlation(
        `turn-${this.descriptorValue.nextTurn}-${crypto.randomUUID().toLowerCase()}`,
      );
      reservation.correlation = correlation;
      this.supervisor.setCurrentCorrelation(correlation);
      const admission = await this.options.data.executionAdmit(this.sessionId, {
        executionId: reservation.executionId,
        taskId: reservation.taskId,
        task: reservation.task,
        correlation,
        createdAt: reservation.createdAt,
      });
      this.acceptDescriptor(admission.descriptor);
      reservation.admitted = true;
      execution = {
        executionId: reservation.executionId,
        turn: admission.descriptor.latestExecution?.turn ??
          Math.max(1, this.descriptorValue.nextTurn),
        correlation,
        protocolTrace: [...this.supervisor.bootstrapTrace],
        reservation,
        requestCount: 0,
        settling: false,
        cancelled: reservation.cancelled,
        forced: false,
        dispatched: false,
      };
      this.activeExecution = execution;
      this.flushPendingControlFacts(reservation);
      this.supervisor.beginTurnStageProbeEpoch();
      const completion = reservation.completion!;
      reservation.resolve?.({ executionId: execution.executionId, completion });
      const chatgptRegistrationId = await this.executionChatGPTRegistrationId();
      this.children.openParent(
        execution.executionId,
        chatgptRegistrationId,
      );
      this.publishRuntimeState();

      if (reservation.cancelled || execution.forced) {
        return await this.seal(
          execution,
          execution.forced ? 'interrupted' : 'cancelled',
          'cancelled during preparation',
        );
      }

      this.send({
        kind: 'turn',
        correlation,
        executionId: execution.executionId,
        task: reservation.task,
        ...(chatgptRegistrationId === undefined ? {} : {
          chatgptRegistrationId,
        }),
      });
      execution.dispatched = true;
      this.publishRuntimeState();
      const terminal = await this.supervisor.messages.wait(
        (
          message,
        ): message is
          | WorkerProposalReadyMessage
          | WorkerFailureReadyMessage
          | WorkerErrorMessage =>
          (message.kind === 'proposal_ready' ||
            message.kind === 'failure_ready' ||
            message.kind === 'worker_error') &&
          (message.kind === 'worker_error'
            ? message.correlation === undefined ||
              sameCorrelation(message.correlation, correlation)
            : sameCorrelation(message.correlation, correlation)),
      );
      if (terminal.kind === 'worker_error') {
        execution.settling = true;
        this.supervisor.markUnavailableForReplacement();
        await this.finishProcessCleanup(execution);
        await this.children.cleanupParent(execution.executionId);
        const outcome = await this.seal(
          execution,
          'interrupted',
          terminal.message,
          terminal.details ??
            captureFailureDetails(terminal.message, {
              operation: `worker_${terminal.stage}`,
            }),
        );
        return outcome;
      }
      execution.settling = true;
      if (terminal.kind === 'failure_ready') {
        const cleanup = await this.children.cleanupParent(
          execution.executionId,
        );
        await this.options.data.updateExecutionArtifactMetadata(
          this.sessionId,
          execution.executionId,
          {
            protocolTrace: this.trace(execution),
            ...(cleanup === undefined ? {} : { childCleanup: cleanup }),
          },
        );
        const result = await this.options.data.settleFailure(this.sessionId, {
          executionId: execution.executionId,
          finalDataSequence: terminal.finalDataSequence,
        });
        this.acceptTerminal(result);
        this.sendSettlementAcknowledgement(execution, result);
        await this.waitForTurnSettled(execution);
        await this.finishProcessCleanup(execution);
        this.finishExecution(execution);
        if (
          result.outcome.diagnostic?.stage === 'cancellation_cleanup' &&
          result.outcome.diagnostic.code === 'cleanup_error'
        ) this.supervisor.markUnavailable();
        this.deliverTerminal(execution, result, false);
        return this.terminalOutcome(result);
      }
      operation = 'session_commit';
      return await this.settleProposal(execution, terminal, reservation);
    } catch (error) {
      if (execution === undefined) {
        return smallFailure(
          reservation.task,
          errorText(error),
          reservation.cancelled,
        );
      }
      if (execution.forced) {
        await this.finishProcessCleanup(execution);
        return await this.seal(
          execution,
          'interrupted',
          'Worker generation was terminated after cancellation did not settle',
        );
      }
      if (execution.cancelled || reservation.cancelled) {
        return await this.seal(execution, 'cancelled', 'execution cancelled');
      }
      this.supervisor.markUnavailableForReplacement();
      await this.finishProcessCleanup(execution);
      const outcome = await this.seal(
        execution,
        'interrupted',
        errorText(error),
        captureFailureDetails(error, { operation }),
      );
      return outcome;
    } finally {
      this.clearCancellationWatchdog(reservation);
      if (execution !== undefined) {
        await this.children.cleanupParent(execution.executionId).catch(() => undefined);
        await this.finishProcessCleanup(execution);
        this.supervisor.finishProcessExecution(execution.executionId);
        this.children.releaseParent(execution.executionId);
        await execution.reservation.controlWrites;
        if (this.activeExecution === execution) {
          this.activeExecution = undefined;
        }
      }
      if (this.pendingAdmission === reservation) {
        this.pendingAdmission = undefined;
      }
      this.active = false;
      this.admissionCompletion = undefined;
      this.supervisor.setCurrentCorrelation(undefined);
      this.publishRuntimeState();
    }
  }

  private async executionChatGPTRegistrationId(): Promise<
    string | null | undefined
  > {
    const selection = this.descriptorValue.modelSelection;
    if (selection.provider !== 'openai-chatgpt') return undefined;
    if (this.options.chatgptRegistrationId !== undefined) {
      return this.options.chatgptRegistrationId;
    }
    if (
      'registrationId' in selection && selection.registrationId !== undefined
    ) {
      return selection.registrationId;
    }
    return await this.chatgptAuthService().selectedRegistrationId();
  }

  private async settleProposal(
    execution: ActiveExecution,
    barrier: WorkerProposalReadyMessage,
    reservation: PendingAdmission,
  ): Promise<SmallOutcome> {
    const token = await this.options.data.prepareProposal(this.sessionId, {
      proposalId: barrier.proposalId,
      executionId: execution.executionId,
      finalDataSequence: barrier.finalDataSequence,
    });
    if (execution.terminalPromise !== undefined) {
      return await execution.terminalPromise;
    }
    const cleanup = await this.children.cleanupParent(execution.executionId);
    if (execution.terminalPromise !== undefined) {
      return await execution.terminalPromise;
    }
    await this.options.data.updateExecutionArtifactMetadata(
      this.sessionId,
      execution.executionId,
      {
        protocolTrace: this.trace(execution),
        ...(cleanup === undefined ? {} : { childCleanup: cleanup }),
      },
    );
    const stillCurrent = this.activeExecution === execution &&
      sameCorrelation(
        this.supervisor.currentCorrelation ?? execution.correlation,
        execution.correlation,
      ) &&
      !this.supervisor.isUnavailable;
    const decision: DataCommitDecision = execution.cancelled || reservation.cancelled
      ? {
        accepted: false,
        settlement: 'cancelled',
        reason: 'execution cancelled before commit',
      }
      : execution.forced || !stillCurrent
      ? {
        accepted: false,
        settlement: 'interrupted',
        reason: 'execution changed before commit',
      }
      : cleanup?.runs.some((run) => run.durability === 'failed')
      ? {
        accepted: false,
        settlement: 'rejected',
        reason: 'child cleanup failed',
      }
      : { accepted: true };
    execution.settling = true;
    this.publishRuntimeState();
    execution.terminalPromise = (async () => {
      const result = await this.options.data.authorizeCommit(
        this.sessionId,
        token,
        decision,
      );
      this.acceptTerminal(result);
      const accepted = result.accepted && result.durable;
      this.sendSettlementAcknowledgement(execution, result);
      await this.waitForTurnSettled(execution);
      await this.finishProcessCleanup(execution);
      this.finishExecution(execution);
      this.deliverTerminal(execution, result, accepted);
      return this.terminalOutcome(result);
    })();
    return await execution.terminalPromise;
  }

  private async seal(
    execution: ActiveExecution,
    decision: 'cancelled' | 'interrupted',
    reason: string,
    details?: FailureDetails,
  ): Promise<SmallOutcome> {
    if (execution.terminalPromise !== undefined) {
      return await execution.terminalPromise;
    }
    execution.settling = true;
    execution.terminalPromise = (async () => {
      this.supervisor.markUnavailableForReplacement();
      await this.finishProcessCleanup(execution);
      const cleanup = await this.children.cleanupParent(execution.executionId)
        .catch(() => undefined);
      try {
        await this.options.data.updateExecutionArtifactMetadata(
          this.sessionId,
          execution.executionId,
          {
            protocolTrace: this.trace(execution),
            ...(cleanup === undefined ? {} : { childCleanup: cleanup }),
          },
        );
      } catch {
        // Sealing the durable prefix is the terminal decision; metadata is auxiliary.
      }
      const result = await this.options.data.sealGeneration(this.sessionId, {
        executionId: execution.executionId,
        decision,
        reason,
        ...(details === undefined ? {} : {
          diagnostic: createFailureDiagnostic({
            stage: details.operation === 'session_commit' ||
                details.operation === 'data_prepare_proposal' ||
                details.operation === 'data_authorize_commit'
              ? 'session_commit'
              : 'worker_execution',
            code: details.operation === 'session_commit' ||
                details.operation === 'data_prepare_proposal' ||
                details.operation === 'data_authorize_commit'
              ? 'commit_error'
              : 'worker_error',
            turnNumber: execution.turn,
            modelStep: 0,
            providerRequestCount: execution.requestCount,
            details,
          }),
        }),
      });
      this.acceptTerminal(result);
      this.deliverTerminal(execution, result, false);
      this.finishExecution(execution);
      return this.terminalOutcome(result);
    })();
    return await execution.terminalPromise;
  }

  private acceptTerminal(result: DataSessionTerminalResult): void {
    this.acceptDescriptor(result.descriptor);
  }

  private terminalOutcome(result: DataSessionTerminalResult): SmallOutcome {
    const runtimeCount = result.outcome.runtimeProviderRequestCount;
    return runtimeCount === undefined ? result.outcome : {
      ...result.outcome,
      runtimeProviderRequestCount: this.runtimeRequestCount,
    };
  }

  private finishExecution(execution: ActiveExecution): void {
    if (this.activeExecution === execution) execution.settling = true;
    this.clearCancellationWatchdog(execution.reservation);
  }

  private deliverTerminal(
    execution: ActiveExecution,
    result: DataSessionTerminalResult,
    committed: boolean,
  ): void {
    if (!result.durable) return;
    const outcome = this.terminalOutcome(result);
    this.recordExecutionControl(execution.reservation, {
      kind: 'post_commit_turn_end',
      correlation: execution.correlation,
      turn: execution.turn,
      outcome: outcome.stopReason,
      committed,
      generationUnavailable: this.supervisor.isUnavailable ||
        this.supervisor.generationNeedsReplacement,
    });
    this.deliver(turnEndFromOutcome(execution.turn, outcome, committed));
  }

  private deliver(event: AgentEvent): void {
    try {
      this.options.eventSink?.(structuredClone(event));
    } catch {
      // Data owns durable event state; a display callback cannot change settlement.
    }
  }

  private send(
    command: import('./worker_protocol.ts').WorkerHostCommand,
  ): void {
    this.supervisor.send(
      command,
      this.activeExecution?.protocolTrace ?? this.supervisor.bootstrapTrace,
    );
  }

  private trace(
    execution: ActiveExecution,
  ): readonly WorkerExecutionTraceEntry[] {
    return execution.protocolTrace.map((entry, index) => ({
      ...structuredClone(entry),
      sequence: index + 1,
    }));
  }

  private receive(message: WorkerToHostMessage): void {
    this.supervisor.noteWorkerSequenceReceived(message);
    this.supervisor.receiveTrace(message, this.activeExecution?.protocolTrace);
    if (message.kind === 'startup_prepared') {
      const current = this.supervisor.currentCorrelation;
      if (
        current !== undefined && sameCorrelation(message.correlation, current)
      ) {
        this.options.onStartupPrepared?.(message);
      }
      return;
    }
    if (message.kind === 'async_agent_request') {
      void this.handleAsyncAgentRequest(message);
      return;
    }
    if (message.kind === 'request_count') {
      this.acceptRequestCount(message);
      return;
    }
    if (message.kind === 'request_started') {
      this.acceptRequestStarted(message);
      return;
    }
    if (message.kind === 'steering_applied') {
      const execution = this.activeExecution;
      if (
        execution !== undefined &&
        sameCorrelation(message.correlation, execution.correlation)
      ) {
        try {
          this.options.applicationObservationSink?.({
            kind: 'steering_applied',
            executionId: execution.executionId,
          });
        } catch {
          // The task service observation is advisory; the stored Agent event is in Data.
        }
      }
      return;
    }
    if (message.kind === 'cancel_received') {
      const reservation = this.pendingAdmission;
      if (
        reservation !== undefined &&
        reservation.correlation !== undefined &&
        sameCorrelation(message.correlation, reservation.correlation)
      ) {
        this.recordExecutionControl(reservation, {
          kind: 'cancel_received',
          correlation: message.correlation,
          workerSequence: message.sequence,
          result: message.result,
          observedAt: message.observedAt,
        });
      }
      return;
    }
    this.supervisor.messages.publish(message);
  }

  private recordExecutionControl(
    reservation: PendingAdmission,
    fact: DataExecutionControlFact,
  ): void {
    const input = {
      ...fact,
      observedAt: fact.observedAt ?? new Date().toISOString(),
      controlSequence: ++reservation.controlSequence,
    } as DataExecutionControlInput;
    if (!reservation.admitted) {
      reservation.pendingControlFacts.push(input);
      return;
    }
    this.persistExecutionControl(reservation, input);
  }

  private flushPendingControlFacts(reservation: PendingAdmission): void {
    for (const input of reservation.pendingControlFacts.splice(0)) {
      this.persistExecutionControl(reservation, input);
    }
  }

  private persistExecutionControl(
    reservation: PendingAdmission,
    input: DataExecutionControlInput,
  ): void {
    reservation.controlWrites = reservation.controlWrites.catch(() => undefined)
      .then(async () => {
        try {
          const descriptor = await this.options.data.recordExecutionControl(
            this.sessionId,
            reservation.executionId,
            input,
          );
          const latest = descriptor.latestExecution;
          if (latest?.executionId !== reservation.executionId) return;
          this.descriptorValue = {
            ...this.descriptorValue,
            latestExecution: structuredClone(latest),
          };
          this.publishRuntimeState();
        } catch {
          // Post-terminal control facts cannot change the saved execution outcome.
        }
      });
  }

  private sendSettlementAcknowledgement(
    execution: ActiveExecution,
    result: DataSessionTerminalResult,
  ): void {
    const accepted = result.accepted && result.durable;
    try {
      this.send({
        kind: 'commit_acknowledgement',
        correlation: execution.correlation,
        accepted,
        settlement: {
          accepted: result.accepted,
          adopted: result.canonical,
          durable: result.durable,
          stateRevision: result.stateRevision,
          terminalOutcome: {
            ok: result.outcome.ok,
            outcome: result.outcome.outcome,
            stopReason: result.outcome.stopReason,
            ...(result.outcome.error === undefined ? {} : { error: result.outcome.error }),
          },
        },
      });
      this.recordExecutionControl(execution.reservation, {
        kind: 'acknowledgement_requested',
        accepted,
      });
      this.recordExecutionControl(execution.reservation, {
        kind: 'acknowledgement_sent',
        accepted,
      });
    } catch {
      this.recordExecutionControl(execution.reservation, {
        kind: 'acknowledgement_requested',
        accepted,
      });
      this.recordExecutionControl(execution.reservation, {
        kind: 'acknowledgement_failed',
        accepted,
      });
      this.supervisor.markUnavailableForReplacement();
    }
  }

  private async waitForTurnSettled(
    execution: ActiveExecution,
  ): Promise<boolean> {
    try {
      const message = await this.supervisor.messages.wait(
        (message): message is WorkerTurnSettledMessage | WorkerErrorMessage =>
          (message.kind === 'turn_settled' &&
            sameCorrelation(message.correlation, execution.correlation)) ||
          (message.kind === 'worker_error' &&
            (message.correlation === undefined ||
              sameCorrelation(message.correlation, execution.correlation))),
      );
      if (message.kind === 'worker_error') {
        this.supervisor.markUnavailableForReplacement();
        return false;
      }
      this.recordExecutionControl(execution.reservation, {
        kind: 'turn_settled',
        correlation: execution.correlation,
      });
      return true;
    } catch {
      this.supervisor.markUnavailableForReplacement();
      return false;
    }
  }

  private async finishProcessCleanup(
    execution: ActiveExecution,
  ): Promise<void> {
    if (execution.reservation.processCleanupRecorded) return;
    let result: 'complete' | 'failed' = 'complete';
    try {
      await this.supervisor.waitForProcessCleanup(execution.executionId);
    } catch {
      result = 'failed';
    }
    execution.reservation.processCleanupRecorded = true;
    this.recordExecutionControl(execution.reservation, {
      kind: 'process_cleanup_finished',
      result,
    });
  }

  private acceptRequestStarted(message: WorkerRequestStartedMessage): void {
    const execution = this.activeExecution;
    if (
      execution !== undefined &&
      sameCorrelation(message.correlation, execution.correlation)
    ) {
      execution.latestRequestOrdinal = message.requestOrdinal;
      execution.latestModelStep = message.modelStep;
      execution.requestCount += 1;
    }
    this.generationRequestCount += 1;
    this.runtimeRequestCount = this.generationRequestBase +
      this.generationRequestCount;
  }

  private acceptRequestCount(message: WorkerRequestCountMessage): void {
    if (
      message.runtimeProviderRequestCount !== undefined &&
      Number.isSafeInteger(message.runtimeProviderRequestCount) &&
      message.runtimeProviderRequestCount >= 0
    ) {
      this.generationRequestCount = Math.max(
        this.generationRequestCount,
        message.runtimeProviderRequestCount,
      );
      const total = this.generationRequestBase +
        message.runtimeProviderRequestCount;
      if (total >= this.runtimeRequestCount) this.runtimeRequestCount = total;
    }
    const execution = this.activeExecution;
    if (
      execution !== undefined &&
      (message.executionId === undefined ||
        message.executionId === execution.executionId) &&
      message.turnProviderRequestCount !== undefined &&
      Number.isSafeInteger(message.turnProviderRequestCount) &&
      message.turnProviderRequestCount >= 0
    ) {
      execution.requestCount = message.turnProviderRequestCount;
    }
  }

  private workerResponseTimeoutMs(): number {
    return this.options.workerResponseTimeoutMs ?? 5_000;
  }

  private async ensureGeneration(): Promise<void> {
    if (this.supervisor.generationNeedsReplacement) {
      const cleanup = await this.children.cleanupAll();
      if (cleanup?.runs.some((run) => run.durability === 'failed')) {
        throw new Error('async child cleanup failed before Worker replacement');
      }
    }
    await this.supervisor.ensureGeneration();
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    const reservation = this.pendingAdmission;
    const execution = this.activeExecution;
    const target = execution ?? (reservation === undefined ? undefined : {
      executionId: reservation.executionId,
      correlation: reservation.correlation ??
        this.supervisor.currentCorrelation,
    });
    if (target === undefined || !this.active) return 'idle';
    if (execution?.cancelled || reservation?.cancelled) {
      return 'already_requested';
    }
    if (execution !== undefined) execution.cancelled = true;
    if (reservation !== undefined) reservation.cancelled = true;
    this.supervisor.cancelProcessExecution(target.executionId);
    let cancelSent = false;
    if (target.correlation !== undefined) {
      try {
        this.send({ kind: 'cancel', correlation: target.correlation });
        cancelSent = true;
      } catch {
        this.supervisor.markUnavailableForReplacement();
      }
    }
    if (execution !== undefined) {
      void this.children.cleanupParent(execution.executionId).catch(() => {});
    }
    if (reservation !== undefined) {
      this.scheduleCancellationWatchdog(reservation);
    }
    const activeReservation = reservation ?? execution?.reservation;
    if (activeReservation !== undefined) {
      this.recordExecutionControl(activeReservation, {
        kind: 'cancel_requested',
      });
      if (target.correlation !== undefined) {
        this.recordExecutionControl(activeReservation, {
          kind: cancelSent ? 'cancel_sent' : 'cancel_failed',
        });
      }
    }
    this.publishRuntimeState();
    return 'requested';
  }

  private scheduleCancellationWatchdog(reservation: PendingAdmission): void {
    if (reservation.watchdog !== undefined) clearTimeout(reservation.watchdog);
    reservation.watchdog = setTimeout(() => {
      void this.escalateCancellation(reservation);
    }, this.options.cancelSettlementGraceMs ?? WORKER_SETTLEMENT_GRACE_MS);
  }

  private clearCancellationWatchdog(
    reservation: PendingAdmission | undefined,
  ): void {
    if (reservation?.watchdog === undefined) return;
    clearTimeout(reservation.watchdog);
    reservation.watchdog = undefined;
  }

  private async escalateCancellation(
    reservation: PendingAdmission,
  ): Promise<void> {
    if (!reservation.cancelled) return;
    const execution = this.activeExecution;
    if (
      execution !== undefined &&
      execution.executionId === reservation.executionId
    ) {
      execution.forced = true;
    }
    this.supervisor.markUnavailableForReplacement();
    await this.supervisor.waitForProcessCleanup(reservation.executionId).catch(
      () => {},
    );
    this.recordExecutionControl(reservation, { kind: 'cancel_escalated' });
    if (
      execution !== undefined &&
      execution.executionId === reservation.executionId
    ) {
      if (execution.terminalPromise !== undefined) {
        await execution.terminalPromise.catch(() => {});
      } else {
        await this.seal(
          execution,
          'interrupted',
          'Worker generation was terminated after cancellation did not settle',
        ).catch(() => {});
      }
    }
  }

  async steerActiveTurn(
    text: string,
  ): Promise<'accepted' | 'already_accepted' | 'idle'> {
    const execution = this.activeExecution;
    if (
      execution === undefined || !this.active || !execution.dispatched ||
      this.supervisor.currentCorrelation === undefined || execution.cancelled
    ) return 'idle';
    const validated = validateSteeringText(text);
    const requestId = crypto.randomUUID();
    try {
      this.send({
        kind: 'steer',
        correlation: execution.correlation,
        requestId,
        text: validated,
      });
      const reply = await this.supervisor.messages.wait(
        (
          message,
        ): message is import('./worker_protocol.ts').WorkerSteeringReceivedMessage =>
          message.kind === 'steering_received' &&
          message.requestId === requestId &&
          sameCorrelation(message.correlation, execution.correlation),
        this.workerResponseTimeoutMs(),
      );
      return reply.result;
    } catch (error) {
      this.supervisor.markUnavailableForReplacement();
      throw error;
    }
  }

  private async handleAsyncAgentRequest(
    message: Extract<WorkerToHostMessage, { kind: 'async_agent_request' }>,
  ): Promise<void> {
    const execution = this.activeExecution;
    let response: import('../tools/async_agents.ts').AsyncAgentResponse;
    try {
      response = await this.children.handle(
        message.request,
        message.callId,
        execution?.executionId,
      );
    } catch (error) {
      response = { ok: false, error: errorText(error) };
    }
    if (execution === undefined || this.activeExecution !== execution) return;
    try {
      this.send({
        kind: 'async_agent_response',
        correlation: message.correlation,
        requestId: message.requestId,
        response,
      });
    } catch {
      // The parent terminal path owns any child left by a failed response send.
    }
  }

  private correlation(command: string): WorkerCorrelation {
    return this.supervisor.correlation(command);
  }

  async close(): Promise<WorkerClosedMessage | undefined> {
    if (this.closed) return this.closeResult;
    this.closed = true;
    if (this.active) this.cancelActiveTurn();
    await this.admissionCompletion?.catch(() => {});
    await this.children.cleanupAll().catch(() => undefined);
    this.unsubscribeWatch?.();
    this.unsubscribeAgentEvents?.();
    this.closeResult = await this.supervisor.close();
    await this.chatgptAuth?.close().catch(() => {});
    this.publishRuntimeState();
    return this.closeResult;
  }
}
