import type { AgentEvent, AgentEventSink } from './events.ts';
import type { LoopOutcome, Message } from './contracts.ts';
import {
  historyPageWindow,
  indexSessionHistory,
  type SessionHistoryPage,
} from './session_history.ts';
import { discoverAgentInstructionSnapshot } from './agent_instructions.ts';
import { discoverSkills } from './skills.ts';
import { PRODUCTION_PROFILE } from './provider_profile.ts';
import { projectRuntimeDisplayState, type RuntimeDisplayState } from './startup_orientation.ts';
import { resolveWorkspace } from './work_tools.ts';
import type {
  NavigationBinding,
  NavigationListing,
  NavigationPosition,
  SessionNavigationHost,
} from './session_navigation.ts';
import {
  type DefinitionRevisionRef,
  DenoSessionStore,
  launcherStateRoot,
  restoredMessages,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  type SessionRecordV2,
  type StoredSessionRecord,
  validateSemanticContextCheckpoint,
  validateSessionRecordV2,
  type WorkerSessionHandle,
  type WorkerSessionStorePort,
} from './session_store.ts';
import type {
  FailureDiagnosticPersistenceErrorCode,
  FailureDiagnosticPersister,
  FailureDiagnosticV1,
} from './failure_diagnostic.ts';
import type {
  ProviderEvidencePersistenceErrorCode,
  ProviderEvidenceStore,
  ProviderEvidenceV1,
} from './provider_evidence.ts';
import { DenoFailureDiagnosticStore } from './failure_diagnostic_store.ts';
import { DenoProviderEvidenceStore } from './provider_evidence_store.ts';
import {
  readWorkerModuleRevision,
  WorkerCapsule,
  type WorkerModuleRevision,
} from './worker_capsule.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerErrorMessage,
  WorkerReadyMessage,
  WorkerRuntimeEventMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import {
  type WorkerExecutionAcknowledgement,
  type WorkerExecutionArtifactV1,
  workerExecutionOutcome,
  type WorkerExecutionSettlement,
  type WorkerExecutionStoreResult,
  type WorkerExecutionTraceEntry,
  type WorkerExecutionTurnCommand,
  workerHostCommandSubtype,
  workerMessageSubtype,
} from './worker_execution_artifact.ts';
import {
  DenoWorkerExecutionArtifactStore,
  type WorkerExecutionArtifactStore,
} from './worker_execution_artifact_store.ts';

const workerUrl = new URL('./worker_bootstrap.ts', import.meta.url);
const profileIdPattern = /^[^\0]+$/u;

type MessagePredicate<T extends WorkerToHostMessage> = (
  message: WorkerToHostMessage,
) => message is T;

