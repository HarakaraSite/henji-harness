import { type TurnCancellation } from './cancellation.ts';
import { type FailureDiagnosticOwner } from '../session/failure_diagnostic.ts';
import { type ProviderEvidenceRecorder } from '../provider/provider_evidence.ts';
import type { ModelRequest } from './contracts.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { ContextOccurrenceSource } from '../history/context_attribution.ts';
import type { WorkerStageName } from '../worker/worker_stage_probe.ts';

/** The append operation that gave one transcript message its causal source. */
export type RequestMessageSourceKind =
  | 'committed'
  | 'task'
  | 'assistant'
  | 'tool'
  | 'steering';

/** Parallel provenance sidecars for a request transcript. */
export interface ModelRequestSourceAttribution {
  readonly transcript: readonly (readonly ContextOccurrenceSource[])[];
}

export type RequestMessageSourceFactory = (
  message: import('./contracts.ts').Message,
  kind: RequestMessageSourceKind,
  messageIndex: number,
  modelStep?: number,
) => readonly ContextOccurrenceSource[];

export interface ModelRequestObservation {
  /** The exact provider request. History observers must not clone or retain the full value. */
  readonly request: ModelRequest;
  readonly modelStep: number;
  readonly modelSelection?: ModelSelection;
  /** Explicit sidecars built alongside the request projection, never inferred from bytes. */
  readonly sourceAttribution?: ModelRequestSourceAttribution;
  /** Append-only transcript boundary for the previous request. */
  readonly previousTranscriptLength: number;
}

export interface AuxiliaryRequestObservation {
  readonly purpose: 'web_search';
  readonly body: string;
  readonly callId: string;
  readonly modelStep: number;
  readonly modelSelection?: ModelSelection;
}

export interface TurnRequestBudgetSnapshot {
  readonly parent: number;
  readonly aggregate: number;
}

export const REQUEST_LIMITS = Object.freeze({
  parent: 8,
  aggregate: 8,
});

export interface TurnRequestLimits {
  readonly parent: number;
  readonly aggregate: number;
}

/** Maximum encoded size of one provider-neutral progress snapshot. */
export const MAX_TOOL_PROGRESS_TEXT_BYTES = 8_192;

/** Maximum accepted progress snapshots for one tool call. */
export const MAX_TOOL_PROGRESS_UPDATES_PER_CALL = 64;

/** Execution-only callback for one tool's accumulated progress snapshot. */
export type ToolProgressReporter = (snapshot: string) => void;

/**
 * Synchronous provider-neutral request admission for one accepted turn.
 * A successful claim is consumed even when the model subsequently fails.
 */
export class TurnRequestBudget {
  private parent = 0;

  constructor(private readonly limits: TurnRequestLimits = REQUEST_LIMITS) {
    if (
      !Number.isSafeInteger(limits.parent) || limits.parent <= 0 ||
      !Number.isSafeInteger(limits.aggregate) ||
      limits.aggregate < limits.parent
    ) throw new RangeError('request limits must be positive safe integers');
  }

  claim(): boolean {
    if (this.parent >= this.limits.parent || this.parent >= this.limits.aggregate) {
      return false;
    }
    this.parent += 1;
    return true;
  }

  get aggregate(): number {
    return this.parent;
  }

  snapshot(): TurnRequestBudgetSnapshot {
    return Object.freeze({
      parent: this.parent,
      aggregate: this.parent,
    });
  }
}

/** Internal loop seam for the accepted parent turn. */
export interface ModelExecutionContext {
  readonly signal?: AbortSignal;
  readonly cancellation?: TurnCancellation;
  readonly diagnosticOwner?: FailureDiagnosticOwner;
  readonly providerEvidence?: ProviderEvidenceRecorder;
  /** Exact logical request observation at the model.generate boundary. */
  readonly observeModelRequest?: (
    observation: ModelRequestObservation,
  ) => number | PromiseLike<number>;
  readonly observeAuxiliaryRequest?: (
    observation: AuxiliaryRequestObservation,
  ) => number | PromiseLike<number>;
  readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void;
  readonly modelSelection?: ModelSelection;
  /** Worker-owned source projection for the accepted turn. */
  readonly requestMessageSource?: RequestMessageSourceFactory;
  /** Worker-owned parent projection for the accepted turn. */
  readonly projectParentRequestWithSources?: (
    request: ModelRequest,
    sources: ModelRequestSourceAttribution,
  ) => {
    readonly request: ModelRequest;
    readonly sources: ModelRequestSourceAttribution;
  };
  /** Aggregate fetch count at the current failure occurrence, supplied by the host adapter. */
  readonly providerRequestCount?: () => number;
  /** Runtime-process cumulative fetch count, supplied by the host adapter. */
  readonly runtimeProviderRequestCount?: () => number;
  persistDiagnostic(): Promise<void>;
  claimModelRequest(): boolean;
  snapshot(): TurnRequestBudgetSnapshot;
}

