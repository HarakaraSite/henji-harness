import {
  type LoopOutcome,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResult,
} from './contracts.ts';
import { type AgentEvent, type AgentEventSink, deliverEvent } from './events.ts';
import { type AgentTurnOptions, runAgentTurn } from './loop.ts';
import { Registry } from './tools.ts';
import { snapshotMessages } from './events.ts';
import { type ContextMetrics, prepareModelContext } from './context.ts';
import { type ParentTurnExecutionContext } from './execution_context.ts';
import {
  type CancelRequestResult,
  isCancellationCleanupError,
  TurnCancellationOwner,
} from './cancellation.ts';
import { type SemanticContextCheckpointV1, type SessionRecord } from './session_store.ts';
import {
  historyPageWindow,
  indexSessionHistory,
  type SessionHistoryIndex,
  type SessionHistoryPage,
} from './session_history.ts';
import { SteeringOwner, type SteerRequestResult, validateSteeringText } from './steering.ts';
import {
  checkpointMessage,
  type ContextAdmissionOptions,
  findContextCandidate,
  parseSummaryResult,
  prepareProjectedRequest,
  projectSemanticContext,
  summaryRequest,
} from './semantic_context.ts';
import { measureModelRequestWire } from './openrouter_model.ts';
import {
  FailureDiagnosticOwner,
  type FailureDiagnosticOwnerOptions,
  type FailureDiagnosticPersistenceErrorCode,
} from './failure_diagnostic.ts';

export const AGENT_SESSION_UNAVAILABLE = 'agent session unavailable';

export interface AgentSessionOptions {
  readonly agent?: SessionRecord['agent'];
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
  readonly eventSink?: AgentEventSink;
  /** Runtime-owned factory that gives every accepted turn a fresh request context. */
  readonly createTurnExecutionContext?: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellationOwner,
    diagnosticOwner?: FailureDiagnosticOwner,
    providerRequestCount?: () => number,
  ) => ParentTurnExecutionContext;
  /** Optional durable owner. Ephemeral sessions leave this unset. */
  readonly persistence?: SessionPersistence;
  /** Optional turn-local diagnostic persistence; omitted for in-memory diagnostics. */
  readonly diagnosticPersistence?: FailureDiagnosticOwnerOptions['persist'];
  /** Direct-test-only owner factory for deterministic identity and time. */
  readonly diagnosticOwnerFactory?: (turn: number) => FailureDiagnosticOwner;
  /** Host-owned aggregate fetch count used for occurrence-bound diagnostics. */
  readonly providerRequestCount?: () => number;
  /** Hydrated committed state used by the persistent TUI modes. */
  readonly initialRecord?: SessionRecord;
  /** Dedicated no-tool semantic operation supplied by the selected runtime profile. */
  readonly summarizeContext?: (
    request: ModelRequest,
    signal?: AbortSignal,
  ) => PromiseLike<ModelResult> | ModelResult;
  readonly sourceProfileId?: string;
}

/** Narrow persistence port owned by the runtime/store composition layer. */
export interface SessionPersistence {
  readonly id?: string;
  readonly record: SessionRecord | undefined;
  readonly checkpoint?: SemanticContextCheckpointV1;
  commit(transcript: readonly Message[], nextTurn: number, updatedAt: string): void;
  rollback(): void;
  installCheckpoint?(checkpoint: SemanticContextCheckpointV1): void;
  rollbackCheckpoint?(): void;
  close(): void | Promise<void>;
}

/**
 * A private, in-memory conversation. Submissions are deliberately sequential and nonqueueing:
 * callers must wait for the active turn to finish before submitting another one.
 */
