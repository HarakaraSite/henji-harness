import { backup, DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  decodeExactBytePlan,
  encodeExactBytePlan,
  exactByteDigest,
  type ExactBytePlan,
  materializeExactBytePlan,
  type ValidatedExactByteObjectRef,
} from './exact_byte_plan.ts';
import {
  decodeHistoryLogicalRecord,
  encodeHistoryLogicalRecord,
  type HistoryLogicalRecord,
} from './history_record_codec.ts';
import {
  decodeHistorySegment,
  type EncodedHistorySegment,
  type HistorySegmentCodec,
  type HistorySegmentPolicy,
  segmentHistoryRecords,
} from './history_segment_codec.ts';
import {
  addHistoryLogicalCost,
  emptyHistoryLogicalCost,
  type HistoryLogicalCost,
} from './history_authority.ts';
import {
  type PersistentSequenceNode,
  type PersistentSequenceNodeSummary,
  type PersistentSequenceRoot,
  PersistentSequenceStore,
  validatePersistentSequenceNode,
} from './persistent_sequence.ts';

export const HISTORY_V6_SCHEMA_VERSION = 6 as const;

export type HistoryV6FaultPhase =
  | 'before_transaction'
  | 'after_objects'
  | 'after_segments'
  | 'after_catalog'
  | 'before_commit'
  | 'after_commit';

export interface HistoryV6ExactObjectInput {
  readonly bytes: Uint8Array;
  readonly logicalDigest?: string;
  /** Avoids rehash when the capture boundary already established this immutable identity. */
  readonly validatedRef?: ValidatedExactByteObjectRef;
}

export interface HistoryV6ByteStreamInput {
  readonly streamId: string;
  readonly plan: ExactBytePlan;
}

export interface HistoryV6SequenceRevisionInput {
  readonly revisionId: string;
  readonly root: PersistentSequenceRoot;
  readonly parentRoot: PersistentSequenceRoot;
  readonly itemCount: number;
  /** A complete reachable node set for this root; global dedup happens on insert. */
  readonly nodes: readonly PersistentSequenceNode[];
}

export interface HistoryV6ProjectionInput {
  readonly projectionKind: string;
  readonly projectionKey: string;
  readonly sourceThroughOrdinal: number;
  readonly text: string;
}

export interface HistoryV6SearchDocumentInput {
  readonly recordId: string;
  readonly text: string;
}

export interface HistoryV6AppendBatch {
  readonly executionId: string;
  readonly expectedLatestOrdinal: number;
  readonly objects?: readonly HistoryV6ExactObjectInput[];
  readonly byteStreams?: readonly HistoryV6ByteStreamInput[];
  readonly sequenceRevisions?: readonly HistoryV6SequenceRevisionInput[];
  readonly records: readonly HistoryLogicalRecord[];
  readonly terminalRecordId?: string;
  readonly projections?: readonly HistoryV6ProjectionInput[];
  readonly searchDocuments?: readonly HistoryV6SearchDocumentInput[];
}

export interface HistoryV6ExecutionLedger {
  readonly executionId: string;
  readonly sessionId: string;
  readonly lifecycle: 'active' | 'settled';
  readonly outcome:
    | 'unknown'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  readonly adoption: 'non_canonical' | 'canonical';
  readonly baseSessionRevision: number;
  readonly generation: string;
  readonly latestOrdinal: number;
  readonly recordCount: number;
  readonly orderedRoot: string;
  readonly terminalRecordId?: string;
  readonly unresolvedReferenceCount: number;
}

export interface HistoryV6AppendReceipt {
  readonly executionId: string;
  readonly firstOrdinal: number;
  readonly latestOrdinal: number;
  readonly recordCount: number;
  readonly segmentCount: number;
  readonly orderedRoot: string;
  readonly unresolvedReferenceCount: number;
  readonly cost: HistoryLogicalCost;
}

export interface HistoryV6RecordMetadata {
  readonly recordId: string;
  readonly ordinal: number;
  readonly authority: string;
  readonly kind: string;
  readonly observedAt: string;
  readonly segmentId: string;
}

export interface HistoryV6RecordPage {
  readonly records: readonly HistoryV6RecordMetadata[];
  readonly nextAfterOrdinal?: number;
}

export interface HistoryV6RecordDetail {
  readonly record: HistoryLogicalRecord;
  readonly objects: Readonly<Record<string, Uint8Array>>;
  readonly byteStreams: Readonly<Record<string, Uint8Array>>;
}

export type HistoryV6ExactExportEntry =
  | {
    readonly kind: 'record';
    readonly recordId: string;
    readonly bytes: Uint8Array;
  }
  | {
    readonly kind: 'object';
    readonly digest: string;
    readonly bytes: Uint8Array;
  }
  | {
    readonly kind: 'byte_stream';
    readonly streamId: string;
    readonly bytes: Uint8Array;
  };

export interface HistoryV6SegmentImpact {
  readonly segmentId: string;
  readonly executionId: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly recordCount: number;
}

export interface HistoryV6AuditReport {
  readonly integrity: 'ok';
  readonly executions: number;
  readonly records: number;
  readonly segments: number;
  readonly exactObjects: number;
  readonly byteStreams: number;
  readonly sequenceRevisions: number;
}

export interface HistoryV6BackupReport {
  readonly destinationPath: string;
  readonly schemaVersion: 6;
  readonly integrity: 'ok';
  readonly executions: number;
  readonly records: number;
}

export interface HistoryV6CheckpointReport {
  readonly mode: 'passive' | 'truncate';
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

export interface HistoryV6StoreOptions {
  readonly segmentCodec?: HistorySegmentCodec;
  readonly segmentPolicy?: HistorySegmentPolicy;
  readonly fault?: (phase: HistoryV6FaultPhase) => void;
}

export interface HistoryV6AdoptionState {
  readonly session: HistoryV6SessionStateInput;
  readonly updatedAt: string;
  readonly outcomeJson: string;
  readonly evidenceId?: string;
  readonly diagnosticId?: string;
  readonly artifactId?: string;
}

export interface HistoryV6ExecutionMessageInput {
  readonly ordinal: number;
  readonly turn: number;
  readonly json: string;
}

export interface HistoryV6SessionStateInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly stateRevision: number;
  readonly agent: 'default' | 'planner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly nextTurn: number;
  readonly definitionJson: string;
  readonly activeModelJson: string;
  readonly expectedMessageCount: number;
  readonly messages: readonly {
    readonly ordinal: number;
    readonly turn: number;
    readonly json: string;
  }[];
  readonly expectedModelChangeCount: number;
  readonly modelChanges: readonly {
    readonly ordinal: number;
    readonly effectiveFromTurn: number;
    readonly changedAt: string;
    readonly selectionJson: string;
  }[];
  readonly expectedTurnCount: number;
  readonly turns: readonly {
    readonly ordinal: number;
    readonly turn: number;
    readonly modelJson: string;
    readonly buildJson: string;
    readonly definitionJson: string;
    readonly executionId?: string;
  }[];
}

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;
const encoder = new TextEncoder();

const DEFAULT_POLICY: HistorySegmentPolicy = {
  maxUncompressedBytes: 65_536,
  maxRecords: 128,
  maxFlushLatencyMs: 25,
};