type Waiter = {
  readonly predicate: (message: WorkerToHostMessage) => boolean;
  readonly resolve: (message: WorkerToHostMessage) => void;
  readonly reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

class HostMessageQueue {
  private readonly queue: WorkerToHostMessage[] = [];
  private readonly waiters: Waiter[] = [];

  publish(message: WorkerToHostMessage): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  wait<T extends WorkerToHostMessage>(
    predicate: MessagePredicate<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const queuedIndex = this.queue.findIndex((message) => predicate(message));
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return Promise.resolve(message as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (message) => resolve(message as T),
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `timed out waiting for Worker message after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

export interface WorkerDefinitionRevision extends WorkerModuleRevision {
  readonly kind: DefinitionRevisionRef['kind'];
  readonly id?: 'default' | 'planner';
}

export const readDefinitionRevision = async (
  path: string,
  kind: DefinitionRevisionRef['kind'],
  id?: 'default' | 'planner',
): Promise<DefinitionRevisionRef> => {
  const revision = await readWorkerModuleRevision(path);
  if (kind === 'builtin' && id === undefined) {
    throw new Error('built-in Definition id required');
  }
  if (kind === 'external' && id !== undefined) {
    throw new Error('external Definition has no id');
  }
  return kind === 'builtin'
    ? {
      kind,
      id: id!,
      canonicalSpecifier: revision.canonicalSpecifier,
      entrySha256: revision.entrySha256,
      sourceBytes: revision.sourceBytes,
    }
    : {
      kind,
      canonicalSpecifier: revision.canonicalSpecifier,
      entrySha256: revision.entrySha256,
      sourceBytes: revision.sourceBytes,
    };
};

const sameRef = (
  left: DefinitionRevisionRef,
  right: DefinitionRevisionRef,
): boolean =>
  left.kind === right.kind &&
  (left.kind !== 'builtin' ||
    right.kind !== 'external' && left.id === right.id) &&
  left.canonicalSpecifier === right.canonicalSpecifier &&
  left.entrySha256 === right.entrySha256 &&
  left.sourceBytes === right.sourceBytes;

const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const textFromTranscript = (
  transcript: readonly Message[],
): string | undefined => {
  const message = transcript.at(-1);
  if (
    message?.role !== 'assistant' || typeof message.content !== 'object' ||
    message.content === null || Array.isArray(message.content)
  ) return undefined;
  const content = message.content as {
    readonly kind?: unknown;
    readonly text?: unknown;
  };
  return content.kind === 'text' && typeof content.text === 'string' ? content.text : undefined;
};

const proposalOutcome = (
  task: string,
  transcript: readonly Message[],
  terminal: WorkerRuntimeEventMessage | undefined,
): LoopOutcome => {
  const toolCallCount = transcript.reduce(
    (count, message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? count + message.content.length
        : count,
    0,
  );
  const toolResultCount = transcript.reduce(
    (count, message) => message.role === 'tool' ? count + message.content.length : count,
    0,
  );
  const stopReason = terminal?.event.kind === 'agent_event' &&
      terminal.event.event.kind === 'turn_end'
    ? terminal.event.event.outcome
    : 'final' as const;
  return {
    ok: true,
    task,
    outcome: stopReason,
    stopReason,
    ...(textFromTranscript(transcript) === undefined
      ? {}
      : { finalText: textFromTranscript(transcript) }),
    steps: Math.max(1, toolResultCount),
    toolCallCount,
    toolResultCount,
    transcript: structuredClone(transcript),
  };
};

const failedOutcome = (
  task: string,
  transcript: readonly Message[],
  reason: string,
  cancelled = false,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: cancelled ? 'cancelled' : 'contract_failure',
  stopReason: cancelled ? 'cancelled' : 'contract_failure',
  ...(cancelled ? {} : { error: reason }),
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: structuredClone(transcript),
});

const persistenceCode = <T extends string>(
  error: unknown,
  allowed: readonly T[],
  fallback: T,
): T => {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && allowed.includes(code as T) ? code as T : fallback;
};

const diagnosticPersistenceCodes: readonly FailureDiagnosticPersistenceErrorCode[] = [
  'diagnostic_not_found',
  'diagnostic_busy',
  'diagnostic_invalid',
  'diagnostic_capacity',
  'diagnostic_io_failure',
];

const evidencePersistenceCodes: readonly ProviderEvidencePersistenceErrorCode[] = [
  'provider_evidence_not_found',
  'provider_evidence_invalid',
  'provider_evidence_io_failure',
];

const turnEndFromOutcome = (
  turn: number,
  outcome: LoopOutcome,
  committed: boolean,
): AgentEvent => ({
  kind: 'turn_end',
  turn,
  outcome: outcome.stopReason,
  committed,
  ...(outcome.turnProviderRequestCount === undefined ? {} : {
    turnProviderRequestCount: outcome.turnProviderRequestCount,
  }),
  ...(outcome.runtimeProviderRequestCount === undefined ? {} : {
    runtimeProviderRequestCount: outcome.runtimeProviderRequestCount,
  }),
  ...(outcome.providerEvidenceId === undefined ? {} : {
    providerEvidenceId: outcome.providerEvidenceId,
  }),
  ...(outcome.providerEvidenceDurability === undefined ? {} : {
    providerEvidenceDurability: outcome.providerEvidenceDurability,
  }),
  ...(outcome.providerEvidencePersistenceError === undefined ? {} : {
    providerEvidencePersistenceError: outcome.providerEvidencePersistenceError,
  }),
  ...(outcome.executionArtifactId === undefined ? {} : {
    executionArtifactId: outcome.executionArtifactId,
  }),
  ...(outcome.executionArtifactDurability === undefined ? {} : {
    executionArtifactDurability: outcome.executionArtifactDurability,
  }),
  ...(outcome.executionArtifactPersistenceError === undefined ? {} : {
    executionArtifactPersistenceError: outcome.executionArtifactPersistenceError,
  }),
  ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
  ...(outcome.diagnosticDurability === undefined ? {} : {
    diagnosticDurability: outcome.diagnosticDurability,
  }),
  ...(outcome.diagnosticPersistenceError === undefined ? {} : {
    diagnosticPersistenceError: outcome.diagnosticPersistenceError,
  }),
});

export interface WorkerHostSessionOptions {
  readonly handle: WorkerSessionHandle;
  readonly workspaceRoot: string;
  readonly agent: SessionRecord['agent'];
  readonly definition: DefinitionRevisionRef;
  readonly modulePath: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

export interface WorkerHostCapsule {
  send(command: import('./worker_protocol.ts').WorkerHostCommand): void;
  subscribe(listener: (message: WorkerToHostMessage) => void): () => void;
  terminate(): void;
}

type ActiveWorkerExecution = {
  readonly executionId: string;
  readonly createdAt: string;
  readonly turn: number;
  readonly command: WorkerExecutionTurnCommand;
  readonly baseStateRevision: number;
  readonly protocolTrace: WorkerExecutionTraceEntry[];
  storeResult: WorkerExecutionStoreResult;
  storeError?: 'session_io_failure' | 'session_invalid';
  proposedStateRevision?: number;
  committedStateRevision?: number;
  acknowledgement: WorkerExecutionAcknowledgement;
  settlement: WorkerExecutionSettlement;
  artifactWritten: boolean;
};

/** Host-owned canonical session around one ephemeral Worker generation. */
export class WorkerHostSession {
  private readonly capsule: WorkerHostCapsule;
  private readonly messages = new HostMessageQueue();
  private readonly unsubscribe: () => void;
  private readonly instanceCorrelation = crypto.randomUUID().toLowerCase();
  private readonly workerGeneration = crypto.randomUUID().toLowerCase();
  private readonly bootstrapTrace: WorkerExecutionTraceEntry[] = [];
  private traceSequence = 0;
  private currentCorrelation: WorkerCorrelation | undefined;
  private currentManifest: WorkerReadyMessage['manifest'];
  private transcript: Message[];
  private nextTurn: number;
  private stateRevision: number;
  private checkpoint: SemanticContextCheckpointV1 | undefined;
  private autoCompactionNotice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
  private runtimeRequestCount = 0;
  private active = false;
  private unavailable = false;
  private closed = false;
  private activeExecution: ActiveWorkerExecution | undefined;

  private constructor(private readonly options: WorkerHostSessionOptions) {
    this.capsule = options.capsuleFactory?.(workerUrl) ??
      new WorkerCapsule(workerUrl);
    const record = options.handle.record;
    if (
      record !== undefined &&
      (record.workspaceRoot !== options.workspaceRoot ||
        record.agent !== options.agent ||
        record.schemaVersion === 2 &&
          !sameRef(record.definition, options.definition))
    ) {
      throw new Error(
        'session Definition revision does not match the selected binding',
      );
    }
    this.transcript = record === undefined ? [] : structuredClone(record.transcript) as Message[];
    this.nextTurn = record?.nextTurn ?? 1;
    this.stateRevision = record?.schemaVersion === 2 ? record.stateRevision : 1;
    this.checkpoint = options.handle.checkpoint === undefined
      ? undefined
      : structuredClone(options.handle.checkpoint);
    this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
  }

  static async open(
    options: WorkerHostSessionOptions,
  ): Promise<WorkerHostSession> {
    const session = new WorkerHostSession(options);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get definition(): DefinitionRevisionRef {
    return structuredClone(this.options.definition);
  }

  get sessionId(): string {
    return this.options.handle.id;
  }

  private trace(
    direction: WorkerExecutionTraceEntry['direction'],
    kind: WorkerExecutionTraceEntry['kind'],
    semanticSubtype: string,
    correlation: WorkerCorrelation,
    ackAccepted?: boolean,
  ): void {
    const entry: WorkerExecutionTraceEntry = {
      direction,
      kind,
      semanticSubtype,
      sequence: ++this.traceSequence,
      correlation: structuredClone(correlation),
      ...(ackAccepted === undefined ? {} : { ackAccepted }),
    };
    if (this.activeExecution === undefined) this.bootstrapTrace.push(entry);
    else this.activeExecution.protocolTrace.push(entry);
  }

  private send(command: import('./worker_protocol.ts').WorkerHostCommand): void {
    const subtype = workerHostCommandSubtype(command);
    this.trace(
      'host_to_worker',
      subtype.kind,
      subtype.semanticSubtype,
      command.correlation,
      subtype.ackAccepted,
    );
    this.capsule.send(command);
  }

  private receiveTrace(message: WorkerToHostMessage): void {
    const subtype = workerMessageSubtype(message);
    const correlation = 'correlation' in message && message.correlation !== undefined
      ? message.correlation
      : this.currentCorrelation ?? this.correlation('worker_error');
    this.trace('worker_to_host', subtype.kind, subtype.semanticSubtype, correlation);
  }

  private receive(message: WorkerToHostMessage): void {
    this.receiveTrace(message);
    if (message.kind === 'runtime_event') {
      if (
        message.event.kind === 'agent_event' &&
        message.event.event.kind === 'turn_end'
      ) {
        this.messages.publish(message);
      } else if (message.event.kind === 'agent_event') {
        this.deliver(message.event.event);
      }
      return;
    }
    if (message.kind === 'effect_observation') {
      this.deliver(message.effect);
      return;
    }
    if (message.kind === 'checkpoint_proposal') {
      void this.installCheckpoint(message);
      return;
    }
    this.messages.publish(message);
  }

  private deliver(event: AgentEvent): void {
    if (this.options.eventSink === undefined) return;
    try {
      this.options.eventSink(structuredClone(event));
    } catch {
      // A pre-commit projection failure must stop the generation before it can propose or
      // continue effects. After durable commit, the caller still owns the committed outcome.
      this.markUnavailable();
    }
  }

  private markUnavailable(): void {
    if (!this.unavailable) {
      this.unavailable = true;
      this.capsule.terminate();
    }
    this.messages.fail(new Error('Worker transport unavailable'));
  }

  private observeRequestCount(outcome: LoopOutcome): void {
    const count = outcome.runtimeProviderRequestCount;
    if (count !== undefined && Number.isSafeInteger(count) && count >= this.runtimeRequestCount) {
      this.runtimeRequestCount = count;
    }
  }

  requestCount(): number {
    return this.runtimeRequestCount;
  }

  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null {
    const notice = this.autoCompactionNotice;
    this.autoCompactionNotice = undefined;
    return notice === undefined ? null : structuredClone(notice);
  }

  private async persistArtifacts(
    outcome: LoopOutcome,
    providerEvidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): Promise<LoopOutcome> {
    const evidenceId = providerEvidence?.evidenceId ?? outcome.providerEvidenceId;
    let evidenceDurability = providerEvidence === undefined
      ? outcome.providerEvidenceDurability
      : 'unknown' as const;
    let evidenceError = outcome.providerEvidencePersistenceError;
    if (providerEvidence !== undefined) {
      if (this.options.providerEvidenceStore === undefined) {
        evidenceDurability = 'unknown';
      } else {
        try {
          await this.options.providerEvidenceStore.write(providerEvidence);
          if (diagnostic?.diagnosticId !== undefined) {
            await this.options.providerEvidenceStore.linkDiagnostic(
              diagnostic.diagnosticId,
              providerEvidence.evidenceId,
            );
          }
          evidenceDurability = 'yes';
          evidenceError = undefined;
        } catch (error) {
          evidenceDurability = 'failed';
          evidenceError = persistenceCode(
            error,
            evidencePersistenceCodes,
            'provider_evidence_io_failure',
          );
        }
      }
    }
    let diagnosticDurability = outcome.diagnosticDurability;
    let diagnosticError = outcome.diagnosticPersistenceError;
    if (diagnostic !== undefined) {
      if (this.options.diagnosticPersistence === undefined) {
        diagnosticDurability = 'unknown';
      } else {
        try {
          await this.options.diagnosticPersistence(diagnostic);
          diagnosticDurability = 'yes';
          diagnosticError = undefined;
        } catch (error) {
          diagnosticDurability = 'failed';
          diagnosticError = persistenceCode(
            error,
            diagnosticPersistenceCodes,
            'diagnostic_io_failure',
          );
        }
      }
    }
    const settled = {
      ...outcome,
      ...(evidenceId === undefined ? {} : { providerEvidenceId: evidenceId }),
      ...(evidenceDurability === undefined ? {} : {
        providerEvidenceDurability: evidenceDurability,
      }),
      ...(evidenceError === undefined ? {} : {
        providerEvidencePersistenceError: evidenceError,
      }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(diagnosticDurability === undefined ? {} : { diagnosticDurability }),
      ...(diagnosticError === undefined ? {} : {
        diagnosticPersistenceError: diagnosticError,
      }),
    };
    this.observeRequestCount(settled);
    return settled;
  }

  private async persistExecutionArtifact(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
  ): Promise<LoopOutcome> {
    if (execution.artifactWritten) return outcome;
    execution.artifactWritten = true;
    const store = this.options.executionArtifactStore;
    if (store === undefined || this.currentManifest === undefined) return outcome;
    const artifact: WorkerExecutionArtifactV1 = {
      schemaVersion: 1,
      executionId: execution.executionId,
      createdAt: execution.createdAt,
      settledAt: new Date().toISOString(),
      sessionId: this.sessionId,
      turn: execution.turn,
      agent: this.options.agent,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
      definition: structuredClone(this.options.definition),
      manifest: structuredClone(this.currentManifest),
      command: structuredClone(execution.command),
      baseStateRevision: execution.baseStateRevision,
      ...(execution.proposedStateRevision === undefined ? {} : {
        proposedStateRevision: execution.proposedStateRevision,
      }),
      ...(execution.committedStateRevision === undefined ? {} : {
        committedStateRevision: execution.committedStateRevision,
      }),
      // The bootstrap prefix is shared by generations, while an artifact's sequence is
      // deliberately local to this admitted turn. Preserve the observed order and correlation
      // without leaking the Host-wide trace counter into the durable per-turn contract.
      protocolTrace: execution.protocolTrace.map((entry, index) => ({
        ...structuredClone(entry),
        sequence: index + 1,
      })),
      ...(outcome.providerEvidenceId === undefined ? {} : {
        providerEvidenceId: outcome.providerEvidenceId,
      }),
      ...(outcome.providerEvidenceDurability === undefined ? {} : {
        providerEvidenceDurability: outcome.providerEvidenceDurability,
      }),
      ...(outcome.providerEvidencePersistenceError === undefined ? {} : {
        providerEvidencePersistenceError: outcome.providerEvidencePersistenceError,
      }),
      storeResult: execution.storeResult,
      ...(execution.storeError === undefined ? {} : { storeError: execution.storeError }),
      acknowledgement: execution.acknowledgement,
      settlement: execution.settlement,
      outcome: workerExecutionOutcome(outcome),
      effectCommitRelation: 'not_transactional',
      automaticReplay: false,
    };
    try {
      await store.write(artifact);
      return {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'yes',
        executionArtifactPersistenceError: undefined,
      };
    } catch (error) {
      const code = typeof error === 'object' && error !== null &&
          (error as { readonly code?: unknown }).code === 'worker_execution_artifact_invalid'
        ? 'worker_execution_artifact_invalid' as const
        : 'worker_execution_artifact_io_failure' as const;
      return {
        ...outcome,
        executionArtifactId: execution.executionId,
        executionArtifactDurability: 'failed',
        executionArtifactPersistenceError: code,
      };
    }
  }

  private async settleExecution(
    execution: ActiveWorkerExecution,
    outcome: LoopOutcome,
    providerEvidence: ProviderEvidenceV1 | undefined,
    diagnostic: FailureDiagnosticV1 | undefined,
  ): Promise<LoopOutcome> {
    const settled = await this.persistArtifacts(outcome, providerEvidence, diagnostic);
    return await this.persistExecutionArtifact(execution, settled);
  }

  private correlation(command: string): WorkerCorrelation {
    return {
      session: this.sessionId,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.workerGeneration,
      baseStateRevision: this.stateRevision,
      command,
    };
  }

  private async start(): Promise<void> {
    const correlation = this.correlation('start');
    const readyPromise = this.messages.wait((
      message,
    ): message is WorkerReadyMessage | WorkerErrorMessage =>
      (message.kind === 'ready' &&
        sameCorrelation(message.correlation, correlation)) ||
      (message.kind === 'worker_error' &&
        (message.correlation === undefined ||
          sameCorrelation(message.correlation, correlation))), 5_000);
    const revision = await readWorkerModuleRevision(this.options.modulePath);
    if (
      revision.canonicalSpecifier !==
        this.options.definition.canonicalSpecifier ||
      revision.entrySha256 !== this.options.definition.entrySha256 ||
      revision.sourceBytes !== this.options.definition.sourceBytes
    ) throw new Error('Definition revision changed before Worker startup');
    this.currentCorrelation = correlation;
    try {
      this.send({
        kind: 'start',
        correlation,
        module: revision,
        workspaceRoot: this.options.workspaceRoot,
        physicalIoMode: this.options.physicalIoMode ?? 'production',
        ...(this.options.rootMaxSteps === undefined
          ? {}
          : { rootMaxSteps: this.options.rootMaxSteps }),
        initialTranscript: this.transcript,
        nextTurn: this.nextTurn,
        ...(this.checkpoint === undefined ? {} : { checkpoint: this.checkpoint }),
      });
    } catch {
      this.markUnavailable();
      throw new Error('Worker transport unavailable');
    }
    const ready = await readyPromise;
    if (ready.kind === 'worker_error') throw new Error(ready.message);
    const expectedRole = this.options.agent === 'planner' ? 'planner' : 'parent';
    if (
      ready.manifest === undefined || ready.manifest.role !== expectedRole ||
      (this.options.rootMaxSteps !== undefined &&
        ready.manifest.maxSteps !== this.options.rootMaxSteps)
    ) {
      throw new Error('Worker manifest did not match Host selection');
    }
    this.currentManifest = ready.manifest;
  }

  private installCheckpoint(message: WorkerCheckpointProposalMessage): void {
    let accepted = false;
    try {
      if (
        this.currentCorrelation === undefined || !this.active ||
        !sameCorrelation(message.correlation, this.currentCorrelation) ||
        !validateSemanticContextCheckpoint(message.checkpoint) ||
        this.currentManifest === undefined ||
        !profileIdPattern.test(this.currentManifest.profileId) ||
        message.checkpoint.sessionId !== this.sessionId ||
        message.checkpoint.sourceProfileId !== this.currentManifest.profileId
      ) throw new Error('checkpoint correlation invalid');
      const completedTurns = indexSessionHistory(this.transcript)?.turns.length ?? 0;
      if (
        message.checkpoint.coveredThroughTurn < 1 ||
        message.checkpoint.coveredThroughTurn >= completedTurns ||
        message.checkpoint.retainedFromTurn !==
          message.checkpoint.coveredThroughTurn + 1
      ) throw new Error('checkpoint boundary invalid');
      this.options.handle.installCheckpoint(message.checkpoint);
      this.checkpoint = structuredClone(message.checkpoint);
      const notice = {
        coveredThroughTurn: message.checkpoint.coveredThroughTurn,
        retainedFromTurn: message.checkpoint.retainedFromTurn,
      };
      accepted = true;
      try {
        this.send({
          kind: 'checkpoint_acknowledgement',
          correlation: message.correlation,
          accepted,
        });
        // Only an acknowledgement that was delivered to the generation may publish the
        // notice. The held turn has not started when this method returns.
        this.autoCompactionNotice = notice;
      } catch {
        this.autoCompactionNotice = undefined;
        this.markUnavailable();
      }
      return;
    } catch {
      accepted = false;
    }
    try {
      this.send({
        kind: 'checkpoint_acknowledgement',
        correlation: message.correlation,
        accepted,
      });
    } catch {
      this.autoCompactionNotice = undefined;
      this.markUnavailable();
    }
  }

  private proposalRecord(
    proposal: WorkerCommitProposalMessage,
  ): SessionRecordV2 | undefined {
    const record: SessionRecordV2 = {
      schemaVersion: 2,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.options.handle.record?.createdAt ??
        new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stateRevision: this.stateRevision + 1,
      nextTurn: proposal.nextTurn,
      transcript: structuredClone(proposal.transcript),
      definition: structuredClone(this.options.definition),
    };
    return validateSessionRecordV2(record) ? record : undefined;
  }

  async submit(task: string): Promise<LoopOutcome> {
    if (this.closed || this.unavailable) {
      throw new Error('agent session unavailable');
    }
    if (this.active) throw new Error('agent session is busy');
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    this.active = true;
    const correlation = this.correlation(
      `turn-${this.nextTurn}-${crypto.randomUUID().toLowerCase()}`,
    );
    this.currentCorrelation = correlation;
    const execution: ActiveWorkerExecution = {
      executionId: crypto.randomUUID().toLowerCase(),
      createdAt: new Date().toISOString(),
      turn: this.nextTurn,
      command: { kind: 'turn', correlation: structuredClone(correlation), task },
      baseStateRevision: this.stateRevision,
      protocolTrace: [...this.bootstrapTrace],
      storeResult: 'not_attempted',
      acknowledgement: 'not_sent',
      settlement: 'uncommitted',
      artifactWritten: false,
    };
    this.activeExecution = execution;
    try {
      try {
        this.send({ kind: 'turn', correlation, task });
      } catch {
        this.markUnavailable();
        const outcome = failedOutcome(task, this.transcript, 'Worker transport unavailable');
        const settled = await this.settleExecution(execution, outcome, undefined, undefined);
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      const message = await this.messages.wait((
        value,
      ): value is
        | WorkerCommitProposalMessage
        | Extract<WorkerToHostMessage, { kind: 'turn_failed' }>
        | WorkerErrorMessage =>
        (value.kind === 'commit_proposal' || value.kind === 'turn_failed' ||
          value.kind === 'worker_error') &&
        (value.kind === 'worker_error' ||
          sameCorrelation(value.correlation, correlation))
      );
      if (message.kind === 'turn_failed') {
        const diagnostic = message.diagnostic ?? message.outcome.diagnostic;
        const settled = await this.settleExecution(
          execution,
          message.outcome,
          message.providerEvidence,
          diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      if (message.kind === 'worker_error') {
        this.markUnavailable();
        const outcome = failedOutcome(task, this.transcript, message.message);
        const settled = await this.settleExecution(execution, outcome, undefined, undefined);
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      if (!sameCorrelation(message.correlation, correlation)) {
        throw new Error('commit proposal correlation invalid');
      }
      const record = this.proposalRecord(message);
      if (record === undefined) {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: false,
          });
          execution.acknowledgement = 'rejected_sent';
        } catch {
          execution.acknowledgement = 'delivery_failed';
          this.markUnavailable();
        }
        const outcome = failedOutcome(
          task,
          this.transcript,
          'commit proposal invalid',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          message.diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      const proposedOutcome = message.outcome === undefined
        ? proposalOutcome(task, message.transcript, undefined)
        : {
          ...structuredClone(message.outcome),
          task,
          transcript: structuredClone(message.transcript),
        };
      const diagnostic = message.diagnostic ?? proposedOutcome.diagnostic;
      execution.proposedStateRevision = record.stateRevision;
      try {
        this.options.handle.commit(record);
        execution.storeResult = 'committed';
      } catch {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: false,
          });
          execution.acknowledgement = 'rejected_sent';
        } catch {
          execution.acknowledgement = 'delivery_failed';
          this.markUnavailable();
        }
        execution.storeResult = 'failed';
        execution.storeError = 'session_io_failure';
        const outcome = failedOutcome(
          task,
          this.transcript,
          'durable session commit failed',
        );
        const settled = await this.settleExecution(
          execution,
          outcome,
          message.providerEvidence,
          diagnostic,
        );
        this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
        return settled;
      }
      this.transcript = structuredClone(record.transcript) as Message[];
      this.nextTurn = record.nextTurn;
      this.stateRevision = record.stateRevision;
      execution.committedStateRevision = record.stateRevision;
      const committed = await this.persistArtifacts(
        proposedOutcome,
        message.providerEvidence,
        diagnostic,
      );
      const ackSent = (() => {
        try {
          this.send({
            kind: 'commit_acknowledgement',
            correlation,
            accepted: true,
          });
          execution.acknowledgement = 'accepted_sent';
          return true;
        } catch {
          execution.acknowledgement = 'delivery_failed';
          return false;
        }
      })();
      if (!ackSent) {
        execution.settlement = 'committed_generation_unavailable';
        this.markUnavailable();
        const settled = await this.persistExecutionArtifact(execution, committed);
        this.deliver(turnEndFromOutcome(this.nextTurn - 1, settled, true));
        return settled;
      }
      let workerError: WorkerErrorMessage | undefined;
      try {
        const settled = await this.messages.wait((
          value,
        ): value is Extract<WorkerToHostMessage, { kind: 'runtime_event' }> | WorkerErrorMessage =>
          (value.kind === 'runtime_event' || value.kind === 'worker_error') &&
          (value.kind === 'worker_error' || sameCorrelation(value.correlation, correlation))
        );
        if (settled.kind === 'worker_error') workerError = settled;
      } catch {
        this.markUnavailable();
      }
      if (workerError !== undefined) {
        this.markUnavailable();
      }
      execution.settlement = workerError === undefined && !this.unavailable
        ? 'committed'
        : 'committed_generation_unavailable';
      const settled = await this.persistExecutionArtifact(execution, committed);
      this.deliver(turnEndFromOutcome(this.nextTurn - 1, settled, true));
      return settled;
    } catch (error) {
      const outcome = failedOutcome(
        task,
        this.transcript,
        error instanceof Error ? error.message : String(error),
      );
      execution.settlement = 'uncommitted';
      const settled = await this.settleExecution(execution, outcome, undefined, undefined);
      this.deliver(turnEndFromOutcome(this.nextTurn, settled, false));
      return settled;
    } finally {
      this.activeExecution = undefined;
      this.active = false;
      this.currentCorrelation = undefined;
    }
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    try {
      this.send({
        kind: 'cancel',
        correlation: this.currentCorrelation,
      });
      return 'requested';
    } catch {
      this.markUnavailable();
      return 'requested';
    }
  }

  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (!this.active || this.currentCorrelation === undefined) return 'idle';
    try {
      this.send({
        kind: 'steer',
        correlation: this.currentCorrelation,
        text,
      });
      return 'accepted';
    } catch {
      this.markUnavailable();
      return 'accepted';
    }
  }

  isAvailable(): boolean {
    return !this.closed && !this.unavailable && !this.active;
  }

  transcriptSnapshot(): readonly Message[] {
    return structuredClone(this.transcript);
  }

  currentPosition(): {
    readonly sessionId: string;
    readonly agent: SessionRecord['agent'];
    readonly committedTurn: number;
    readonly messageCount: number;
    readonly checkpoint?: Pick<
      SemanticContextCheckpointV1,
      'coveredThroughTurn' | 'retainedFromTurn'
    >;
  } {
    return {
      sessionId: this.sessionId,
      agent: this.options.agent,
      committedTurn: this.nextTurn - 1,
      messageCount: this.transcript.length,
      ...(this.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.checkpoint.retainedFromTurn,
        },
      }),
    };
  }

  historyPage(
    page: number,
    turn = this.nextTurn - 1,
    rows = 16,
  ): SessionHistoryPage | undefined {
    return historyPageWindow(this.transcript, turn, page, {
      sessionId: this.sessionId,
      agent: this.options.agent,
      rows,
    });
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.checkpoint === undefined ? undefined : structuredClone(this.checkpoint);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentManifest === undefined) {
      this.unsubscribe();
      this.messages.fail(new Error('Worker host session closed'));
      this.capsule.terminate();
      await this.options.handle.close();
      return;
    }
    const correlation = this.correlation('close');
    try {
      const closed = this.messages.wait((
        value,
      ): value is Extract<WorkerToHostMessage, { kind: 'closed' }> | WorkerErrorMessage =>
        (value.kind === 'closed' || value.kind === 'worker_error') &&
        (value.kind === 'worker_error' || sameCorrelation(value.correlation, correlation)), 5_000);
      this.send({ kind: 'close', correlation });
      const settled = await closed;
      if (settled.kind === 'worker_error') throw new Error(settled.message);
    } catch {
      this.capsule.terminate();
    } finally {
      this.unsubscribe();
      this.messages.fail(new Error('Worker host session closed'));
      await this.options.handle.close();
    }
  }
}

class MemoryWorkerHandle implements WorkerSessionHandle {
  private current: StoredSessionRecord | undefined;
  private currentCheckpoint: SemanticContextCheckpointV1 | undefined;

  constructor(readonly id: string) {}

  get record(): StoredSessionRecord | undefined {
    return this.current === undefined ? undefined : structuredClone(this.current);
  }

  get checkpoint(): SemanticContextCheckpointV1 | undefined {
    return this.currentCheckpoint === undefined
      ? undefined
      : structuredClone(this.currentCheckpoint);
  }

  commit(record: StoredSessionRecord): void {
    this.current = structuredClone(record);
  }

  rollback(): void {
    this.current = undefined;
  }

  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    this.currentCheckpoint = structuredClone(checkpoint);
  }

  rollbackCheckpoint(): void {
    this.currentCheckpoint = undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface WorkerTuiSessionOptions {
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly sessionId?: string;
  readonly agent: SessionRecord['agent'];
  readonly externalDefinitionPath?: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

export interface WorkerTuiSessionResult {
  readonly session: WorkerHostSession;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
  readonly workspaceRoot: string;
  readonly sessionLine?: string;
  readonly restored?: {
    readonly messages: readonly Message[];
    readonly omitted: number;
  };
  readonly displayState: RuntimeDisplayState;
  readonly navigation?: SessionNavigationHost;
}

const recordRefMatches = (
  record: StoredSessionRecord | undefined,
  definition: DefinitionRevisionRef,
): boolean => {
  if (record === undefined || record.schemaVersion === 1) {
    return definition.kind === 'builtin';
  }
  return sameRef(record.definition, definition);
};

const navigationPosition = (
  value: ReturnType<WorkerHostSession['currentPosition']>,
): NavigationPosition => ({
  sessionId: value.sessionId,
  agent: value.agent,
  committedTurn: value.committedTurn,
  messageCount: value.messageCount,
  ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
});

const workerDefinitionPath = async (
  workspaceRoot: string,
  externalPath: string,
): Promise<string> => {
  if (!externalPath.endsWith('.ts')) {
    throw new Error('external Definition must be a TypeScript file');
  }
  const candidate = externalPath.startsWith('/') ? externalPath : `${Deno.cwd()}/${externalPath}`;
  const canonical = await Deno.realPath(candidate);
  if (
    canonical !== workspaceRoot && !canonical.startsWith(`${workspaceRoot}/`)
  ) {
    throw new Error('external Definition must stay within the workspace');
  }
  return canonical;
};

const restoreRecordMessages = (
  record: StoredSessionRecord | undefined,
):
  | { readonly messages: readonly Message[]; readonly omitted: number }
  | undefined => record === undefined ? undefined : restoredMessages(record.transcript);

/** Build the production-equivalent TUI session through the Host/Worker route. */
export const createWorkerTuiSession = async (
  options: WorkerTuiSessionOptions,
): Promise<WorkerTuiSessionResult> => {
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const instructionSnapshot = await discoverAgentInstructionSnapshot(
    workspace.root,
  );
  const skillCatalog = await discoverSkills(workspace.root);
  const modulePath = options.externalDefinitionPath === undefined
    ? workerBuiltinModulePath(options.agent)
    : await workerDefinitionPath(
      workspace.root,
      options.externalDefinitionPath,
    );
  const definition = await readDefinitionRevision(
    modulePath,
    options.externalDefinitionPath === undefined ? 'builtin' : 'external',
    options.externalDefinitionPath === undefined ? options.agent : undefined,
  );
  const productionStateRoot = options.physicalIoMode === 'production'
    ? options.stateRoot ?? launcherStateRoot()
    : undefined;
  const defaultDiagnosticStore = options.physicalIoMode === 'production' &&
      options.diagnosticPersistence === undefined
    ? new DenoFailureDiagnosticStore(productionStateRoot!, workspace.root)
    : undefined;
  const defaultEvidenceStore = options.physicalIoMode === 'production' &&
      options.providerEvidenceStore === undefined
    ? new DenoProviderEvidenceStore(productionStateRoot!, workspace.root)
    : undefined;
  const defaultExecutionArtifactStore = options.executionArtifactStore ??
    (options.physicalIoMode === 'production' || options.stateRoot !== undefined
      ? new DenoWorkerExecutionArtifactStore(
        options.stateRoot ?? launcherStateRoot(),
        workspace.root,
      )
      : undefined);
  const displayState = projectRuntimeDisplayState({
    workspaceRoot: workspace.root,
    agentId: options.agent,
    profileId: PRODUCTION_PROFILE.id,
    sessionMode: options.persistence,
    instructionSource: instructionSnapshot?.source,
    skillNames: skillCatalog.skills.map((skill) => skill.name),
  });
  const store: WorkerSessionStorePort | undefined = options.persistence === 'none'
    ? undefined
    : new DenoSessionStore(
      options.stateRoot ?? launcherStateRoot(),
      workspace.root,
      {
        sourceProfileId: PRODUCTION_PROFILE.id,
      },
    );
  let handle: WorkerSessionHandle;
  let record: StoredSessionRecord | undefined;
  if (options.persistence === 'none') {
    handle = new MemoryWorkerHandle(crypto.randomUUID().toLowerCase());
  } else if (options.persistence === 'continue') {
    const listed = await store!.listWorker();
    const candidate = listed.sessions.find((item) =>
      item.agent === options.agent &&
      (item.definition === undefined
        ? definition.kind === 'builtin'
        : sameRef(item.definition, definition))
    );
    if (candidate === undefined) throw new Error('session not found');
    handle = await store!.openExistingWorker(candidate.id);
    record = handle.record;
  } else if (options.persistence === 'session') {
    if (options.sessionId === undefined) throw new Error('session id required');
    handle = await store!.openExistingWorker(options.sessionId);
    record = handle.record;
  } else {
    handle = await store!.allocateWorker(options.agent, definition);
  }
  try {
    if (
      record !== undefined &&
      (record.workspaceRoot !== workspace.root ||
        record.agent !== options.agent ||
        !recordRefMatches(record, definition))
    ) {
      throw new Error(
        'session Definition revision does not match the selected binding',
      );
    }
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: workspace.root,
      agent: options.agent,
      definition,
      modulePath,
      physicalIoMode: options.physicalIoMode,
      rootMaxSteps: options.rootMaxSteps,
      eventSink: options.eventSink,
      diagnosticPersistence: options.diagnosticPersistence ?? defaultDiagnosticStore?.persist,
      providerEvidenceStore: options.providerEvidenceStore ?? defaultEvidenceStore,
      executionArtifactStore: defaultExecutionArtifactStore,
      capsuleFactory: options.capsuleFactory,
    });
    let currentHost = host;
    let currentHandle = handle;
    let currentRecord = record;
    const position = (): NavigationPosition => navigationPosition(currentHost.currentPosition());
    const navigation = store === undefined ? undefined : {
      persistent: true,
      async list(signal?: AbortSignal): Promise<NavigationListing> {
        if (signal?.aborted) throw new Error('navigation cancelled');
        const listed = await store!.listWorker();
        if (signal?.aborted) throw new Error('navigation cancelled');
        return {
          sessions: listed.sessions.map((item) => ({
            ...item,
            current: item.id === currentHandle.id,
            resumed: item.id === currentHandle.id,
            mismatch: item.agent !== options.agent ||
              (item.definition === undefined
                ? definition.kind !== 'builtin'
                : !sameRef(item.definition, definition)),
          })),
          skippedInvalid: listed.skippedInvalid,
        };
      },
      async switchTo(
        id: string,
        signal?: AbortSignal,
      ): Promise<NavigationBinding> {
        if (signal?.aborted) throw new Error('navigation cancelled');
        const targetHandle = await store!.openExistingWorker(id);
        try {
          const targetRecord = targetHandle.record;
          if (
            targetRecord === undefined ||
            targetRecord.workspaceRoot !== workspace.root ||
            targetRecord.agent !== options.agent ||
            !recordRefMatches(targetRecord, definition)
          ) throw new Error('session Definition revision mismatch');
          const targetHost = await WorkerHostSession.open({
            handle: targetHandle,
            workspaceRoot: workspace.root,
            agent: options.agent,
            definition,
            modulePath,
            physicalIoMode: options.physicalIoMode,
            rootMaxSteps: options.rootMaxSteps,
            eventSink: options.eventSink,
            diagnosticPersistence: options.diagnosticPersistence ?? defaultDiagnosticStore?.persist,
            providerEvidenceStore: options.providerEvidenceStore ?? defaultEvidenceStore,
            executionArtifactStore: defaultExecutionArtifactStore,
            capsuleFactory: options.capsuleFactory,
          });
          await currentHost.close();
          currentHost = targetHost;
          currentHandle = targetHandle;
          currentRecord = targetRecord;
          const restored = restoreRecordMessages(targetRecord);
          return {
            session: currentHost,
            position: position(),
            ...(restored === undefined ? {} : { restored }),
          };
        } catch (error) {
          await targetHandle.close();
          throw error;
        }
      },
      historyPage(page: number, turn?: number, rows?: number) {
        return Promise.resolve(currentHost.historyPage(page, turn, rows));
      },
      currentPosition: position,
    } satisfies SessionNavigationHost;
    return {
      session: host,
      requestCount: () => currentHost.requestCount(),
      close: () => currentHost.close(),
      workspaceRoot: workspace.root,
      displayState,
      ...(currentRecord === undefined ? {} : { restored: restoreRecordMessages(currentRecord) }),
      ...(options.persistence === 'none' ? {} : {
        sessionLine: `session> ${handle.id} ${currentRecord === undefined ? '(new)' : '(resumed)'}`,
      }),
      ...(navigation === undefined ? {} : { navigation }),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export const workerBuiltinModulePath = (
  agent: SessionRecord['agent'],
): string =>
  new URL(
    agent === 'planner'
      ? './worker_builtin_planner_definition.ts'
      : './worker_builtin_definition.ts',
    import.meta.url,
  ).pathname;

export const workerSessionRecord = (
  record: StoredSessionRecord | undefined,
): StoredSessionRecord | undefined => record === undefined ? undefined : structuredClone(record);