export class AgentSession {
  private readonly model: Model;
  private readonly registry: Registry;
  private readonly options: AgentTurnOptions;
  private readonly createTurnContext?: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellationOwner,
    diagnosticOwner?: FailureDiagnosticOwner,
    providerRequestCount?: () => number,
  ) => ParentTurnExecutionContext;
  private committedTranscript: Message[] = [];
  private active = false;
  private activeCancellation: TurnCancellationOwner | null = null;
  private activeSteering: SteeringOwner | null = null;
  private unavailable = false;
  private nextTurn = 1;
  private committedContextSnapshot: ContextMetrics | undefined;
  private readonly persistence?: SessionPersistence;
  private pendingRollback = false;
  private commitAttempted = false;
  private readonly sessionId?: string;
  private readonly sessionAgent: SessionRecord['agent'];
  private checkpoint?: SemanticContextCheckpointV1;
  private readonly summarizeContext?: AgentSessionOptions['summarizeContext'];
  private readonly sourceProfileId: string;
  private readonly diagnosticPersistence?: FailureDiagnosticOwnerOptions['persist'];
  private readonly diagnosticOwnerFactory?: (turn: number) => FailureDiagnosticOwner;
  private readonly providerRequestCount?: () => number;
  private activeDiagnosticOwner: FailureDiagnosticOwner | null = null;

  constructor(model: Model, registry: Registry, options: AgentSessionOptions = {}) {
    const maxSteps = options.maxSteps ?? 8;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new RangeError('maxSteps must be a positive integer');
    }
    this.model = model;
    this.registry = registry;
    this.options = {
      maxSteps,
      systemInstruction: options.systemInstruction,
      eventSink: options.eventSink,
    };
    this.createTurnContext = options.createTurnExecutionContext;
    this.persistence = options.persistence;
    this.diagnosticPersistence = options.diagnosticPersistence;
    this.diagnosticOwnerFactory = options.diagnosticOwnerFactory;
    this.providerRequestCount = options.providerRequestCount;
    this.summarizeContext = options.summarizeContext;
    this.sourceProfileId = options.sourceProfileId ??
      options.persistence?.checkpoint?.sourceProfileId ?? 'unknown-profile';
    this.sessionAgent = options.agent ?? options.initialRecord?.agent ??
      options.persistence?.record?.agent ?? 'default';
    this.sessionId = options.initialRecord?.sessionId ?? options.persistence?.id ??
      options.persistence?.record?.sessionId;
    this.checkpoint = options.initialRecord === undefined
      ? options.persistence?.checkpoint
      : options.persistence?.checkpoint;
    if (this.checkpoint !== undefined && this.checkpoint.sourceProfileId !== this.sourceProfileId) {
      throw new Error('session checkpoint profile mismatch');
    }
    if (options.initialRecord !== undefined) {
      this.committedTranscript = snapshotMessages(options.initialRecord.transcript);
      this.nextTurn = options.initialRecord.nextTurn;
      const request: ModelRequest = options.systemInstruction === undefined
        ? { transcript: this.committedTranscript, tools: this.registry.definitions() }
        : {
          systemInstruction: options.systemInstruction,
          transcript: this.committedTranscript,
          tools: this.registry.definitions(),
        };
      this.committedContextSnapshot = prepareModelContext(request).metrics;
    }
  }

  /** Return a defensive snapshot of all messages from successfully committed turns. */
  transcriptSnapshot(): readonly Message[] {
    return snapshotMessages(this.committedTranscript);
  }

  /** Return metrics for the current committed transcript, never an uncommitted turn draft. */
  contextSnapshot(): ContextMetrics | undefined {
    return this.committedContextSnapshot === undefined
      ? undefined
      : { ...this.committedContextSnapshot };
  }

  /** Structural post-settlement availability used by the interactive controller. */
  isAvailable(): boolean {
    return !this.unavailable && !this.active;
  }

  /** Stable identity/position projection for the TUI; never exposes transcript content. */
  currentPosition(): {
    readonly sessionId?: string;
    readonly agent: SessionRecord['agent'];
    readonly committedTurn: number;
    readonly messageCount: number;
    readonly checkpoint?:
      & Pick<
        SemanticContextCheckpointV1,
        'coveredThroughTurn' | 'retainedFromTurn'
      >
      & { readonly projectedMessagesBytes?: number };
  } {
    let projectedMessagesBytes: number | undefined;
    if (this.checkpoint !== undefined) {
      try {
        const request: ModelRequest = this.options.systemInstruction === undefined
          ? { transcript: this.committedTranscript, tools: this.registry.definitions() }
          : {
            systemInstruction: this.options.systemInstruction,
            transcript: this.committedTranscript,
            tools: this.registry.definitions(),
          };
        projectedMessagesBytes = measureModelRequestWire(
          prepareProjectedRequest(request, this.checkpoint).request,
        ).messagesBytes;
      } catch {
        projectedMessagesBytes = undefined;
      }
    }
    return {
      sessionId: this.sessionId,
      agent: this.sessionAgent,
      committedTurn: this.nextTurn - 1,
      messageCount: this.committedTranscript.length,
      ...(this.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.checkpoint.retainedFromTurn,
          ...(projectedMessagesBytes === undefined ? {} : { projectedMessagesBytes }),
        },
      }),
    };
  }

  historyIndex(): SessionHistoryIndex | undefined {
    return indexSessionHistory(this.committedTranscript);
  }

  historyPage(page: number, turn = this.nextTurn - 1, rows = 16): SessionHistoryPage | undefined {
    return historyPageWindow(this.committedTranscript, turn, page, {
      sessionId: this.sessionId,
      agent: this.sessionAgent,
      rows,
    });
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.checkpoint === undefined ? undefined : structuredClone(this.checkpoint);
  }

  /** Install a validated durable checkpoint; canonical transcript remains untouched. */
  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    if (this.active || this.unavailable) throw new Error('agent session is busy');
    if (this.persistence?.installCheckpoint === undefined) {
      throw new Error('session checkpoint persistence unavailable');
    }
    const indexed = indexSessionHistory(this.committedTranscript);
    if (
      this.sessionId === undefined || checkpoint.sessionId !== this.sessionId ||
      checkpoint.sourceProfileId !== this.sourceProfileId || indexed === undefined ||
      checkpoint.coveredThroughTurn < 1 || checkpoint.coveredThroughTurn >= indexed.turnCount ||
      checkpoint.retainedFromTurn !== checkpoint.coveredThroughTurn + 1
    ) throw new Error('session checkpoint correlation invalid');
    this.persistence.installCheckpoint(checkpoint);
    this.checkpoint = structuredClone(checkpoint);
  }

  contextCompactionPreview(): {
    readonly useful: boolean;
    readonly currentTurn: number;
    readonly currentCheckpoint?: Pick<
      SemanticContextCheckpointV1,
      'coveredThroughTurn' | 'retainedFromTurn'
    >;
    readonly proposed?: Pick<
      SemanticContextCheckpointV1,
      'coveredThroughTurn' | 'retainedFromTurn'
    >;
    readonly baselineMessagesBytes?: number;
    readonly projectedMessagesBytes?: number;
  } {
    const options = this.contextAdmissionOptions();
    const candidate = findContextCandidate(this.committedTranscript, options);
    return {
      useful: candidate !== undefined,
      currentTurn: this.nextTurn - 1,
      ...(this.checkpoint === undefined ? {} : {
        currentCheckpoint: {
          coveredThroughTurn: this.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.checkpoint.retainedFromTurn,
        },
      }),
      ...(candidate === undefined ? {} : {
        proposed: {
          coveredThroughTurn: candidate.coveredThroughTurn,
          retainedFromTurn: candidate.retainedFromTurn,
        },
        baselineMessagesBytes: candidate.baselineMessagesBytes,
        projectedMessagesBytes: candidate.projectedMessagesBytes,
      }),
    };
  }

  async compactContext(signal?: AbortSignal): Promise<{
    readonly kind: 'installed' | 'refused' | 'failed' | 'cancelled';
    readonly coveredThroughTurn?: number;
    readonly retainedFromTurn?: number;
    readonly reason?: string;
  }> {
    if (this.active || this.unavailable) return { kind: 'refused', reason: 'session unavailable' };
    if (this.summarizeContext === undefined || this.persistence?.installCheckpoint === undefined) {
      return { kind: 'refused', reason: 'context recovery unavailable' };
    }
    const options = this.contextAdmissionOptions();
    const candidate = findContextCandidate(this.committedTranscript, options);
    if (candidate === undefined) return { kind: 'refused', reason: 'no useful fitting compaction' };
    if (signal?.aborted) return { kind: 'cancelled' };
    let generated: ModelResult;
    try {
      generated = await this.summarizeContext(
        summaryRequest(this.committedTranscript, candidate.coveredThroughTurn),
        signal,
      );
    } catch (error) {
      if (isCancellationCleanupError(error)) {
        this.unavailable = true;
        throw error;
      }
      return signal?.aborted
        ? { kind: 'cancelled' }
        : { kind: 'failed', reason: 'summary generation failed' };
    }
    if (signal?.aborted) return { kind: 'cancelled' };
    if (generated.kind !== 'final') return { kind: 'failed', reason: 'summary result invalid' };
    const summary = parseSummaryResult(generated.text);
    if (summary === undefined) return { kind: 'failed', reason: 'summary result invalid' };
    const checkpoint: SemanticContextCheckpointV1 = {
      contextSchemaVersion: 1,
      sessionId: this.sessionId ?? this.persistence.id ?? '',
      createdAt: new Date().toISOString(),
      sourceProfileId: this.sourceProfileId,
      coveredThroughTurn: candidate.coveredThroughTurn,
      retainedFromTurn: candidate.retainedFromTurn,
      summary,
    };
    try {
      const messageBytes =
        measureModelRequestWire({ transcript: [checkpointMessage(checkpoint)], tools: [] })
          .messagesBytes;
      if (messageBytes > 16_384) {
        return { kind: 'failed', reason: 'summary exceeds context reserve' };
      }
      const draft = {
        ...(options.systemInstruction === undefined
          ? {}
          : { systemInstruction: options.systemInstruction }),
        transcript: [...this.committedTranscript, {
          role: 'user' as const,
          content: { kind: 'text' as const, text: '\u0001'.repeat(4_096) },
        }],
        tools: structuredClone(options.tools),
      };
      const prepared = prepareProjectedRequest(draft, checkpoint);
      const actual = measureModelRequestWire(prepared.request);
      if (
        actual.messagesBytes > 76 * 1024 || actual.bodyBytes > 256 * 1024 ||
        actual.messagesBytes >= candidate.baselineMessagesBytes
      ) {
        return { kind: 'failed', reason: 'summary is not a useful fitting compaction' };
      }
      this.persistence.installCheckpoint(checkpoint);
      this.checkpoint = structuredClone(checkpoint);
      return {
        kind: 'installed',
        coveredThroughTurn: checkpoint.coveredThroughTurn,
        retainedFromTurn: checkpoint.retainedFromTurn,
      };
    } catch {
      return { kind: 'failed', reason: 'context checkpoint was not installed' };
    }
  }

  private contextAdmissionOptions(): ContextAdmissionOptions {
    return {
      systemInstruction: this.options.systemInstruction,
      tools: this.registry.definitions(),
      sourceProfileId: this.sourceProfileId,
      checkpoint: this.checkpoint,
    };
  }

  /** Request cancellation for the currently settling turn, without allocating another turn. */
  cancelActiveTurn(): CancelRequestResult {
    const cancellation = this.activeCancellation;
    if (!this.active || cancellation === null || cancellation.state === 'settled') return 'idle';
    this.activeSteering?.close();
    return cancellation.request();
  }

  /** Admit one bounded steering message for the currently active parent turn. */
  steerActiveTurn(text: string): SteerRequestResult {
    if (this.unavailable) throw new Error(AGENT_SESSION_UNAVAILABLE);
    const validated = validateSteeringText(text);
    const cancellation = this.activeCancellation;
    const steering = this.activeSteering;
    if (
      !this.active || steering === null || cancellation === null ||
      cancellation.state !== 'active'
    ) return 'idle';
    return steering.admit(validated);
  }

  /** Submit one nonblank turn; an active turn is rejected rather than queued. */
  async submit(userText: string): Promise<LoopOutcome> {
    if (this.unavailable) throw new Error(AGENT_SESSION_UNAVAILABLE);
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    if (this.active) throw new Error('agent session is busy');

    this.active = true;
    const turn = this.nextTurn;
    const cancellation = new TurnCancellationOwner();
    this.activeCancellation = cancellation;
    const steering = new SteeringOwner();
    this.activeSteering = steering;
    const diagnosticOwner = this.diagnosticOwnerFactory?.(turn) ??
      new FailureDiagnosticOwner(turn, {
        persist: this.diagnosticPersistence,
      });
    this.activeDiagnosticOwner = diagnosticOwner;
    const requestCountAtAdmission = this.providerRequestCount?.() ?? 0;
    const turnProviderRequestCount = this.providerRequestCount === undefined
      ? undefined
      : () => Math.max(0, this.providerRequestCount!() - requestCountAtAdmission);
    const previousTranscript = snapshotMessages(this.committedTranscript);
    const previousContext = this.committedContextSnapshot === undefined
      ? undefined
      : { ...this.committedContextSnapshot };
    // The loop emits its terminal event before returning. Hold only diagnostic terminal events
    // until the owner has settled persistence, so live presentation can truthfully label the
    // same immutable record as durable or failed.
    const deferredDiagnosticEvents: AgentEvent[] = [];
    const eventSink: AgentEventSink | undefined = this.options.eventSink === undefined
      ? undefined
      : (event) => {
        if (event.kind === 'turn_end' && event.diagnostic !== undefined) {
          deferredDiagnosticEvents.push(event);
          return;
        }
        this.options.eventSink!(event);
      };
    try {
      const executionContext = this.createTurnContext?.(
        turn,
        cancellation.signal,
        cancellation,
        diagnosticOwner,
        turnProviderRequestCount,
      ) ??
        undefined;
      const outcome = await runAgentTurn(
        userText,
        snapshotMessages(this.committedTranscript),
        this.model,
        this.registry,
        {
          ...this.options,
          eventSink,
          turn,
          executionContext,
          cancellation,
          signal: cancellation.signal,
          steering,
          diagnosticOwner,
          projectParentRequest: this.checkpoint === undefined
            ? undefined
            : (request) => projectSemanticContext(request, this.checkpoint!),
          commit: (transcript) => {
            const committedTranscript = snapshotMessages(transcript);
            const request: ModelRequest = this.options.systemInstruction === undefined
              ? {
                transcript: committedTranscript,
                tools: this.registry.definitions(),
              }
              : {
                systemInstruction: this.options.systemInstruction,
                transcript: committedTranscript,
                tools: this.registry.definitions(),
              };
            const metrics = prepareModelContext(request).metrics;
            this.commitAttempted = true;
            this.persistence?.commit(committedTranscript, turn + 1, new Date().toISOString());
            this.committedTranscript = committedTranscript;
            this.committedContextSnapshot = metrics;
            this.pendingRollback = this.persistence !== undefined;
            this.nextTurn = turn + 1;
          },
        },
      );
      let diagnosticPersistenceError: unknown;
      try {
        await diagnosticOwner.persist();
      } catch (error) {
        diagnosticPersistenceError = error;
      }
      if (diagnosticOwner.hasCollision) this.unavailable = true;
      if (this.commitAttempted && !outcome.ok && this.persistence !== undefined) {
        this.unavailable = true;
      }
      if (this.pendingRollback) this.pendingRollback = false;
      const settledOutcome = outcome.diagnostic === undefined ? outcome : {
        ...outcome,
        diagnosticDurability: diagnosticOwner.durability,
        ...(diagnosticOwner.persistenceErrorCode === undefined ? {} : {
          diagnosticPersistenceError: diagnosticOwner
            .persistenceErrorCode as FailureDiagnosticPersistenceErrorCode,
        }),
      };
      // A diagnostic persistence failure is itself recoverable: retain the typed in-memory
      // outcome and publish durable=failed with only the fixed store error code. A failure while
      // there is no diagnostic remains an ordinary submit rejection.
      if (diagnosticPersistenceError !== undefined && outcome.diagnostic === undefined) {
        throw diagnosticPersistenceError;
      }
      for (const event of deferredDiagnosticEvents) {
        if (event.kind !== 'turn_end') continue;
        deliverEvent(this.options.eventSink, {
          ...event,
          diagnosticDurability: diagnosticOwner.durability,
          ...(diagnosticOwner.persistenceErrorCode === undefined
            ? {}
            : { diagnosticPersistenceError: diagnosticOwner.persistenceErrorCode }),
        });
      }
      return settledOutcome;
    } catch (error) {
      try {
        // A child may have already persisted before a parent exception. This second idempotent
        // settlement also covers every submit rejection path without rewriting the record.
        await diagnosticOwner.persist();
      } catch {
        this.unavailable = true;
      }
      // This also undoes a successful draft committed just before a failing turn_end sink.
      this.committedTranscript = previousTranscript;
      this.committedContextSnapshot = previousContext;
      this.nextTurn = turn;
      if (this.commitAttempted && !this.pendingRollback && this.persistence !== undefined) {
        this.unavailable = true;
      }
      if (this.pendingRollback) {
        try {
          this.persistence?.rollback();
          this.pendingRollback = false;
        } catch {
          this.unavailable = true;
        }
      }
      this.commitAttempted = false;
      throw error;
    } finally {
      steering.close();
      this.activeSteering = null;
      if (cancellation.state === 'cleanup_failed') this.unavailable = true;
      this.activeCancellation = null;
      this.activeDiagnosticOwner = null;
      this.active = false;
      this.commitAttempted = false;
    }
  }

  /** Release the durable session lock after the TUI has settled all work. */
  async close(): Promise<void> {
    const owner = this.activeDiagnosticOwner;
    if (owner !== null) {
      try {
        await owner.persist();
      } catch {
        this.unavailable = true;
      }
    }
    await this.persistence?.close();
  }
}
