import type {
  AgentDataPortRequest,
  AgentDataPortResponse,
  AgentGenerationContextBasis,
} from './agent_data_contract.ts';
import type { ExecutionDataInput } from './execution_data_journal.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerReadyMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';

interface ProposalData {
  readonly executionId: string;
  readonly sequence: number;
  readonly message: WorkerCommitProposalMessage;
}
interface FailureData {
  readonly executionId: string;
  readonly sequence: number;
  readonly message: WorkerTurnFailedMessage;
}
interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/** Data-local endpoint. Full context, proposal and failure payloads stay on the Agent data port. */
export class AgentDataEndpoint {
  private startup: WorkerReadyMessage | undefined;
  private readonly startupWaiters = new Set<Waiter<WorkerReadyMessage>>();
  private readonly proposals = new Map<string, ProposalData>();
  private readonly proposalWaiters = new Map<
    string,
    Set<Waiter<ProposalData>>
  >();
  private readonly failures = new Map<string, FailureData>();
  private readonly failureWaiters = new Map<string, Set<Waiter<FailureData>>>();
  private sealed = false;
  private closed = false;

  constructor(
    private readonly input: {
      readonly port: MessagePort;
      readonly generationContext: (
        correlation: WorkerCorrelation,
      ) => AgentGenerationContextBasis;
      readonly beginExecution?: (
        executionId: string,
        correlation: WorkerCorrelation,
        diagnosticStageBuffer?: SharedArrayBuffer,
        auxiliaryStageGapMs?: number,
      ) => void;
      readonly receiveData: (
        input: ExecutionDataInput,
      ) => 'accepted' | 'sealed';
      readonly checkpoint: (
        message: WorkerCheckpointProposalMessage,
      ) => boolean | Promise<boolean>;
      readonly onFailure: (error: Error) => void;
    },
  ) {
    input.port.onmessage = (
      event: MessageEvent<AgentDataPortRequest>,
    ): void => {
      void this.receive(event.data).catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if ('requestId' in event.data) {
          this.reply({
            kind: 'error',
            requestId: event.data.requestId,
            error: {
              status: 500,
              code: 'agent_data_failed',
              message: error.message,
            },
          });
        }
        this.input.onFailure(error);
      });
    };
    input.port.onmessageerror = (): void => {
      this.input.onFailure(new Error('Agent data message could not be cloned'));
    };
  }

  private reply(message: AgentDataPortResponse): void {
    if (!this.closed) this.input.port.postMessage(message);
  }

  private async receive(request: AgentDataPortRequest): Promise<void> {
    if (this.closed || this.sealed) return;
    if (request.kind === 'generation_context') {
      this.reply({
        kind: 'generation_context_result',
        requestId: request.requestId,
        correlation: request.correlation,
        basis: this.input.generationContext(request.correlation),
      });
      return;
    }
    if (request.kind === 'ready') {
      this.startup = request.message;
      for (const waiter of this.startupWaiters) waiter.resolve(request.message);
      this.startupWaiters.clear();
      this.reply({
        kind: 'ready_acknowledgement',
        requestId: request.requestId,
        correlation: request.message.correlation,
      });
      return;
    }
    if (request.kind === 'begin_execution') {
      this.input.beginExecution?.(
        request.executionId,
        request.correlation,
        request.diagnosticStageBuffer,
        request.auxiliaryStageGapMs,
      );
      return;
    }
    const accepted = this.input.receiveData(request);
    if (accepted === 'sealed') return;
    if (request.kind === 'proposal') {
      this.proposals.set(request.proposalId, request);
      const waiters = this.proposalWaiters.get(request.proposalId);
      if (waiters !== undefined) {
        for (const waiter of waiters) waiter.resolve(request);
        this.proposalWaiters.delete(request.proposalId);
      }
    } else if (request.kind === 'failure') {
      this.failures.set(request.executionId, request);
      const waiters = this.failureWaiters.get(request.executionId);
      if (waiters !== undefined) {
        for (const waiter of waiters) waiter.resolve(request);
        this.failureWaiters.delete(request.executionId);
      }
    } else if (request.kind === 'checkpoint_proposal') {
      const accepted = await this.input.checkpoint(request.message);
      this.reply({
        kind: 'checkpoint_acknowledgement',
        requestId: request.requestId,
        correlation: request.message.correlation,
        accepted,
      });
    }
  }

  ready(): Promise<WorkerReadyMessage> {
    if (this.startup !== undefined) return Promise.resolve(this.startup);
    if (this.closed || this.sealed) {
      return Promise.reject(new Error('Agent data generation sealed'));
    }
    return new Promise((resolve, reject) => this.startupWaiters.add({ resolve, reject }));
  }

  proposal(proposalId: string): Promise<ProposalData> {
    const data = this.proposals.get(proposalId);
    if (data !== undefined) return Promise.resolve(data);
    if (this.closed || this.sealed) {
      return Promise.reject(new Error('Agent data generation sealed'));
    }
    let waiters = this.proposalWaiters.get(proposalId);
    if (waiters === undefined) {
      waiters = new Set();
      this.proposalWaiters.set(proposalId, waiters);
    }
    const pending = waiters;
    return new Promise((resolve, reject) => pending.add({ resolve, reject }));
  }

  failure(executionId: string): Promise<FailureData> {
    const data = this.failures.get(executionId);
    if (data !== undefined) return Promise.resolve(data);
    if (this.closed || this.sealed) {
      return Promise.reject(new Error('Agent data generation sealed'));
    }
    let waiters = this.failureWaiters.get(executionId);
    if (waiters === undefined) {
      waiters = new Set();
      this.failureWaiters.set(executionId, waiters);
    }
    const pending = waiters;
    return new Promise((resolve, reject) => pending.add({ resolve, reject }));
  }

  releaseExecution(executionId: string): void {
    for (const [proposalId, proposal] of this.proposals) {
      if (proposal.executionId === executionId) {
        this.proposals.delete(proposalId);
      }
    }
    this.failures.delete(executionId);
  }

  /** Stop input and unblock prepare waiters; the owner flushes and terminalizes before close(). */
  seal(): void {
    this.sealed = true;
    const error = new Error('Agent data generation sealed');
    for (const waiter of this.startupWaiters) waiter.reject(error);
    this.startupWaiters.clear();
    for (const waiters of this.proposalWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.proposalWaiters.clear();
    for (const waiters of this.failureWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.failureWaiters.clear();
  }

  close(): void {
    if (this.closed) return;
    this.seal();
    this.closed = true;
    this.input.port.close();
    this.proposals.clear();
    this.failures.clear();
    this.startup = undefined;
  }
}
