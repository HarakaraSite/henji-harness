export type ConversationValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: ConversationValue }
  | readonly ConversationValue[];

export type ConversationOutcome =
  | 'unknown'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export type ConversationAdoption = 'canonical' | 'non_canonical';

export interface ConversationRequestReference {
  readonly lane?: 'parent' | 'planner';
  readonly modelStep: number;
  readonly requestOrdinal?: number;
}

export interface ConversationRequestKey extends ConversationRequestReference {
  readonly executionId: string;
}

/** Stable ordering coordinates supplied by source facts, never by apply count. */
export interface ConversationPosition {
  readonly executionOrder: number;
  /** Physical request start ordinal, or the source event ordinal when no request exists. */
  readonly requestOrder: number;
  /** Thinking, assistant text, and tool activity have stable phases within a request. */
  readonly phase: number;
  readonly eventOrdinal: number;
  readonly itemOrdinal: number;
}

export interface ConversationExecutionMetadata {
  readonly executionId: string;
  readonly taskId: string;
  readonly task: string;
  readonly sessionId: string;
  readonly canonicalSessionId?: string;
  readonly parentExecutionId?: string;
  readonly spawnCallId?: string;
  readonly turn: number;
  readonly createdAt: string;
  readonly settledAt?: string;
  readonly terminalSemanticOccurrenceId?: string;
  readonly lifecycle: 'active' | 'settled';
  readonly outcome: ConversationOutcome;
  readonly stopReason?: string;
  readonly diagnostic?: Readonly<{ code: string; stage: string }>;
  readonly adoption: ConversationAdoption;
  readonly baseRevision: number;
  readonly committedRevision?: number;
  readonly agent: string;
  /** Opaque JSON model attribution keeps this contract independent of provider modules. */
  readonly model: ConversationValue;
}

export interface ConversationExecutionEntity {
  readonly kind: 'execution';
  readonly id: string;
  readonly executionId: string;
  readonly version: number;
  readonly position: ConversationPosition;
  readonly execution: ConversationExecutionMetadata;
}

export interface ConversationRequestEntity {
  readonly kind: 'request';
  readonly id: string;
  readonly executionId: string;
  readonly requestKey: ConversationRequestKey;
  readonly turn: number;
  readonly version: number;
  readonly position: ConversationPosition;
  readonly attribution?: Readonly<{
    provider?: string;
    modelId?: string;
    api?: string;
  }>;
}

export interface ConversationMessageEntity {
  readonly kind: 'message';
  readonly id: string;
  readonly executionId: string;
  readonly turn: number;
  readonly version: number;
  readonly position: ConversationPosition;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly complete: boolean;
  readonly requestKey?: ConversationRequestKey;
  readonly semanticOccurrenceId?: string;
  readonly toolOccurrenceIds?: readonly string[];
  /** Stable entity references, including model-declared calls not yet started by a tool worker. */
  readonly toolIds?: readonly string[];
}

export interface ConversationThinkingEntity {
  readonly kind: 'thinking';
  readonly id: string;
  readonly executionId: string;
  readonly turn: number;
  readonly requestKey: ConversationRequestKey;
  readonly thinkingKind: 'text' | 'summary';
  readonly version: number;
  readonly position: ConversationPosition;
  readonly text: string;
  readonly complete: boolean;
}

export interface ConversationToolEntity {
  readonly kind: 'tool';
  readonly id: string;
  /** Set only after a semantic tool_call occurrence has been saved. */
  readonly semanticOccurrenceId?: string;
  /** model_result occurrence that declared this call, when present. */
  readonly declarationOccurrenceId?: string;
  readonly declarationIndex?: number;
  /** Zero-based position in the declaring model_result.calls batch. */
  readonly callIndex?: number;
  readonly started: boolean;
  readonly executionId: string;
  readonly turn: number;
  readonly requestKey: ConversationRequestKey;
  readonly version: number;
  readonly position: ConversationPosition;
  readonly callId: string;
  readonly name: string;
  readonly arguments: ConversationValue;
  readonly progress?: string;
  readonly result?: Readonly<{
    text: string;
    outcome: 'success' | 'error';
    terminal?: string;
  }>;
}

export interface ConversationSteeringEntity {
  readonly kind: 'steering';
  readonly id: string;
  readonly executionId: string;
  readonly version: number;
  readonly position: ConversationPosition;
  readonly status: 'requested' | 'sent' | 'failed';
  readonly text: string;
}

export type ConversationEntity =
  | ConversationExecutionEntity
  | ConversationRequestEntity
  | ConversationMessageEntity
  | ConversationThinkingEntity
  | ConversationToolEntity
  | ConversationSteeringEntity;

