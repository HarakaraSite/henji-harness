import type { Message } from '../core/contracts.ts';
import type { AfterTurnHookEffect, RuntimeStopHookEffect } from '../core/hook_effect.ts';
import type { ProviderEvidenceObservation } from '../provider/provider_evidence.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { SemanticContextCheckpointV1 } from '../session/session_store_contract.ts';
import type { RecalledExecutionContext } from '../worker/recalled_execution_context.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerReadyMessage,
  WorkerToHostMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';

export interface AgentGenerationContextBasis {
  readonly initialTranscript: readonly Message[];
  readonly nextTurn: number;
  readonly stateRevision: number;
  readonly canonicalMessageCount: number;
  readonly historySource: 'canonical' | 'runtime';
  readonly checkpoint?: SemanticContextCheckpointV1;
  readonly modelSelection: ModelSelection;
  readonly privateStateFromTurn: number;
  /** Recall admitted for this execution, kept off the Core control channel. */
  readonly recalledContext?: RecalledExecutionContext;
}

/** One canonical or runtime-adopted turn loaded from a bounded history range. */
export interface ContextTurnRead {
  readonly turn: number;
  readonly executionId: string;
  readonly messages: readonly Message[];
  /** Zero-based global start position in the selected history source. */
  readonly messageStart: number;
  readonly source: 'canonical' | 'runtime';
  /** Sum of persisted message payload bytes read from SQLite for this turn. */
  readonly byteLength: number;
}

export interface AgentProposalBarrier {
  readonly proposalId: string;
  readonly correlation: WorkerCorrelation;
  readonly finalDataSequence: number;
}

export interface AgentFailureBarrier {
  readonly correlation: WorkerCorrelation;
  readonly finalDataSequence: number;
}

/** Post-settlement hook update sent directly to the Data owner, outside its sealed journal. */
export interface AgentAfterTurnContextUpdate {
  readonly executionId: string;
  readonly correlation: WorkerCorrelation;
  readonly turn: number;
  readonly effect: AfterTurnHookEffect;
  /** Hook-originated auxiliary requests captured after the execution was sealed. */
  readonly providerObservations?: readonly ProviderEvidenceObservation[];
}

export interface AgentPostSettlementHookUpdate {
  readonly executionId: string;
  readonly correlation: WorkerCorrelation;
  readonly turn: number;
  readonly settlement: import('../core/hook_effect.ts').AfterTurnSettlement;
  readonly effect: RuntimeStopHookEffect;
  readonly providerObservations?: readonly ProviderEvidenceObservation[];
}

export interface AgentDataPortClient {
  generationContext(
    correlation: WorkerCorrelation,
  ): Promise<AgentGenerationContextBasis>;
  readContextTurn(
    correlation: WorkerCorrelation,
    beforeTurn: number,
  ): Promise<ContextTurnRead | null>;
  ready(message: WorkerReadyMessage): Promise<void>;
  beginExecution(
    executionId: string,
    correlation: WorkerCorrelation,
    diagnosticStageBuffer?: SharedArrayBuffer,
    auxiliaryStageGapMs?: number,
  ): void;
  observation(message: WorkerToHostMessage): number;
  sendProposal(message: WorkerCommitProposalMessage): AgentProposalBarrier;
  sendFailure(message: WorkerTurnFailedMessage): AgentFailureBarrier;
  checkpoint(message: WorkerCheckpointProposalMessage): Promise<boolean>;
  afterTurn(update: AgentAfterTurnContextUpdate): Promise<boolean>;
  postSettlementHook(update: AgentPostSettlementHookUpdate): Promise<boolean>;
  close(): void;
}

export type AgentDataPortRequest =
  | Readonly<{
    kind: 'generation_context';
    requestId: number;
    correlation: WorkerCorrelation;
  }>
  | Readonly<{
    kind: 'context_turn_read';
    requestId: number;
    correlation: WorkerCorrelation;
    beforeTurn: number;
  }>
  | Readonly<{
    kind: 'ready';
    requestId: number;
    message: WorkerReadyMessage;
  }>
  | Readonly<{
    kind: 'begin_execution';
    executionId: string;
    correlation: WorkerCorrelation;
    /** Fixed-size Worker stage latch shared with Data for Data-owned snapshots. */
    diagnosticStageBuffer?: SharedArrayBuffer;
    /** Focused-test seam; production defaults to 1000 ms in Data. */
    auxiliaryStageGapMs?: number;
  }>
  | Readonly<{
    kind: 'execution_data';
    executionId: string;
    sequence: number;
    message: WorkerToHostMessage;
  }>
  | Readonly<{
    kind: 'proposal';
    proposalId: string;
    executionId: string;
    sequence: number;
    message: WorkerCommitProposalMessage;
  }>
  | Readonly<{
    kind: 'failure';
    executionId: string;
    sequence: number;
    message: WorkerTurnFailedMessage;
  }>
  | Readonly<{
    kind: 'checkpoint_proposal';
    requestId: number;
    executionId: string;
    sequence: number;
    message: WorkerCheckpointProposalMessage;
  }>
  | Readonly<{
    kind: 'after_turn_context';
    requestId: number;
    sequence: number;
    update: AgentAfterTurnContextUpdate;
  }>
  | Readonly<{
    kind: 'post_settlement_hook';
    requestId: number;
    sequence: number;
    update: AgentPostSettlementHookUpdate;
  }>;

export type AgentDataPortResponse =
  | Readonly<{
    kind: 'generation_context_result';
    requestId: number;
    correlation: WorkerCorrelation;
    basis: AgentGenerationContextBasis;
  }>
  | Readonly<{
    kind: 'context_turn_result';
    requestId: number;
    correlation: WorkerCorrelation;
    turn: ContextTurnRead | null;
  }>
  | Readonly<{
    kind: 'checkpoint_acknowledgement';
    requestId: number;
    correlation: WorkerCorrelation;
    accepted: boolean;
  }>
  | Readonly<{
    kind: 'after_turn_acknowledgement';
    requestId: number;
    correlation: WorkerCorrelation;
    accepted: boolean;
  }>
  | Readonly<{
    kind: 'post_settlement_hook_acknowledgement';
    requestId: number;
    correlation: WorkerCorrelation;
    accepted: boolean;
  }>
  | Readonly<{
    kind: 'ready_acknowledgement';
    requestId: number;
    correlation: WorkerCorrelation;
  }>
  | Readonly<{
    kind: 'error';
    requestId: number;
    error: Readonly<{ status: number; code: string; message: string }>;
  }>;
