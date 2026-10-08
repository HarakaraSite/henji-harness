import type { AgentEvent, AgentEventSink } from '../core/events.ts';
import { type JsonValue, type LoopOutcome, type Message } from '../core/contracts.ts';
import type {
  AfterTurnHookContribution,
  AfterTurnHookEffect,
  AfterTurnSettlement,
  HookEffectFailure,
  HookEffectSource,
  RuntimeStopHookEffect,
  RuntimeStopHookResult,
  ToolHookEffect,
} from '../core/hook_effect.ts';
import { causalTranscriptIndex } from '../session/session_store.ts';
import { projectSemanticContext } from '../session/semantic_context.ts';
import { indexSessionHistory } from '../session/session_history.ts';
import {
  type SemanticContextCheckpointV1,
  validateSemanticContextCheckpoint,
} from '../session/session_store.ts';
import { runAgentTurn } from '../core/loop.ts';
import {
  ParentTurnExecutionContext,
  type RequestMessageSourceKind,
  TurnRequestBudget,
} from '../core/execution_context.ts';
import { TurnCancellationOwner } from '../core/cancellation.ts';
import { SteeringOwner, validateSteeringText } from '../core/steering.ts';
import { FailureDiagnosticOwner } from '../session/failure_diagnostic.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
} from '../provider/provider_evidence.ts';
import type { WorkerAgentComposition } from '../worker_agent_api.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import {
  type ContextModelRequestDelta,
  contextOccurrenceDigest,
  type ContextOccurrenceInput,
  type ContextOccurrenceSource,
  contextRevisionDigest,
  type ContextSourceRelation,
  createExecutionContextManifest,
  jsonBlob,
  textBlob,
  type WorkerContextSnapshot,
} from '../history/context_attribution.ts';
import type {
  AuxiliaryRequestObservation,
  ModelRequestObservation,
} from '../core/execution_context.ts';
import type { WorkerRequestCounter } from './worker_physical_io.ts';
import {
  type ModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import {
  type ChatGPTModelSelection,
  type CredentialAvailability,
  type CredentialAvailabilityStatus,
  modelRouteProfileId,
  sameModelSelection,
} from '../provider/model_selection.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerCommitProposalMessage,
  WorkerCorrelation,
  WorkerEffectObservation,
} from './worker_protocol.ts';
import {
  projectRecalledExecutionContext,
  type RecalledExecutionContext,
} from './recalled_execution_context.ts';
import type { WorkerStageName } from './worker_stage_probe.ts';
import type { AgentGenerationContextBasis } from '../data/agent_data_contract.ts';
import type {
  AgentAfterTurnContextUpdate,
  AgentPostSettlementHookUpdate,
} from '../data/agent_data_contract.ts';
import type { WorkerConfigurationSnapshot } from './worker_configuration.ts';
import type { LoadedWorkerHook } from '../../hooks/hook_loader.ts';
import type { HookProviderEvidenceScope } from '../provider/auxiliary_request.ts';
import { runHookPhase } from '../../hooks/hook_runner.ts';
import {
  type AfterToolInput,
  type AfterTurnInput,
  type BeforeToolInput,
  type HookContextSnapshot,
  type HookRuntimeIdentity,
  type HookToolResult,
  type HookTranscriptTurn,
} from '../hook_api.ts';
import {
  type ConfigurationRejection,
  configurationRejection,
} from '../configuration/agent_configuration.ts';
import {
  defineInstructionComponent,
  type InstructionComponent,
} from '../instructions/component.ts';
import {
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
} from '../definitions/resource_identity.ts';
import type { WorkerHookFailure } from './worker_protocol.ts';

export interface WorkerGenerationPort {
  readonly runtimeEvent: (
    correlation: WorkerCorrelation,
    event: AgentEvent,
  ) => number | undefined;
  readonly effectObservation: (
    correlation: WorkerCorrelation,
    effect: WorkerEffectObservation,
  ) => number | undefined;
  readonly providerObservation?: (
    correlation: WorkerCorrelation,
    observation: ProviderEvidenceObservation,
    turn: number,
  ) => number | undefined;
  readonly contextObservation?: (
    correlation: WorkerCorrelation,
    observation: ContextModelRequestDelta,
  ) => number | undefined | PromiseLike<number | undefined>;
  readonly checkpointProposal: (
    correlation: WorkerCorrelation,
    proposal: WorkerCheckpointProposalMessage,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly commitProposal: (
    correlation: WorkerCorrelation,
    proposal: WorkerCommitProposalMessage,
    signal: AbortSignal,
  ) => Promise<boolean | AfterTurnSettlement>;
  readonly afterTurnContext?: (
    update: AgentAfterTurnContextUpdate,
  ) => Promise<boolean>;
  readonly postSettlementHook?: (
    update: AgentPostSettlementHookUpdate,
  ) => Promise<boolean>;
  readonly settlementFailure?: (
    correlation: WorkerCorrelation,
    error: unknown,
  ) => void;
  readonly turnFailed: (
    correlation: WorkerCorrelation,
    outcome: LoopOutcome,
    contextManifest?: import('../history/context_attribution.ts').ExecutionContextManifestV2,
  ) => void | boolean | AfterTurnSettlement | PromiseLike<void | boolean | AfterTurnSettlement>;
  /** Synchronous Core receipt emitted only after runtime turn cleanup clears `active`. */
  readonly turnSettled?: (correlation: WorkerCorrelation) => void;
}

type TurnEndEvent = Extract<AgentEvent, { readonly kind: 'turn_end' }>;

const snapshotMessages = (messages: readonly Message[]): Message[] =>
  structuredClone(messages) as Message[];

const isHookJsonValue = (
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((
    part,
  ) => isHookJsonValue(part, ancestors));
  ancestors.delete(value);
  return valid;
};

const hookFailure = (
  hook: LoadedWorkerHook | undefined,
  phase: HookEffectFailure['phase'],
  error: unknown,
): HookEffectFailure => ({
  name: hook?.selection.name ?? 'hook',
  ...(hook?.selection.path === undefined ? {} : { path: hook.selection.path }),
  phase,
  reason: errorText(error),
});

const hookFailureDescription = (failure: HookEffectFailure): string =>
  `${failure.phase} hook ${failure.name}${
    failure.path === undefined ? '' : ` (${failure.path})`
  }: ${failure.reason}`;

const hookEffectSource = (
  name: string,
  path: string | undefined,
): HookEffectSource => ({ name, ...(path === undefined ? {} : { path }) });

const freezeData = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
};

/** Structural turn ranges retain canonical message references without copying their bodies. */
const hookTranscriptTurns = (
  messages: readonly Message[],
): readonly HookTranscriptTurn[] => {
  const indexed = causalTranscriptIndex(messages);
  return Object.freeze((indexed?.turns ?? []).map((turn) =>
    Object.freeze({
      turn: turn.turn,
      messages: Object.freeze(
        messages.slice(turn.start, turn.end).map((message) => freezeData(message)),
      ),
    })
  ));
};

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

const withTerminalOutcome = (
  draft: LoopOutcome,
  terminalOutcome: AfterTurnSettlement['terminalOutcome'],
  transcript: readonly Message[] = draft.transcript,
): LoopOutcome => {
  const draftWithoutError = { ...draft };
  // Data's optional error is authoritative too: an omitted value clears a draft error.
  delete draftWithoutError.error;
  return {
    ...draftWithoutError,
    ...terminalOutcome,
    transcript,
  };
};

const rejectedCommitOutcome = (
  task: string,
  outcome: LoopOutcome,
  terminalOutcome?: AfterTurnSettlement['terminalOutcome'],
): LoopOutcome =>
  withTerminalOutcome(
    { ...outcome, task },
    terminalOutcome ?? {
      ok: false,
      outcome: 'contract_failure',
      stopReason: 'contract_failure',
      error: 'Host did not acknowledge the commit proposal',
    },
  );

const isEffect = (event: AgentEvent): event is WorkerEffectObservation =>
  event.kind === 'tool_call' || event.kind === 'tool_result' ||
  event.kind === 'tool_progress';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One ephemeral Worker generation with local turn/context semantics and Host proposal ports. */
