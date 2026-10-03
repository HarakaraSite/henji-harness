import type { LoopOutcome, Message } from '../../../v0/agent/core/contracts.ts';
import { createDataClient } from '../../../v0/agent/data/client.ts';
import type {
  DataService,
  DataSessionDescriptor,
  DataSessionOpenInput,
} from '../../../v0/agent/data/data_contract.ts';
import { createAgentDataPortClient } from '../../../v0/agent/data/agent_data_client.ts';
import { SqliteHistoryStore } from '../../../v0/agent/history/sqlite_history_store.ts';
import type {
  WorkerHostCapsule,
  WorkerHostSessionOptions,
} from '../../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerCommitProposalMessage,
  WorkerHostCommand,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from '../../../v0/agent/worker/worker_protocol.ts';
import { WorkerHostSession } from '../../../v0/agent/worker/worker_host_session.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../../../v0/agent/worker_agent_api.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../../v0/agent/provider/model_selection.ts';
import type { AgentConfigurationChoice } from '../../../v0/agent/configuration/configuration_resolver.ts';
import { workerConfigurationFixture } from './worker_configuration_fixture.ts';

interface Increment170FoundationDataHarness {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly data: DataService;
  readonly descriptor: DataSessionDescriptor;
  close(): Promise<void>;
}

