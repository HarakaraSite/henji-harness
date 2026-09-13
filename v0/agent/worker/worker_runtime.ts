import type { AgentEvent, AgentEventSink } from '../core/events.ts';
import { type LoopOutcome, type Message } from '../core/contracts.ts';
import { projectSemanticContext } from '../session/semantic_context.ts';
import { indexSessionHistory } from '../session/session_history.ts';
import { type SemanticContextCheckpointV1 } from '../session/session_store.ts';
import { runAgentTurn } from '../core/loop.ts';
import {
  ParentTurnExecutionContext,
  type RequestMessageSourceKind,
  TurnRequestBudget,
} from '../core/execution_context.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../definitions/agent_definition.ts';
import { TurnCancellationOwner } from '../core/cancellation.ts';
import { SteeringOwner, validateSteeringText } from '../core/steering.ts';
import { FailureDiagnosticOwner } from '../session/failure_diagnostic.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  type ProviderEvidenceV1,
} from '../provider/provider_evidence.ts';
import type { WorkerAgentComposition } from '../worker_agent_api.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import {
  type ContextModelRequestItem,
  type ContextModelRequestRecord,
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
import {
  projectRecalledExecutionContext,
  type RecalledExecutionContext,
} from './recalled_execution_context.ts';

export interface WorkerGenerationPort {
  readonly runtimeEvent: (
    correlation: WorkerCorrelation,
    event: AgentEvent,
  ) => void;
  readonly effectObservation: (
    correlation: WorkerCorrelation,
    effect: WorkerEffectObservation,
  ) => void;
  readonly providerObservation?: (
    correlation: WorkerCorrelation,
    observation: ProviderEvidenceObservation,
    turn: number,
  ) => void;
  readonly contextObservation?: (
    correlation: WorkerCorrelation,
    observation: ContextModelRequestRecord,
  ) => void | PromiseLike<void>;
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
    contextManifest?: import('../history/context_attribution.ts').ExecutionContextManifestV1,
  ) => void | PromiseLike<void>;
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
    readonly startupSnapshot: {
      readonly instructionSource?: AgentInstructionSource;
      readonly skillNames: readonly string[];
      readonly context?: WorkerContextSnapshot;
    } = { skillNames: [] },
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
      plannerModel: Object.freeze(
        structuredClone(PLANNER_DEFAULT_MODEL_SELECTION),
      ),
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

  async runTurn(
    correlation: WorkerCorrelation,
    task: string,
    recalledContext?: RecalledExecutionContext,
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
      undefined,
      (observation) => this.port.providerObservation?.(correlation, observation, turn),
    );
    this.activeCancellation = cancellation;
    this.activeSteering = steering;
    const childMaxSteps = DEFAULT_AGENT_MAX_STEPS;
    const contextObservations: Promise<void>[] = [];
    const contextRequests: ContextModelRequestRecord[] = [];
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
    const sourceForMessage = (
      message: Message,
      kind: RequestMessageSourceKind,
      messageIndex: number,
      modelStep?: number,
      requestLane?: 'parent' | 'child',
      sourceCallId?: string,
    ): readonly ContextSourceRelation[] => {
      const lane: 'parent' | 'planner' = requestLane === 'child' ||
          this.composition.role === 'planner'
        ? 'planner'
        : 'parent';
      if (kind === 'committed') {
        const indexed = indexSessionHistory(this.committedTranscript);
        const canonicalTurn = indexed?.turns.find((candidate) =>
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
        return [{
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity: `current-task:${correlation.session}:turn:${turn}${
            lane === 'planner'
              ? `:lane:planner${sourceCallId === undefined ? '' : `:call:${sourceCallId}`}`
              : ''
          }`,
          lane,
          ...(sourceCallId === undefined ? {} : { callId: sourceCallId }),
        }];
      }
      if (kind === 'steering') {
        steeringSourceOrdinal += 1;
        return [{
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `steering:${correlation.session}:turn:${turn}:message:${steeringSourceOrdinal}`,
          lane,
        }];
      }
      if (kind === 'assistant') {
        assistantSourceOrdinal += 1;
        if (!Array.isArray(message.content) || message.content.length === 0) {
          return [{
            stage: 'projected',
            resourceKind: 'message',
            logicalIdentity:
              `current-execution:${correlation.session}:turn:${turn}:assistant:event:${assistantSourceOrdinal}`,
            lane,
            ...(modelStep === undefined ? {} : { modelStep }),
          }];
        }
        const assistantEvent: ContextSourceRelation = {
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `current-execution:${correlation.session}:turn:${turn}:assistant:event:${assistantSourceOrdinal}`,
          lane,
          ...(modelStep === undefined ? {} : { modelStep }),
        };
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
            return {
              stage: 'projected' as const,
              resourceKind: 'message' as const,
              logicalIdentity:
                `current-execution:${correlation.session}:turn:${turn}:call:${call.callId}`,
              callId: call.callId,
              lane,
              ...(modelStep === undefined ? {} : { modelStep }),
            };
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
        const base: ContextSourceRelation = {
          stage: 'projected',
          resourceKind: 'message',
          logicalIdentity:
            `current-execution:${correlation.session}:turn:${turn}:call:${result.callId}`,
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
          ...(sourceRequestOrdinal === undefined ? {} : { requestOrdinal: sourceRequestOrdinal }),
        };
        const observed: ContextSourceRelation = {
          stage: 'observed',
          resourceKind: 'tool_result',
          logicalIdentity: `tool-result:${correlation.session}:turn:${turn}:call:${result.callId}`,
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
          ...(sourceRequestOrdinal === undefined ? {} : { requestOrdinal: sourceRequestOrdinal }),
        };
        const projected: ContextSourceRelation = {
          stage: 'projected',
          resourceKind: skill === undefined ? 'tool_result' : 'skill',
          logicalIdentity: skill === undefined
            ? `tool-result:${correlation.session}:turn:${turn}:call:${result.callId}`
            : `skill:${skill.name}`,
          ...(skill === undefined ? {} : { sourceLocator: skill.sourceDirectory }),
          callId: result.callId,
          lane,
          ...(sourceModelStep === undefined ? {} : { modelStep: sourceModelStep }),
        };
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
        const relations: ContextSourceRelation[] = [base, projected];
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
    const contextualizeSource = (
      source: ContextSourceRelation,
      requestOrdinal: number,
      lane: 'parent' | 'planner',
      modelStep: number,
    ): ContextSourceRelation => ({
      ...source,
      lane,
      modelStep,
      requestOrdinal,
    });
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
        const hydrateSource = async (
          source: ContextSourceRelation,
          itemDigest: string,
          message?: Message,
        ): Promise<ContextSourceRelation> => {
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
        const items: ContextModelRequestItem[] = [];
        let itemOrdinal = 1;
        if (observation.request.systemInstruction !== undefined) {
          const blob = await textBlob(observation.request.systemInstruction);
          const hasNamedInstructionComponents =
            (this.startupSnapshot.context?.instructionComponents.length ?? 0) >
              0;
          items.push({
            ordinal: itemOrdinal++,
            kind: 'system',
            content: {
              digest: blob.digest,
              byteLength: blob.byteLength,
              mediaType: blob.mediaType,
            },
            bytesBase64: blob.bytes.toBase64(),
            relationOrdinals: [],
            sourceRelations: [{
              stage: 'projected',
              resourceKind: hasNamedInstructionComponents
                ? 'instruction_component'
                : 'definition_output',
              logicalIdentity: hasNamedInstructionComponents
                ? `composition:${correlation.session}:system`
                : `definition-output:${correlation.session}`,
              lane: observation.lane === 'child' ? 'planner' : 'parent',
              modelStep: observation.modelStep,
              requestOrdinal,
              contentDigest: blob.digest,
            }],
          });
        }
        for (
          const [messageIndex, message] of observation.request.transcript
            .entries()
        ) {
          const blob = await jsonBlob(
            message as unknown as import('../core/contracts.ts').JsonValue,
            'application/vnd.henji.message+json',
          );
          const sourceRelations = await Promise.all(
            (observation.sourceAttribution?.transcript[messageIndex] ?? []).map(
              (source) =>
                hydrateSource(
                  contextualizeSource(
                    source,
                    requestOrdinal,
                    observation.lane === 'child' ? 'planner' : 'parent',
                    observation.modelStep,
                  ),
                  blob.digest,
                  message,
                ),
            ),
          );
          items.push({
            ordinal: itemOrdinal++,
            kind: 'message',
            content: {
              digest: blob.digest,
              byteLength: blob.byteLength,
              mediaType: blob.mediaType,
            },
            bytesBase64: blob.bytes.toBase64(),
            relationOrdinals: [],
            sourceRelations,
          });
        }
        for (const tool of observation.request.tools) {
          const blob = await jsonBlob(
            tool as unknown as import('../core/contracts.ts').JsonValue,
            'application/vnd.henji.tool+json',
          );
          const manifestToolIdentity = this.composition.manifest.resources
            .filter((resource) => resource === `tool:${tool.name}`);
          items.push({
            ordinal: itemOrdinal++,
            kind: 'tool_contract',
            content: {
              digest: blob.digest,
              byteLength: blob.byteLength,
              mediaType: blob.mediaType,
            },
            bytesBase64: blob.bytes.toBase64(),
            relationOrdinals: [],
            sourceRelations: manifestToolIdentity.length === 1
              ? [{
                stage: 'projected',
                resourceKind: 'tool_contract',
                logicalIdentity: `tool-contract:${manifestToolIdentity[0]}`,
                lane: observation.lane === 'child' ? 'planner' : 'parent',
                modelStep: observation.modelStep,
                requestOrdinal,
                contentDigest: blob.digest,
              }]
              : [],
          });
        }
        const requestRecord: ContextModelRequestRecord = {
          requestOrdinal,
          lane: observation.lane === 'child' ? 'planner' : 'parent',
          purpose: 'user_turn',
          modelStep: observation.modelStep,
          ...(observation.modelSelection === undefined ? {} : {
            modelSelection: structuredClone(observation.modelSelection),
          }),
          request: structuredClone(observation.request),
          items,
        };
        contextRequests.push(requestRecord);
        await this.port.contextObservation?.(correlation, requestRecord);
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
        const blob = await textBlob(observation.body, 'application/json');
        const requestRecord: ContextModelRequestRecord = {
          requestOrdinal,
          lane: observation.lane === 'child' ? 'planner' : 'parent',
          purpose: observation.purpose,
          modelStep: observation.modelStep,
          ...(observation.modelSelection === undefined ? {} : {
            modelSelection: structuredClone(observation.modelSelection),
          }),
          providerBody: observation.body,
          sourceCallId: observation.callId,
          items: [{
            ordinal: 1,
            kind: 'provider_wire_body',
            content: {
              digest: blob.digest,
              byteLength: blob.byteLength,
              mediaType: blob.mediaType,
            },
            bytesBase64: blob.bytes.toBase64(),
            relationOrdinals: [],
            sourceRelations: [{
              stage: 'projected',
              resourceKind: 'provider_wire_body',
              logicalIdentity: `tool-call:${observation.callId}`,
              callId: observation.callId,
              lane: observation.lane === 'child' ? 'planner' : 'parent',
              modelStep: observation.modelStep,
              requestOrdinal,
              contentDigest: blob.digest,
            }],
          }],
        };
        contextRequests.push(requestRecord);
        await this.port.contextObservation?.(correlation, requestRecord);
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
      if (this.checkpoint !== undefined) {
        const indexed = indexSessionHistory(this.committedTranscript);
        const coveredEnd = indexed
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
      observeModelRequest,
      this.rootModelSelection,
      PLANNER_DEFAULT_MODEL_SELECTION,
      observeAuxiliaryRequest,
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
      providerEvidenceId: evidence.evidenceId,
      ...(outcome.diagnostic === undefined &&
          diagnosticOwner.snapshot() === undefined
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
    const makeContextManifest = async (): Promise<
      | import('../history/context_attribution.ts').ExecutionContextManifestV1
      | undefined
    > => {
      await Promise.allSettled(contextObservations);
      if (contextObservationFailed) return undefined;
      try {
        const projected = new Set(
          contextRequests.flatMap((request) =>
            request.items.flatMap((item) => (item.sourceRelations ?? []).map(relationKey))
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
    const failTurn = async (outcome: LoopOutcome): Promise<void> => {
      const finalized = finalizeEvidence(outcome);
      await this.port.turnFailed(
        correlation,
        finalized.outcome,
        finalized.providerEvidence,
        await makeContextManifest(),
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
        await failTurn(finalized.outcome);
        return;
      }
      proposal = {
        ...proposal,
        outcome: finalized.outcome,
        providerEvidence: finalized.providerEvidence,
        contextManifest: await makeContextManifest(),
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
        await failTurn(
          rejectedCommitOutcome(
            task,
            this.committedTranscript,
            finalized.outcome,
          ),
        );
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
      await failTurn(failureOutcome(
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
