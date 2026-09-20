/** Increment 90's storage-neutral history contract. */
export const HISTORY_LOGICAL_SCHEMA_VERSION = 1 as const;

export type HistoryAuthority =
  | 'transport_observation'
  | 'contemporaneous_interpretation'
  | 'host_decision'
  | 'attribution'
  | 'derived_projection';

export type HistoryLogicalRecordKind =
  | 'transport_request'
  | 'transport_response_chunk'
  | 'sse_event'
  | 'parser_transition'
  | 'runtime_event'
  | 'tool_event'
  | 'effect_event'
  | 'execution_decision'
  | 'canonical_adoption'
  | 'resource_attribution'
  | 'reinterpretation';

export interface HistoryLogicalCost {
  /** Bytes presented without a previously validated immutable reference. */
  readonly unreferencedInputBytes: number;
  readonly logicalRecords: number;
  readonly validatedFragmentRefs: number;
  readonly edgeAndRootEdits: number;
  readonly indexOperations: number;
  readonly indexKeyBytes: number;
  readonly microsegments: number;
  /** Provider body bytes emitted at the adapter capture boundary. */
  readonly wireBytes: number;
  /** History-only passes over a complete body after adapter serialization. */
  readonly postHocFullBodyPasses: number;
  readonly preexistingPayloadBytesDecoded: number;
  readonly preexistingPayloadBytesRehashed: number;
  readonly preexistingPayloadBytesReencoded: number;
  readonly oldSegmentLogicalRewrites: number;
}

export const emptyHistoryLogicalCost = (): HistoryLogicalCost => ({
  unreferencedInputBytes: 0,
  logicalRecords: 0,
  validatedFragmentRefs: 0,
  edgeAndRootEdits: 0,
  indexOperations: 0,
  indexKeyBytes: 0,
  microsegments: 0,
  wireBytes: 0,
  postHocFullBodyPasses: 0,
  preexistingPayloadBytesDecoded: 0,
  preexistingPayloadBytesRehashed: 0,
  preexistingPayloadBytesReencoded: 0,
  oldSegmentLogicalRewrites: 0,
});

const COST_FIELDS = Object.keys(emptyHistoryLogicalCost()) as (keyof HistoryLogicalCost)[];

export const addHistoryLogicalCost = (
  left: HistoryLogicalCost,
  right: Partial<HistoryLogicalCost>,
): HistoryLogicalCost => {
  const result = { ...left } as Record<keyof HistoryLogicalCost, number>;
  for (const field of COST_FIELDS) {
    const value = right[field] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`invalid history cost: ${field}`);
    }
    result[field] += value;
  }
  return result;
};

export interface V5AuthorityInventoryEntry {
  readonly table: string;
  readonly authority: HistoryAuthority;
  readonly v6Disposition:
    | 'retain_semantics'
    | 'replace_representation'
    | 'rebuild_projection'
    | 'remove_duplicate';
  readonly note: string;
}

/**
 * Every application table in history-v5.sqlite3 has exactly one primary semantic owner here.
 * Foreign keys may point across owners; those references do not create a second authority owner.
 */
export const V5_AUTHORITY_INVENTORY: readonly V5AuthorityInventoryEntry[] = [
  ['store_metadata', 'host_decision', 'replace_representation', 'store identity and schema'],
  ['sessions', 'host_decision', 'retain_semantics', 'canonical session head'],
  ['session_model_changes', 'host_decision', 'retain_semantics', 'model selection decisions'],
  ['semantic_checkpoints', 'derived_projection', 'rebuild_projection', 'working-context summary'],
  ['tasks', 'host_decision', 'retain_semantics', 'admitted user task'],
  ['executions', 'host_decision', 'replace_representation', 'execution admission and lifecycle'],
  ['execution_outcomes', 'host_decision', 'replace_representation', 'terminal decision'],
  ['canonical_turns', 'host_decision', 'retain_semantics', 'canonical adoption'],
  ['execution_messages', 'derived_projection', 'rebuild_projection', 'human transcript projection'],
  ['execution_projections', 'derived_projection', 'rebuild_projection', 'explicit projection'],
  ['provider_evidence', 'transport_observation', 'replace_representation', 'capture catalog'],
  [
    'model_requests',
    'transport_observation',
    'replace_representation',
    'request occurrence catalog',
  ],
  ['context_blobs', 'attribution', 'replace_representation', 'shared exact resource bytes'],
  ['context_occurrences', 'attribution', 'replace_representation', 'resource occurrences'],
  ['context_occurrence_sources', 'attribution', 'replace_representation', 'resource provenance'],
  [
    'context_sequence_revisions',
    'attribution',
    'replace_representation',
    'context sequence lineage',
  ],
  ['context_sequence_splices', 'attribution', 'replace_representation', 'context sequence edit'],
  [
    'context_sequence_insertions',
    'attribution',
    'replace_representation',
    'context sequence edit values',
  ],
  [
    'execution_context_relations',
    'attribution',
    'replace_representation',
    'execution resource provenance',
  ],
  ['execution_context_counters', 'attribution', 'replace_representation', 'attribution allocator'],
  [
    'provider_request_contexts',
    'attribution',
    'replace_representation',
    'wire-to-context correlation',
  ],
  ['context_tool_calls', 'attribution', 'replace_representation', 'tool causal lookup'],
  [
    'failure_diagnostics',
    'contemporaneous_interpretation',
    'replace_representation',
    'failure interpretation',
  ],
  ['diagnostic_evidence_links', 'attribution', 'replace_representation', 'diagnostic correlation'],
  [
    'execution_artifacts',
    'host_decision',
    'remove_duplicate',
    'settlement snapshot duplicated by ledger',
  ],
  ['worker_generations', 'attribution', 'retain_semantics', 'worker identity'],
  [
    'worker_protocol_observations',
    'contemporaneous_interpretation',
    'replace_representation',
    'protocol fact',
  ],
  [
    'execution_artifact_trace',
    'attribution',
    'replace_representation',
    'protocol-to-settlement correlation',
  ],
  [
    'execution_observations',
    'contemporaneous_interpretation',
    'remove_duplicate',
    'generic JSON envelope copy',
  ],
  [
    'runtime_occurrences',
    'contemporaneous_interpretation',
    'replace_representation',
    'runtime interpretation',
  ],
  [
    'provider_observation_facts',
    'transport_observation',
    'replace_representation',
    'normalized provider fact',
  ],
  [
    'execution_progress_deltas',
    'contemporaneous_interpretation',
    'replace_representation',
    'stream delta',
  ],
  ['execution_effects', 'host_decision', 'replace_representation', 'effect lifecycle state'],
].map(([table, authority, v6Disposition, note]) => ({
  table,
  authority,
  v6Disposition,
  note,
})) as readonly V5AuthorityInventoryEntry[];

export const assertCompleteV5AuthorityInventory = (tables: readonly string[]): void => {
  const expected = [...new Set(tables)].sort();
  const actual = V5_AUTHORITY_INVENTORY.map((entry) => entry.table).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `v5 authority inventory mismatch: expected=${JSON.stringify(expected)} actual=${
        JSON.stringify(actual)
      }`,
    );
  }
};
