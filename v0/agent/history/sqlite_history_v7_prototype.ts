import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '../core/contracts.ts';
import { exactByteDigest } from './exact_byte_plan.ts';
import {
  emptyHistoryV7OperationCost,
  encodeHistoryV7Payload,
  HISTORY_V7_SCHEMA_VERSION,
  type HistoryV7CaptureProfile,
  type HistoryV7DiagnosticCoverage,
  type HistoryV7OperationCost,
  type HistoryV7SemanticOccurrence,
  type HistoryV7SemanticOccurrenceInput,
  validateHistoryV7Occurrence,
} from './history_v7_model.ts';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

const SCHEMA = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE session_heads (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  canonical_execution_id TEXT
);
CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session_heads(session_id),
  base_revision INTEGER NOT NULL,
  capture_profile TEXT NOT NULL,
  diagnostic_coverage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  latest_ordinal INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  terminal_occurrence_id TEXT,
  unresolved_mandatory_count INTEGER NOT NULL
);
CREATE TABLE execution_admissions (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  task TEXT NOT NULL,
  canonical_session_id TEXT,
  session_correlation TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  agent TEXT NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  manifest_json TEXT,
  instance_correlation TEXT,
  worker_generation TEXT,
  context_snapshot_json TEXT,
  recalled_context_json TEXT,
  outcome_json TEXT,
  evidence_id TEXT,
  diagnostic_id TEXT,
  artifact_id TEXT,
  base_message_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX execution_admissions_session_turn
  ON execution_admissions(session_correlation, turn_number, created_at, execution_id);
CREATE TABLE immutable_contents (
  content_digest TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  content_bytes BLOB NOT NULL
);
CREATE TABLE semantic_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_digest TEXT REFERENCES immutable_contents(content_digest),
  UNIQUE(execution_id, ordinal)
);
CREATE INDEX semantic_occurrences_execution_ordinal
  ON semantic_occurrences(execution_id, ordinal);
CREATE TABLE semantic_relations (
  occurrence_id TEXT NOT NULL REFERENCES semantic_occurrences(occurrence_id) ON DELETE CASCADE,
  relation_ordinal INTEGER NOT NULL,
  relation TEXT NOT NULL,
  target_occurrence_id TEXT NOT NULL,
  mandatory INTEGER NOT NULL,
  resolved INTEGER NOT NULL,
  PRIMARY KEY(occurrence_id, relation_ordinal)
);
CREATE INDEX semantic_relations_unresolved
  ON semantic_relations(resolved, target_occurrence_id);
CREATE TABLE diagnostic_attachments (
  attachment_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  occurrence_id TEXT REFERENCES semantic_occurrences(occurrence_id),
  attachment_kind TEXT NOT NULL,
  coverage TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  content_digest TEXT REFERENCES immutable_contents(content_digest)
);
CREATE TABLE projection_outbox (
  occurrence_id TEXT PRIMARY KEY REFERENCES semantic_occurrences(occurrence_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE history_projection_entries (
  occurrence_id TEXT PRIMARY KEY REFERENCES semantic_occurrences(occurrence_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  search_text TEXT NOT NULL
);
CREATE TABLE canonical_turns (
  session_id TEXT NOT NULL REFERENCES session_heads(session_id),
  turn INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  session_revision INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn)
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT,
  state_revision INTEGER NOT NULL,
  next_turn INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  active_model_json TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  model_change_count INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  checkpoint_json TEXT
);
CREATE TABLE session_messages (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY(session_id, message_ordinal)
);
CREATE TABLE session_message_projection_outbox (
  session_id TEXT NOT NULL,
  message_ordinal INTEGER NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  PRIMARY KEY(session_id, message_ordinal),
  FOREIGN KEY(session_id, message_ordinal)
    REFERENCES session_messages(session_id, message_ordinal) ON DELETE CASCADE
);
CREATE TABLE session_model_changes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  change_ordinal INTEGER NOT NULL,
  effective_from_turn INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  PRIMARY KEY(session_id, change_ordinal)
);
CREATE TABLE session_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_ordinal INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  model_json TEXT NOT NULL,
  build_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  execution_id TEXT,
  PRIMARY KEY(session_id, turn_ordinal),
  UNIQUE(session_id, turn_number)
);
CREATE TABLE execution_messages (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY(execution_id, message_ordinal)
);
CREATE TABLE execution_message_projection_outbox (
  execution_id TEXT NOT NULL,
  message_ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(execution_id, message_ordinal),
  FOREIGN KEY(execution_id, message_ordinal)
    REFERENCES execution_messages(execution_id, message_ordinal) ON DELETE CASCADE
);
CREATE TABLE execution_context_manifests (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL
);
CREATE TABLE derived_documents (
  document_kind TEXT NOT NULL,
  document_id TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(execution_id) ON DELETE CASCADE,
  value_json TEXT NOT NULL,
  PRIMARY KEY(document_kind, document_id)
);
CREATE TABLE recall_relations (
  source_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  target_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  occurrence_id TEXT NOT NULL UNIQUE REFERENCES semantic_occurrences(occurrence_id),
  PRIMARY KEY(source_execution_id, target_execution_id)
);
CREATE TABLE human_history_entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  preview_text TEXT NOT NULL,
  detail_id TEXT NOT NULL,
  search_text TEXT NOT NULL,
  projection_version INTEGER NOT NULL
);
CREATE INDEX human_history_entries_page
  ON human_history_entries(session_id, turn_number, execution_id, entry_id);