/** Keyed state: ordinary updates replace one entity without rebuilding conversation arrays. */
export interface ConversationState {
  readonly sessionId: string;
  readonly entities: Map<string, ConversationEntity>;
  /** Structural order keys are stored by identity; consumers sort only for a snapshot/export. */
  readonly order: Map<string, ConversationPosition>;
  /** Relationship index used to attach tools to the assistant item for their request. */
  readonly toolsByRequest: Map<string, string[]>;
}

export type ConversationChange =
  | Readonly<{ kind: 'upsert'; entity: ConversationEntity }>
  | Readonly<{ kind: 'remove'; id: string }>
  | Readonly<{
    kind: 'order';
    action: 'insert' | 'remove';
    id: string;
    position?: ConversationPosition;
  }>;

/** Provider-neutral input accepted from saved-history and live-save adapters. */
export type ConversationObservation =
  | Readonly<{
    kind: 'execution';
    execution: ConversationExecutionMetadata;
    executionOrder: number;
  }>
  | Readonly<{
    kind: 'request_start';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    request: ConversationRequestReference;
    attribution?: ConversationRequestEntity['attribution'];
  }>
  | Readonly<{
    kind: 'assistant_progress';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    firstEventOrdinal?: number;
    request: ConversationRequestReference;
    text: string;
    semanticOccurrenceId?: string;
  }>
  | Readonly<{
    kind: 'model_result';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    firstEventOrdinal?: number;
    request: ConversationRequestReference;
    text?: string;
    semanticOccurrenceId?: string;
    declaredCalls?: readonly Readonly<{
      callId: string;
      name: string;
      arguments: ConversationValue;
    }>[];
  }>
  | Readonly<{
    kind: 'thinking';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    request: ConversationRequestReference;
    thinkingKind: 'text' | 'summary';
    text: string;
    complete: boolean;
  }>
  | Readonly<{
    kind: 'tool_call';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    semanticOccurrenceId: string;
    callIndex?: number;
    request: ConversationRequestReference;
    callId: string;
    name: string;
    arguments: ConversationValue;
  }>
  | Readonly<{
    kind: 'tool_progress';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    request: ConversationRequestReference;
    callIndex?: number;
    callId: string;
    text: string;
  }>
  | Readonly<{
    kind: 'tool_result';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    request: ConversationRequestReference;
    callIndex?: number;
    result: Readonly<{
      callId: string;
      name: string;
      text: string;
      outcome: 'success' | 'error';
      terminal?: string;
    }>;
  }>
  | Readonly<{
    kind: 'steering_operation';
    executionId: string;
    eventOrdinal: number;
    status: 'requested' | 'sent' | 'failed';
    text: string;
  }>
  | Readonly<{
    kind: 'steering_applied';
    executionId: string;
    turn: number;
    eventOrdinal: number;
    semanticOccurrenceId: string;
    text: string;
  }>
  | Readonly<{
    kind: 'execution_settled';
    executionId: string;
    eventOrdinal: number;
    settledAt?: string;
    terminalSemanticOccurrenceId?: string;
    outcome: ConversationOutcome;
    readonly stopReason?: string;
    readonly diagnostic?: Readonly<{ code: string; stage: string }>;
    adoption: ConversationAdoption;
    committedRevision?: number;
  }>;

export const conversationRequestIdentity = (
  requestKey: ConversationRequestKey,
): string =>
  JSON.stringify([
    requestKey.executionId,
    requestKey.lane ?? '',
    requestKey.modelStep,
    requestKey.requestOrdinal ?? -1,
  ]);

export const conversationEntityId = (
  entity: Pick<ConversationEntity, 'kind' | 'id'>,
): string => `${entity.kind}:${entity.id}`;

export const compareConversationPositions = (
  left: ConversationPosition,
  right: ConversationPosition,
): number =>
  left.executionOrder - right.executionOrder ||
  left.requestOrder - right.requestOrder ||
  left.phase - right.phase ||
  left.eventOrdinal - right.eventOrdinal ||
  left.itemOrdinal - right.itemOrdinal;

export const createConversationState = (sessionId: string): ConversationState => ({
  sessionId,
  entities: new Map(),
  order: new Map(),
  toolsByRequest: new Map(),
});

export const orderedConversationEntities = (
  state: ConversationState,
): readonly ConversationEntity[] =>
  [...state.entities.values()].sort((left, right) =>
    compareConversationPositions(left.position, right.position) ||
    left.id.localeCompare(right.id)
  );
