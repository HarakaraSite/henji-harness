import type { AgentEvent, AgentEventSink } from '../core/events.ts';
import { type LoopOutcome, type Message } from '../core/contracts.ts';
import { projectSemanticContext } from '../session/semantic_context.ts';
import { type SemanticContextCheckpointV1 } from '../session/session_store.ts';
import { runAgentTurn } from '../core/loop.ts';
import { ParentTurnExecutionContext, TurnRequestBudget } from '../core/execution_context.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../definitions/agent_definition.ts';
import { TurnCancellationOwner } from '../core/cancellation.ts';
import { SteeringOwner, validateSteeringText } from '../core/steering.ts';
import { FailureDiagnosticOwner } from '../session/failure_diagnostic.ts';
import {
  ProviderEvidenceRecorder,
  type ProviderEvidenceV1,
} from '../provider/provider_evidence.ts';
import type { WorkerAgentComposition } from '../worker_agent_api.ts';
import type { WorkerRequestCounter } from './worker_physical_io.ts';
import {
  type ModelSelection,
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import {
  type CredentialAvailability,
  type CredentialAvailabilityStatus,
  modelRouteProfileId,
} from '../provider/model_selection.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerEffectObservation,
} from './worker_protocol.ts';

export interface WorkerGenerationPort {
  readonly runtimeEvent: (
    correlation: WorkerCorrelation,
    event: AgentEvent,
  ) => void;
  readonly effectObservation: (
    correlation: WorkerCorrelation,
    effect: WorkerEffectObservation,
  ) => void;
  readonly checkpointProposal: (
    correlation: WorkerCorrelation,
    proposal: WorkerCheckpointProposalMessage,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly commitProposal: (
    correlation: WorkerCorrelation,
    proposal: WorkerCommitProposalMessage,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly turnFailed: (
    correlation: WorkerCorrelation,
    outcome: LoopOutcome,
    providerEvidence?: ProviderEvidenceV1,
  ) => void;
}

type TurnEndEvent = Extract<AgentEvent, { readonly kind: 'turn_end' }>;

const snapshotMessages = (messages: readonly Message[]): Message[] =>
  structuredClone(messages) as Message[];

const failureOutcome = (
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
  transcript: snapshotMessages(transcript),
});

const rejectedCommitOutcome = (
  task: string,
  transcript: readonly Message[],
  outcome: LoopOutcome,
): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  error: 'Host did not acknowledge the commit proposal',
  steps: outcome.steps,
  toolCallCount: outcome.toolCallCount,
  toolResultCount: outcome.toolResultCount,
  transcript: snapshotMessages(transcript),
});

const isEffect = (event: AgentEvent): event is WorkerEffectObservation =>
  event.kind === 'tool_call' || event.kind === 'tool_result' ||
  event.kind === 'tool_progress';

/** One ephemeral Worker generation with local turn/context semantics and Host proposal ports. */
export class WorkerGeneration {
  private committedTranscript: Message[] = [];
  private nextTurn = 1;
  private checkpoint: SemanticContextCheckpointV1 | undefined;
  private activeCancellation: TurnCancellationOwner | null = null;
  private activeSteering: SteeringOwner | null = null;
  private active = false;
  private rootModelSelection: ModelSelection;

  constructor(
    private readonly composition: WorkerAgentComposition,
    private readonly sessionId: string,
    private readonly port: WorkerGenerationPort,
    initialTranscript: readonly Message[] = [],
    initialNextTurn = 1,
    initialCheckpoint?: SemanticContextCheckpointV1,
    private readonly requestCounter: WorkerRequestCounter = {
      increment: () => {},
      count: () => 0,
    },
    initialModelSelection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
    private readonly replaceRootModel: (selection: ModelSelection) => void = () => {},
    private readonly inspectCredentialAvailability: (
      authProfile: ModelSelection['authProfile'],
    ) => Promise<CredentialAvailabilityStatus> = () => Promise.resolve('unknown'),
  ) {
    this.committedTranscript = snapshotMessages(initialTranscript);
    this.nextTurn = initialNextTurn;
    this.checkpoint = initialCheckpoint === undefined
      ? undefined
      : structuredClone(initialCheckpoint);
    this.rootModelSelection = structuredClone(initialModelSelection);
  }

  get manifest(): WorkerAgentComposition['manifest'] {
    const rootModel = structuredClone(this.rootModelSelection);
    const profileId = modelRouteProfileId(rootModel);
    const resources = this.composition.manifest.resources.map((resource) =>
      resource.startsWith('model:') ? `model:${rootModel.provider}:${profileId}` : resource
    ).sort();
    return Object.freeze({
      ...this.composition.manifest,
      profileId,
      resources: Object.freeze(resources),
      rootModel: Object.freeze(rootModel),
      plannerModel: Object.freeze(structuredClone(PLANNER_DEFAULT_MODEL_SELECTION)),
    });
  }

  selectRootModel(selection: ModelSelection): boolean {
    if (this.active) return false;
    this.replaceRootModel(selection);
    this.rootModelSelection = structuredClone(selection);
    return true;
  }

  async rootCredentialAvailability(): Promise<CredentialAvailability> {
    const authProfile = this.rootModelSelection.authProfile;
    return Object.freeze({
      authProfile,
      status: await this.inspectCredentialAvailability(authProfile),
    });
  }