export const createIncrement170FoundationDataHarness = async (
  options: {
    readonly prefix?: string;
    readonly persistence?: DataSessionOpenInput['persistence'];
    readonly agent?: DataSessionOpenInput['agent'];
    readonly agentChoice?: AgentConfigurationChoice;
    readonly sessionId?: string;
  } = {},
): Promise<Increment170FoundationDataHarness> => {
  const root = await Deno.makeTempDir({
    prefix: options.prefix ?? 'henji-i170-foundation-data-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  try {
    const descriptor = await data.openSession({
      persistence: options.persistence ?? 'none',
      agent: options.agent ?? 'default',
      agentChoice: options.agentChoice ?? {},
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
    let closed = false;
    return {
      root,
      workspaceRoot,
      stateRoot,
      data,
      descriptor,
      async close() {
        if (closed) return;
        closed = true;
        await data.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await data.close();
    await Deno.remove(root, { recursive: true });
    throw error;
  }
};

export const openIncrement170FoundationHost = async (
  harness: Increment170FoundationDataHarness,
  options:
    & Omit<
      Partial<WorkerHostSessionOptions>,
      'data' | 'descriptor' | 'workspaceRoot'
    >
    & { readonly descriptor?: DataSessionDescriptor } = {},
): Promise<WorkerHostSession> => {
  const { descriptor, ...hostOptions } = options;
  return await WorkerHostSession.open({
    data: harness.data,
    descriptor: descriptor ?? harness.descriptor,
    workspaceRoot: harness.workspaceRoot,
    agentChoice: harness.descriptor.agentChoice,
    configRoot: `${harness.root}/config`,
    physicalIoMode: 'provider-free',
    ...hostOptions,
  });
};

export const readIncrement170FoundationArtifacts = async (
  harness: Pick<
    Increment170FoundationDataHarness,
    'stateRoot' | 'workspaceRoot'
  >,
) => {
  const store = new SqliteHistoryStore(
    harness.stateRoot,
    harness.workspaceRoot,
    { readOnly: true },
  );
  try {
    await store.initialize();
    return await store.executionArtifacts.list();
  } finally {
    store.close();
  }
};

type StartCommand = Extract<WorkerHostCommand, { readonly kind: 'start' }>;
type TurnCommand = Extract<WorkerHostCommand, { readonly kind: 'turn' }>;

interface Increment170FoundationAgentTurnInput {
  readonly data: ReturnType<typeof createAgentDataPortClient>;
  readonly command: TurnCommand;
  readonly turnNumber: number;
  requestStarted(requestOrdinal: number, modelStep: number): void;
  requestCount(
    turnProviderRequestCount: number,
    runtimeProviderRequestCount: number,
  ): void;
}

type Increment170FoundationProposalFactory = (
  input: Increment170FoundationAgentTurnInput,
) => WorkerCommitProposalMessage | Promise<WorkerCommitProposalMessage>;

/** A test Agent that sends full proposal and observation data through the production Agent Data port. */
export class Increment170FoundationDataPortAgent implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();
  private agentData: ReturnType<typeof createAgentDataPortClient> | undefined;
  private startTask: Promise<void> | undefined;
  private turnNumber = 1;
  private workerSequence = 0;
  private terminalStopReason: LoopOutcome['stopReason'] = 'final';
  private closed = false;

  constructor(
    private readonly createProposal: Increment170FoundationProposalFactory,
    private readonly configuration: ReturnType<typeof workerConfigurationFixture> =
      workerConfigurationFixture(),
  ) {}

  private emit(message: WorkerToHostMessage): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  private async start(command: StartCommand): Promise<void> {
    if (command.dataPort === undefined) {
      throw new Error('Core did not transfer the Agent Data port');
    }
    const agentData = createAgentDataPortClient(command.dataPort);
    this.agentData = agentData;
    const basis = await agentData.generationContext(command.correlation);
    this.turnNumber = basis.nextTurn;
    const rootModel = command.modelSelection ?? basis.modelSelection ??
      ROOT_DEFAULT_MODEL_SELECTION;
    const ready: WorkerReadyMessage = {
      kind: 'ready',
      configuration: this.configuration,
      correlation: command.correlation,
      manifest: {
        role: 'parent',
        maxSteps: command.rootMaxSteps ?? DEFAULT_AGENT_MAX_STEPS,
        profileId: modelRouteProfileId(rootModel),
        resources: [],
        rootModel,
        ...(command.baseInstruction === undefined ? {} : {
          baseInstruction: {
            slot: command.baseInstruction.slot,
            selectionSource: command.baseInstruction.selectionSource,
            ref: command.baseInstruction.ref,
            contentDigest: command.baseInstruction.contentDigest,
          },
        }),
      },
      startupSnapshot: { skillNames: [] },
      credentialAvailability: {
        authProfile: rootModel.authProfile,
        status: 'unknown',
      },
    };
    await agentData.ready(ready);
    this.emit(ready);
  }

  private async runTurn(command: TurnCommand): Promise<void> {
    const agentData = this.agentData;
    const executionId = command.executionId;
    if (agentData === undefined || executionId === undefined) {
      throw new Error('Agent Data turn identity is unavailable');
    }
    agentData.beginExecution(executionId, command.correlation);
    const proposal = await this.createProposal({
      data: agentData,
      command,
      turnNumber: this.turnNumber,
      requestStarted: (requestOrdinal, modelStep) => {
        this.emit({
          kind: 'request_started',
          correlation: command.correlation,
          sequence: ++this.workerSequence,
          requestOrdinal,
          modelStep,
        });
      },
      requestCount: (turnProviderRequestCount, runtimeProviderRequestCount) => {
        this.emit({
          kind: 'request_count',
          correlation: command.correlation,
          sequence: ++this.workerSequence,
          executionId,
          turnProviderRequestCount,
          runtimeProviderRequestCount,
        });
      },
    });
    const barrier = agentData.sendProposal(proposal);
    this.terminalStopReason = proposal.outcome?.stopReason ?? 'final';
    this.turnNumber = proposal.nextTurn;
    this.emit({
      kind: 'proposal_ready',
      correlation: command.correlation,
      proposalId: barrier.proposalId,
      finalDataSequence: barrier.finalDataSequence,
    });
  }

  send(command: WorkerHostCommand, _transfer?: Transferable[]): void {
    if (this.closed) return;
    if (command.kind === 'start') {
      this.startTask = this.start(command);
      void this.startTask.catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind === 'turn') {
      void (async () => {
        await this.startTask;
        await this.runTurn(command);
      })().catch((error) =>
        this.emit({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'turn',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      return;
    }
    if (command.kind === 'commit_acknowledgement') {
      if (command.accepted) {
        this.agentData?.observation({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: ++this.workerSequence,
          event: {
            kind: 'agent_event',
            event: {
              kind: 'turn_end',
              turn: this.turnNumber - 1,
              outcome: this.terminalStopReason,
              committed: true,
            },
          },
        });
      }
      queueMicrotask(() =>
        this.emit({
          kind: 'turn_settled',
          correlation: command.correlation,
        })
      );
      return;
    }
    if (command.kind === 'close') {
      this.agentData?.close();
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.closed = true;
    this.agentData?.close();
    this.listeners.clear();
  }
}

export const foundationProposal = (input: {
  readonly correlation: WorkerCommitProposalMessage['correlation'];
  readonly task: string;
  readonly turn: number;
  readonly transcript: readonly Message[];
  readonly outcome?: Omit<LoopOutcome, 'task' | 'transcript'>;
}): WorkerCommitProposalMessage => ({
  kind: 'commit_proposal',
  correlation: input.correlation,
  transcript: structuredClone(input.transcript),
  nextTurn: input.turn + 1,
  ...(input.outcome === undefined ? {} : {
    outcome: {
      ...structuredClone(input.outcome),
      task: input.task,
      transcript: structuredClone(input.transcript),
    },
  }),
});