/** Per-accepted-turn state shared by the root model loop. */
export class ParentTurnExecutionContext implements ModelExecutionContext {
  constructor(
    readonly turn: number,
    private readonly budget = new TurnRequestBudget(),
    readonly signal?: AbortSignal,
    readonly cancellation?: TurnCancellation,
    readonly diagnosticOwner?: FailureDiagnosticOwner,
    readonly providerRequestCount?: () => number,
    readonly runtimeProviderRequestCount?: () => number,
    readonly providerEvidence?: ProviderEvidenceRecorder,
    readonly observeModelRequest?: (
      observation: ModelRequestObservation,
    ) => number | PromiseLike<number>,
    readonly modelSelection?: ModelSelection,
    readonly observeAuxiliaryRequest?: (
      observation: AuxiliaryRequestObservation,
    ) => number | PromiseLike<number>,
    readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void,
    readonly requestMessageSource?: RequestMessageSourceFactory,
    readonly projectParentRequestWithSources?: (
      request: ModelRequest,
      sources: ModelRequestSourceAttribution,
    ) => {
      readonly request: ModelRequest;
      readonly sources: ModelRequestSourceAttribution;
    },
  ) {
    if (!Number.isSafeInteger(turn) || turn <= 0) {
      throw new RangeError('turn must be a positive integer');
    }
  }

  claimModelRequest(): boolean {
    return this.budget.claim();
  }

  snapshot(): TurnRequestBudgetSnapshot {
    return this.budget.snapshot();
  }

  persistDiagnostic(): Promise<void> {
    return this.diagnosticOwner?.persist() ?? Promise.resolve();
  }
}

export const createTurnExecutionContext = (
  turn: number,
  signal?: AbortSignal,
  cancellation?: TurnCancellation,
  diagnosticOwner?: FailureDiagnosticOwner,
  providerRequestCount?: () => number,
  runtimeProviderRequestCount?: () => number,
  providerEvidence?: ProviderEvidenceRecorder,
  limits?: TurnRequestLimits,
  observeModelRequest?: (
    observation: ModelRequestObservation,
  ) => number | PromiseLike<number>,
  modelSelection?: ModelSelection,
  observeAuxiliaryRequest?: (
    observation: AuxiliaryRequestObservation,
  ) => number | PromiseLike<number>,
  reportAuxiliaryStage?: (stage: WorkerStageName) => void,
  requestMessageSource?: RequestMessageSourceFactory,
  projectParentRequestWithSources?: (
    request: ModelRequest,
    sources: ModelRequestSourceAttribution,
  ) => {
    readonly request: ModelRequest;
    readonly sources: ModelRequestSourceAttribution;
  },
): ParentTurnExecutionContext =>
  new ParentTurnExecutionContext(
    turn,
    limits === undefined ? undefined : new TurnRequestBudget(limits),
    signal,
    cancellation,
    diagnosticOwner,
    providerRequestCount,
    runtimeProviderRequestCount,
    providerEvidence,
    observeModelRequest,
    modelSelection,
    observeAuxiliaryRequest,
    reportAuxiliaryStage,
    requestMessageSource,
    projectParentRequestWithSources,
  );

/** The execution-only wrapper passed to tools; request admission remains nested separately. */
export interface ToolExecutionContext {
  readonly modelExecution?: ModelExecutionContext;
  /** Parent-loop model step whose tool call is currently executing. */
  readonly modelStep?: number;
  /** Exact model-issued tool call identity when the tool is invoked by the loop. */
  readonly callId?: string;
  readonly signal?: AbortSignal;
  readonly cancellation?: TurnCancellation;
  readonly reportProgress?: ToolProgressReporter;
}
