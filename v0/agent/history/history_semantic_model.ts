import type { JsonValue } from '../core/contracts.ts';
import { canonicalJsonBytes } from './context_attribution.ts';
import type { ProviderEvidenceLane } from '../provider/provider_evidence.ts';
import type { StoredExecutionEvent } from './history_store_contract.ts';

/** Attribution within one execution, taken from the production provider observation. */
export interface HistoryAssistantTextKey {
  readonly lane?: ProviderEvidenceLane;
  readonly modelStep: number;
  readonly requestOrdinal?: number;
}

/** Sole authority for the latest committed text of a still-incomplete request. */
export interface HistoryAssistantTextState {
  readonly key: HistoryAssistantTextKey;
  readonly firstEventOrdinal: number;
  readonly event: StoredExecutionEvent;
}

export type HistoryAssistantTextUpdate =
  | { readonly kind: 'put'; readonly state: HistoryAssistantTextState }
  | { readonly kind: 'remove'; readonly key: HistoryAssistantTextKey };

export interface HistoryAppendBatchInput {
  readonly executionId: string;
  readonly expectedLatestOrdinal: number;
  readonly occurrences: readonly HistorySemanticOccurrenceInput[];
  readonly assistantTextUpdates?: readonly HistoryAssistantTextUpdate[];
  readonly eventCount?: number;
  readonly terminalOccurrenceId?: string;
}

export type HistorySemanticKind =
  | 'execution_admission'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'control_decision'
  | 'effect_observation'
  | 'model_request'
  | 'model_result'
  | 'context_update'
  | 'context_item'
  | 'resource_revision'
  | 'host_decision'
  | 'recall_projection';

interface HistorySemanticRelationInput {
  readonly relation: string;
  readonly targetOccurrenceId: string;
  readonly mandatory?: boolean;
}

export interface HistorySemanticOccurrenceInput {
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly kind: HistorySemanticKind;
  readonly observedAt: string;
  readonly payload: JsonValue;
  readonly content?: Uint8Array;
  /**
   * Expected identity for newly supplied content, or a validated reference to content that is
   * already present when `content` is omitted.
   */
  readonly contentDigest?: string;
  readonly relations?: readonly HistorySemanticRelationInput[];
}

export interface HistorySemanticOccurrence {
  readonly executionId: string;
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly kind: HistorySemanticKind;
  readonly observedAt: string;
  readonly payload: JsonValue;
  readonly contentDigest?: string;
}

export interface HistoryOperationCost {
  readonly serializedBytes: number;
  readonly contentBytesHashed: number;
  readonly contentDigestCalls: number;
  readonly newOccurrences: number;
  readonly newRelations: number;
  readonly preexistingPayloadRowsRead: number;
  readonly preexistingPayloadBytesRead: number;
  readonly preexistingPayloadBytesRewritten: number;
}

export const emptyHistoryOperationCost = (): HistoryOperationCost => ({
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

export const encodeHistoryPayload = (payload: JsonValue): Uint8Array => canonicalJsonBytes(payload);

export const validateHistoryOccurrence = (
  occurrence: HistorySemanticOccurrenceInput,
): void => {
  if (
    !nonempty(occurrence.occurrenceId) ||
    !Number.isSafeInteger(occurrence.ordinal) || occurrence.ordinal < 1 ||
    !nonempty(occurrence.observedAt)
  ) throw new TypeError('invalid history semantic occurrence');
  encodeHistoryPayload(occurrence.payload);
  if (
    occurrence.contentDigest !== undefined &&
    !nonempty(occurrence.contentDigest)
  ) {
    throw new TypeError('invalid history content digest');
  }
  for (const relation of occurrence.relations ?? []) {
    if (
      !nonempty(relation.relation) || !nonempty(relation.targetOccurrenceId)
    ) {
      throw new TypeError('invalid history semantic relation');
    }
  }
};
