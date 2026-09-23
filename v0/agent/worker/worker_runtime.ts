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
import type { ProviderExactRequestObservation } from '../core/contracts.ts';
import {
  projectRecalledExecutionContext,
  type RecalledExecutionContext,
} from './recalled_execution_context.ts';
import type { WorkerStageName } from './worker_stage_probe.ts';

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
  readonly providerExactRequest?: (
    correlation: WorkerCorrelation,
    observation: ProviderExactRequestObservation,
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
  ) => Promise<boolean>;
  readonly turnFailed: (
    correlation: WorkerCorrelation,
    outcome: LoopOutcome,
    providerEvidence?: ProviderEvidenceV1,
    contextManifest?: import('../history/context_attribution.ts').ExecutionContextManifestV2,
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
    private readonly reportAuxiliaryStage?: (stage: WorkerStageName) => void,
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
      undefined,
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
    );
    this.activeCancellation = cancellation;
    this.activeSteering = steering;
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
          const rootInstructionComponents = this.startupSnapshot.context?.instructionComponents ??
            [];
          const namedInstructionComponents = rootInstructionComponents;
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
      this.port.providerExactRequest === undefined ? undefined : (observation) => {
        this.port.providerExactRequest!(correlation, observation);
      },
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