export class WorkerGeneration {
  private committedTranscript: readonly Message[] = [];
  private nextTurn = 1;
  private checkpoint: SemanticContextCheckpointV1 | undefined;
  private activeCancellation: TurnCancellationOwner | null = null;
  private activeSteering: SteeringOwner | null = null;
  private active = false;
  private rootModelSelection: ModelSelection;
  private privateStateFromTurn: number;
  private composition: WorkerAgentComposition;
  private hooks: readonly LoadedWorkerHook[];
  private startupSnapshotValue: {
    readonly instructionSource?: AgentInstructionSource;
    readonly skillNames: readonly string[];
    readonly context?: WorkerContextSnapshot;
  };
  private configurationValue: WorkerConfigurationSnapshot | undefined;
  private readonly runtimeIdentity: HookRuntimeIdentity | undefined;
  private readonly startupContextContributions: InstructionComponent[] = [];
  private started = false;
  private stopped = false;
  private stopFailures: readonly WorkerHookFailure[] = Object.freeze([]);
  private stopResult: RuntimeStopHookResult | undefined;
  private lastSettlement: {
    readonly executionId: string;
    readonly correlation: WorkerCorrelation;
    readonly turn: number;
    readonly settlement: AfterTurnSettlement;
    readonly providerRequestOrdinal: number;
  } | undefined;
  private postSettlementProviderEvidence: {
    readonly executionId: string;
    readonly recorder: ProviderEvidenceRecorder;
    readonly observations: ProviderEvidenceObservation[];
  } | undefined;