  transcriptSnapshot(): readonly Message[] {
    return snapshotMessages(this.committedTranscript);
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (this.activeCancellation === null) return 'idle';
    return this.activeCancellation.request();
  }

  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    if (this.activeSteering === null || !this.active) return 'idle';
    return this.activeSteering.admit(validateSteeringText(text));
  }

  async runTurn(correlation: WorkerCorrelation, task: string): Promise<void> {
    if (this.active) {
      this.port.turnFailed(
        correlation,
        failureOutcome(
          task,
          this.committedTranscript,
          'Worker generation is busy',
        ),
      );
      return;
    }
    this.active = true;
    const cancellation = new TurnCancellationOwner();
    const steering = new SteeringOwner();
    const turn = this.nextTurn;
    let requestCountAtAdmission = this.requestCounter.count();
    let userTurnAdmitted = false;
    const turnProviderRequestCount = () =>
      userTurnAdmitted ? Math.max(0, this.requestCounter.count() - requestCountAtAdmission) : 0;
    const diagnosticOwner = new FailureDiagnosticOwner(turn);
    const evidence = new ProviderEvidenceRecorder(
      crypto.randomUUID().toLowerCase(),
      turn,
      new Date().toISOString(),
    );
    this.activeCancellation = cancellation;
    this.activeSteering = steering;
    const childMaxSteps = DEFAULT_AGENT_MAX_STEPS;
    const executionContext = new ParentTurnExecutionContext(
      turn,
      new TurnRequestBudget({
        parent: this.composition.maxSteps,
        child: childMaxSteps,
        aggregate: Math.min(
          Number.MAX_SAFE_INTEGER,
          this.composition.maxSteps + childMaxSteps,
        ),
      }),
      cancellation.signal,
      cancellation,
      diagnosticOwner,
      turnProviderRequestCount,
      this.requestCounter.count,
      evidence,
    );
    let evidenceFinalized = false;
    const settledOutcome = (outcome: LoopOutcome): LoopOutcome => ({
      ...outcome,
      ...(outcome.turnProviderRequestCount === undefined
        ? { turnProviderRequestCount: turnProviderRequestCount() }
        : {}),
      ...(outcome.runtimeProviderRequestCount === undefined
        ? { runtimeProviderRequestCount: this.requestCounter.count() }
        : {}),
      providerEvidenceId: evidence.evidenceId,
      ...(outcome.diagnostic === undefined && diagnosticOwner.snapshot() === undefined
        ? {}
        : { diagnostic: outcome.diagnostic ?? diagnosticOwner.snapshot()! }),
    });
    const finalizeEvidence = (outcome: LoopOutcome): {
      readonly outcome: LoopOutcome;
      readonly providerEvidence: ProviderEvidenceV1;
    } => {
      const settled = settledOutcome(outcome);
      if (!evidenceFinalized) {
        evidence.finalize({
          outcome: settled,
          ...(settled.diagnostic === undefined ? {} : {
            diagnosticId: settled.diagnostic.diagnosticId,
          }),
        });
        evidenceFinalized = true;
      }
      return { outcome: settled, providerEvidence: evidence.snapshot() };
    };
    const failTurn = (outcome: LoopOutcome): void => {
      const finalized = finalizeEvidence(outcome);
      this.port.turnFailed(
        correlation,
        finalized.outcome,
        finalized.providerEvidence,
      );
    };
    try {
      requestCountAtAdmission = this.requestCounter.count();
      userTurnAdmitted = true;

      let proposal: WorkerCommitProposalMessage | undefined;
      let terminal: TurnEndEvent | undefined;
      const eventSink: AgentEventSink = (event) => {
        if (event.kind === 'turn_end') {
          terminal = event;
        } else if (isEffect(event)) {
          this.port.effectObservation(correlation, event);
        } else {
          this.port.runtimeEvent(correlation, event);
        }
      };
      const outcome = await runAgentTurn(
        task,
        this.committedTranscript,
        this.composition.model,
        this.composition.registry,
        {
          maxSteps: this.composition.maxSteps,
          systemInstruction: this.composition.systemInstruction,
          turn: this.nextTurn,
          eventSink,
          executionContext,
          cancellation,
          signal: cancellation.signal,
          steering,
          projectParentRequest: this.checkpoint === undefined
            ? undefined
            : (request) => projectSemanticContext(request, this.checkpoint!),
          commit: (transcript) => {
            proposal = {
              kind: 'commit_proposal',
              correlation,
              transcript: snapshotMessages(transcript),
              nextTurn: this.nextTurn + 1,
            };
          },
        },
      );
      const finalized = finalizeEvidence(outcome);
      if (!outcome.ok || proposal === undefined) {
        failTurn(finalized.outcome);
        return;
      }
      proposal = {
        ...proposal,
        outcome: finalized.outcome,
        providerEvidence: finalized.providerEvidence,
        ...(finalized.outcome.diagnostic === undefined ? {} : {
          diagnostic: finalized.outcome.diagnostic,
        }),
      };
      const accepted = await this.port.commitProposal(
        correlation,
        proposal,
        cancellation.signal,
      );
      if (!accepted) {
        failTurn(rejectedCommitOutcome(task, this.committedTranscript, finalized.outcome));
        return;
      }
      this.committedTranscript = snapshotMessages(proposal.transcript);
      this.nextTurn = proposal.nextTurn;
      this.port.runtimeEvent(
        correlation,
        terminal ?? {
          kind: 'turn_end',
          turn: this.nextTurn - 1,
          outcome: outcome.stopReason,
          committed: true,
        },
      );
    } catch (error) {
      failTurn(failureOutcome(
        task,
        this.committedTranscript,
        error instanceof Error ? error.message : String(error),
        cancellation.signal.aborted,
      ));
    } finally {
      steering.close();
      this.activeSteering = null;
      this.activeCancellation = null;
      this.active = false;
    }
  }
}