INSERT INTO store_metadata(singleton, schema_version, created_at)
VALUES(1, 7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 7;
`;

export type HistoryV7PrototypeFaultPhase = 'after_occurrences' | 'before_commit';

export interface HistoryV7PrototypeOptions {
  readonly fault?: (phase: HistoryV7PrototypeFaultPhase) => void;
  /** Open the database read-only and never create or migrate schema (read-only viewer). */
  readonly readOnly?: boolean;
}

export interface HistoryV7ExecutionAdmission {
  readonly executionId: string;
  readonly taskId: string;
  readonly task: string;
  readonly canonicalSessionId?: string;
  readonly sessionCorrelation: string;
  readonly turn: number;
  readonly createdAt: string;
  readonly agent: string;
  readonly model: JsonValue;
  readonly build: JsonValue;
  readonly definition: JsonValue;
  readonly manifest?: JsonValue;
  readonly instanceCorrelation?: string;
  readonly workerGeneration?: string;
  readonly contextSnapshot?: JsonValue;
  readonly recalledContext?: JsonValue;
  readonly baseMessageCount: number;
}

export interface HistoryV7ExecutionState {
  readonly executionId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly captureProfile: HistoryV7CaptureProfile;
  readonly diagnosticCoverage: HistoryV7DiagnosticCoverage;
  readonly lifecycle: 'active' | 'settled';
  readonly outcome: 'unknown' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly adoption: 'non_canonical' | 'canonical';
  readonly latestOrdinal: number;
  readonly occurrenceCount: number;
  readonly terminalOccurrenceId?: string;
  readonly unresolvedMandatoryCount: number;
}

export interface HistoryV7DiagnosticAttachment {
  readonly attachmentId: string;
  readonly executionId: string;
  readonly occurrenceId?: string;
  readonly kind: string;
  readonly coverage: Exclude<HistoryV7DiagnosticCoverage, 'not_requested'>;
  readonly metadata: JsonValue;
  readonly content?: Uint8Array;
}

export interface HistoryV7ProjectionEntry {
  readonly occurrenceId: string;
  readonly executionId: string;
  readonly version: number;
  readonly text: string;
}

export class SqliteHistoryV7Prototype {
  readonly #db: DatabaseSync;
  readonly #fault?: (phase: HistoryV7PrototypeFaultPhase) => void;
  readonly #readOnly: boolean;

  constructor(readonly databasePath: string, options: HistoryV7PrototypeOptions = {}) {
    if (!databasePath.startsWith('/') || databasePath.includes('\0')) {
      throw new TypeError('history v7 prototype path must be absolute');
    }
    this.#fault = options.fault;
    this.#readOnly = options.readOnly === true;
    this.#db = this.#readOnly
      ? new DatabaseSync(databasePath, { readOnly: true })
      : new DatabaseSync(databasePath);
    this.#db.exec(
      this.#readOnly
        ? 'PRAGMA foreign_keys=ON;'
        : 'PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;',
    );
    const version = Number(
      (this.#db.prepare('PRAGMA user_version').get() as Row).user_version,
    );
    if (this.#readOnly) {
      if (version !== HISTORY_V7_SCHEMA_VERSION) {
        this.#db.close();
        throw new Error(`unsupported history v7 prototype schema: ${version}`);
      }
    } else if (version === 0) {
      this.#db.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    } else if (version !== HISTORY_V7_SCHEMA_VERSION) {
      this.#db.close();
      throw new Error(`unsupported history v7 prototype schema: ${version}`);
    }
  }

  close(): void {
    this.#db.close();
  }

  beginExecution(
    input: Readonly<{
      executionId: string;
      sessionId: string;
      baseRevision: number;
      captureProfile: HistoryV7CaptureProfile;
    }>,
  ): void {
    this.#transaction(() => this.#insertExecution(input));
  }

  recordExecutionAdmission(input: HistoryV7ExecutionAdmission): void {
    this.#transaction(() => this.#insertExecutionAdmission(input));
  }

  beginExecutionWithAdmission(
    input: Readonly<{
      executionId: string;
      sessionId: string;
      baseRevision: number;
      captureProfile: HistoryV7CaptureProfile;
      admission: HistoryV7ExecutionAdmission;
    }>,
  ): void {
    if (input.admission.executionId !== input.executionId) {
      throw new Error('history v7 admission execution mismatch');
    }
    this.#transaction(() => {
      this.#insertExecution(input);
      this.#insertExecutionAdmission(input.admission);
    });
  }

  #insertExecution(
    input: Readonly<{
      executionId: string;
      sessionId: string;
      baseRevision: number;
      captureProfile: HistoryV7CaptureProfile;
    }>,
  ): void {
    this.#db.prepare(`
      INSERT INTO session_heads(session_id, revision, canonical_execution_id)
      VALUES(?, ?, NULL) ON CONFLICT(session_id) DO NOTHING
    `).run(input.sessionId, input.baseRevision);
    const session = this.#row(
      'SELECT revision FROM session_heads WHERE session_id=?',
      input.sessionId,
    );
    if (Number(session.revision) !== input.baseRevision) {
      throw new Error('history v7 base revision mismatch');
    }
    this.#db.prepare(`
      INSERT INTO executions(
        execution_id, session_id, base_revision, capture_profile, diagnostic_coverage,
        lifecycle, outcome, adoption, latest_ordinal, occurrence_count,
        terminal_occurrence_id, unresolved_mandatory_count
      ) VALUES(?, ?, ?, ?, ?, 'active', 'unknown', 'non_canonical', 0, 0, NULL, 0)
    `).run(
      input.executionId,
      input.sessionId,
      input.baseRevision,
      input.captureProfile,
      input.captureProfile === 'normal-v1' ? 'not_requested' : 'partial',
    );
  }

  #insertExecutionAdmission(input: HistoryV7ExecutionAdmission): void {
    const row = this.#row(
      'SELECT session_id FROM executions WHERE execution_id=?',
      input.executionId,
    );
    const authoritySession = input.canonicalSessionId ??
      `detached:${input.sessionCorrelation}`;
    if (String(row.session_id) !== authoritySession) {
      throw new Error('history v7 admission session mismatch');
    }
    this.#db.prepare(`
      INSERT INTO execution_admissions(
        execution_id, task_id, task, canonical_session_id, session_correlation,
        turn_number, created_at, agent, model_json, build_json, definition_json,
        manifest_json, instance_correlation, worker_generation, context_snapshot_json,
        recalled_context_json, base_message_count
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.executionId,
      input.taskId,
      input.task,
      input.canonicalSessionId ?? null,
      input.sessionCorrelation,
      input.turn,
      input.createdAt,
      input.agent,
      JSON.stringify(input.model),
      JSON.stringify(input.build),
      JSON.stringify(input.definition),
      input.manifest === undefined ? null : JSON.stringify(input.manifest),
      input.instanceCorrelation ?? null,
      input.workerGeneration ?? null,
      input.contextSnapshot === undefined ? null : JSON.stringify(input.contextSnapshot),
      input.recalledContext === undefined ? null : JSON.stringify(input.recalledContext),
      input.baseMessageCount,
    );
  }

  appendSemantic(
    executionId: string,
    expectedLatestOrdinal: number,
    occurrences: readonly HistoryV7SemanticOccurrenceInput[],
    terminalOccurrenceId?: string,
  ): HistoryV7OperationCost {
    if (occurrences.length === 0) throw new TypeError('empty semantic append');
    const encoded = occurrences.map((occurrence, index) => {
      validateHistoryV7Occurrence(occurrence);
      if (occurrence.ordinal !== expectedLatestOrdinal + index + 1) {
        throw new TypeError('non-contiguous semantic ordinal');
      }
      return encodeHistoryV7Payload(occurrence.payload);
    });
    let cost = emptyHistoryV7OperationCost();
    this.#transaction(() => {
      const state = this.#row('SELECT * FROM executions WHERE execution_id=?', executionId);
      if (
        state.lifecycle !== 'active' ||
        Number(state.latest_ordinal) !== expectedLatestOrdinal ||
        state.terminal_occurrence_id !== null
      ) throw new Error('history v7 append fence mismatch');
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index];
        const payloadBytes = encoded[index];
        let contentDigest: string | null = null;
        if (occurrence.content !== undefined) {
          contentDigest = exactByteDigest(occurrence.content);
          if (
            occurrence.contentDigest !== undefined &&
            occurrence.contentDigest !== contentDigest
          ) throw new Error('history v7 content digest mismatch');
          this.#db.prepare(`
            INSERT INTO immutable_contents(content_digest, byte_length, content_bytes)
            VALUES(?, ?, ?) ON CONFLICT(content_digest) DO NOTHING
          `).run(contentDigest, occurrence.content.byteLength, occurrence.content);
          const stored = this.#row(
            'SELECT byte_length FROM immutable_contents WHERE content_digest=?',
            contentDigest,
          );
          if (Number(stored.byte_length) !== occurrence.content.byteLength) {
            throw new Error('history v7 content length mismatch');
          }
        } else if (occurrence.contentDigest !== undefined) {
          const stored = this.#db.prepare(
            'SELECT byte_length FROM immutable_contents WHERE content_digest=?',
          ).get(occurrence.contentDigest) as Row | undefined;
          if (stored === undefined) throw new Error('history v7 content reference missing');
          contentDigest = occurrence.contentDigest;
        }
        this.#db.prepare(`
          INSERT INTO semantic_occurrences(
            occurrence_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
          ) VALUES(?, ?, ?, ?, ?, ?, ?)
        `).run(
          occurrence.occurrenceId,
          executionId,
          occurrence.ordinal,
          occurrence.kind,
          occurrence.observedAt,
          new TextDecoder().decode(payloadBytes),
          contentDigest,
        );
        for (
          let relationOrdinal = 0;
          relationOrdinal < (occurrence.relations?.length ?? 0);
          relationOrdinal += 1
        ) {
          const relation = occurrence.relations![relationOrdinal];
          const resolved = this.#db.prepare(
              'SELECT 1 FROM semantic_occurrences WHERE occurrence_id=?',
            ).get(relation.targetOccurrenceId) === undefined
            ? 0
            : 1;
          this.#db.prepare(`
            INSERT INTO semantic_relations(
              occurrence_id, relation_ordinal, relation, target_occurrence_id, mandatory, resolved
            ) VALUES(?, ?, ?, ?, ?, ?)
          `).run(
            occurrence.occurrenceId,
            relationOrdinal,
            relation.relation,
            relation.targetOccurrenceId,
            relation.mandatory === false ? 0 : 1,
            resolved,
          );
          if (resolved === 0 && relation.mandatory !== false) {
            this.#db.prepare(`
              UPDATE executions
              SET unresolved_mandatory_count=unresolved_mandatory_count+1
              WHERE execution_id=?
            `).run(executionId);
          }
        }
        const newlyResolved = this.#db.prepare(`
          SELECT o.execution_id, count(*) AS count
          FROM semantic_relations r
          JOIN semantic_occurrences o ON o.occurrence_id=r.occurrence_id
          WHERE r.resolved=0 AND r.mandatory=1 AND r.target_occurrence_id=?
          GROUP BY o.execution_id
        `).all(occurrence.occurrenceId) as Row[];
        this.#db.prepare(`
          UPDATE semantic_relations SET resolved=1
          WHERE resolved=0 AND target_occurrence_id=?
        `).run(occurrence.occurrenceId);
        for (const row of newlyResolved) {
          this.#db.prepare(`
            UPDATE executions
            SET unresolved_mandatory_count=unresolved_mandatory_count-?
            WHERE execution_id=? AND unresolved_mandatory_count>=?
          `).run(row.count, row.execution_id, row.count);
        }
        const projectsToHumanHistory = occurrence.kind !== 'context_item';
        if (projectsToHumanHistory) {
          this.#db.prepare(`
            INSERT INTO projection_outbox(occurrence_id, execution_id, status)
            VALUES(?, ?, 'pending')
          `).run(occurrence.occurrenceId, executionId);
        }
        cost = {
          ...cost,
          serializedBytes: cost.serializedBytes + payloadBytes.byteLength,
          contentBytesHashed: cost.contentBytesHashed + (occurrence.content?.byteLength ?? 0),
          contentDigestCalls: cost.contentDigestCalls + (occurrence.content === undefined ? 0 : 1),
          newOccurrences: cost.newOccurrences + 1,
          newRelations: cost.newRelations + (occurrence.relations?.length ?? 0),
          projectionOutboxRows: cost.projectionOutboxRows + (projectsToHumanHistory ? 1 : 0),
        };
      }
      this.#fault?.('after_occurrences');
      if (
        terminalOccurrenceId !== undefined &&
        !occurrences.some((occurrence) => occurrence.occurrenceId === terminalOccurrenceId)
      ) throw new Error('terminal occurrence is not in append');
      this.#db.prepare(`
        UPDATE executions SET latest_ordinal=?, occurrence_count=occurrence_count+?,
          terminal_occurrence_id=coalesce(?, terminal_occurrence_id)
        WHERE execution_id=?
      `).run(
        occurrences.at(-1)!.ordinal,
        occurrences.length,
        terminalOccurrenceId ?? null,
        executionId,
      );
      this.#fault?.('before_commit');
    });
    return cost;
  }

  appendDiagnostic(
    input: Readonly<{
      attachmentId: string;
      executionId: string;
      occurrenceId?: string;
      kind: string;
      coverage: Exclude<HistoryV7DiagnosticCoverage, 'not_requested'>;
      metadata: JsonValue;
      content?: Uint8Array;
    }>,
  ): void {
    const state = this.readExecution(input.executionId);
    if (state.captureProfile !== 'diagnostic-v1') {
      throw new Error('diagnostic attachment was not requested');
    }
    const metadata = new TextDecoder().decode(encodeHistoryV7Payload(input.metadata));
    this.#transaction(() => {
      let digest: string | null = null;
      if (input.content !== undefined) {
        digest = exactByteDigest(input.content);
        this.#db.prepare(`
          INSERT INTO immutable_contents(content_digest, byte_length, content_bytes)
          VALUES(?, ?, ?) ON CONFLICT(content_digest) DO NOTHING
        `).run(digest, input.content.byteLength, input.content);
      }
      this.#db.prepare(`
        INSERT INTO diagnostic_attachments(
          attachment_id, execution_id, occurrence_id, attachment_kind,
          coverage, metadata_json, content_digest
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.attachmentId,
        input.executionId,
        input.occurrenceId ?? null,
        input.kind,
        input.coverage,
        metadata,
        digest,
      );
      this.#db.prepare(`
        UPDATE executions SET diagnostic_coverage=? WHERE execution_id=?
      `).run(input.coverage, input.executionId);
    });
  }

  settleExecution(
    executionId: string,
    outcome: Exclude<HistoryV7ExecutionState['outcome'], 'unknown'>,
  ): HistoryV7OperationCost {
    this.#transaction(() => {
      const state = this.#row('SELECT * FROM executions WHERE execution_id=?', executionId);
      if (
        state.lifecycle !== 'active' || state.terminal_occurrence_id === null ||
        Number(state.unresolved_mandatory_count) !== 0 ||
        Number(state.latest_ordinal) !== Number(state.occurrence_count)
      ) throw new Error('history v7 semantic settlement incomplete');
      this.#db.prepare(`
        UPDATE executions SET lifecycle='settled', outcome=? WHERE execution_id=?
      `).run(outcome, executionId);
    });
    return emptyHistoryV7OperationCost();
  }

  adoptCanonical(executionId: string, turn: number): void {
    this.#transaction(() => {
      const state = this.#row('SELECT * FROM executions WHERE execution_id=?', executionId);
      if (state.lifecycle !== 'settled' || state.outcome !== 'completed') {
        throw new Error('history v7 execution is not adoptable');
      }
      const session = this.#row(
        'SELECT revision FROM session_heads WHERE session_id=?',
        String(state.session_id),
      );
      if (Number(session.revision) !== Number(state.base_revision)) {
        throw new Error('history v7 adoption revision mismatch');
      }
      const revision = Number(state.base_revision) + 1;
      this.#db.prepare(`
        INSERT INTO canonical_turns(session_id, turn, execution_id, session_revision)
        VALUES(?, ?, ?, ?)
      `).run(state.session_id, turn, executionId, revision);
      this.#db.prepare(`
        UPDATE session_heads SET revision=?, canonical_execution_id=? WHERE session_id=?
      `).run(revision, executionId, state.session_id);
      this.#db.prepare(`
        UPDATE executions SET adoption='canonical' WHERE execution_id=?
      `).run(executionId);
    });
  }

  drainProjection(
    limit: number,
    project: (occurrence: HistoryV7SemanticOccurrence) => string,
  ): number {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('invalid projection limit');
    const pending = this.#db.prepare(`
      SELECT occurrence_id FROM projection_outbox WHERE status='pending'
      ORDER BY rowid LIMIT ?
    `).all(limit) as Row[];
    let completed = 0;
    for (const item of pending) {
      const occurrence = this.readOccurrence(String(item.occurrence_id));
      const text = project(occurrence);
      this.#transaction(() => {
        this.#db.prepare(`
          INSERT INTO history_projection_entries(
            occurrence_id, execution_id, projection_version, search_text
          ) VALUES(?, ?, 1, ?)
        `).run(occurrence.occurrenceId, occurrence.executionId, text);
        this.#db.prepare(`
          UPDATE projection_outbox SET status='complete' WHERE occurrence_id=?
        `).run(occurrence.occurrenceId);
      });
      completed += 1;
    }
    return completed;
  }

  markProjectionStale(occurrenceId: string): void {
    this.#transaction(() => {
      this.#db.prepare(
        'DELETE FROM history_projection_entries WHERE occurrence_id=?',
      ).run(occurrenceId);
      const result = this.#db.prepare(`
        UPDATE projection_outbox SET status='pending' WHERE occurrence_id=?
      `).run(occurrenceId);
      if (Number(result.changes) !== 1) throw new Error('projection source not found');
    });
  }

  readExecution(executionId: string): HistoryV7ExecutionState {
    const row = this.#row('SELECT * FROM executions WHERE execution_id=?', executionId);
    return {
      executionId: String(row.execution_id),
      sessionId: String(row.session_id),
      baseRevision: Number(row.base_revision),
      captureProfile: String(row.capture_profile) as HistoryV7CaptureProfile,
      diagnosticCoverage: String(row.diagnostic_coverage) as HistoryV7DiagnosticCoverage,
      lifecycle: String(row.lifecycle) as HistoryV7ExecutionState['lifecycle'],
      outcome: String(row.outcome) as HistoryV7ExecutionState['outcome'],
      adoption: String(row.adoption) as HistoryV7ExecutionState['adoption'],
      latestOrdinal: Number(row.latest_ordinal),
      occurrenceCount: Number(row.occurrence_count),
      ...(row.terminal_occurrence_id === null ? {} : {
        terminalOccurrenceId: String(row.terminal_occurrence_id),
      }),
      unresolvedMandatoryCount: Number(row.unresolved_mandatory_count),
    };
  }

  readOccurrence(occurrenceId: string): HistoryV7SemanticOccurrence {
    const row = this.#row(
      'SELECT * FROM semantic_occurrences WHERE occurrence_id=?',
      occurrenceId,
    );
    return {
      executionId: String(row.execution_id),
      occurrenceId: String(row.occurrence_id),
      ordinal: Number(row.ordinal),
      kind: String(row.kind) as HistoryV7SemanticOccurrence['kind'],
      observedAt: String(row.observed_at),
      payload: JSON.parse(String(row.payload_json)) as JsonValue,
      ...(row.content_digest === null ? {} : { contentDigest: String(row.content_digest) }),
    };
  }

  listOccurrences(executionId: string): readonly HistoryV7SemanticOccurrence[] {
    return (this.#db.prepare(`
      SELECT occurrence_id FROM semantic_occurrences
      WHERE execution_id=? ORDER BY ordinal
    `).all(executionId) as Row[]).map((row) => this.readOccurrence(String(row.occurrence_id)));
  }

  readContent(contentDigest: string): Uint8Array {
    const row = this.#row(
      'SELECT byte_length, content_bytes FROM immutable_contents WHERE content_digest=?',
      contentDigest,
    );
    const content = (row.content_bytes as Uint8Array).slice();
    if (
      content.byteLength !== Number(row.byte_length) ||
      exactByteDigest(content) !== contentDigest
    ) throw new Error('history v7 content digest mismatch');
    return content;
  }

  hasContent(contentDigest: string, byteLength: number): boolean {
    const row = this.#db.prepare(
      'SELECT byte_length FROM immutable_contents WHERE content_digest=?',
    ).get(contentDigest) as Row | undefined;
    return row !== undefined && Number(row.byte_length) === byteLength;
  }

  listDiagnosticAttachments(executionId: string): readonly HistoryV7DiagnosticAttachment[] {
    return (this.#db.prepare(`
      SELECT * FROM diagnostic_attachments WHERE execution_id=? ORDER BY rowid
    `).all(executionId) as Row[]).map((row) => {
      let content: Uint8Array | undefined;
      if (row.content_digest !== null) {
        const object = this.#row(
          'SELECT byte_length, content_bytes FROM immutable_contents WHERE content_digest=?',
          row.content_digest,
        );
        content = (object.content_bytes as Uint8Array).slice();
        if (
          content.byteLength !== Number(object.byte_length) ||
          exactByteDigest(content) !== row.content_digest
        ) throw new Error('diagnostic content digest mismatch');
      }
      return {
        attachmentId: String(row.attachment_id),
        executionId: String(row.execution_id),
        ...(row.occurrence_id === null ? {} : { occurrenceId: String(row.occurrence_id) }),
        kind: String(row.attachment_kind),
        coverage: String(row.coverage) as Exclude<
          HistoryV7DiagnosticCoverage,
          'not_requested'
        >,
        metadata: JSON.parse(String(row.metadata_json)) as JsonValue,
        ...(content === undefined ? {} : { content }),
      };
    });
  }

  listProjectionEntries(executionId: string): readonly string[] {
    return (this.#db.prepare(`
      SELECT search_text FROM history_projection_entries
      WHERE execution_id=? ORDER BY rowid
    `).all(executionId) as Row[]).map((row) => String(row.search_text));
  }

  readProjectionEntry(occurrenceId: string): HistoryV7ProjectionEntry {
    const row = this.#row(
      `
      SELECT * FROM history_projection_entries WHERE occurrence_id=?
    `,
      occurrenceId,
    );
    return {
      occurrenceId: String(row.occurrence_id),
      executionId: String(row.execution_id),
      version: Number(row.projection_version),
      text: String(row.search_text),
    };
  }

  searchProjection(executionId: string, query: string): readonly HistoryV7ProjectionEntry[] {
    if (!query || query.includes('\0')) throw new TypeError('invalid projection query');
    return (this.#db.prepare(`
      SELECT * FROM history_projection_entries
      WHERE execution_id=? AND instr(search_text, ?) > 0 ORDER BY rowid
    `).all(executionId, query) as Row[]).map((row) => ({
      occurrenceId: String(row.occurrence_id),
      executionId: String(row.execution_id),
      version: Number(row.projection_version),
      text: String(row.search_text),
    }));
  }

  pendingProjectionCount(): number {
    return Number(
      this.#row(
        "SELECT count(*) AS count FROM projection_outbox WHERE status='pending'",
      ).count,
    );
  }

  tableNames(): readonly string[] {
    return (this.#db.prepare(`
      SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Row[]).map((row) => String(row.name));
  }

  #row(sql: string, ...params: readonly SqlValue[]): Row {
    const row = this.#db.prepare(sql).get(...params) as Row | undefined;
    if (row === undefined) throw new Error('history v7 row not found');
    return row;
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  }
}
