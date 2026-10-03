import type { Message } from '../core/contracts.ts';
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
  readonly checkpoint?: SemanticContextCheckpointV1;
  readonly modelSelection: ModelSelection;
  readonly privateStateFromTurn: number;
  /** Recall admitted for this execution, kept off the Core control channel. */
  readonly recalledContext?: RecalledExecutionContext;
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

export interface AgentDataPortClient {
  generationContext(
    correlation: WorkerCorrelation,
  ): Promise<AgentGenerationContextBasis>;
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
  close(): void;
}

export type AgentDataPortRequest =
  | Readonly<{
    kind: 'generation_context';
    requestId: number;
    correlation: WorkerCorrelation;
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
  }>;

export type AgentDataPortResponse =
  | Readonly<{
    kind: 'generation_context_result';
    requestId: number;
    correlation: WorkerCorrelation;
    basis: AgentGenerationContextBasis;
  }>
  | Readonly<{
    kind: 'checkpoint_acknowledgement';
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