const SCHEMA = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  state_revision INTEGER NOT NULL,
  canonical_execution_id TEXT,
  workspace_root TEXT,
  record_bytes BLOB,
  checkpoint_bytes BLOB,
  updated_at TEXT,
  agent TEXT,
  created_at_session TEXT,
  title TEXT,
  next_turn INTEGER,
  definition_json TEXT,
  active_model_json TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  model_change_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_model_changes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  change_ordinal INTEGER NOT NULL,
  effective_from_turn INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  PRIMARY KEY (session_id, change_ordinal)
);
CREATE TABLE session_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_ordinal INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  execution_id TEXT,
  PRIMARY KEY (session_id, turn),
  UNIQUE (session_id, turn_ordinal)
);
CREATE TABLE session_messages (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  logical_digest TEXT NOT NULL,
  representation_digest TEXT NOT NULL,
  encoded_bytes BLOB NOT NULL,
  PRIMARY KEY (session_id, message_ordinal)
);
CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  history_session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  base_session_revision INTEGER NOT NULL,
  generation TEXT NOT NULL,
  latest_ordinal INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  ordered_root TEXT NOT NULL,
  terminal_record_id TEXT,
  unresolved_reference_count INTEGER NOT NULL,
  metadata_json TEXT,
  created_at TEXT,
  settled_at TEXT,
  outcome_json TEXT,
  evidence_id TEXT,
  diagnostic_id TEXT,
  artifact_id TEXT,
  base_message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX executions_history_session_turn
  ON executions(history_session_id, turn_number, created_at, execution_id);
CREATE TABLE execution_messages (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  logical_digest TEXT NOT NULL,
  representation_digest TEXT NOT NULL,
  encoded_bytes BLOB NOT NULL,
  PRIMARY KEY (execution_id, message_ordinal)
);
CREATE TABLE exact_objects (
  logical_digest TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  representation_codec TEXT NOT NULL,
  representation_digest TEXT NOT NULL,
  encoded_length INTEGER NOT NULL,
  encoded_bytes BLOB NOT NULL
);
CREATE TABLE byte_streams (
  stream_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  capture_boundary TEXT NOT NULL,
  serializer_version TEXT NOT NULL,
  content_encoding TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  whole_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_bytes BLOB NOT NULL
);
CREATE TABLE byte_stream_object_refs (
  stream_id TEXT NOT NULL REFERENCES byte_streams(stream_id) ON DELETE CASCADE,
  fragment_ordinal INTEGER NOT NULL,
  object_digest TEXT NOT NULL REFERENCES exact_objects(logical_digest),
  PRIMARY KEY (stream_id, fragment_ordinal)
);
CREATE TABLE sequence_nodes (
  digest TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  height INTEGER NOT NULL,
  value TEXT,
  left_digest TEXT REFERENCES sequence_nodes(digest),
  right_digest TEXT REFERENCES sequence_nodes(digest)
);
CREATE TABLE sequence_revisions (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  root_digest TEXT REFERENCES sequence_nodes(digest),
  parent_root_digest TEXT,
  item_count INTEGER NOT NULL,
  PRIMARY KEY (execution_id, revision_id)
);
CREATE TABLE history_segments (
  segment_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  first_ordinal INTEGER NOT NULL,
  last_ordinal INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  kind_summary_json TEXT NOT NULL,
  codec TEXT NOT NULL,
  uncompressed_length INTEGER NOT NULL,
  encoded_length INTEGER NOT NULL,
  logical_digest TEXT NOT NULL,
  representation_digest TEXT NOT NULL,
  encoded_bytes BLOB NOT NULL,
  UNIQUE (execution_id, first_ordinal),
  UNIQUE (execution_id, last_ordinal)
);
CREATE TABLE record_anchors (
  record_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  authority TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  segment_id TEXT NOT NULL REFERENCES history_segments(segment_id),
  segment_record_index INTEGER NOT NULL,
  encoded_record_digest TEXT NOT NULL,
  UNIQUE (execution_id, ordinal)
);
CREATE TABLE record_object_refs (
  record_id TEXT NOT NULL REFERENCES record_anchors(record_id) ON DELETE CASCADE,
  ref_ordinal INTEGER NOT NULL,
  object_digest TEXT NOT NULL REFERENCES exact_objects(logical_digest),
  PRIMARY KEY (record_id, ref_ordinal)
);
CREATE TABLE record_byte_ranges (
  record_id TEXT NOT NULL REFERENCES record_anchors(record_id) ON DELETE CASCADE,
  range_ordinal INTEGER NOT NULL,
  stream_id TEXT NOT NULL REFERENCES byte_streams(stream_id),
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  PRIMARY KEY (record_id, range_ordinal)
);
CREATE TABLE record_causes (
  record_id TEXT NOT NULL REFERENCES record_anchors(record_id) ON DELETE CASCADE,
  cause_ordinal INTEGER NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  cause_record_id TEXT NOT NULL,
  resolved INTEGER NOT NULL,
  PRIMARY KEY (record_id, cause_ordinal)
);
CREATE INDEX record_causes_unresolved
  ON record_causes(execution_id, resolved, cause_record_id);
CREATE INDEX record_anchors_execution_authority_kind_ordinal
  ON record_anchors(execution_id, authority, record_kind, ordinal);
CREATE INDEX record_anchors_execution_authority_ordinal
  ON record_anchors(execution_id, authority, ordinal);
CREATE INDEX record_anchors_execution_kind_ordinal
  ON record_anchors(execution_id, record_kind, ordinal);
CREATE TABLE projections (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL,
  projection_key TEXT NOT NULL,
  source_through_ordinal INTEGER NOT NULL,
  projected_text TEXT NOT NULL,
  PRIMARY KEY (execution_id, projection_kind, projection_key)
);
CREATE VIRTUAL TABLE record_search USING fts5(
  record_id UNINDEXED,
  execution_id,
  search_text,
  tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE human_history_search USING fts5(
  entry_id UNINDEXED,
  execution_id UNINDEXED,
  session_id UNINDEXED,
  search_text,
  tokenize = 'trigram case_sensitive 1'
);
CREATE TABLE canonical_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  session_revision INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);
CREATE TABLE captured_documents (
  document_kind TEXT NOT NULL,
  document_id TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(execution_id) ON DELETE CASCADE,
  document_bytes BLOB NOT NULL,
  PRIMARY KEY (document_kind, document_id)
);
CREATE INDEX captured_documents_execution_kind
  ON captured_documents(execution_id, document_kind, document_id);
