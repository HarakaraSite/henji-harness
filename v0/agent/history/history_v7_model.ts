import type { JsonValue } from '../core/contracts.ts';
import { canonicalJsonBytes } from './context_attribution.ts';
import type { ProviderEvidenceLane } from '../provider/provider_evidence.ts';
import type { StoredExecutionEvent } from './history_store_contract.ts';

export const HISTORY_V7_SCHEMA_VERSION = 11 as const;

/** Attribution within one execution, taken from the production provider observation. */
export interface HistoryV7AssistantTextKey {
  readonly lane?: ProviderEvidenceLane;
  readonly modelStep: number;
  readonly requestOrdinal?: number;
}

/** Sole authority for the latest committed text of a still-incomplete request. */
export interface HistoryV7AssistantTextState {
  readonly key: HistoryV7AssistantTextKey;
  readonly firstEventOrdinal: number;
  readonly event: StoredExecutionEvent;
}

export type HistoryV7AssistantTextUpdate =
  | { readonly kind: 'put'; readonly state: HistoryV7AssistantTextState }
  | { readonly kind: 'remove'; readonly key: HistoryV7AssistantTextKey };

export interface HistoryV7AppendBatchInput {
  readonly executionId: string;
  readonly expectedLatestOrdinal: number;
  readonly occurrences: readonly HistoryV7SemanticOccurrenceInput[];
  readonly assistantTextUpdates?: readonly HistoryV7AssistantTextUpdate[];
  readonly eventCount?: number;
  readonly terminalOccurrenceId?: string;
}

export type HistoryV7SemanticKind =
  | 'execution_admission'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'control_decision'
  | 'effect_observation'
  | 'model_request'
  | 'model_result'
  | 'context_item'
  | 'resource_revision'
  | 'host_decision'
  | 'recall_projection';

export interface HistoryV7SemanticRelationInput {
  readonly relation: string;
  readonly targetOccurrenceId: string;
  readonly mandatory?: boolean;
}

export interface HistoryV7SemanticOccurrenceInput {
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly kind: HistoryV7SemanticKind;
  readonly observedAt: string;
  readonly payload: JsonValue;
  readonly content?: Uint8Array;
  /**
   * Expected identity for newly supplied content, or a validated reference to content that is
   * already present when `content` is omitted.
   */
  readonly contentDigest?: string;
  readonly relations?: readonly HistoryV7SemanticRelationInput[];
}

export interface HistoryV7SemanticOccurrence {
  readonly executionId: string;
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly kind: HistoryV7SemanticKind;
  readonly observedAt: string;
  readonly payload: JsonValue;
  readonly contentDigest?: string;
}

export interface HistoryV7OperationCost {
  readonly serializedBytes: number;
  readonly contentBytesHashed: number;
  readonly contentDigestCalls: number;
  readonly newOccurrences: number;
  readonly newRelations: number;
  readonly preexistingPayloadRowsRead: number;
  readonly preexistingPayloadBytesRead: number;
  readonly preexistingPayloadBytesRewritten: number;
}

export const emptyHistoryV7OperationCost = (): HistoryV7OperationCost => ({
  serializedBytes: 0,
  contentBytesHashed: 0,
  contentDigestCalls: 0,
  newOccurrences: 0,
  newRelations: 0,
  preexistingPayloadRowsRead: 0,
  preexistingPayloadBytesRead: 0,
  preexistingPayloadBytesRewritten: 0,
});

const nonempty = (value: string): boolean => value.length > 0 && !value.includes('\0');

export const encodeHistoryV7Payload = (payload: JsonValue): Uint8Array =>
  canonicalJsonBytes(payload);

export const validateHistoryV7Occurrence = (
  occurrence: HistoryV7SemanticOccurrenceInput,
): void => {
  if (
    !nonempty(occurrence.occurrenceId) ||
    !Number.isSafeInteger(occurrence.ordinal) || occurrence.ordinal < 1 ||
    !nonempty(occurrence.observedAt)
  ) throw new TypeError('invalid history v7 semantic occurrence');
  encodeHistoryV7Payload(occurrence.payload);
  if (occurrence.contentDigest !== undefined && !nonempty(occurrence.contentDigest)) {
    throw new TypeError('invalid history v7 content digest');
  }
  for (const relation of occurrence.relations ?? []) {
    if (!nonempty(relation.relation) || !nonempty(relation.targetOccurrenceId)) {
      throw new TypeError('invalid history v7 semantic relation');
    }
  }
};
