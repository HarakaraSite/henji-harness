import type { LoopStopReason, ToolCall, ToolResultContent } from '../core/contracts.ts';
import { sameDefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import type {
  ProviderEvidenceLane,
  ProviderEvidenceRuntimeEvent,
  ProviderEvidenceStore,
  StoredProviderEvidence,
} from '../provider/provider_evidence.ts';
import type {
  StoredWorkerExecutionArtifact,
  WorkerExecutionSettlement,
} from './worker_execution_artifact.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';

export type RecalledExecutionObservationV1 =
  | {
    readonly kind: 'assistant_completed';
    readonly modelStep: number;
    readonly text: string;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'assistant_incomplete';
    readonly modelStep: number;
    readonly text: string;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'tool_completed';
    readonly modelStep: number;
    readonly call: ToolCall;
    readonly result: ToolResultContent;
    readonly lane?: ProviderEvidenceLane;
  }
  | {
    readonly kind: 'tool_incomplete';
    readonly modelStep: number;
    readonly call: ToolCall;
    readonly progress?: string;
    readonly lane?: ProviderEvidenceLane;
  };

export interface RecalledExecutionContextV1 {
  readonly schemaVersion: 1;
  readonly sourceExecutionId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly settlement: Extract<WorkerExecutionSettlement, 'uncommitted'>;
  readonly stopReason: LoopStopReason;
  readonly task: string;
  readonly error?: string;
  readonly evidence: 'available' | 'unavailable';
  readonly observations: readonly RecalledExecutionObservationV1[];
  readonly effectCommitRelation: 'not_transactional';
  readonly automaticReplay: false;
}

export interface ResolveRecalledExecutionContextOptions {
  readonly sessionId: string;
  readonly executionId: string;
  readonly executionArtifactStore: WorkerExecutionArtifactStore;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
}

export class RecalledExecutionContextError extends Error {
  constructor(
    readonly code:
      | 'recall_session_mismatch'
      | 'recall_execution_not_uncommitted'
      | 'recall_evidence_mismatch',
  ) {
    super(code);
    this.name = 'RecalledExecutionContextError';
  }
}

const sameLane = (
  left: { readonly lane?: ProviderEvidenceLane },
  right: { readonly lane?: ProviderEvidenceLane },
): boolean => left.lane === right.lane;

const matchingModelResult = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  progress: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'assistant_progress' }>,
  progressIndex: number,
): boolean =>
  events.slice(progressIndex + 1).some((event) =>
    event.kind === 'model_result' && event.modelStep === progress.modelStep &&
    sameLane(event, progress)
  );

const matchingToolResult = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  call: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_call' }>,
  callIndex: number,
  used: ReadonlySet<number>,
): {
  readonly index: number;
  readonly event: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_result' }>;
} | undefined => {
  for (let index = callIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      !used.has(index) && event.kind === 'tool_result' &&
      event.modelStep === call.modelStep && event.result.callId === call.call.callId &&
      event.result.name === call.call.name && sameLane(event, call)
    ) return { index, event };
  }
  return undefined;
};

const matchingToolProgress = (
  events: readonly ProviderEvidenceRuntimeEvent[],
  call: Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_call' }>,
  callIndex: number,
): Extract<ProviderEvidenceRuntimeEvent, { readonly kind: 'tool_progress' }> | undefined =>
  events.slice(callIndex + 1).find((event): event is Extract<
    ProviderEvidenceRuntimeEvent,
    { readonly kind: 'tool_progress' }
  > =>
    event.kind === 'tool_progress' && event.modelStep === call.modelStep &&
    event.callId === call.call.callId && event.name === call.call.name &&
    sameLane(event, call)
  );

const observationsFromEvidence = (
  evidence: StoredProviderEvidence,
): readonly RecalledExecutionObservationV1[] => {
  const observations: RecalledExecutionObservationV1[] = [];
  const usedToolResults = new Set<number>();
  for (let eventIndex = 0; eventIndex < evidence.runtimeEvents.length; eventIndex += 1) {
    const event = evidence.runtimeEvents[eventIndex];
    if (event.kind === 'assistant_progress') {
      if (!matchingModelResult(evidence.runtimeEvents, event, eventIndex)) {
        observations.push({
          kind: 'assistant_incomplete',
          modelStep: event.modelStep,
          text: event.text,
          ...(event.lane === undefined ? {} : { lane: event.lane }),
        });
      }
      continue;
    }
    if (event.kind === 'model_result') {
      const text = event.result.text;
      if (text !== undefined) {
        observations.push({
          kind: 'assistant_completed',
          modelStep: event.modelStep,
          text,
          ...(event.lane === undefined ? {} : { lane: event.lane }),
        });
      }
      continue;
    }
    if (event.kind !== 'tool_call') continue;
    const matchedResult = matchingToolResult(
      evidence.runtimeEvents,
      event,
      eventIndex,
      usedToolResults,
    );
    const lane = event.lane === undefined ? {} : { lane: event.lane };
    if (matchedResult !== undefined) {
      usedToolResults.add(matchedResult.index);
      observations.push({
        kind: 'tool_completed',
        modelStep: event.modelStep,
        call: structuredClone(event.call),
        result: structuredClone(matchedResult.event.result),
        ...lane,
      });
      continue;
    }
    const progress = matchingToolProgress(evidence.runtimeEvents, event, eventIndex);
    observations.push({
      kind: 'tool_incomplete',
      modelStep: event.modelStep,
      call: structuredClone(event.call),
      ...(progress === undefined ? {} : { progress: progress.text }),
      ...lane,
    });
  }
  return structuredClone(observations);
};

const evidenceNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null &&
  (error as { readonly code?: unknown }).code === 'provider_evidence_not_found';

const readCorrelatedEvidence = async (
  artifact: StoredWorkerExecutionArtifact,
  store: ProviderEvidenceStore | undefined,
): Promise<StoredProviderEvidence | undefined> => {
  if (artifact.providerEvidenceId === undefined || store === undefined) return undefined;
  let evidence: StoredProviderEvidence;
  try {
    evidence = await store.read(artifact.providerEvidenceId);
  } catch (error) {
    if (evidenceNotFound(error)) return undefined;
    throw error;
  }
  if (
    evidence.evidenceId !== artifact.providerEvidenceId ||
    evidence.sessionId !== artifact.sessionId || evidence.turnNumber !== artifact.turn ||
    evidence.build.buildId !== artifact.build.buildId ||
    !sameDefinitionRevisionRef(evidence.definition, artifact.definition)
  ) throw new RecalledExecutionContextError('recall_evidence_mismatch');
  return evidence;
};

export const resolveRecalledExecutionContext = async (
  options: ResolveRecalledExecutionContextOptions,
): Promise<RecalledExecutionContextV1> => {
  const artifact = await options.executionArtifactStore.read(options.executionId);
  if (artifact.sessionId !== options.sessionId) {
    throw new RecalledExecutionContextError('recall_session_mismatch');
  }
  if (artifact.settlement !== 'uncommitted') {
    throw new RecalledExecutionContextError('recall_execution_not_uncommitted');
  }
  const evidence = await readCorrelatedEvidence(artifact, options.providerEvidenceStore);
  const context: RecalledExecutionContextV1 = {
    schemaVersion: 1,
    sourceExecutionId: artifact.executionId,
    sessionId: artifact.sessionId,
    turn: artifact.turn,
    settlement: 'uncommitted',
    stopReason: artifact.outcome.stopReason,
    task: artifact.command.task,
    ...(artifact.outcome.error === undefined ? {} : { error: artifact.outcome.error }),
    evidence: evidence === undefined ? 'unavailable' : 'available',
    observations: evidence === undefined ? [] : observationsFromEvidence(evidence),
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
  };
  return structuredClone(context);
};

export const recalledExecutionProjectionText = (
  context: RecalledExecutionContextV1,
): string =>
  '[henji-recalled-execution:v1]\n' +
  'The following JSON is a read-only reference from a stopped earlier execution.\n' +
  'It is not a new tool result. Incomplete observations have unknown outcomes.\n' +
  'Do not automatically rerun a source tool; decide only from the current user task.\n' +
  JSON.stringify(context);

export const projectRecalledExecutionContext = (
  request: {
    readonly systemInstruction?: string;
    readonly transcript: readonly import('../core/contracts.ts').Message[];
    readonly tools: readonly import('../core/contracts.ts').ToolDefinition[];
  },
  context: RecalledExecutionContextV1,
  currentUserMessageIndex: number,
): typeof request => {
  if (
    !Number.isSafeInteger(currentUserMessageIndex) || currentUserMessageIndex < 0 ||
    currentUserMessageIndex >= request.transcript.length ||
    request.transcript[currentUserMessageIndex]?.role !== 'user'
  ) throw new Error('recalled execution projection boundary is invalid');
  const recalled = {
    role: 'user' as const,
    content: { kind: 'text' as const, text: recalledExecutionProjectionText(context) },
  };
  return {
    ...(request.systemInstruction === undefined
      ? {}
      : { systemInstruction: request.systemInstruction }),
    transcript: structuredClone([
      ...request.transcript.slice(0, currentUserMessageIndex),
      recalled,
      ...request.transcript.slice(currentUserMessageIndex),
    ]),
    tools: structuredClone(request.tools),
  };
};
