import type {
  AgentAfterTurnContextUpdate,
  AgentDataPortClient,
  AgentDataPortRequest,
  AgentDataPortResponse,
  AgentFailureBarrier,
  AgentGenerationContextBasis,
  AgentPostSettlementHookUpdate,
  AgentProposalBarrier,
} from './agent_data_contract.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerReadyMessage,
  WorkerToHostMessage,
  WorkerTurnFailedMessage,
} from '../worker/worker_protocol.ts';

type PendingRequest = {
  readonly correlation: WorkerCorrelation;
  readonly responseKind:
    | 'generation_context_result'
    | 'checkpoint_acknowledgement'
    | 'after_turn_acknowledgement'
    | 'post_settlement_hook_acknowledgement'
    | 'ready_acknowledgement';
  readonly resolve: (response: AgentDataPortResponse) => void;
  readonly reject: (error: Error) => void;
};

type CurrentExecution = {
  readonly executionId: string;
  sequence: number;
};

const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

class AgentDataPortError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentDataPortError';
  }
}

/** Agent-side endpoint for the transferred Data MessagePort. */
export class AgentDataPortClientImpl implements AgentDataPortClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private current: CurrentExecution | undefined;
  private closed = false;

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<AgentDataPortResponse>): void => {
      this.receive(event.data);
    };
    port.onmessageerror = (): void => {
      this.fail(new Error('Agent Data response could not be cloned'));
    };
    port.start();
  }

  generationContext(
    correlation: WorkerCorrelation,
  ): Promise<AgentGenerationContextBasis> {
    const requestId = this.allocateRequestId();
    return this.request(
      { kind: 'generation_context', requestId, correlation },
      correlation,
    )
      .then((response) => {
        if (response.kind !== 'generation_context_result') {
          throw new Error('unexpected Agent Data generation context response');
        }
        return response.basis;
      });
  }

  ready(message: WorkerReadyMessage): Promise<void> {
    const requestId = this.allocateRequestId();
    return this.request(
      { kind: 'ready', requestId, message },
      message.correlation,
    )
      .then((response) => {
        if (response.kind !== 'ready_acknowledgement') {
          throw new Error('unexpected Agent Data ready response');
        }
      });
  }

  beginExecution(
    executionId: string,
    correlation: WorkerCorrelation,
    diagnosticStageBuffer?: SharedArrayBuffer,
    auxiliaryStageGapMs?: number,
  ): void {
    this.current = { executionId, sequence: 0 };
    this.post({
      kind: 'begin_execution',
      executionId,
      correlation,
      ...(diagnosticStageBuffer === undefined ? {} : { diagnosticStageBuffer }),
      ...(auxiliaryStageGapMs === undefined ? {} : { auxiliaryStageGapMs }),
    });
  }

  observation(message: WorkerToHostMessage): number {
    const current = this.requireCurrentExecution();
    const sequence = ++current.sequence;
    this.post({
      kind: 'execution_data',
      executionId: current.executionId,
      sequence,
      message,
    });
    return sequence;
  }

  sendProposal(message: WorkerCommitProposalMessage): AgentProposalBarrier {
    const current = this.requireCurrentExecution();
    const proposalId = crypto.randomUUID().toLowerCase();
    const sequence = ++current.sequence;
    this.post({
      kind: 'proposal',
      proposalId,
      executionId: current.executionId,
      sequence,
      message,
    });
    return {
      proposalId,
      correlation: message.correlation,
      finalDataSequence: sequence,
    };
  }

  sendFailure(message: WorkerTurnFailedMessage): AgentFailureBarrier {
    const current = this.requireCurrentExecution();
    const sequence = ++current.sequence;
    this.post({
      kind: 'failure',
      executionId: current.executionId,
      sequence,
      message,
    });
    return {
      correlation: message.correlation,
      finalDataSequence: sequence,
    };
  }

  checkpoint(message: WorkerCheckpointProposalMessage): Promise<boolean> {
    const current = this.requireCurrentExecution();
    const requestId = this.allocateRequestId();
    const sequence = ++current.sequence;
    return this.request({
      kind: 'checkpoint_proposal',
      requestId,
      executionId: current.executionId,
      sequence,
      message,
    }, message.correlation).then((response) => {
      if (response.kind !== 'checkpoint_acknowledgement') {
        throw new Error('unexpected Agent Data checkpoint response');
      }
      return response.accepted;
    });
  }

  afterTurn(update: AgentAfterTurnContextUpdate): Promise<boolean> {
    const current = this.requireCurrentExecution();
    const requestId = this.allocateRequestId();
    const sequence = ++current.sequence;
    current.sequence += update.providerObservations?.length ?? 0;
    return this.request({
      kind: 'after_turn_context',
      requestId,
      sequence,
      update,
    }, update.correlation).then((response) => {
      if (response.kind !== 'after_turn_acknowledgement') {
        throw new Error('unexpected Agent Data after_turn response');
      }
      return response.accepted;
    });
  }

  postSettlementHook(update: AgentPostSettlementHookUpdate): Promise<boolean> {
    const current = this.requireCurrentExecution();
    const requestId = this.allocateRequestId();
    const sequence = ++current.sequence;
    current.sequence += update.providerObservations?.length ?? 0;
    return this.request({
      kind: 'post_settlement_hook',
      requestId,
      sequence,
      update,
    }, update.correlation).then((response) => {
      if (response.kind !== 'post_settlement_hook_acknowledgement') {
        throw new Error('unexpected Agent Data post-settlement hook response');
      }
      return response.accepted;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Agent Data port closed'));
    this.current = undefined;
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    this.port.close();
  }

  private allocateRequestId(): number {
    return this.nextRequestId++;
  }

  private requireCurrentExecution(): CurrentExecution {
    if (this.closed) throw new Error('Agent Data port closed');
    if (this.current === undefined) {
      throw new Error('Agent Data execution has not begun');
    }
    return this.current;
  }

  private post(message: AgentDataPortRequest): void {
    if (this.closed) throw new Error('Agent Data port closed');
    this.port.postMessage(message);
  }

  private request(
    message: Extract<AgentDataPortRequest, { readonly requestId: number }>,
    correlation: WorkerCorrelation,
  ): Promise<AgentDataPortResponse> {
    if (this.closed) return Promise.reject(new Error('Agent Data port closed'));
    const responseKind = message.kind === 'generation_context'
      ? 'generation_context_result'
      : message.kind === 'checkpoint_proposal'
      ? 'checkpoint_acknowledgement'
      : message.kind === 'after_turn_context'
      ? 'after_turn_acknowledgement'
      : message.kind === 'post_settlement_hook'
      ? 'post_settlement_hook_acknowledgement'
      : 'ready_acknowledgement';
    return new Promise<AgentDataPortResponse>((resolve, reject) => {
      this.pending.set(message.requestId, {
        correlation,
        responseKind,
        resolve,
        reject,
      });
      try {
        this.port.postMessage(message);
      } catch (error) {
        this.pending.delete(message.requestId);
        reject(asError(error));
      }
    });
  }

  private receive(response: AgentDataPortResponse): void {
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) return;
    this.pending.delete(response.requestId);
    if (response.kind === 'error') {
      pending.reject(
        new AgentDataPortError(
          response.error.status,
          response.error.code,
          response.error.message,
        ),
      );
      return;
    }
    if (
      response.kind !== pending.responseKind ||
      !sameCorrelation(response.correlation, pending.correlation)
    ) {
      pending.reject(new Error('unexpected Agent Data response'));
      return;
    }
    pending.resolve(response);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export const createAgentDataPortClient = (
  port: MessagePort,
): AgentDataPortClient => new AgentDataPortClientImpl(port);