INSERT INTO store_metadata(singleton, schema_version, created_at)
VALUES (1, 6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 6;
`;

const nonempty = (value: string, name: string): void => {
  if (!value || value.includes('\0')) throw new TypeError(`invalid ${name}`);
};

const safeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`invalid ${name}`);
  }
};

const ledgerSeed = (executionId: string): string =>
  exactByteDigest(encoder.encode(`henji-execution-ledger-v1\0${executionId}`));

const advanceLedgerRoot = (
  root: string,
  record: HistoryLogicalRecord,
  encoded: Uint8Array,
): string =>
  exactByteDigest(
    encoder.encode(
      `henji-execution-ledger-entry-v1\0${root}\0${record.recordId}\0${record.ordinal}\0${
        exactByteDigest(encoded)
      }`,
    ),
  );

export class SqliteHistoryV6Store {
  readonly #db: DatabaseSync;
  readonly #codec: HistorySegmentCodec;
  readonly #policy: HistorySegmentPolicy;
  readonly #fault?: (phase: HistoryV6FaultPhase) => void;

  constructor(
    readonly databasePath: string,
    options: HistoryV6StoreOptions = {},
  ) {
    if (!databasePath.startsWith('/') || databasePath.includes('\0')) {
      throw new TypeError('v6 database path must be absolute');
    }
    this.#codec = options.segmentCodec ?? 'gzip-6';
    this.#policy = options.segmentPolicy ?? DEFAULT_POLICY;
    this.#fault = options.fault;
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    const version = Number(
      (this.#db.prepare('PRAGMA user_version').get() as Row).user_version,
    );
    if (version === 0) {
      this.#db.exec('PRAGMA journal_mode = WAL;');
      this.#db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    } else if (version !== HISTORY_V6_SCHEMA_VERSION) {
      this.#db.close();
      throw new Error(`unsupported isolated history schema: ${version}`);
    } else {
      const metadata = this.#db.prepare(`
        SELECT schema_version FROM store_metadata WHERE singleton = 1
      `).get() as Row | undefined;
      if (
        metadata === undefined ||
        Number(metadata.schema_version) !== HISTORY_V6_SCHEMA_VERSION
      ) {
        this.#db.close();
        throw new Error('invalid isolated history v6 metadata');
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  writeSessionState(state: HistoryV6SessionStateInput): void {
    this.#transaction(() => this.#applySessionState(state));
  }

  replaceSessionState(state: HistoryV6SessionStateInput): void {
    this.#transaction(() => {
      this.#db.prepare(`
        DELETE FROM session_messages
        WHERE session_id = ? AND message_ordinal >= ?
      `).run(state.sessionId, state.expectedMessageCount);
      this.#db.prepare(`
        DELETE FROM session_model_changes
        WHERE session_id = ? AND change_ordinal >= ?
      `).run(state.sessionId, state.expectedModelChangeCount);
      this.#db.prepare(`
        DELETE FROM session_turns WHERE session_id = ? AND turn_ordinal >= ?
      `).run(state.sessionId, state.expectedTurnCount);
      this.#db.prepare(`
        UPDATE sessions SET message_count = ?, model_change_count = ?, turn_count = ?
        WHERE session_id = ?
      `).run(
        state.expectedMessageCount,
        state.expectedModelChangeCount,
        state.expectedTurnCount,
        state.sessionId,
      );
      this.#applySessionState(state);
    });
  }

  beginExecution(
    executionId: string,
    sessionId: string,
    baseSessionRevision: number,
    generation: string,
    metadata?: Readonly<{ json: string; createdAt: string }>,
    baseMessageCount = 0,
    historySessionId = sessionId,
    turnNumber = 0,
  ): HistoryV6ExecutionLedger {
    nonempty(executionId, 'execution id');
    nonempty(sessionId, 'session id');
    nonempty(generation, 'generation');
    safeInteger(baseSessionRevision, 'base session revision');
    safeInteger(baseMessageCount, 'base message count');
    nonempty(historySessionId, 'history session id');
    safeInteger(turnNumber, 'history turn number');
    this.#transaction(() => {
      this.#db.prepare(`
        INSERT INTO sessions(session_id, state_revision, canonical_execution_id)
        VALUES (?, ?, NULL) ON CONFLICT(session_id) DO NOTHING
      `).run(sessionId, baseSessionRevision);
      const session = this.#row(
        'SELECT state_revision FROM sessions WHERE session_id = ?',
        sessionId,
      );
      if (Number(session.state_revision) !== baseSessionRevision) {
        throw new Error('v6 session revision mismatch');
      }
      this.#db.prepare(`
        INSERT INTO executions(
          execution_id, session_id, history_session_id, turn_number, lifecycle, outcome, adoption,
          base_session_revision, generation, latest_ordinal, record_count,
          ordered_root, terminal_record_id, unresolved_reference_count, metadata_json, created_at,
          base_message_count
        ) VALUES (?, ?, ?, ?, 'active', 'unknown', 'non_canonical', ?, ?, 0, 0, ?, NULL, 0, ?, ?, ?)
      `).run(
        executionId,
        sessionId,
        historySessionId,
        turnNumber,
        baseSessionRevision,
        generation,
        ledgerSeed(executionId),
        metadata?.json ?? null,
        metadata?.createdAt ?? null,
        baseMessageCount,
      );
    });
    return this.readLedger(executionId);
  }

  append(batch: HistoryV6AppendBatch): HistoryV6AppendReceipt {
    nonempty(batch.executionId, 'execution id');
    safeInteger(batch.expectedLatestOrdinal, 'expected latest ordinal');
    if (batch.records.length === 0) {
      throw new TypeError('v6 append batch must contain records');
    }
    const encodedRecords = batch.records.map((record) => {
      if (record.executionId !== batch.executionId) {
        throw new TypeError('record execution mismatch');
      }
      return encodeHistoryLogicalRecord(record);
    });
    for (let index = 0; index < batch.records.length; index += 1) {
      const expected = batch.expectedLatestOrdinal + index + 1;
      if (batch.records[index].ordinal !== expected) {
        throw new TypeError('record ordinals are not contiguous');
      }
    }
    const segments = segmentHistoryRecords(
      encodedRecords,
      this.#policy,
      this.#codec,
    );
    this.#fault?.('before_transaction');
    let receipt: HistoryV6AppendReceipt | undefined;
    this.#transaction(() => {
      const ledger = this.#ledgerRow(batch.executionId);
      if (
        ledger.lifecycle !== 'active' ||
        Number(ledger.latest_ordinal) !== batch.expectedLatestOrdinal ||
        ledger.terminal_record_id !== null
      ) throw new Error('v6 append fence mismatch');

      let cost = emptyHistoryLogicalCost();
      for (const object of batch.objects ?? []) {
        if (
          object.validatedRef !== undefined &&
          object.validatedRef.byteLength !== object.bytes.byteLength
        ) throw new Error('v6 validated exact object length mismatch');
        const digest = object.validatedRef?.digest ??
          exactByteDigest(object.bytes);
        if (
          object.logicalDigest !== undefined && object.logicalDigest !== digest
        ) {
          throw new Error('v6 exact object logical digest mismatch');
        }
        const existing = this.#optionalRow(
          'SELECT byte_length FROM exact_objects WHERE logical_digest = ?',
          digest,
        );
        if (existing === undefined) {
          const encoded = new Uint8Array(
            brotliCompressSync(object.bytes, {
              params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
            }),
          );
          this.#db.prepare(`
            INSERT INTO exact_objects(
              logical_digest, byte_length, representation_codec,
              representation_digest, encoded_length, encoded_bytes
            ) VALUES (?, ?, 'brotli-5', ?, ?, ?)
          `).run(
            digest,
            object.bytes.byteLength,
            exactByteDigest(encoded),
            encoded.byteLength,
            encoded,
          );
          cost = addHistoryLogicalCost(cost, {
            unreferencedInputBytes: object.bytes.byteLength,
            indexOperations: 1,
            indexKeyBytes: digest.length,
          });
        } else if (Number(existing.byte_length) !== object.bytes.byteLength) {
          throw new Error('v6 exact object metadata mismatch');
        }
      }

      for (const stream of batch.byteStreams ?? []) {
        nonempty(stream.streamId, 'stream id');
        const manifest = encodeExactBytePlan(stream.plan);
        this.#db.prepare(`
          INSERT INTO byte_streams(
            stream_id, execution_id, capture_boundary, serializer_version,
            content_encoding, byte_length, whole_digest, manifest_digest, manifest_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          stream.streamId,
          batch.executionId,
          stream.plan.captureBoundary,
          stream.plan.serializerVersion,
          stream.plan.contentEncoding,
          stream.plan.byteLength,
          stream.plan.digest,
          exactByteDigest(manifest),
          manifest,
        );
        for (
          let ordinal = 0;
          ordinal < stream.plan.fragments.length;
          ordinal += 1
        ) {
          const fragment = stream.plan.fragments[ordinal];
          if (fragment.kind === 'literal') {
            cost = addHistoryLogicalCost(cost, {
              unreferencedInputBytes: fragment.bytes.byteLength,
            });
            continue;
          }
          const object = this.#optionalRow(
            'SELECT byte_length FROM exact_objects WHERE logical_digest = ?',
            fragment.object.digest,
          );
          if (
            object === undefined ||
            Number(object.byte_length) !== fragment.object.byteLength
          ) {
            throw new Error('v6 byte stream object ref is unresolved');
          }
          this.#db.prepare(`
            INSERT INTO byte_stream_object_refs(stream_id, fragment_ordinal, object_digest)
            VALUES (?, ?, ?)
          `).run(stream.streamId, ordinal, fragment.object.digest);
          cost = addHistoryLogicalCost(cost, {
            validatedFragmentRefs: 1,
            indexOperations: 1,
          });
        }
        cost = addHistoryLogicalCost(cost, {
          wireBytes: stream.plan.byteLength,
        });
      }

      for (const revision of batch.sequenceRevisions ?? []) {
        nonempty(revision.revisionId, 'sequence revision id');
        safeInteger(revision.itemCount, 'sequence item count');
        const newNodes = new Map<string, PersistentSequenceNodeSummary>();
        const resolveNode = (
          digest: string,
        ): PersistentSequenceNodeSummary | undefined => {
          const current = newNodes.get(digest);
          if (current !== undefined) return current;
          const stored = this.#optionalRow(
            'SELECT item_count, height FROM sequence_nodes WHERE digest = ?',
            digest,
          );
          return stored === undefined ? undefined : {
            count: Number(stored.item_count),
            height: Number(stored.height),
          };
        };
        for (const node of revision.nodes) {
          validatePersistentSequenceNode(node, resolveNode);
          newNodes.set(node.digest, { count: node.count, height: node.height });
        }
        const rootSummary = revision.root === null ? undefined : resolveNode(revision.root);
        if (
          revision.root === null ? revision.itemCount !== 0 : rootSummary === undefined ||
            rootSummary.count !== revision.itemCount
        ) {
          throw new Error('v6 sequence root count mismatch');
        }
        for (const node of revision.nodes) {
          if (node.kind === 'leaf') {
            this.#db.prepare(`
              INSERT INTO sequence_nodes(
                digest, node_kind, item_count, height, value, left_digest, right_digest
              ) VALUES (?, 'leaf', 1, 1, ?, NULL, NULL)
              ON CONFLICT(digest) DO NOTHING
            `).run(node.digest, node.value);
          } else {
            this.#db.prepare(`
              INSERT INTO sequence_nodes(
                digest, node_kind, item_count, height, value, left_digest, right_digest
              ) VALUES (?, 'branch', ?, ?, NULL, ?, ?)
              ON CONFLICT(digest) DO NOTHING
            `).run(node.digest, node.count, node.height, node.left, node.right);
          }
        }
        if (revision.parentRoot !== null) {
          const parent = this.#optionalRow(
            'SELECT 1 AS present FROM sequence_revisions WHERE execution_id = ? AND root_digest = ?',
            batch.executionId,
            revision.parentRoot,
          );
          if (parent === undefined) {
            throw new Error('v6 sequence parent root is unknown');
          }
        }
        this.#db.prepare(`
          INSERT INTO sequence_revisions(
            execution_id, revision_id, root_digest, parent_root_digest, item_count
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          batch.executionId,
          revision.revisionId,
          revision.root,
          revision.parentRoot,
          revision.itemCount,
        );
        cost = addHistoryLogicalCost(cost, {
          edgeAndRootEdits: 1,
          indexOperations: revision.nodes.length + 1,
        });
      }
      this.#fault?.('after_objects');

      let recordCursor = 0;
      const segmentRows: {
        segmentId: string;
        segment: EncodedHistorySegment;
        start: number;
      }[] = [];
      for (const segment of segments) {
        const start = recordCursor;
        const first = batch.records[start].ordinal;
        const last = batch.records[start + segment.recordCount - 1].ordinal;
        const segmentId = exactByteDigest(
          encoder.encode(
            `henji-segment-id-v1\0${batch.executionId}\0${first}\0${last}\0${segment.logicalDigest}`,
          ),
        );
        const kinds = [
          ...new Set(
            batch.records.slice(start, start + segment.recordCount).map((
              record,
            ) => record.kind),
          ),
        ].sort();
        this.#db.prepare(`
          INSERT INTO history_segments(
            segment_id, execution_id, first_ordinal, last_ordinal, record_count,
            kind_summary_json, codec, uncompressed_length, encoded_length,
            logical_digest, representation_digest, encoded_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          segmentId,
          batch.executionId,
          first,
          last,
          segment.recordCount,
          JSON.stringify(kinds),
          segment.codec,
          segment.uncompressedBytes,
          segment.encodedBytes,
          segment.logicalDigest,
          segment.representationDigest,
          segment.bytes,
        );
        segmentRows.push({ segmentId, segment, start });
        recordCursor += segment.recordCount;
      }
      this.#fault?.('after_segments');

      let orderedRoot = String(ledger.ordered_root);
      for (const segmentRow of segmentRows) {
        for (
          let local = 0;
          local < segmentRow.segment.recordCount;
          local += 1
        ) {
          const index = segmentRow.start + local;
          const record = batch.records[index];
          const encoded = encodedRecords[index];
          this.#db.prepare(`
            INSERT INTO record_anchors(
              record_id, execution_id, ordinal, authority, record_kind, observed_at,
              segment_id, segment_record_index, encoded_record_digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            record.recordId,
            record.executionId,
            record.ordinal,
            record.authority,
            record.kind,
            record.observedAt,
            segmentRow.segmentId,
            local,
            exactByteDigest(encoded),
          );
          orderedRoot = advanceLedgerRoot(orderedRoot, record, encoded);
        }
      }

      for (const record of batch.records) {
        for (
          let ordinal = 0;
          ordinal < record.objectRefs.length;
          ordinal += 1
        ) {
          const digest = record.objectRefs[ordinal];
          if (
            this.#optionalRow(
              'SELECT 1 AS present FROM exact_objects WHERE logical_digest = ?',
              digest,
            ) === undefined
          ) throw new Error('v6 record object ref is unresolved');
          this.#db.prepare(`
            INSERT INTO record_object_refs(record_id, ref_ordinal, object_digest)
            VALUES (?, ?, ?)
          `).run(record.recordId, ordinal, digest);
        }
        for (
          let ordinal = 0;
          ordinal < record.byteRanges.length;
          ordinal += 1
        ) {
          const range = record.byteRanges[ordinal];
          const stream = this.#optionalRow(
            'SELECT byte_length FROM byte_streams WHERE stream_id = ? AND execution_id = ?',
            range.streamId,
            batch.executionId,
          );
          if (stream === undefined || range.end > Number(stream.byte_length)) {
            throw new Error('v6 record byte range is unresolved');
          }
          this.#db.prepare(`
            INSERT INTO record_byte_ranges(
              record_id, range_ordinal, stream_id, start_offset, end_offset
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            record.recordId,
            ordinal,
            range.streamId,
            range.start,
            range.end,
          );
        }
        for (let ordinal = 0; ordinal < record.causes.length; ordinal += 1) {
          const cause = record.causes[ordinal];
          const resolved = this.#optionalRow(
              'SELECT 1 AS present FROM record_anchors WHERE record_id = ? AND execution_id = ?',
              cause.recordId,
              batch.executionId,
            ) === undefined
            ? 0
            : 1;
          this.#db.prepare(`
            INSERT INTO record_causes(
              record_id, cause_ordinal, execution_id, relation, cause_record_id, resolved
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            record.recordId,
            ordinal,
            batch.executionId,
            cause.relation,
            cause.recordId,
            resolved,
          );
        }
      }
      const resolveCauses = this.#db.prepare(`
        UPDATE record_causes SET resolved = 1
        WHERE execution_id = ? AND resolved = 0 AND cause_record_id = ?
      `);
      for (const record of batch.records) {
        resolveCauses.run(batch.executionId, record.recordId);
      }

      for (const projection of batch.projections ?? []) {
        nonempty(projection.projectionKind, 'projection kind');
        nonempty(projection.projectionKey, 'projection key');
        safeInteger(projection.sourceThroughOrdinal, 'projection watermark');
        if (projection.sourceThroughOrdinal > batch.records.at(-1)!.ordinal) {
          throw new Error('v6 projection watermark exceeds durable prefix');
        }
        this.#db.prepare(`
          INSERT INTO projections(
            execution_id, projection_kind, projection_key,
            source_through_ordinal, projected_text
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(execution_id, projection_kind, projection_key) DO UPDATE SET
            source_through_ordinal = excluded.source_through_ordinal,
            projected_text = excluded.projected_text
        `).run(
          batch.executionId,
          projection.projectionKind,
          projection.projectionKey,
          projection.sourceThroughOrdinal,
          projection.text,
        );
      }
      for (const document of batch.searchDocuments ?? []) {
        nonempty(document.recordId, 'search document record id');
        if (
          this.#optionalRow(
            'SELECT 1 AS present FROM record_anchors WHERE record_id = ? AND execution_id = ?',
            document.recordId,
            batch.executionId,
          ) === undefined
        ) throw new Error('v6 search projection source is unresolved');
        this.#db.prepare(`
          INSERT INTO record_search(record_id, execution_id, search_text)
          VALUES (?, ?, ?)
        `).run(document.recordId, batch.executionId, document.text);
      }

      const terminalRecordId = batch.terminalRecordId ??
        (ledger.terminal_record_id === null ? null : String(ledger.terminal_record_id));
      if (
        terminalRecordId !== null &&
        this.#optionalRow(
            'SELECT ordinal FROM record_anchors WHERE record_id = ? AND execution_id = ?',
            terminalRecordId,
            batch.executionId,
          )?.ordinal !== batch.records.at(-1)!.ordinal
      ) throw new Error('v6 terminal record is unresolved');
      const unresolved = Number(
        this.#row(
          'SELECT COUNT(*) AS count FROM record_causes WHERE execution_id = ? AND resolved = 0',
          batch.executionId,
        ).count,
      );
      const latestOrdinal = batch.records.at(-1)!.ordinal;
      const recordCount = Number(ledger.record_count) + batch.records.length;
      this.#db.prepare(`
        UPDATE executions SET
          latest_ordinal = ?, record_count = ?, ordered_root = ?,
          terminal_record_id = ?, unresolved_reference_count = ?
        WHERE execution_id = ?
      `).run(
        latestOrdinal,
        recordCount,
        orderedRoot,
        terminalRecordId,
        unresolved,
        batch.executionId,
      );
      cost = addHistoryLogicalCost(cost, {
        unreferencedInputBytes: encodedRecords.reduce(
          (sum, encoded) => sum + encoded.byteLength,
          0,
        ),
        logicalRecords: batch.records.length,
        validatedFragmentRefs: batch.records.reduce(
          (sum, record) => sum + record.objectRefs.length,
          0,
        ),
        edgeAndRootEdits: batch.records.reduce(
          (sum, record) => sum + record.causes.length + record.byteRanges.length + 1,
          0,
        ),
        indexOperations: batch.records.length * 3,
        microsegments: segments.length,
      });
      receipt = {
        executionId: batch.executionId,
        firstOrdinal: batch.records[0].ordinal,
        latestOrdinal,
        recordCount,
        segmentCount: segments.length,
        orderedRoot,
        unresolvedReferenceCount: unresolved,
        cost,
      };
      this.#fault?.('after_catalog');
      this.#fault?.('before_commit');
    });
    this.#fault?.('after_commit');
    return receipt!;
  }

  settleExecution(
    executionId: string,
    expected: Pick<
      HistoryV6ExecutionLedger,
      'latestOrdinal' | 'recordCount' | 'orderedRoot' | 'terminalRecordId'
    >,
    outcome: HistoryV6ExecutionLedger['outcome'],
    state?: Readonly<{
      settledAt: string;
      outcomeJson?: string;
      outcomeMessages?: readonly HistoryV6ExecutionMessageInput[];
      evidenceId?: string;
      diagnosticId?: string;
      artifactId?: string;
    }>,
  ): HistoryV6ExecutionLedger {
    this.#transaction(() => {
      const ledger = this.readLedger(executionId);
      if (
        ledger.lifecycle !== 'active' ||
        ledger.unresolvedReferenceCount !== 0 ||
        ledger.latestOrdinal !== expected.latestOrdinal ||
        ledger.recordCount !== expected.recordCount ||
        ledger.orderedRoot !== expected.orderedRoot ||
        ledger.terminalRecordId === undefined ||
        ledger.terminalRecordId !== expected.terminalRecordId
      ) throw new Error('v6 settlement ledger mismatch');
      this.#db.prepare(`
        UPDATE executions SET lifecycle = 'settled', outcome = ?, settled_at = coalesce(?, settled_at),
          outcome_json = coalesce(?, outcome_json), evidence_id = coalesce(?, evidence_id),
          diagnostic_id = coalesce(?, diagnostic_id), artifact_id = coalesce(?, artifact_id)
        WHERE execution_id = ?
      `).run(
        outcome,
        state?.settledAt ?? null,
        state?.outcomeJson ?? null,
        state?.evidenceId ?? null,
        state?.diagnosticId ?? null,
        state?.artifactId ?? null,
        executionId,
      );
      if (state?.outcomeMessages !== undefined) {
        this.#applyExecutionMessages(executionId, state.outcomeMessages);
      }
    });
    return this.readLedger(executionId);
  }

  adoptExecution(executionId: string, turn: number): number {
    return this.adoptExecutionWithState(executionId, turn);
  }

  adoptExecutionWithState(
    executionId: string,
    turn: number,
    state?: HistoryV6AdoptionState,
  ): number {
    safeInteger(turn, 'canonical turn');
    let committedRevision = 0;
    this.#transaction(() => {
      const ledger = this.readLedger(executionId);
      if (
        ledger.lifecycle !== 'settled' || ledger.outcome !== 'completed' ||
        ledger.adoption !== 'non_canonical' ||
        ledger.terminalRecordId === undefined
      ) throw new Error('v6 execution is not adoptable');
      const session = this.#row(
        'SELECT state_revision FROM sessions WHERE session_id = ?',
        ledger.sessionId,
      );
      if (Number(session.state_revision) !== ledger.baseSessionRevision) {
        throw new Error('v6 canonical adoption fence mismatch');
      }
      committedRevision = ledger.baseSessionRevision + 1;
      if (state !== undefined) {
        if (
          state.session.sessionId !== ledger.sessionId ||
          state.session.stateRevision !== committedRevision
        ) throw new Error('v6 canonical session state mismatch');
        this.#applySessionState(state.session);
      } else {
        this.#db.prepare(`
          UPDATE sessions SET state_revision = ?
          WHERE session_id = ? AND state_revision = ?
        `).run(committedRevision, ledger.sessionId, ledger.baseSessionRevision);
      }
      this.#db.prepare(`
        UPDATE sessions SET canonical_execution_id = ?, updated_at = coalesce(?, updated_at)
        WHERE session_id = ?
      `).run(executionId, state?.updatedAt ?? null, ledger.sessionId);
      this.#db.prepare(`
        INSERT INTO canonical_turns(session_id, turn, execution_id, session_revision)
        VALUES (?, ?, ?, ?)
      `).run(ledger.sessionId, turn, executionId, committedRevision);
      this.#db.prepare(`
        UPDATE executions SET adoption = 'canonical', settled_at = coalesce(?, settled_at),
          outcome_json = coalesce(?, outcome_json), evidence_id = coalesce(?, evidence_id),
          diagnostic_id = coalesce(?, diagnostic_id), artifact_id = coalesce(?, artifact_id)
        WHERE execution_id = ?
      `).run(
        state?.updatedAt ?? null,
        state?.outcomeJson ?? null,
        state?.evidenceId ?? null,
        state?.diagnosticId ?? null,
        state?.artifactId ?? null,
        executionId,
      );
    });
    return committedRevision;
  }

  readLedger(executionId: string): HistoryV6ExecutionLedger {
    const row = this.#ledgerRow(executionId);
    return {
      executionId: String(row.execution_id),
      sessionId: String(row.session_id),
      lifecycle: String(row.lifecycle) as HistoryV6ExecutionLedger['lifecycle'],
      outcome: String(row.outcome) as HistoryV6ExecutionLedger['outcome'],
      adoption: String(row.adoption) as HistoryV6ExecutionLedger['adoption'],
      baseSessionRevision: Number(row.base_session_revision),
      generation: String(row.generation),
      latestOrdinal: Number(row.latest_ordinal),
      recordCount: Number(row.record_count),
      orderedRoot: String(row.ordered_root),
      ...(row.terminal_record_id === null
        ? {}
        : { terminalRecordId: String(row.terminal_record_id) }),
      unresolvedReferenceCount: Number(row.unresolved_reference_count),
    };
  }

  listRecordMetadata(executionId: string): readonly HistoryV6RecordMetadata[] {
    return (this.#db.prepare(`
      SELECT record_id, ordinal, authority, record_kind, observed_at, segment_id
      FROM record_anchors WHERE execution_id = ? ORDER BY ordinal
    `).all(executionId) as Row[]).map((row) => ({
      recordId: String(row.record_id),
      ordinal: Number(row.ordinal),
      authority: String(row.authority),
      kind: String(row.record_kind),
      observedAt: String(row.observed_at),
      segmentId: String(row.segment_id),
    }));
  }

  pageRecordMetadata(
    executionId: string,
    options: {
      readonly afterOrdinal?: number;
      readonly limit: number;
      readonly authority?: string;
      readonly kind?: string;
    },
  ): HistoryV6RecordPage {
    nonempty(executionId, 'execution id');
    safeInteger(options.afterOrdinal ?? 0, 'record page cursor');
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new TypeError('invalid record page limit');
    }
    const clauses = ['execution_id = ?', 'ordinal > ?'];
    const params: (string | number)[] = [
      executionId,
      options.afterOrdinal ?? 0,
    ];
    if (options.authority !== undefined) {
      nonempty(options.authority, 'record authority');
      clauses.push('authority = ?');
      params.push(options.authority);
    }
    if (options.kind !== undefined) {
      nonempty(options.kind, 'record kind');
      clauses.push('record_kind = ?');
      params.push(options.kind);
    }
    params.push(options.limit + 1);
    const rows = this.#db.prepare(`
      SELECT record_id, ordinal, authority, record_kind, observed_at, segment_id
      FROM record_anchors WHERE ${clauses.join(' AND ')}
      ORDER BY ordinal LIMIT ?
    `).all(...params) as Row[];
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit).map((row) => ({
      recordId: String(row.record_id),
      ordinal: Number(row.ordinal),
      authority: String(row.authority),
      kind: String(row.record_kind),
      observedAt: String(row.observed_at),
      segmentId: String(row.segment_id),
    }));
    return {
      records: page,
      ...(hasMore && page.length > 0 ? { nextAfterOrdinal: page.at(-1)!.ordinal } : {}),
    };
  }

  latestRecordMetadata(
    executionId: string,
  ): HistoryV6RecordMetadata | undefined {
    const row = this.#optionalRow(
      `SELECT record_id, ordinal, authority, record_kind, observed_at, segment_id
       FROM record_anchors WHERE execution_id = ? ORDER BY ordinal DESC LIMIT 1`,
      executionId,
    );
    return row === undefined ? undefined : {
      recordId: String(row.record_id),
      ordinal: Number(row.ordinal),
      authority: String(row.authority),
      kind: String(row.record_kind),
      observedAt: String(row.observed_at),
      segmentId: String(row.segment_id),
    };
  }

  searchRecords(executionId: string, query: string, limit: number): readonly {
    readonly recordId: string;
    readonly text: string;
    readonly rank: number;
  }[] {
    nonempty(executionId, 'execution id');
    if (!query.trim() || query.includes('\0')) {
      throw new TypeError('invalid history search query');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('invalid history search limit');
    }
    const match = query.trim().split(/\s+/u).map((term) => `"${term.replaceAll('"', '""')}"`).join(
      ' AND ',
    );
    const expression = `execution_id : "${executionId.replaceAll('"', '""')}" AND ` +
      `search_text : (${match})`;
    return (this.#db.prepare(`
      SELECT record_id, search_text, rank FROM record_search
      WHERE record_search MATCH ? AND execution_id = ?
      ORDER BY rank, rowid LIMIT ?
    `).all(expression, executionId, limit) as Row[]).map((row) => ({
      recordId: String(row.record_id),
      text: String(row.search_text),
      rank: Number(row.rank),
    }));
  }

  readProjection(
    executionId: string,
    projectionKind: string,
    projectionKey: string,
  ): { readonly sourceThroughOrdinal: number; readonly text: string } {
    const row = this.#row(
      `SELECT source_through_ordinal, projected_text FROM projections
       WHERE execution_id = ? AND projection_kind = ? AND projection_key = ?`,
      executionId,
      projectionKind,
      projectionKey,
    );
    return {
      sourceThroughOrdinal: Number(row.source_through_ordinal),
      text: String(row.projected_text),
    };
  }

  readRecord(recordId: string): HistoryLogicalRecord {
    const row = this.#row(
      `
      SELECT a.execution_id, a.ordinal, a.segment_record_index, a.encoded_record_digest,
        s.segment_id, s.record_count, s.codec, s.uncompressed_length, s.encoded_length,
        s.logical_digest, s.representation_digest, s.encoded_bytes
      FROM record_anchors a JOIN history_segments s ON s.segment_id = a.segment_id
      WHERE a.record_id = ?
    `,
      recordId,
    );
    const segment: EncodedHistorySegment = {
      schemaVersion: 1,
      codec: String(row.codec) as HistorySegmentCodec,
      recordCount: Number(row.record_count),
      uncompressedBytes: Number(row.uncompressed_length),
      encodedBytes: Number(row.encoded_length),
      logicalDigest: String(row.logical_digest),
      representationDigest: String(row.representation_digest),
      bytes: row.encoded_bytes as Uint8Array,
    };
    const encoded = decodeHistorySegment(segment)[Number(row.segment_record_index)];
    if (
      encoded === undefined ||
      exactByteDigest(encoded) !== row.encoded_record_digest
    ) {
      throw new Error('v6 record anchor digest mismatch');
    }
    const record = decodeHistoryLogicalRecord(encoded);
    if (
      record.recordId !== recordId || record.executionId !== row.execution_id ||
      record.ordinal !== Number(row.ordinal)
    ) throw new Error('v6 record anchor identity mismatch');
    return record;
  }

  async readRecordDetail(recordId: string): Promise<HistoryV6RecordDetail> {
    const record = this.readRecord(recordId);
    const objects: Record<string, Uint8Array> = {};
    for (const digest of new Set(record.objectRefs)) {
      objects[digest] = this.#readObject(digest);
    }
    const byteStreams: Record<string, Uint8Array> = {};
    for (
      const streamId of new Set(
        record.byteRanges.map((range) => range.streamId),
      )
    ) {
      byteStreams[streamId] = await this.readByteStream(streamId);
    }
    return { record, objects, byteStreams };
  }

  /** Direct verified object read for synchronous compatibility projections. */
  readExactObject(logicalDigest: string): Uint8Array {
    return this.#readObject(logicalDigest);
  }

  *exportNormalizedRecords(
    executionId: string,
    afterOrdinal = 0,
  ): Generator<Uint8Array, void, undefined> {
    safeInteger(afterOrdinal, 'normalized export cursor');
    const newline = encoder.encode('\n');
    let cursor = afterOrdinal;
    while (true) {
      const page = this.pageRecordMetadata(executionId, {
        afterOrdinal: cursor,
        limit: 256,
      });
      for (const metadata of page.records) {
        const encoded = encodeHistoryLogicalRecord(
          this.readRecord(metadata.recordId),
        );
        const line = new Uint8Array(encoded.byteLength + newline.byteLength);
        line.set(encoded);
        line.set(newline, encoded.byteLength);
        yield line;
        cursor = metadata.ordinal;
      }
      if (page.nextAfterOrdinal === undefined) return;
    }
  }

  async *exportExactExecution(
    executionId: string,
  ): AsyncGenerator<HistoryV6ExactExportEntry, void, undefined> {
    const emittedObjects = new Set<string>();
    const emittedStreams = new Set<string>();
    let cursor = 0;
    while (true) {
      const page = this.pageRecordMetadata(executionId, {
        afterOrdinal: cursor,
        limit: 256,
      });
      for (const metadata of page.records) {
        const record = this.readRecord(metadata.recordId);
        yield {
          kind: 'record',
          recordId: record.recordId,
          bytes: encodeHistoryLogicalRecord(record),
        };
        for (const digest of record.objectRefs) {
          if (emittedObjects.has(digest)) continue;
          emittedObjects.add(digest);
          yield { kind: 'object', digest, bytes: this.#readObject(digest) };
        }
        for (const range of record.byteRanges) {
          if (emittedStreams.has(range.streamId)) continue;
          emittedStreams.add(range.streamId);
          yield {
            kind: 'byte_stream',
            streamId: range.streamId,
            bytes: await this.readByteStream(range.streamId),
          };
        }
        cursor = metadata.ordinal;
      }
      if (page.nextAfterOrdinal === undefined) return;
    }
  }

  async readByteStream(streamId: string): Promise<Uint8Array> {
    const row = this.#row(
      'SELECT manifest_digest, manifest_bytes FROM byte_streams WHERE stream_id = ?',
      streamId,
    );
    const manifest = row.manifest_bytes as Uint8Array;
    if (exactByteDigest(manifest) !== row.manifest_digest) {
      throw new Error('v6 byte stream manifest digest mismatch');
    }
    const plan = decodeExactBytePlan(manifest);
    return await materializeExactBytePlan(
      plan,
      (ref) => this.#readObject(ref.digest),
    );
  }

  readSequence(revisionId: string, executionId: string): readonly string[] {
    const revision = this.#row(
      `
      SELECT root_digest, item_count FROM sequence_revisions
      WHERE execution_id = ? AND revision_id = ?
    `,
      executionId,
      revisionId,
    );
    const root = revision.root_digest === null ? null : String(revision.root_digest);
    const rows = this.#db.prepare(`
      WITH RECURSIVE reachable(digest) AS (
        SELECT ?
        UNION
        SELECT n.left_digest FROM sequence_nodes n JOIN reachable r ON n.digest = r.digest
          WHERE n.left_digest IS NOT NULL
        UNION
        SELECT n.right_digest FROM sequence_nodes n JOIN reachable r ON n.digest = r.digest
          WHERE n.right_digest IS NOT NULL
      )
      SELECT n.* FROM sequence_nodes n JOIN reachable r ON r.digest = n.digest
    `).all(root) as Row[];
    const nodes: PersistentSequenceNode[] = rows.map((row) =>
      row.node_kind === 'leaf'
        ? {
          kind: 'leaf',
          digest: String(row.digest),
          height: 1,
          count: 1,
          value: String(row.value),
        }
        : {
          kind: 'branch',
          digest: String(row.digest),
          height: Number(row.height),
          count: Number(row.item_count),
          left: String(row.left_digest),
          right: String(row.right_digest),
        }
    );
    const sequence = new PersistentSequenceStore();
    sequence.importNodes(nodes);
    if (sequence.count(root) !== Number(revision.item_count)) {
      throw new Error('v6 stored sequence count mismatch');
    }
    return sequence.materialize(root);
  }

  identifySegmentImpact(segmentId: string): HistoryV6SegmentImpact {
    const row = this.#row(
      `SELECT segment_id, execution_id, first_ordinal, last_ordinal, record_count
       FROM history_segments WHERE segment_id = ?`,
      segmentId,
    );
    return {
      segmentId: String(row.segment_id),
      executionId: String(row.execution_id),
      firstOrdinal: Number(row.first_ordinal),
      lastOrdinal: Number(row.last_ordinal),
      recordCount: Number(row.record_count),
    };
  }

  async audit(): Promise<HistoryV6AuditReport> {
    const integrityRows = this.#db.prepare('PRAGMA integrity_check')
      .all() as Row[];
    if (
      integrityRows.length !== 1 ||
      String(integrityRows[0].integrity_check) !== 'ok'
    ) throw new Error('v6 SQLite integrity check failed');
    if (
      (this.#db.prepare('PRAGMA foreign_key_check').all() as Row[]).length !== 0
    ) {
      throw new Error('v6 SQLite foreign key check failed');
    }

    const segmentRows = this.#db.prepare('SELECT * FROM history_segments')
      .all() as Row[];
    for (const row of segmentRows) {
      decodeHistorySegment({
        schemaVersion: 1,
        codec: String(row.codec) as HistorySegmentCodec,
        recordCount: Number(row.record_count),
        uncompressedBytes: Number(row.uncompressed_length),
        encodedBytes: Number(row.encoded_length),
        logicalDigest: String(row.logical_digest),
        representationDigest: String(row.representation_digest),
        bytes: row.encoded_bytes as Uint8Array,
      });
    }
    const objectRows = this.#db.prepare(
      'SELECT logical_digest FROM exact_objects',
    ).all() as Row[];
    for (const row of objectRows) this.#readObject(String(row.logical_digest));
    const streamRows = this.#db.prepare('SELECT stream_id FROM byte_streams')
      .all() as Row[];
    for (const row of streamRows) {
      await this.readByteStream(String(row.stream_id));
    }
    const revisionRows = this.#db.prepare(`
      SELECT execution_id, revision_id FROM sequence_revisions
    `).all() as Row[];
    for (const row of revisionRows) {
      this.readSequence(String(row.revision_id), String(row.execution_id));
    }

    const executionRows = this.#db.prepare('SELECT * FROM executions')
      .all() as Row[];
    let recordCount = 0;
    for (const execution of executionRows) {
      const executionId = String(execution.execution_id);
      const metadata = this.listRecordMetadata(executionId);
      let root = ledgerSeed(executionId);
      for (const item of metadata) {
        const record = this.readRecord(item.recordId);
        root = advanceLedgerRoot(
          root,
          record,
          encodeHistoryLogicalRecord(record),
        );
      }
      recordCount += metadata.length;
      const latest = metadata.at(-1);
      const terminal = execution.terminal_record_id === null
        ? undefined
        : String(execution.terminal_record_id);
      const unresolved = Number(
        this.#row(
          `SELECT count(*) AS count FROM record_causes
           WHERE execution_id = ? AND resolved = 0`,
          executionId,
        ).count,
      );
      if (
        metadata.length !== Number(execution.record_count) ||
        (latest?.ordinal ?? 0) !== Number(execution.latest_ordinal) ||
        root !== execution.ordered_root ||
        unresolved !== Number(execution.unresolved_reference_count) ||
        (terminal !== undefined && latest?.recordId !== terminal)
      ) throw new Error(`v6 execution ledger audit failed: ${executionId}`);
    }
    return {
      integrity: 'ok',
      executions: executionRows.length,
      records: recordCount,
      segments: segmentRows.length,
      exactObjects: objectRows.length,
      byteStreams: streamRows.length,
      sequenceRevisions: revisionRows.length,
    };
  }

  async backupTo(destinationPath: string): Promise<HistoryV6BackupReport> {
    if (
      !destinationPath.startsWith('/') || destinationPath.includes('\0') ||
      destinationPath === this.databasePath
    ) throw new TypeError('invalid v6 backup destination');
    await backup(this.#db, destinationPath);
    return SqliteHistoryV6Store.verifyBackup(destinationPath);
  }

  checkpoint(mode: 'passive' | 'truncate'): HistoryV6CheckpointReport {
    const pragma = mode === 'passive' ? 'PASSIVE' : 'TRUNCATE';
    const row = this.#db.prepare(`PRAGMA wal_checkpoint(${pragma})`)
      .get() as Row;
    return {
      mode,
      busy: Number(row.busy),
      logFrames: Number(row.log),
      checkpointedFrames: Number(row.checkpointed),
    };
  }

  static verifyBackup(databasePath: string): HistoryV6BackupReport {
    if (!databasePath.startsWith('/') || databasePath.includes('\0')) {
      throw new TypeError('invalid v6 backup path');
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const version = Number(
        (db.prepare('PRAGMA user_version').get() as Row).user_version,
      );
      const metadata = db.prepare(`
        SELECT schema_version FROM store_metadata WHERE singleton = 1
      `).get() as Row | undefined;
      const integrity = db.prepare('PRAGMA integrity_check').get() as Row;
      if (
        version !== HISTORY_V6_SCHEMA_VERSION || metadata === undefined ||
        Number(metadata.schema_version) !== HISTORY_V6_SCHEMA_VERSION ||
        String(integrity.integrity_check) !== 'ok'
      ) throw new Error('invalid v6 backup');
      return {
        destinationPath: databasePath,
        schemaVersion: HISTORY_V6_SCHEMA_VERSION,
        integrity: 'ok',
        executions: Number(
          (db.prepare('SELECT count(*) AS count FROM executions').get() as Row)
            .count,
        ),
        records: Number(
          (db.prepare('SELECT count(*) AS count FROM record_anchors')
            .get() as Row).count,
        ),
      };
    } finally {
      db.close();
    }
  }

  #applySessionState(state: HistoryV6SessionStateInput): void {
    nonempty(state.sessionId, 'session id');
    nonempty(state.workspaceRoot, 'workspace root');
    safeInteger(state.stateRevision, 'session state revision');
    safeInteger(state.nextTurn, 'session next turn');
    const existing = this.#optionalRow(
      `SELECT message_count, model_change_count, turn_count
       FROM sessions WHERE session_id = ?`,
      state.sessionId,
    );
    let messageCount = existing === undefined ? 0 : Number(existing.message_count);
    let modelChangeCount = existing === undefined ? 0 : Number(existing.model_change_count);
    let turnCount = existing === undefined ? 0 : Number(existing.turn_count);
    if (
      messageCount !== state.expectedMessageCount ||
      modelChangeCount !== state.expectedModelChangeCount ||
      turnCount !== state.expectedTurnCount
    ) throw new Error('v6 session delta fence mismatch');
    this.#db.prepare(`
      INSERT INTO sessions(
        session_id, state_revision, canonical_execution_id, workspace_root, record_bytes,
        checkpoint_bytes, updated_at, agent, created_at_session, title, next_turn,
        definition_json, active_model_json
      ) VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state_revision=excluded.state_revision, workspace_root=excluded.workspace_root,
        updated_at=excluded.updated_at, agent=excluded.agent,
        created_at_session=excluded.created_at_session, title=excluded.title,
        next_turn=excluded.next_turn, definition_json=excluded.definition_json,
        active_model_json=excluded.active_model_json
    `).run(
      state.sessionId,
      state.stateRevision,
      state.workspaceRoot,
      state.updatedAt,
      state.agent,
      state.createdAt,
      state.title,
      state.nextTurn,
      state.definitionJson,
      state.activeModelJson,
    );
    const insertMessage = this.#db.prepare(`
      INSERT INTO session_messages(
        session_id, message_ordinal, turn, logical_digest, representation_digest, encoded_bytes
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const message of state.messages) {
      if (message.ordinal !== messageCount) {
        throw new Error('v6 session message delta is not contiguous');
      }
      const raw = encoder.encode(message.json);
      const encoded = new Uint8Array(brotliCompressSync(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }));
      insertMessage.run(
        state.sessionId,
        message.ordinal,
        message.turn,
        exactByteDigest(raw),
        exactByteDigest(encoded),
        encoded,
      );
      messageCount += 1;
    }
    const insertModelChange = this.#db.prepare(`
      INSERT INTO session_model_changes(
        session_id, change_ordinal, effective_from_turn, changed_at, selection_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const change of state.modelChanges) {
      if (change.ordinal !== modelChangeCount) {
        throw new Error('v6 model change delta is not contiguous');
      }
      insertModelChange.run(
        state.sessionId,
        change.ordinal,
        change.effectiveFromTurn,
        change.changedAt,
        change.selectionJson,
      );
      modelChangeCount += 1;
    }
    const insertTurn = this.#db.prepare(`
      INSERT INTO session_turns(
        session_id, turn_ordinal, turn, model_json, build_json, definition_json, execution_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const turn of state.turns) {
      if (turn.ordinal !== turnCount) {
        throw new Error('v6 session turn delta is not contiguous');
      }
      insertTurn.run(
        state.sessionId,
        turn.ordinal,
        turn.turn,
        turn.modelJson,
        turn.buildJson,
        turn.definitionJson,
        turn.executionId ?? null,
      );
      turnCount += 1;
    }
    this.#db.prepare(`
      UPDATE sessions SET message_count = ?, model_change_count = ?, turn_count = ?
      WHERE session_id = ?
    `).run(messageCount, modelChangeCount, turnCount, state.sessionId);
  }

  #applyExecutionMessages(
    executionId: string,
    messages: readonly HistoryV6ExecutionMessageInput[],
  ): void {
    const insert = this.#db.prepare(`
      INSERT INTO execution_messages(
        execution_id, message_ordinal, turn, logical_digest, representation_digest, encoded_bytes
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    let expected = 0;
    for (const message of messages) {
      if (message.ordinal !== expected) {
        throw new Error('v6 execution message delta is not contiguous');
      }
      const raw = encoder.encode(message.json);
      const encoded = new Uint8Array(brotliCompressSync(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }));
      insert.run(
        executionId,
        message.ordinal,
        message.turn,
        exactByteDigest(raw),
        exactByteDigest(encoded),
        encoded,
      );
      expected += 1;
    }
  }

  #readObject(digest: string): Uint8Array {
    const row = this.#row(
      `
      SELECT byte_length, representation_codec, representation_digest,
        encoded_length, encoded_bytes FROM exact_objects WHERE logical_digest = ?
    `,
      digest,
    );
    const encoded = row.encoded_bytes as Uint8Array;
    if (
      encoded.byteLength !== Number(row.encoded_length) ||
      exactByteDigest(encoded) !== row.representation_digest ||
      row.representation_codec !== 'brotli-5'
    ) throw new Error('v6 exact object representation mismatch');
    const bytes = new Uint8Array(brotliDecompressSync(encoded));
    if (
      bytes.byteLength !== Number(row.byte_length) ||
      exactByteDigest(bytes) !== digest
    ) {
      throw new Error('v6 exact object logical digest mismatch');
    }
    return bytes;
  }

  #ledgerRow(executionId: string): Row {
    return this.#row(
      'SELECT * FROM executions WHERE execution_id = ?',
      executionId,
    );
  }

  #row(sql: string, ...params: (string | number)[]): Row {
    const row = this.#db.prepare(sql).get(...params) as Row | undefined;
    if (row === undefined) throw new Error('v6 history row not found');
    return row;
  }

  #optionalRow(sql: string, ...params: (string | number)[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    let active = true;
    try {
      const value = body();
      this.#db.exec('COMMIT');
      active = false;
      return value;
    } catch (error) {
      if (active) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