  constructor(
    composition: WorkerAgentComposition,
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
      registrationId?: string | null,
    ) => Promise<CredentialAvailabilityStatus> = () => Promise.resolve('unknown'),
    startupSnapshot: {
      readonly instructionSource?: AgentInstructionSource;
      readonly skillNames: readonly string[];
      readonly context?: WorkerContextSnapshot;
    } = { skillNames: [] },
    private readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void,
    initialPrivateStateFromTurn = 1,
    configuration?: WorkerConfigurationSnapshot,
    hooks: readonly LoadedWorkerHook[] = [],
    runtimeIdentity?: HookRuntimeIdentity,
    private readonly hookProviderEvidenceScope: HookProviderEvidenceScope = {},
  ) {
    this.composition = composition;
    this.hooks = hooks;
    this.startupSnapshotValue = startupSnapshot;
    this.configurationValue = configuration;
    this.runtimeIdentity = runtimeIdentity;
    this.committedTranscript = snapshotMessages(initialTranscript);
    this.nextTurn = initialNextTurn;
    this.checkpoint = initialCheckpoint === undefined
      ? undefined
      : structuredClone(initialCheckpoint);
    this.rootModelSelection = structuredClone(initialModelSelection);
    this.privateStateFromTurn = initialPrivateStateFromTurn;
  }

  get startupSnapshot(): {
    readonly instructionSource?: AgentInstructionSource;
    readonly skillNames: readonly string[];
    readonly context?: WorkerContextSnapshot;
  } {
    return this.startupSnapshotValue;
  }

  get configuration(): WorkerConfigurationSnapshot | undefined {
    return this.configurationValue;
  }

  get runtimeStopResult(): RuntimeStopHookResult | undefined {
    return this.stopResult;
  }

  private postSettlementEvidenceForCurrentExecution(): {
    readonly recorder: ProviderEvidenceRecorder;
    readonly observations: ProviderEvidenceObservation[];
  } | undefined {
    const settlement = this.lastSettlement;
    if (settlement === undefined) return undefined;
    if (this.postSettlementProviderEvidence?.executionId !== settlement.executionId) {
      const observations: ProviderEvidenceObservation[] = [];
      const recorder = new ProviderEvidenceRecorder(
        crypto.randomUUID().toLowerCase(),
        settlement.turn,
        new Date().toISOString(),
        (observation) => {
          observations.push(observation);
          return undefined;
        },
        false,
        settlement.providerRequestOrdinal,
      );
      this.postSettlementProviderEvidence = {
        executionId: settlement.executionId,
        recorder,
        observations,
      };
    }
    return this.postSettlementProviderEvidence;
  }

  /** Apply startup hooks once, before this generation can report ready. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const accepted: LoadedWorkerHook[] = [];
    const startupRejections: ConfigurationRejection[] = [];
    let turns: readonly HookTranscriptTurn[] | undefined;
    for (const hook of this.hooks) {
      try {
        await runHookPhase(
          [hook],
          'runtime_start',
          () => {
            turns ??= hookTranscriptTurns(this.committedTranscript);
            return {
              runtime: this.requireRuntimeIdentity(),
              context: this.hookContext(turns),
            };
          },
          ({ name, path, result }) => this.applyStartupContext(name, path, result),
        );
        accepted.push(hook);
      } catch (error) {
        const reason = `runtime_start: ${errorText(error)}`;
        const rejection = configurationRejection(
          'hook',
          hook.selection.name,
          new Error(reason),
          hook.selection.path,
        );
        startupRejections.push(
          Object.freeze({ ...rejection, field: 'runtime_start' }),
        );
      }
    }
    this.hooks = Object.freeze(accepted);
    this.configurationValue = this.configurationValue === undefined ? undefined : Object.freeze({
      ...this.configurationValue,
      systemInstruction: this.composition.systemInstruction ?? '',
      instructionComponents: structuredClone(
        this.composition.instructionComponents ?? [],
      ),
      hooks: Object.freeze(
        this.configurationValue.hooks.filter(({ name }) =>
          accepted.some((hook) => hook.selection.name === name)
        ),
      ),
      rejections: Object.freeze([
        ...this.configurationValue.rejections,
        ...startupRejections,
      ]),
    });
  }

  /** Run all registered stop handlers, retaining each failure while continuing cleanup. */
  async stop(reason: string): Promise<readonly WorkerHookFailure[]> {
    if (this.stopped) return this.stopFailures;
    this.stopped = true;
    const failures: WorkerHookFailure[] = [];
    const contributions: RuntimeStopHookEffect['contributions'][number][] = [];
    const settlement = this.lastSettlement?.settlement;
    const settledEvidence = this.postSettlementEvidenceForCurrentExecution();
    const executionlessObservations: ProviderEvidenceObservation[] = [];
    const providerEvidence = settledEvidence?.recorder ?? new ProviderEvidenceRecorder(
      crypto.randomUUID().toLowerCase(),
      this.lastSettlement?.turn ?? this.nextTurn - 1,
      new Date().toISOString(),
      (observation) => {
        executionlessObservations.push(observation);
        return undefined;
      },
      false,
    );
    const providerObservations = settledEvidence?.observations ?? executionlessObservations;
    const priorEvidence = this.hookProviderEvidenceScope.current;
    const currentEvidence = {
      recorder: providerEvidence,
      ...(this.reportAuxiliaryStage === undefined ? {} : {
        reportAuxiliaryStage: this.reportAuxiliaryStage,
      }),
    };
    this.hookProviderEvidenceScope.current = currentEvidence;
    let context: HookContextSnapshot | undefined;
    for (const hook of this.hooks.filter((entry) => entry.handlers.runtime_stop !== undefined)) {
      try {
        await runHookPhase(
          [hook],
          'runtime_stop',
          () => ({
            runtime: this.requireRuntimeIdentity(),
            reason,
            context: context ??= this.hookContext(),
          }),
          () => {},
        );
        contributions.push(Object.freeze({
          name: hook.selection.name,
          ...(hook.selection.path === undefined ? {} : { path: hook.selection.path }),
          outcome: 'completed',
        }));
      } catch (error) {
        const reason = errorText(error);
        contributions.push(Object.freeze({
          name: hook.selection.name,
          ...(hook.selection.path === undefined ? {} : { path: hook.selection.path }),
          outcome: 'failed',
          reason,
        }));
        failures.push(Object.freeze({
          name: hook.selection.name,
          ...(hook.selection.path === undefined ? {} : { path: hook.selection.path }),
          phase: 'runtime_stop',
          reason,
        }));
      }
    }
    this.hookProviderEvidenceScope.current = priorEvidence;
    const effect: RuntimeStopHookEffect = freezeData({
      phase: 'runtime_stop',
      ...(settlement === undefined ? {} : { settlement }),
      contributions,
    });
    this.stopResult = Object.freeze({
      effect,
      providerObservations: Object.freeze(providerObservations),
    });
    if (
      contributions.length > 0 && this.lastSettlement !== undefined &&
      this.port.postSettlementHook !== undefined
    ) {
      try {
        const saved = await this.port.postSettlementHook({
          executionId: this.lastSettlement.executionId,
          correlation: this.lastSettlement.correlation,
          turn: this.lastSettlement.turn,
          settlement: this.lastSettlement.settlement,
          effect,
          providerObservations,
        });
        if (!saved) throw new Error('Data owner did not acknowledge runtime_stop effects');
      } catch (error) {
        failures.push(Object.freeze({
          name: 'worker-runtime',
          phase: 'runtime_stop',
          reason: `runtime_stop effect persistence failed: ${errorText(error)}`,
        }));
      }
    }
    this.stopFailures = Object.freeze(failures);
    return this.stopFailures;
  }

  private requireRuntimeIdentity(): HookRuntimeIdentity {
    if (this.runtimeIdentity === undefined) {
      throw new Error('Worker hook runtime identity is unavailable');
    }
    return this.runtimeIdentity;
  }

  private applyStartupContext(
    hookName: string,
    hookPath: string | undefined,
    result: import('../hook_api.ts').ContextAddition | void,
  ): void {
    if (result === undefined) return;
    if (
      typeof result !== 'object' || result === null ||
      !Array.isArray(result.context) ||
      !result.context.every((part) => typeof part === 'string')
    ) {
      throw new Error('runtime_start must return a context string array');
    }
    const text = result.context.join('\n');
    if (text.trim().length === 0) return;
    const sourceLocator = JSON.stringify({
      hook: hookName,
      ...(hookPath === undefined ? {} : { path: hookPath }),
    });
    const component = Object.freeze({
      ...defineInstructionComponent(
        `instruction:runtime-start-hook-${this.startupContextContributions.length + 1}`,
        text,
      ),
      sourceLocator,
    });
    this.startupContextContributions.push(component);
    this.rebuildStartupInstruction();
  }

  private rebuildStartupInstruction(): void {
    if (this.startupContextContributions.length === 0) return;
    const contributionIds = new Set(
      this.startupContextContributions.map((component) => component.identity),
    );
    const priorComponents = (this.composition.instructionComponents ?? [])
      .filter((entry) => !contributionIds.has(entry.identity));
    const instructionComponents = Object.freeze([
      ...priorComponents,
      ...this.startupContextContributions,
    ]);
    const systemInstruction = instructionComponents.map((entry) => entry.text)
      .join('\n\n');
    const instructionResources = [
      ...new Set([
        ...this.composition.resolved.capabilities.instructions,
        ...this.startupContextContributions.map((component) => component.identity),
      ]),
    ].sort(compareAgentResourceIdentities);
    const resources = [
      ...new Set([
        ...this.composition.resolved.resourceSelection.resources.map(String),
        ...this.startupContextContributions.map((component) => String(component.identity)),
      ]),
    ].map((identity) => createAgentResourceIdentity(identity))
      .sort(compareAgentResourceIdentities);
    const manifestResources = [
      ...new Set([
        ...this.composition.manifest.resources,
        ...this.startupContextContributions.map((component) => String(component.identity)),
      ]),
    ].sort();
    const resolved = Object.freeze({
      ...this.composition.resolved,
      systemInstruction,
      capabilities: Object.freeze({
        ...this.composition.resolved.capabilities,
        instructions: Object.freeze(instructionResources),
      }),
      resourceSelection: createAgentResourceSelection(
        resources.map(String),
        this.composition.maxSteps,
      ),
    });
    this.composition = Object.freeze({
      ...this.composition,
      systemInstruction,
      instructionComponents,
      manifest: Object.freeze({
        ...this.composition.manifest,
        resources: Object.freeze(manifestResources),
      }),
      resolved,
    });
    const startupContext = this.startupSnapshotValue.context;
    if (startupContext !== undefined) {
      this.startupSnapshotValue = Object.freeze({
        ...this.startupSnapshotValue,
        context: Object.freeze({
          ...startupContext,
          instructionComponents: structuredClone(instructionComponents),
          systemInstruction,
        }),
      });
    }
  }

  private hookContext(
    turns: readonly HookTranscriptTurn[] = hookTranscriptTurns(
      this.committedTranscript,
    ),
    systemInstruction = this.composition.systemInstruction ?? '',
    currentInstructionComponents = this.composition.instructionComponents ?? [],
    checkpointValue = this.checkpoint,
  ): HookContextSnapshot {
    const checkpoint = checkpointValue === undefined ? undefined : Object.freeze({
      summary: checkpointValue.summary,
      coveredThroughTurn: checkpointValue.coveredThroughTurn,
      retainedFromTurn: checkpointValue.coveredThroughTurn + 1,
    });
    const instructionComponents = freezeData(
      structuredClone(currentInstructionComponents),
    );
    const tools = freezeData(
      structuredClone(this.composition.registry.definitions()),
    );
    const transcript = Object.freeze({ turns });
    return Object.freeze({
      systemInstruction,
      instructionComponents,
      tools,
      transcript,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      projectedContext: Object.freeze({
        ...(checkpoint === undefined ? {} : { checkpoint }),
        retainedTurns: Object.freeze(
          checkpoint === undefined
            ? [...turns]
            : turns.filter((turn) => turn.turn >= checkpoint.retainedFromTurn),
        ),
      }),
    });
  }

  close(): Promise<void> {
    return this.composition.registry.close();
  }

  get manifest(): Omit<WorkerAgentComposition['manifest'], 'tools'> {
    const rootModel = structuredClone(this.rootModelSelection);
    const profileId = modelRouteProfileId(rootModel);
    const resources = this.composition.manifest.resources.map((resource) =>
      resource.startsWith('model:') ? `model:${rootModel.provider}:${profileId}` : resource
    ).sort();
    return Object.freeze({
      role: this.composition.manifest.role,
      maxSteps: this.composition.manifest.maxSteps,
      profileId,
      resources: Object.freeze(resources),
      rootModel: Object.freeze(rootModel),
      ...(this.composition.manifest.baseInstruction === undefined ? {} : {
        baseInstruction: structuredClone(
          this.composition.manifest.baseInstruction,
        ),
      }),
    });
  }

  selectRootModel(
    selection: ModelSelection,
    privateStateFromTurn = 1,
  ): boolean {
    if (this.active) return false;
    this.replaceRootModel(selection);
    this.rootModelSelection = structuredClone(selection);
    this.privateStateFromTurn = privateStateFromTurn;
    return true;
  }

  async rootCredentialAvailability(): Promise<CredentialAvailability> {
    const authProfile = this.rootModelSelection.authProfile;
    return Object.freeze({
      authProfile,
      status: await this.inspectCredentialAvailability(
        authProfile,
        'registrationId' in this.rootModelSelection
          ? this.rootModelSelection.registrationId
          : undefined,
      ),
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

  async runTurn(
    correlation: WorkerCorrelation,
    task: string,
    recalledContext?: RecalledExecutionContext,
    chatgptRegistrationId?: string | null,
    generationBasis?: AgentGenerationContextBasis,
    cancelledDuringPreparation = false,
    executionId?: string,
  ): Promise<void> {
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
    if (generationBasis !== undefined) {
      this.committedTranscript = snapshotMessages(
        generationBasis.initialTranscript,
      );
      this.nextTurn = generationBasis.nextTurn;
      this.checkpoint = generationBasis.checkpoint === undefined
        ? undefined
        : structuredClone(generationBasis.checkpoint);
      if (
        !sameModelSelection(
          this.rootModelSelection,
          generationBasis.modelSelection,
        )
      ) {
        this.replaceRootModel(generationBasis.modelSelection);
      }
      this.rootModelSelection = structuredClone(generationBasis.modelSelection);
      this.privateStateFromTurn = generationBasis.privateStateFromTurn;
      recalledContext = generationBasis.recalledContext;
    }
    this.active = true;
    if (
      this.rootModelSelection.provider === 'openai-chatgpt' &&
      chatgptRegistrationId !== undefined
    ) {
      const boundSelection: ModelSelection = {
        ...(this.rootModelSelection as ChatGPTModelSelection),
        registrationId: chatgptRegistrationId,
      };
      if (!sameModelSelection(this.rootModelSelection, boundSelection)) {
        this.replaceRootModel(boundSelection);
        this.rootModelSelection = structuredClone(boundSelection);
      }
    }
    const cancellation = new TurnCancellationOwner();
    const steering = new SteeringOwner();
    const turn = this.nextTurn;
    const baseSystemInstruction = this.composition.systemInstruction;
    let turnInstructionComponents = [
      ...(this.composition.instructionComponents ?? []),
    ];
    if (
      turnInstructionComponents.length === 0 &&
      baseSystemInstruction !== undefined && baseSystemInstruction.trim() !== ''
    ) {
      turnInstructionComponents = [Object.freeze({
        identity: createAgentResourceIdentity('instruction:worker-composition'),
        text: baseSystemInstruction,
        sourceLocator: 'worker-composition',
      })];
    }
    let turnSystemInstruction = baseSystemInstruction;
    let turnHookTurns: readonly HookTranscriptTurn[] | undefined;
    const currentTurnHookContext = (): HookContextSnapshot => {
      turnHookTurns ??= hookTranscriptTurns(this.committedTranscript);
      return this.hookContext(
        turnHookTurns,
        turnSystemInstruction ?? '',
        turnInstructionComponents,
      );
    };
    const turnRuntime = (
      signal: AbortSignal,
    ): import('../hook_api.ts').HookTurnRuntime => {
      if (executionId === undefined) {
        throw new Error('Worker hook execution identity is unavailable');
      }
      return {
        ...this.requireRuntimeIdentity(),
        executionId,
        turnNumber: turn,
        signal,
      };
    };
    let requestCountAtAdmission = this.requestCounter.count();
    let userTurnAdmitted = false;
    const turnProviderRequestCount = () =>
      userTurnAdmitted ? Math.max(0, this.requestCounter.count() - requestCountAtAdmission) : 0;
    const diagnosticOwner = new FailureDiagnosticOwner(turn);
    const runtimeSequences = new Map<string, number>();
    const effectSequences = new Map<string, number>();
    const providerSequences = new Map<string, number>();
    let runtimeAssistantOrdinal = 0;
    let runtimeSteeringOrdinal = 0;
    const providerSequenceKey = (
      event: import('../provider/provider_evidence.ts').ProviderEvidenceRuntimeEvent,
    ): string | undefined => {
      if (event.kind === 'turn_outcome') return undefined;
      const lane = event.lane === 'planner' ? 'planner' : 'parent';
      if (event.kind === 'model_result') {
        return `model-result:${lane}:${event.modelStep}`;
      }
      if (event.kind === 'tool_call') {
        return `tool-call:${lane}:${event.call.callId}`;
      }
      if (event.kind === 'tool_result') {
        return `tool-result:${lane}:${event.result.callId}`;
      }
      return undefined;
    };
    const evidence = new ProviderEvidenceRecorder(
      crypto.randomUUID().toLowerCase(),
      turn,
      new Date().toISOString(),
      (observation) => {
        const sequence = this.port.providerObservation?.(
          correlation,
          observation,
          turn,
        );
        if (
          sequence !== undefined && observation.kind === 'runtime_event'
        ) {
          const key = providerSequenceKey(observation.event);
          if (key !== undefined) providerSequences.set(key, sequence);
        }
        return sequence;
      },
      false,
    );
    const previousHookProviderEvidence = this.hookProviderEvidenceScope.current;
    const activeHookProviderEvidence = {
      recorder: evidence,
      ...(this.reportAuxiliaryStage === undefined ? {} : {
        reportAuxiliaryStage: this.reportAuxiliaryStage,
      }),
    };
    this.hookProviderEvidenceScope.current = activeHookProviderEvidence;
    this.activeCancellation = cancellation;
    this.activeSteering = steering;
    if (cancelledDuringPreparation) cancellation.request();
    const contextObservations: Promise<void>[] = [];
    const contextRequests: ContextModelRequestDelta[] = [];
    const sentContextBlobs = new Set<string>();
    const occurrenceCounters = new Map<'parent' | 'planner', number>();
    const revisionStates = new Map<'parent' | 'planner', {
      readonly revisionDigest: string;
      readonly itemCount: number;
      readonly systemCount: number;
      readonly transcriptCount: number;
      readonly toolCount: number;
    }>();
    const committedHistoryIndex = indexSessionHistory(this.committedTranscript);
    let skipTurnSettled = false;
    let contextObservationFailed = false;
    let contextRequestOrdinal = 0;
    // Skill selection is a causal fact of the call occurrence.  The tool name is always
    // `skill`; using it as the selected identity would make duplicate catalog entries
    // indistinguishable.  Lane is part of the key because parent and planner calls share IDs
    // only by convention, not by protocol guarantee.
    const skillCalls = new Map<string, string>();
    const toolCallAttributions = new Map<string, {
      readonly modelStep?: number;
      readonly requestOrdinal?: number;
    }>();
    const externalToolRelations = new Map<string, ContextSourceRelation>();
    const toolResultTexts = new Map<string, string>();
    const callKey = (lane: 'parent' | 'planner', callId: string): string => `${lane}:${callId}`;
    const relationKey = (relation: ContextSourceRelation): string =>
      `${relation.stage}:${relation.resourceKind}:${relation.lane ?? ''}:${relation.callId ?? ''}:${
        relation.logicalIdentity ?? ''
      }`;
    let assistantSourceOrdinal = 0;
    let steeringSourceOrdinal = 0;
    const withWorkerSequence = (
      source: ContextOccurrenceSource,
      sequence: number | undefined,
    ): ContextOccurrenceSource =>
      sequence === undefined ? source : { ...source, sourceWorkerSequence: sequence };
    const sourceForMessage = (
      message: Message,
      kind: RequestMessageSourceKind,
      messageIndex: number,
      modelStep?: number,
    ): readonly ContextOccurrenceSource[] => {
      const lane = 'parent' as const;
      if (kind === 'committed') {
        const canonicalTurn = committedHistoryIndex?.turns.find((candidate) =>
          messageIndex >= candidate.start && messageIndex < candidate.end
        );
        const messagePosition = canonicalTurn === undefined
          ? messageIndex + 1
          : messageIndex - canonicalTurn.start + 1;
        return [{
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `canonical:${correlation.session}:revision:${correlation.baseStateRevision}:turn:${
              canonicalTurn?.turn ?? 'unknown'
            }:message:${messagePosition}`,
          lane,
        }];
      }
      if (kind === 'task') {
        const sequence = runtimeSequences.get('user-message');
        return [withWorkerSequence({
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity: `current-task:${correlation.session}:turn:${turn}`,
          lane,
        }, sequence)];
      }
      if (kind === 'steering') {
        steeringSourceOrdinal += 1;
        return [withWorkerSequence({
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `steering:${correlation.session}:turn:${turn}:message:${steeringSourceOrdinal}`,
          lane,
        }, runtimeSequences.get(`steering:${steeringSourceOrdinal}`))];
      }
      if (kind === 'assistant') {
        assistantSourceOrdinal += 1;
        if (!Array.isArray(message.content) || message.content.length === 0) {
          return [withWorkerSequence(
            {
              stage: 'projected',
              resourceKind: 'message',
              logicalIdentity:
                `current-execution:${correlation.session}:turn:${turn}:assistant:event:${assistantSourceOrdinal}`,
              lane,
              ...(modelStep === undefined ? {} : { modelStep }),
            },
            modelStep === undefined
              ? runtimeSequences.get(`assistant:${assistantSourceOrdinal}`)
              : providerSequences.get(`model-result:${lane}:${modelStep}`) ??
                runtimeSequences.get(`assistant:${assistantSourceOrdinal}`),
          )];
        }
        const assistantEvent: ContextOccurrenceSource = withWorkerSequence(
          {
            stage: 'projected',
            resourceKind: 'message',
            logicalIdentity:
              `current-execution:${correlation.session}:turn:${turn}:assistant:event:${assistantSourceOrdinal}`,
            lane,
            ...(modelStep === undefined ? {} : { modelStep }),
          },
          modelStep === undefined
            ? runtimeSequences.get(`assistant:${assistantSourceOrdinal}`)
            : providerSequences.get(`model-result:${lane}:${modelStep}`) ??
              runtimeSequences.get(`assistant:${assistantSourceOrdinal}`),
        );
        return [
          assistantEvent,
          ...message.content.map((call) => {
            toolCallAttributions.set(callKey(lane, call.callId), {
              ...(modelStep === undefined ? {} : { modelStep }),
              ...(contextRequestOrdinal === 0 ? {} : {
                requestOrdinal: contextRequestOrdinal,
              }),
            });
            if (
              call.name === 'skill' &&
              typeof call.arguments === 'object' && call.arguments !== null &&
              !Array.isArray(call.arguments) &&
              Object.keys(call.arguments).length === 1 &&
              typeof (call.arguments as { readonly name?: unknown }).name ===
                'string' &&
              (call.arguments as { readonly name: string }).name.length > 0
            ) {
              skillCalls.set(callKey(lane, call.callId), call.arguments.name);
            }
            return withWorkerSequence(
              {
                stage: 'projected' as const,
                resourceKind: 'message' as const,
                logicalIdentity:
                  `current-execution:${correlation.session}:turn:${turn}:call:${call.callId}`,
                callId: call.callId,
                lane,
                ...(modelStep === undefined ? {} : { modelStep }),
              },
              modelStep === undefined
                ? runtimeSequences.get(`assistant:${assistantSourceOrdinal}`)
                : providerSequences.get(`model-result:${lane}:${modelStep}`) ??
                  runtimeSequences.get(`assistant:${assistantSourceOrdinal}`),
            );
          }),
        ];
      }
      const results = message.role === 'tool' ? message.content : [];
      if (results.length === 0) return [];
      return results.flatMap((result) => {
        const resultKey = callKey(lane, result.callId);
        const toolCallAttribution = toolCallAttributions.get(resultKey);
        const sourceModelStep = toolCallAttribution?.modelStep ?? modelStep;
        const sourceRequestOrdinal = toolCallAttribution?.requestOrdinal;
        const requestedSkillName = skillCalls.get(resultKey);
        const skillCandidates = result.name === 'skill' && result.outcome === 'success' &&
            requestedSkillName !== undefined
          ? (this.startupSnapshot.context?.skillCatalog.skills ?? []).filter((
            candidate,
          ) =>
            candidate.name === requestedSkillName &&
            candidate.toolResult === result.text
          )
          : [];
        const skill = skillCandidates.length === 1 ? skillCandidates[0] : undefined;
        const sourceSequence = providerSequences.get(`tool-result:${lane}:${result.callId}`) ??
          effectSequences.get(`tool-result:${result.callId}`);
        const base: ContextOccurrenceSource = withWorkerSequence({
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `current-execution:${correlation.session}:turn:${turn}:call:${result.callId}`,
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
        }, sourceSequence);
        const observed: ContextSourceRelation = {
          stage: 'observed',
          resourceKind: 'tool_result',
          logicalIdentity: `tool-result:${correlation.session}:turn:${turn}:call:${result.callId}`,
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
          ...(sourceRequestOrdinal === undefined ? {} : { requestOrdinal: sourceRequestOrdinal }),
        };
        const projected: ContextOccurrenceSource = withWorkerSequence({
          stage: 'projected',
          resourceKind: skill === undefined ? 'tool_result' : 'skill',
          logicalIdentity: skill === undefined
            ? `tool-result:${correlation.session}:turn:${turn}:call:${result.callId}`
            : `skill:${skill.name}`,
          ...(skill === undefined ? {} : { sourceLocator: skill.sourceDirectory }),
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
        }, sourceSequence);
        const loaded: ContextSourceRelation | undefined = skill === undefined ? undefined : {
          stage: 'loaded',
          resourceKind: 'skill',
          logicalIdentity: `skill:${skill.name}`,
          sourceLocator: skill.sourceDirectory,
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
          ...(sourceRequestOrdinal === undefined ? {} : { requestOrdinal: sourceRequestOrdinal }),
        };
        const relations: ContextOccurrenceSource[] = [base, projected];
        toolResultTexts.set(callKey(lane, result.callId), result.text);
        if (!externalToolRelations.has(relationKey(observed))) {
          externalToolRelations.set(relationKey(observed), observed);
        }
        if (
          loaded !== undefined &&
          !externalToolRelations.has(relationKey(loaded))
        ) {
          externalToolRelations.set(relationKey(loaded), loaded);
        }
        return relations;
      });
    };
    const nextOccurrenceId = (
      lane: 'parent' | 'planner',
      kind: ContextOccurrenceInput['kind'],
    ): string => {
      const next = (occurrenceCounters.get(lane) ?? 0) + 1;
      occurrenceCounters.set(lane, next);
      return `${lane}:${kind}:${next}`;
    };
    const occurrenceFor = async (
      lane: 'parent' | 'planner',
      kind: ContextOccurrenceInput['kind'],
      blob: Awaited<ReturnType<typeof textBlob>>,
      sourceRelations: readonly ContextOccurrenceSource[],
    ): Promise<ContextOccurrenceInput> => {
      const occurrenceId = nextOccurrenceId(lane, kind);
      const content = {
        digest: blob.digest,
        byteLength: blob.byteLength,
        mediaType: blob.mediaType,
      };
      const body = { occurrenceId, kind, content, sourceRelations };
      const occurrenceDigest = await contextOccurrenceDigest(body);
      const includeBytes = !sentContextBlobs.has(blob.digest);
      sentContextBlobs.add(blob.digest);
      return {
        ...body,
        occurrenceDigest,
        ...(includeBytes ? { bytesBase64: blob.bytes.toBase64() } : {}),
      };
    };
    const observeModelRequest = async (
      observation: ModelRequestObservation,
    ): Promise<number> => {
      if (
        observation.sourceAttribution === undefined ||
        observation.sourceAttribution.transcript.length !==
          observation.request.transcript.length
      ) {
        contextObservationFailed = true;
        throw new Error(
          'model request source sidecar does not match transcript',
        );
      }
      const requestOrdinal = ++contextRequestOrdinal;
      const task = (async (): Promise<void> => {
        const lane = 'parent' as const;
        const previous = revisionStates.get(lane);
        if (
          observation.previousTranscriptLength !==
            (previous?.transcriptCount ?? 0) ||
          observation.request.transcript.length <
            observation.previousTranscriptLength
        ) {
          throw new Error('model request transcript delta is not append-only');
        }
        const hydrateSource = async (
          source: ContextOccurrenceSource,
          itemDigest: string,
          message?: Message,
        ): Promise<ContextOccurrenceSource> => {
          if (source.contentDigest !== undefined) return source;
          if (
            source.resourceKind === 'skill' &&
            source.logicalIdentity?.startsWith('skill:')
          ) {
            const name = source.logicalIdentity.slice('skill:'.length);
            const selected = this.startupSnapshot.context?.skillCatalog.skills.filter((
              skill,
            ) => skill.name === name) ?? [];
            if (selected.length === 1) {
              return {
                ...source,
                contentDigest: (await textBlob(selected[0].toolResult)).digest,
              };
            }
          }
          if (
            source.resourceKind === 'tool_result' && message?.role === 'tool'
          ) {
            const result = message.content.find((candidate) => candidate.callId === source.callId);
            if (result !== undefined) {
              return {
                ...source,
                contentDigest: (await textBlob(result.text)).digest,
              };
            }
          }
          // Projected message/context relations refer to the exact occurrence represented by
          // this item.  Keeping that digest explicit prevents a Host from reverse-resolving the
          // source by identical bytes.
          return { ...source, contentDigest: itemDigest };
        };
        const occurrences: ContextOccurrenceInput[] = [];
        let systemCount = previous?.systemCount ?? 0;
        let toolCount = previous?.toolCount ?? 0;
        if (
          previous === undefined &&
          observation.request.systemInstruction !== undefined
        ) {
          const blob = await textBlob(observation.request.systemInstruction);
          const namedInstructionComponents = turnInstructionComponents;
          const hasNamedInstructionComponents = namedInstructionComponents.length > 0;
          let componentByteOffset = 0;
          const componentRelations: ContextOccurrenceSource[] = [];
          for (
            const [index, component] of namedInstructionComponents.entries()
          ) {
            const componentBlob = await textBlob(component.text);
            const byteStart = componentByteOffset;
            const byteEnd = byteStart + componentBlob.byteLength;
            componentRelations.push({
              stage: 'projected',
              resourceKind: 'instruction_component',
              logicalIdentity: String(component.identity),
              sourceLocator: `${
                component.sourceLocator ?? 'worker-composition'
              }#bytes=${byteStart}-${byteEnd}`,
              lane,
              modelStep: observation.modelStep,
              contentDigest: componentBlob.digest,
            });
            componentByteOffset = byteEnd +
              (index + 1 < namedInstructionComponents.length ? 2 : 0);
          }
          occurrences.push(
            await occurrenceFor(
              lane,
              'system',
              blob,
              hasNamedInstructionComponents ? componentRelations : [{
                stage: 'projected',
                resourceKind: 'definition_output',
                logicalIdentity: `definition-output:${correlation.session}`,
                lane,
                modelStep: observation.modelStep,
                contentDigest: blob.digest,
              }],
            ),
          );
          systemCount = 1;
        }
        const newMessages = observation.request.transcript.slice(
          observation.previousTranscriptLength,
        );
        for (const [offset, message] of newMessages.entries()) {
          const messageIndex = observation.previousTranscriptLength + offset;
          const blob = await jsonBlob(
            message as unknown as import('../core/contracts.ts').JsonValue,
            'application/vnd.henji.message+json',
          );
          const sourceRelations = await Promise.all(
            (observation.sourceAttribution?.transcript[messageIndex] ?? []).map(
              (source) =>
                hydrateSource(
                  source,
                  blob.digest,
                  message,
                ),
            ),
          );
          occurrences.push(
            await occurrenceFor(lane, 'message', blob, sourceRelations),
          );
        }
        if (previous === undefined) {
          for (const tool of observation.request.tools) {
            const blob = await jsonBlob(
              tool as unknown as import('../core/contracts.ts').JsonValue,
              'application/vnd.henji.tool+json',
            );
            const manifestToolIdentity = this.composition.manifest.resources
              .filter((resource) => resource === `tool:${tool.name}`);
            occurrences.push(
              await occurrenceFor(
                lane,
                'tool_contract',
                blob,
                manifestToolIdentity.length === 1
                  ? [{
                    stage: 'projected',
                    resourceKind: 'tool_contract',
                    logicalIdentity: `tool-contract:${manifestToolIdentity[0]}`,
                    lane,
                    modelStep: observation.modelStep,
                    contentDigest: blob.digest,
                  }]
                  : [],
              ),
            );
          }
        }
        if (previous === undefined) {
          toolCount = observation.request.tools.length;
        }
        if (
          previous !== undefined &&
          (systemCount !==
              (observation.request.systemInstruction === undefined ? 0 : 1) ||
            toolCount !== observation.request.tools.length)
        ) {
          throw new Error(
            'model request fixed context changed inside one execution lane',
          );
        }
        const insertions = occurrences.map((occurrence) => ({
          occurrenceId: occurrence.occurrenceId,
          occurrenceDigest: occurrence.occurrenceDigest,
        }));
        const splice = previous === undefined ? { start: 0, deleteCount: 0, insertions } : {
          start: previous.systemCount + previous.transcriptCount,
          deleteCount: 0,
          insertions,
        };
        const resultItemCount = (previous?.itemCount ?? 0) + insertions.length;
        const digestInput: Pick<
          ContextModelRequestDelta,
          | 'lane'
          | 'purpose'
          | 'baseRevisionDigest'
          | 'resultItemCount'
          | 'splices'
        > = {
          lane,
          purpose: 'user_turn' as const,
          ...(previous === undefined ? {} : { baseRevisionDigest: previous.revisionDigest }),
          resultItemCount,
          splices: [splice],
        };
        const revisionDigest = await contextRevisionDigest(digestInput);
        const requestDelta: ContextModelRequestDelta = {
          schemaVersion: 2,
          requestOrdinal,
          modelStep: observation.modelStep,
          ...(observation.modelSelection === undefined ? {} : {
            modelSelection: structuredClone(observation.modelSelection),
          }),
          ...digestInput,
          revisionDigest,
          occurrences,
        };
        revisionStates.set(lane, {
          revisionDigest,
          itemCount: resultItemCount,
          systemCount,
          transcriptCount: observation.request.transcript.length,
          toolCount,
        });
        contextRequests.push(requestDelta);
        await this.port.contextObservation?.(correlation, requestDelta);
        this.reportAuxiliaryStage?.('aux_context_await_resumed');
      })();
      contextObservations.push(task);
      try {
        await task;
      } catch (error) {
        contextObservationFailed = true;
        throw error;
      }
      return requestOrdinal;
    };
    const observeAuxiliaryRequest = async (
      observation: AuxiliaryRequestObservation,
    ): Promise<number> => {
      const requestOrdinal = ++contextRequestOrdinal;
      const task = (async (): Promise<void> => {
        const lane = 'parent' as const;
        const blob = await textBlob(observation.body, 'application/json');
        const sourceSequence = providerSequences.get(
          `tool-call:${lane}:${observation.callId}`,
        ) ?? effectSequences.get(`tool-call:${observation.callId}`);
        const occurrence = await occurrenceFor(
          lane,
          'provider_wire_body',
          blob,
          [withWorkerSequence({
            stage: 'projected',
            resourceKind: 'provider_wire_body',
            logicalIdentity: `tool-call:${observation.callId}`,
            callId: observation.callId,
            lane,
            modelStep: observation.modelStep,
            contentDigest: blob.digest,
          }, sourceSequence)],
        );
        const splices = [{
          start: 0,
          deleteCount: 0,
          insertions: [{
            occurrenceId: occurrence.occurrenceId,
            occurrenceDigest: occurrence.occurrenceDigest,
          }],
        }];
        const revisionDigest = await contextRevisionDigest({
          lane,
          purpose: observation.purpose,
          resultItemCount: 1,
          splices,
        });
        const requestDelta: ContextModelRequestDelta = {
          schemaVersion: 2,
          requestOrdinal,
          lane,
          purpose: observation.purpose,
          modelStep: observation.modelStep,
          ...(observation.modelSelection === undefined ? {} : {
            modelSelection: structuredClone(observation.modelSelection),
          }),
          sourceCallId: observation.callId,
          revisionDigest,
          resultItemCount: 1,
          splices,
          occurrences: [occurrence],
        };
        contextRequests.push(requestDelta);
        await this.port.contextObservation?.(correlation, requestDelta);
      })();
      contextObservations.push(task);
      try {
        await task;
      } catch (error) {
        contextObservationFailed = true;
        throw error;
      }
      return requestOrdinal;
    };
    // Keep messages and source sidecars aligned without mutating the borrowed request.
    // The loop snapshots the completed projection before observation and model generation.
    const projectParentRequestWithSources = (
      request: import('../core/contracts.ts').ModelRequest,
      sources: import('../core/execution_context.ts').ModelRequestSourceAttribution,
    ): {
      readonly request: import('../core/contracts.ts').ModelRequest;
      readonly sources: import('../core/execution_context.ts').ModelRequestSourceAttribution;
    } => {
      let projected = request;
      let projectedTranscriptSources = sources.transcript;
      let currentUserMessageIndex = this.committedTranscript.length;
      const privateStateCutoff = this.privateStateFromTurn === 1
        ? 0
        : this.privateStateFromTurn === this.nextTurn
        ? this.committedTranscript.length
        : committedHistoryIndex?.turns[this.privateStateFromTurn - 2]?.end;
      if (privateStateCutoff === undefined) {
        throw new Error('provider switch boundary is invalid');
      }
      if (privateStateCutoff > 0) {
        projected = {
          ...projected,
          transcript: projected.transcript.map((message, index) => {
            if (
              index >= privateStateCutoff || message.role !== 'assistant' ||
              message.providerState === undefined
            ) return message;
            const { providerState: _privateState, ...semanticMessage } = message;
            return semanticMessage;
          }),
        };
      }
      if (this.checkpoint !== undefined) {
        const coveredEnd = committedHistoryIndex
          ?.turns[this.checkpoint.coveredThroughTurn - 1]?.end;
        if (coveredEnd === undefined) {
          throw new Error('checkpoint boundary is invalid');
        }
        projected = projectSemanticContext(projected, this.checkpoint);
        projectedTranscriptSources = [
          [{
            stage: 'projected',
            resourceKind: 'message',
            logicalIdentity:
              `checkpoint:${this.checkpoint.sessionId}:turn:${this.checkpoint.coveredThroughTurn}`,
            sourceLocator: `session:${this.checkpoint.sessionId}`,
          }],
          ...sources.transcript.slice(coveredEnd),
        ];
        currentUserMessageIndex = 1 + this.committedTranscript.length -
          coveredEnd;
      }
      if (recalledContext !== undefined) {
        projected = projectRecalledExecutionContext(
          projected,
          recalledContext,
          currentUserMessageIndex,
        );
        projectedTranscriptSources = [
          ...projectedTranscriptSources.slice(0, currentUserMessageIndex),
          [{
            stage: 'projected',
            resourceKind: 'message',
            logicalIdentity:
              `recall:${recalledContext.sourceExecutionId}->${correlation.session}:turn:${turn}:message:${
                currentUserMessageIndex + 1
              }`,
            sourceLocator: `execution:${recalledContext.sourceExecutionId}`,
          }],
          ...projectedTranscriptSources.slice(currentUserMessageIndex),
        ];
      }
      return {
        request: projected,
        sources: { transcript: projectedTranscriptSources },
      };
    };
    const executionContext = new ParentTurnExecutionContext(
      turn,
      new TurnRequestBudget({
        parent: this.composition.maxSteps,
        aggregate: this.composition.maxSteps,
      }),
      cancellation.signal,
      cancellation,
      diagnosticOwner,
      turnProviderRequestCount,
      this.requestCounter.count,
      evidence,
      observeModelRequest,
      this.rootModelSelection,
      observeAuxiliaryRequest,
      this.reportAuxiliaryStage,
      sourceForMessage,
      projectParentRequestWithSources,
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
      ...(outcome.diagnostic === undefined &&
          diagnosticOwner.snapshot() === undefined
        ? {}
        : { diagnostic: outcome.diagnostic ?? diagnosticOwner.snapshot()! }),
    });
    const finalizeEvidence = (outcome: LoopOutcome): LoopOutcome => {
      const settled = settledOutcome(outcome);
      if (!evidenceFinalized) {
        evidence.recordOutcome(settled.stopReason);
        evidenceFinalized = true;
      }
      return settled;
    };
    const makeContextManifest = async (): Promise<
      | import('../history/context_attribution.ts').ExecutionContextManifestV2
      | undefined
    > => {
      await Promise.allSettled(contextObservations);
      if (contextObservationFailed) return undefined;
      try {
        const projected = new Set(
          contextRequests.flatMap((request) =>
            request.occurrences.flatMap((occurrence) =>
              occurrence.sourceRelations.map((relation) =>
                relationKey(relation as ContextSourceRelation)
              )
            )
          ),
        );
        const external: ContextSourceRelation[] = [];
        for (const relation of externalToolRelations.values()) {
          if (projected.has(relationKey(relation))) continue;
          const text = relation.callId === undefined ? undefined : toolResultTexts.get(
            callKey(relation.lane ?? 'parent', relation.callId),
          );
          external.push({
            ...relation,
            ...(text === undefined ? {} : { contentDigest: (await textBlob(text)).digest }),
          });
        }
        return await createExecutionContextManifest(contextRequests, external);
      } catch {
        return undefined;
      }
    };
    const failTurn = async (
      outcome: LoopOutcome,
    ): Promise<{ readonly outcome: LoopOutcome; readonly settlement?: AfterTurnSettlement }> => {
      const finalized = finalizeEvidence(outcome);
      const result = await this.port.turnFailed(
        correlation,
        finalized,
        await makeContextManifest(),
      );
      const settlement = typeof result === 'object' && result !== null ? result : undefined;
      if (executionId !== undefined && settlement?.durable === true) {
        this.lastSettlement = {
          executionId,
          correlation,
          turn,
          settlement,
          providerRequestOrdinal: evidence.lastRequestOrdinal,
        };
        this.postSettlementProviderEvidence = undefined;
      }
      return { outcome: finalized, ...(settlement === undefined ? {} : { settlement }) };
    };
    const persistAfterTurn = async (
      settlement: AfterTurnSettlement,
      outcome: LoopOutcome,
      canonicalOutcome: boolean,
    ): Promise<void> => {
      const afterTurnHooks = this.hooks.filter((hook) => hook.handlers.after_turn !== undefined);
      if (afterTurnHooks.length === 0) return;
      if (
        executionId === undefined || this.port.afterTurnContext === undefined
      ) throw new Error('after_turn Data settlement port is unavailable');

      // This one structural snapshot is shared by every handler and context projection.
      const canonicalTranscript = Object.freeze([...this.committedTranscript]);
      const committedTurns = hookTranscriptTurns(canonicalTranscript);
      const afterTurnOutcome = freezeData(
        withTerminalOutcome(
          outcome,
          settlement.terminalOutcome,
          canonicalOutcome ? canonicalTranscript : outcome.transcript,
        ),
      );
      let effectiveCheckpoint = this.checkpoint;
      const postSettlementEvidence = this.postSettlementEvidenceForCurrentExecution();
      if (postSettlementEvidence === undefined) {
        throw new Error('post-settlement provider evidence owner is unavailable');
      }
      const providerObservations = postSettlementEvidence.observations;
      const providerEvidence = postSettlementEvidence.recorder;
      for (const hook of afterTurnHooks) {
        let contribution: AfterTurnHookContribution = hookEffectSource(
          hook.selection.name,
          hook.selection.path,
        );
        let candidateCheckpoint: SemanticContextCheckpointV1 | undefined;
        try {
          const priorEvidence = this.hookProviderEvidenceScope.current;
          const currentEvidence = {
            recorder: providerEvidence,
            ...(this.reportAuxiliaryStage === undefined ? {} : {
              reportAuxiliaryStage: this.reportAuxiliaryStage,
            }),
          };
          this.hookProviderEvidenceScope.current = currentEvidence;
          try {
            await runHookPhase(
              [hook],
              'after_turn',
              (): AfterTurnInput => ({
                runtime: turnRuntime(cancellation.signal),
                outcome: afterTurnOutcome,
                settlement,
                context: this.hookContext(
                  committedTurns,
                  turnSystemInstruction ?? '',
                  turnInstructionComponents,
                  effectiveCheckpoint,
                ),
              }),
              ({ result }) => {
                if (result === undefined) return;
                if (
                  typeof result !== 'object' || result === null ||
                  typeof result.checkpoint !== 'object' ||
                  result.checkpoint === null ||
                  typeof result.checkpoint.summary !== 'string' ||
                  !Number.isSafeInteger(result.checkpoint.coveredThroughTurn)
                ) {
                  throw new Error(
                    'after_turn must return a checkpoint summary and coveredThroughTurn',
                  );
                }
                const candidate: SemanticContextCheckpointV1 = {
                  contextSchemaVersion: 1,
                  sessionId: this.sessionId,
                  createdAt: new Date().toISOString(),
                  sourceProfileId: modelRouteProfileId(this.rootModelSelection),
                  coveredThroughTurn: result.checkpoint.coveredThroughTurn,
                  retainedFromTurn: result.checkpoint.coveredThroughTurn + 1,
                  summary: result.checkpoint.summary,
                };
                if (
                  candidate.coveredThroughTurn >= turn ||
                  !validateSemanticContextCheckpoint(candidate)
                ) {
                  throw new Error(
                    'after_turn returned an invalid semantic context checkpoint',
                  );
                }
                contribution = {
                  ...contribution,
                  checkpoint: {
                    summary: candidate.summary,
                    coveredThroughTurn: candidate.coveredThroughTurn,
                  },
                };
                if (settlement.accepted) candidateCheckpoint = candidate;
              },
            );
          } finally {
            if (this.hookProviderEvidenceScope.current === currentEvidence) {
              this.hookProviderEvidenceScope.current = priorEvidence;
            }
          }
        } catch (error) {
          contribution = {
            ...hookEffectSource(hook.selection.name, hook.selection.path),
            failure: { reason: errorText(error) },
          };
        }
        const observations = providerObservations.splice(0);
        const effect: AfterTurnHookEffect = freezeData({
          settlement,
          contributions: [contribution],
          ...(candidateCheckpoint === undefined ? {} : { checkpoint: candidateCheckpoint }),
        });
        const persisted = await this.port.afterTurnContext({
          executionId,
          correlation,
          turn,
          effect,
          ...(observations.length === 0 ? {} : { providerObservations: observations }),
        });
        if (!persisted) {
          throw new Error('Data owner did not acknowledge the after_turn context update');
        }
        if (candidateCheckpoint !== undefined) {
          effectiveCheckpoint = candidateCheckpoint;
          this.checkpoint = candidateCheckpoint;
        }
      }
    };
    const afterSettlement = async (
      settlement: AfterTurnSettlement | undefined,
      outcome: LoopOutcome,
      canonicalOutcome: boolean,
    ): Promise<void> => {
      if (settlement?.durable !== true) return;
      try {
        await persistAfterTurn(settlement, outcome, canonicalOutcome);
      } catch (error) {
        if (this.port.settlementFailure !== undefined) {
          this.port.settlementFailure(correlation, error);
          skipTurnSettled = true;
        }
      }
    };
    const beforeTool = async (
      call: import('../core/contracts.ts').ToolCall,
      modelStep: number,
    ): Promise<{
      readonly arguments: JsonValue;
      readonly applied: boolean;
      readonly hookEffect?: ToolHookEffect;
      readonly failure?: HookEffectFailure;
    }> => {
      let effectiveArguments = structuredClone(call.arguments) as JsonValue;
      const argumentHooks: HookEffectSource[] = [];
      let applied = false;
      let activeHook: LoadedWorkerHook | undefined;
      let context: HookContextSnapshot | undefined;
      let failure: HookEffectFailure | undefined;
      try {
        await runHookPhase(
          this.hooks,
          'before_tool',
          (hook): BeforeToolInput => {
            activeHook = hook;
            return {
              runtime: {
                ...turnRuntime(cancellation.signal),
                modelStep,
                callId: call.callId,
              },
              toolName: call.name,
              arguments: freezeData(structuredClone(effectiveArguments)),
              context: context ??= currentTurnHookContext(),
            };
          },
          ({ name, path, result }) => {
            if (result === undefined) return;
            if (
              typeof result !== 'object' || result === null ||
              !isHookJsonValue(result.arguments)
            ) {
              throw new Error(
                'before_tool must return a JSON arguments update',
              );
            }
            effectiveArguments = structuredClone(result.arguments) as JsonValue;
            applied = true;
            argumentHooks.push(hookEffectSource(name, path));
          },
        );
      } catch (error) {
        failure = hookFailure(activeHook, 'before_tool', error);
      }
      const hookEffect: ToolHookEffect | undefined = applied || failure !== undefined
        ? {
          originalArguments: structuredClone(call.arguments),
          effectiveArguments: structuredClone(effectiveArguments),
          ...(argumentHooks.length === 0 ? {} : { argumentHooks }),
          ...(failure === undefined ? {} : { failure }),
        }
        : undefined;
      return {
        arguments: effectiveArguments,
        applied,
        ...(hookEffect === undefined ? {} : { hookEffect }),
        ...(failure === undefined ? {} : { failure }),
      };
    };
    const afterTool = async (
      call: import('../core/contracts.ts').ToolCall,
      argumentsValue: JsonValue,
      originalResult: import('../core/contracts.ts').ToolResultContent,
      terminal: import('../tools/tools.ts').RegistryDispatchResult['terminal'],
      modelStep: number,
    ): Promise<{
      readonly result: import('../core/contracts.ts').ToolResultContent;
      readonly hookEffect?: ToolHookEffect;
    }> => {
      let currentText = originalResult.text;
      const textHooks: HookEffectSource[] = [];
      let applied = false;
      let activeHook: LoadedWorkerHook | undefined;
      let context: HookContextSnapshot | undefined;
      let failure: HookEffectFailure | undefined;
      const currentHookResult = (): HookToolResult =>
        terminal !== null
          ? {
            outcome: 'terminal',
            text: currentText,
            finalText: terminal.finalText,
            terminalKind: terminal.kind,
          }
          : originalResult.outcome === 'error'
          ? { outcome: 'error', text: currentText }
          : { outcome: 'success', text: currentText };
      try {
        await runHookPhase(
          this.hooks,
          'after_tool',
          (hook): AfterToolInput => {
            activeHook = hook;
            return {
              runtime: {
                ...turnRuntime(cancellation.signal),
                modelStep,
                callId: call.callId,
              },
              toolName: call.name,
              arguments: freezeData(structuredClone(argumentsValue)),
              result: currentHookResult(),
              context: context ??= currentTurnHookContext(),
            };
          },
          ({ name, path, result }) => {
            if (result === undefined) return;
            if (
              typeof result !== 'object' || result === null ||
              typeof result.text !== 'string'
            ) {
              throw new Error('after_tool must return a text update');
            }
            currentText = result.text;
            applied = true;
            textHooks.push(hookEffectSource(name, path));
          },
        );
      } catch (error) {
        failure = hookFailure(activeHook, 'after_tool', error);
        currentText = `${currentText}\n\n[${hookFailureDescription(failure)}]`;
      }
      const hookEffect: ToolHookEffect | undefined = applied || failure !== undefined
        ? {
          originalText: originalResult.text,
          ...(textHooks.length === 0 ? {} : { textHooks }),
          ...(failure === undefined ? {} : { failure }),
        }
        : undefined;
      return {
        result: { ...originalResult, text: currentText },
        ...(hookEffect === undefined ? {} : { hookEffect }),
      };
    };
    try {
      requestCountAtAdmission = this.requestCounter.count();
      userTurnAdmitted = true;

      let beforeTurnContext: HookContextSnapshot | undefined;
      let activeBeforeTurnHook: LoadedWorkerHook | undefined;
      let turnContextContribution = 0;
      try {
        await runHookPhase(
          this.hooks,
          'before_turn',
          (hook) => {
            activeBeforeTurnHook = hook;
            return {
              runtime: turnRuntime(cancellation.signal),
              task,
              context: beforeTurnContext ??= currentTurnHookContext(),
            };
          },
          ({ name, path, result }) => {
            if (result === undefined) return;
            if (
              typeof result !== 'object' || result === null ||
              !Array.isArray(result.context) ||
              !result.context.every((part) => typeof part === 'string')
            ) {
              throw new Error('before_turn must return a context string array');
            }
            const text = result.context.join('\n');
            if (text.trim().length === 0) return;
            turnContextContribution += 1;
            const sourceLocator = JSON.stringify({
              hook: name,
              ...(path === undefined ? {} : { path }),
            });
            turnInstructionComponents.push(Object.freeze({
              ...defineInstructionComponent(
                `instruction:before-turn-hook-${turnContextContribution}`,
                text,
              ),
              sourceLocator,
            }));
            turnSystemInstruction = turnInstructionComponents.map((component) => component.text)
              .join('\n\n');
            if (beforeTurnContext !== undefined) {
              beforeTurnContext = Object.freeze({
                ...beforeTurnContext,
                systemInstruction: turnSystemInstruction,
                instructionComponents: freezeData(
                  structuredClone(turnInstructionComponents),
                ),
              });
            }
          },
        );
      } catch (error) {
        const hook = activeBeforeTurnHook;
        throw new Error(
          `before_turn hook ${hook?.selection.name ?? 'hook'}${
            hook?.selection.path === undefined ? '' : ` (${hook.selection.path})`
          }: ${errorText(error)}`,
          { cause: error },
        );
      }

      let proposal: WorkerCommitProposalMessage | undefined;
      let terminal: TurnEndEvent | undefined;
      const eventSink: AgentEventSink = (event) => {
        if (event.kind === 'turn_end') {
          terminal = event;
        } else if (
          this.port.providerObservation !== undefined &&
          (event.kind === 'assistant_progress' ||
            event.kind === 'assistant_message' || isEffect(event))
        ) {
          // The evidence recorder emits the same completed occurrence with provider
          // attribution. In the production port that observation is the single durable
          // Worker fact and the Host projects the provider-neutral AgentEvent from it.
          return;
        } else if (isEffect(event)) {
          const sequence = this.port.effectObservation(correlation, event);
          if (sequence !== undefined && event.kind === 'tool_call') {
            effectSequences.set(`tool-call:${event.call.callId}`, sequence);
          } else if (sequence !== undefined && event.kind === 'tool_result') {
            effectSequences.set(`tool-result:${event.result.callId}`, sequence);
          }
        } else {
          const sequence = this.port.runtimeEvent(correlation, event);
          if (sequence !== undefined && event.kind === 'user_message') {
            runtimeSequences.set('user-message', sequence);
          } else if (
            sequence !== undefined && event.kind === 'steering_message'
          ) {
            runtimeSteeringOrdinal += 1;
            runtimeSequences.set(
              `steering:${runtimeSteeringOrdinal}`,
              sequence,
            );
          } else if (
            sequence !== undefined && event.kind === 'assistant_message'
          ) {
            runtimeAssistantOrdinal += 1;
            runtimeSequences.set(
              `assistant:${runtimeAssistantOrdinal}`,
              sequence,
            );
          }
        }
      };
      const outcome = await runAgentTurn(
        task,
        this.committedTranscript,
        this.composition.model,
        this.composition.registry,
        {
          maxSteps: this.composition.maxSteps,
          systemInstruction: turnSystemInstruction,
          turn: this.nextTurn,
          eventSink,
          executionContext,
          cancellation,
          signal: cancellation.signal,
          steering,
          beforeTool,
          afterTool,
          requestMessageSource: sourceForMessage,
          projectParentRequestWithSources:
            this.checkpoint === undefined && recalledContext === undefined
              ? undefined
              : projectParentRequestWithSources,
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
      await Promise.all(contextObservations);
      const finalized = finalizeEvidence(outcome);
      if (!outcome.ok || proposal === undefined) {
        const failed = await failTurn(finalized);
        await afterSettlement(failed.settlement, failed.outcome, false);
        return;
      }
      proposal = {
        ...proposal,
        outcome: finalized,
        contextManifest: await makeContextManifest(),
        ...(finalized.diagnostic === undefined ? {} : {
          diagnostic: finalized.diagnostic,
        }),
      };
      const commitResult = await this.port.commitProposal(
        correlation,
        proposal,
        cancellation.signal,
      );
      const settlement = typeof commitResult === 'boolean' ? undefined : commitResult;
      const accepted = typeof commitResult === 'boolean' ? commitResult : commitResult.accepted;
      if (!accepted) {
        const rejected = rejectedCommitOutcome(
          task,
          finalized,
          settlement?.terminalOutcome,
        );
        if (settlement?.durable === true && executionId !== undefined) {
          this.lastSettlement = {
            executionId,
            correlation,
            turn,
            settlement,
            providerRequestOrdinal: evidence.lastRequestOrdinal,
          };
          this.postSettlementProviderEvidence = undefined;
          await afterSettlement(settlement, rejected, false);
        } else {
          const failed = await failTurn(rejected);
          await afterSettlement(failed.settlement, failed.outcome, false);
        }
        return;
      }
      this.committedTranscript = proposal.transcript;
      this.nextTurn = proposal.nextTurn;
      if (settlement?.durable === true && executionId !== undefined) {
        this.lastSettlement = {
          executionId,
          correlation,
          turn,
          settlement,
          providerRequestOrdinal: evidence.lastRequestOrdinal,
        };
        this.postSettlementProviderEvidence = undefined;
      }
      this.port.runtimeEvent(
        correlation,
        terminal ?? {
          kind: 'turn_end',
          turn: this.nextTurn - 1,
          outcome: outcome.stopReason,
          committed: true,
        },
      );
      await afterSettlement(settlement, finalized, true);
    } catch (error) {
      const failed = await failTurn(failureOutcome(
        task,
        this.committedTranscript,
        error instanceof Error ? error.message : String(error),
        cancellation.signal.aborted,
      ));
      await afterSettlement(failed.settlement, failed.outcome, false);
    } finally {
      steering.close();
      this.activeSteering = null;
      this.activeCancellation = null;
      this.active = false;
      if (this.hookProviderEvidenceScope.current === activeHookProviderEvidence) {
        this.hookProviderEvidenceScope.current = previousHookProviderEvidence;
      }
      if (!skipTurnSettled) this.port.turnSettled?.(correlation);
    }
  }
}
