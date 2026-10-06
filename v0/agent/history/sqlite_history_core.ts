import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '../core/contracts.ts';
import type {
  HistoryAppendResult,
  HistoryPostSettlementSemanticEventInput,
  StoredExecutionEvent,
  StoredSessionConversationEvent,
} from './history_store_contract.ts';
import { exactByteDigest } from './exact_byte_plan.ts';
import {
  HISTORY_BUSY_TIMEOUT_MS,
  HISTORY_SCHEMA_SQL,
  HISTORY_SCHEMA_VERSION,
} from './history_schema.ts';
import {
  emptyHistoryOperationCost,
  encodeHistoryPayload,
  type HistoryAppendBatchInput,
  type HistoryAssistantTextKey,
  type HistoryAssistantTextState,
  type HistoryOperationCost,
  type HistorySemanticOccurrence,
  type HistorySemanticOccurrenceInput,
  validateHistoryOccurrence,
} from './history_semantic_model.ts';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

const requiredRow = (
  db: DatabaseSync,
  sql: string,
  ...params: readonly SqlValue[]
): Row => {
  const row = db.prepare(sql).get(...params) as Row | undefined;
  if (row === undefined) throw new Error('history row not found');
  return row;
};

export type HistoryCoreFaultPhase = 'after_occurrences' | 'before_commit';

export interface HistoryCoreOptions {
  readonly fault?: (phase: HistoryCoreFaultPhase) => void;
  readonly readOnly?: boolean;
}

export interface HistoryCoreExecutionAdmission {
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
  readonly configurationId?: string;
  readonly maxSteps: number;
  readonly instanceCorrelation?: string;
  readonly workerGeneration?: string;
  readonly parentExecutionId?: string;
  readonly spawnCallId?: string;
  readonly baseMessageCount: number;
}

export interface HistoryCoreExecutionState {
  readonly executionId: string;
  /** The live correlation supplied at admission. */
  readonly sessionId: string;
  readonly sessionCorrelation: string;
  readonly canonicalSessionId?: string;
  readonly baseRevision: number;
  readonly lifecycle: 'active' | 'settled';
  readonly outcome:
    | 'unknown'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  readonly adoption: 'non_canonical' | 'canonical';
  readonly latestOrdinal: number;
  readonly occurrenceCount: number;
  readonly terminalOccurrenceId?: string;
  readonly unresolvedMandatoryCount: number;
}

export interface HistoryCanonicalAdoptionInput {
  readonly executionId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly turnOrdinal: number;
  readonly turnNumber: number;
  readonly settledAt: string;
  readonly runtimeOutcomeJson?: JsonValue;
}

/**
 * Commit an already-written execution message set into a persistent conversation.
 * The caller owns the surrounding BEGIN IMMEDIATE transaction and updates any
 * session-specific model/checkpoint fields in that same transaction.
 */
export const adoptCanonicalInTransaction = (
  db: DatabaseSync,
  input: HistoryCanonicalAdoptionInput,
): void => {
  const execution = requiredRow(
    db,
    'SELECT * FROM executions WHERE execution_id=?',
    input.executionId,
  );
  const session = requiredRow(
    db,
    'SELECT state_revision, message_count FROM sessions WHERE session_id=?',
    input.sessionId,
  );
  if (
    execution.canonical_session_id !== input.sessionId ||
    Number(execution.base_revision) !== input.baseRevision ||
    Number(session.state_revision) !== input.baseRevision
  ) throw new Error('history canonical adoption revision mismatch');
  if (Number(execution.turn_number) !== input.turnNumber) {
    throw new Error('history canonical adoption turn mismatch');
  }
  if (
    !(
      (execution.lifecycle === 'active' && execution.outcome === 'unknown') ||
      (execution.lifecycle === 'settled' && execution.outcome === 'completed')
    ) || execution.terminal_record_id === null ||
    Number(execution.unresolved_mandatory_count) !== 0 ||
    Number(execution.latest_ordinal) !== Number(execution.occurrence_count)
  ) throw new Error('history semantic settlement incomplete');

  const messages = db.prepare(`
    SELECT message_ordinal FROM messages
    WHERE execution_id=? ORDER BY message_ordinal
  `).all(input.executionId) as Row[];
  const firstMessageOrdinal = Number(session.message_count);
  db.prepare(`
    INSERT INTO session_turns(session_id, turn_ordinal, turn_number, execution_id)
    VALUES(?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.turnOrdinal,
    input.turnNumber,
    input.executionId,
  );
  const insertConversationMessage = db.prepare(`
    INSERT INTO conversation_messages(
      session_id, message_ordinal, turn_number, execution_id, execution_message_ordinal
    ) VALUES(?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < messages.length; index += 1) {
    insertConversationMessage.run(
      input.sessionId,
      firstMessageOrdinal + index,
      input.turnNumber,
      input.executionId,
      messages[index].message_ordinal,
    );
  }

  db.prepare(`
    UPDATE executions SET lifecycle='settled', outcome='completed', adoption='canonical',
      settled_at=?, runtime_outcome_json=coalesce(?, runtime_outcome_json)
    WHERE execution_id=?
  `).run(
    input.settledAt,
    input.runtimeOutcomeJson === undefined ? null : JSON.stringify(input.runtimeOutcomeJson),
    input.executionId,
  );
  db.prepare(`
    UPDATE sessions SET state_revision=?, next_turn=?, message_count=message_count+?,
      turn_count=turn_count+1, updated_at=?
    WHERE session_id=?
  `).run(
    input.baseRevision + 1,
    input.turnNumber + 1,
    messages.length,
    input.settledAt,
    input.sessionId,
  );
};

export class SqliteHistoryCore {
  readonly #db: DatabaseSync;
  readonly #fault?: (phase: HistoryCoreFaultPhase) => void;
  readonly #readOnly: boolean;

  constructor(
    readonly databasePath: string,
    options: HistoryCoreOptions = {},
  ) {
    if (!databasePath.startsWith('/') || databasePath.includes('\0')) {
      throw new TypeError('history path must be absolute');
    }
    this.#fault = options.fault;
    this.#readOnly = options.readOnly === true;
    this.#db = this.#readOnly
      ? new DatabaseSync(databasePath, { readOnly: true })
      : new DatabaseSync(databasePath);
    this.#db.exec(`PRAGMA busy_timeout=${HISTORY_BUSY_TIMEOUT_MS};`);
    this.#db.exec(
      this.#readOnly
        ? 'PRAGMA foreign_keys=ON;'
        : 'PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;',
    );
    const version = Number(
      (this.#db.prepare('PRAGMA user_version').get() as Row).user_version,
    );
    if (this.#readOnly) {
      if (version !== HISTORY_SCHEMA_VERSION) {
        this.#db.close();
        throw new Error(`unsupported history schema version: ${version}`);
      }
    } else if (version === 0) {
      this.#db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
      try {
        const currentVersion = Number(
          (this.#db.prepare('PRAGMA user_version').get() as Row).user_version,
        );
        if (currentVersion === 0) this.#db.exec(HISTORY_SCHEMA_SQL);
        else if (currentVersion !== HISTORY_SCHEMA_VERSION) {
          throw new Error(
            `unsupported history schema version: ${currentVersion}`,
          );
        }
        this.#db.exec('COMMIT;');
      } catch (error) {
        this.#db.exec('ROLLBACK;');
        this.#db.close();
        throw error;
      }
    } else if (version !== HISTORY_SCHEMA_VERSION) {
      this.#db.close();
      throw new Error(`unsupported history schema version: ${version}`);
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Store exact content bytes and return their immutable content identity. */
  writeContent(content: Uint8Array, db?: DatabaseSync): string {
    const digest = exactByteDigest(content);
    if (db === undefined) {
      this.#transaction(() => this.#insertContent(this.#db, digest, content));
    } else {
      this.#insertContent(db, digest, content);
    }
    return digest;
  }

  beginExecutionWithAdmission(
    input: Readonly<{
      executionId: string;
      /** Live session correlation; detached executions do not create a Session row. */
      sessionId: string;
      baseRevision: number;
      admission: HistoryCoreExecutionAdmission;
    }>,
  ): void {
    const admission = input.admission;
    if (
      admission.executionId !== input.executionId ||
      admission.sessionCorrelation !== input.sessionId
    ) throw new Error('history admission execution/session mismatch');
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
      throw new TypeError('invalid history execution base revision');
    }
    this.#transaction(() => {
      const taskBytes = new TextEncoder().encode(admission.task);
      const taskDigest = exactByteDigest(taskBytes);
      this.#insertContent(this.#db, taskDigest, taskBytes);
      if (admission.canonicalSessionId !== undefined) {
        const session = this.#row(
          'SELECT state_revision FROM sessions WHERE session_id=?',
          admission.canonicalSessionId,
        );
        if (Number(session.state_revision) !== input.baseRevision) {
          throw new Error('history base revision mismatch');
        }
      }
      this.#db.prepare(`
        INSERT INTO executions(
          execution_id, canonical_session_id, session_correlation, task_id,
          task_content_digest, parent_execution_id, spawn_call_id, turn_number,
          base_revision, base_message_count, created_at, settled_at, agent_name,
          configuration_id, build_json, model_json, max_steps, instance_correlation,
          worker_generation, lifecycle, outcome, adoption, latest_ordinal,
          occurrence_count, terminal_record_id, unresolved_mandatory_count,
          event_count, runtime_outcome_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
          'active', 'unknown', 'non_canonical', 0, 0, NULL, 0, 0, NULL)
      `).run(
        input.executionId,
        admission.canonicalSessionId ?? null,
        admission.sessionCorrelation,
        admission.taskId,
        taskDigest,
        admission.parentExecutionId ?? null,
        admission.spawnCallId ?? null,
        admission.turn,
        input.baseRevision,
        admission.baseMessageCount,
        admission.createdAt,
        admission.agent,
        admission.configurationId ?? null,
        JSON.stringify(admission.build),
        JSON.stringify(admission.model),
        admission.maxSteps,
        admission.instanceCorrelation ?? null,
        admission.workerGeneration ?? null,
      );
    });
  }

  appendSemantic(
    executionId: string,
    expectedLatestOrdinal: number,
    occurrences: readonly HistorySemanticOccurrenceInput[],
    terminalOccurrenceId?: string,
  ): HistoryOperationCost {
    if (occurrences.length === 0) throw new TypeError('empty semantic append');
    return this.appendBatch({
      executionId,
      expectedLatestOrdinal,
      occurrences,
      terminalOccurrenceId,
    });
  }

  /** Commit semantic facts and latest incomplete assistant text together. */
  appendBatch(input: HistoryAppendBatchInput): HistoryOperationCost {
    const {
      executionId,
      expectedLatestOrdinal,
      occurrences,
      terminalOccurrenceId,
    } = input;
    const encoded = occurrences.map((occurrence, index) => {
      validateHistoryOccurrence(occurrence);
      if (occurrence.ordinal !== expectedLatestOrdinal + index + 1) {
        throw new TypeError('non-contiguous semantic ordinal');
      }
      return encodeHistoryPayload(occurrence.payload);
    });
    let cost = emptyHistoryOperationCost();
    this.#transaction(() => {
      const state = this.#row(
        'SELECT * FROM executions WHERE execution_id=?',
        executionId,
      );
      if (
        state.lifecycle !== 'active' ||
        Number(state.latest_ordinal) !== expectedLatestOrdinal ||
        state.terminal_record_id !== null
      ) throw new Error('history semantic append fence mismatch');
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index];
        const payloadBytes = encoded[index];
        let contentDigest: string | null = null;
        if (occurrence.content !== undefined) {
          contentDigest = exactByteDigest(occurrence.content);
          if (
            occurrence.contentDigest !== undefined &&
            occurrence.contentDigest !== contentDigest
          ) throw new Error('history content digest mismatch');
          this.#insertContent(this.#db, contentDigest, occurrence.content);
        } else if (occurrence.contentDigest !== undefined) {
          const stored = this.#db.prepare(
            'SELECT byte_length FROM contents WHERE content_digest=?',
          ).get(occurrence.contentDigest) as Row | undefined;
          if (stored === undefined) {
            throw new Error('history content reference missing');
          }
          contentDigest = occurrence.contentDigest;
        }
        this.#db.prepare(`
          INSERT INTO semantic_records(
            record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
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
              'SELECT 1 FROM semantic_records WHERE record_id=?',
            ).get(relation.targetOccurrenceId) === undefined
            ? 0
            : 1;
          this.#db.prepare(`
            INSERT INTO semantic_relations(
              record_id, relation_ordinal, relation, target_record_id, mandatory, resolved
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
          SELECT source.execution_id, count(*) AS count
          FROM semantic_relations relation
          JOIN semantic_records source ON source.record_id=relation.record_id
          WHERE relation.resolved=0 AND relation.mandatory=1
            AND relation.target_record_id=?
          GROUP BY source.execution_id
        `).all(occurrence.occurrenceId) as Row[];
        this.#db.prepare(`
          UPDATE semantic_relations SET resolved=1
          WHERE resolved=0 AND target_record_id=?
        `).run(occurrence.occurrenceId);
        for (const row of newlyResolved) {
          this.#db.prepare(`
            UPDATE executions SET unresolved_mandatory_count=unresolved_mandatory_count-?
            WHERE execution_id=? AND unresolved_mandatory_count>=?
          `).run(row.count, row.execution_id, row.count);
        }
        cost = {
          ...cost,
          serializedBytes: cost.serializedBytes + payloadBytes.byteLength,
          contentBytesHashed: cost.contentBytesHashed +
            (occurrence.content?.byteLength ?? 0),
          contentDigestCalls: cost.contentDigestCalls +
            (occurrence.content === undefined ? 0 : 1),
          newOccurrences: cost.newOccurrences + 1,
          newRelations: cost.newRelations + (occurrence.relations?.length ?? 0),
        };
      }
      for (const update of input.assistantTextUpdates ?? []) {
        const key = update.kind === 'put' ? update.state.key : update.key;
        const params = [
          executionId,
          key.lane ?? '',
          key.modelStep,
          key.requestOrdinal ?? -1,
        ];
        if (update.kind === 'remove') {
          this.#db.prepare(`
            DELETE FROM assistant_text_states
            WHERE execution_id=? AND lane=? AND model_step=? AND request_ordinal=?
          `).run(...params);
        } else {
          const eventBytes = encodeHistoryPayload(
            update.state.event as unknown as JsonValue,
          );
          this.#db.prepare(`
            INSERT INTO assistant_text_states(
              execution_id, lane, model_step, request_ordinal, first_event_ordinal, event_json
            ) VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(execution_id, lane, model_step, request_ordinal)
            DO UPDATE SET event_json=excluded.event_json
          `).run(
            ...params,
            update.state.firstEventOrdinal,
            new TextDecoder().decode(eventBytes),
          );
          cost = {
            ...cost,
            serializedBytes: cost.serializedBytes + eventBytes.byteLength,
          };
        }
      }
      if (input.eventCount !== undefined) {
        this.#db.prepare(
          'UPDATE executions SET event_count=? WHERE execution_id=?',
        ).run(input.eventCount, executionId);
      }
      this.#fault?.('after_occurrences');
      if (
        terminalOccurrenceId !== undefined &&
        !occurrences.some((occurrence) => occurrence.occurrenceId === terminalOccurrenceId)
      ) throw new Error('terminal record is not in append');
      this.#db.prepare(`
        UPDATE executions SET latest_ordinal=?, occurrence_count=occurrence_count+?,
          terminal_record_id=coalesce(?, terminal_record_id)
        WHERE execution_id=?
      `).run(
        occurrences.at(-1)?.ordinal ?? expectedLatestOrdinal,
        occurrences.length,
        terminalOccurrenceId ?? null,
        executionId,
      );
      this.#fault?.('before_commit');
    });
    return cost;
  }

  /** Persist ordered control events in the semantic journal. */
  appendControlEvents(
    executionId: string,
    inputs: readonly Omit<StoredExecutionEvent, 'ordinal'>[],
  ): readonly StoredExecutionEvent[] {
    if (inputs.length === 0) return [];
    let events: StoredExecutionEvent[] = [];
    this.#transaction(() => {
      const state = this.#row(
        'SELECT event_count, latest_ordinal FROM executions WHERE execution_id=?',
        executionId,
      );
      const firstEventOrdinal = Number(state.event_count) + 1;
      events = inputs.map((input, index) => ({
        ...input,
        ordinal: firstEventOrdinal + index,
      }));
      for (const event of events) {
        if (event.executionId !== executionId) {
          throw new Error('history control event execution mismatch');
        }
        const recordId = `control:${randomUUID()}`;
        const payload = encodeHistoryPayload(
          { controlEvent: event } as unknown as JsonValue,
        );
        this.#db.prepare(`
          INSERT INTO semantic_records(
            record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
          ) VALUES(?, ?, ?, 'control_decision', ?, ?, NULL)
        `).run(
          recordId,
          executionId,
          Number(state.latest_ordinal) + event.ordinal - firstEventOrdinal + 1,
          event.observedAt,
          new TextDecoder().decode(payload),
        );
      }
      this.#db.prepare(`
        UPDATE executions SET event_count=?, latest_ordinal=latest_ordinal+?,
          occurrence_count=occurrence_count+?
        WHERE execution_id=?
      `).run(
        firstEventOrdinal + events.length - 1,
        events.length,
        events.length,
        executionId,
      );
    });
    return events;
  }

  /** Append a narrowly scoped semantic fact without reopening ordinary worker observations. */
  appendPostSettlementSemanticEvent(
    input: HistoryPostSettlementSemanticEventInput,
  ): HistoryAppendResult {
    let result: HistoryAppendResult | undefined;
    this.#transaction(() => {
      const state = this.#row(
        'SELECT * FROM executions WHERE execution_id=?',
        input.event.executionId,
      );
      if (
        state.lifecycle !== 'settled' || state.terminal_record_id === null ||
        Number(state.unresolved_mandatory_count) !== 0 ||
        Number(state.latest_ordinal) !== Number(state.occurrence_count)
      ) throw new Error('history post-settlement append fence mismatch');

      const event: StoredExecutionEvent = {
        ...input.event,
        ordinal: Number(state.event_count) + 1,
      };
      const ordinal = Number(state.latest_ordinal) + 1;
      const semanticOccurrenceId = `${event.executionId}:semantic:${ordinal}`;
      const occurrence = {
        occurrenceId: semanticOccurrenceId,
        ordinal,
        kind: input.semanticKind,
        observedAt: event.observedAt,
        payload: { event } as unknown as JsonValue,
      };
      validateHistoryOccurrence(occurrence);
      this.#db.prepare(`
        INSERT INTO semantic_records(
          record_id, execution_id, ordinal, kind, observed_at, payload_json, content_digest
        ) VALUES(?, ?, ?, ?, ?, ?, NULL)
      `).run(
        semanticOccurrenceId,
        event.executionId,
        ordinal,
        input.semanticKind,
        event.observedAt,
        new TextDecoder().decode(encodeHistoryPayload(occurrence.payload)),
      );
      this.#db.prepare(`
        UPDATE executions SET event_count=?, latest_ordinal=?, occurrence_count=occurrence_count+1
        WHERE execution_id=?
      `).run(event.ordinal, ordinal, event.executionId);
      result = { event, semanticOccurrenceId };
    });
    if (result === undefined) {
      throw new Error('history post-settlement append failed');
    }
    return result;
  }

  listControlEvents(executionId: string): readonly StoredExecutionEvent[] {
    const records = this.#db.prepare(`
      SELECT payload_json FROM semantic_records
      WHERE execution_id=? AND kind='control_decision'
      ORDER BY ordinal
    `).all(executionId) as Row[];
    return records.flatMap((row) => {
      const payload = JSON.parse(String(row.payload_json)) as {
        readonly controlEvent?: StoredExecutionEvent;
      };
      return payload.controlEvent === undefined ? [] : [payload.controlEvent];
    });
  }

  settleExecution(
    executionId: string,
    outcome: Exclude<HistoryCoreExecutionState['outcome'], 'unknown'>,
    options: Readonly<{ settledAt?: string; runtimeOutcomeJson?: JsonValue }> = {},
  ): HistoryOperationCost {
    this.#transaction(() => {
      const state = this.#row(
        'SELECT * FROM executions WHERE execution_id=?',
        executionId,
      );
      if (
        state.lifecycle !== 'active' || state.terminal_record_id === null ||
        Number(state.unresolved_mandatory_count) !== 0 ||
        Number(state.latest_ordinal) !== Number(state.occurrence_count)
      ) throw new Error('history semantic settlement incomplete');
      this.#db.prepare(`
        UPDATE executions SET lifecycle='settled', outcome=?, settled_at=?,
          runtime_outcome_json=?
        WHERE execution_id=?
      `).run(
        outcome,
        options.settledAt ?? new Date().toISOString(),
        options.runtimeOutcomeJson === undefined
          ? null
          : JSON.stringify(options.runtimeOutcomeJson),
        executionId,
      );
    });
    return emptyHistoryOperationCost();
  }

  /**
   * Apply canonical adoption when used on its own. Production settlement should call
   * adoptCanonicalInTransaction(db, input) inside the Data-owned transaction instead.
   */
  adoptCanonical(executionId: string): void {
    this.#transaction(() => {
      const state = this.#row(
        'SELECT * FROM executions WHERE execution_id=?',
        executionId,
      );
      if (
        state.lifecycle !== 'settled' || state.outcome !== 'completed' ||
        state.canonical_session_id === null
      ) throw new Error('history execution is not adoptable');
      const turnOrdinal = Number(
        this.#row(
          'SELECT coalesce(max(turn_ordinal), -1) + 1 AS next_ordinal FROM session_turns WHERE session_id=?',
          String(state.canonical_session_id),
        ).next_ordinal,
      );
      adoptCanonicalInTransaction(this.#db, {
        executionId,
        sessionId: String(state.canonical_session_id),
        baseRevision: Number(state.base_revision),
        turnOrdinal,
        turnNumber: Number(state.turn_number),
        settledAt: state.settled_at === null ? new Date().toISOString() : String(state.settled_at),
      });
    });
  }

  static adoptCanonicalInTransaction(
    db: DatabaseSync,
    input: HistoryCanonicalAdoptionInput,
  ): void {
    adoptCanonicalInTransaction(db, input);
  }

  readExecution(executionId: string): HistoryCoreExecutionState {
    const row = this.#row(
      'SELECT * FROM executions WHERE execution_id=?',
      executionId,
    );
    return {
      executionId: String(row.execution_id),
      sessionId: String(row.session_correlation),
      sessionCorrelation: String(row.session_correlation),
      ...(row.canonical_session_id === null ? {} : {
        canonicalSessionId: String(row.canonical_session_id),
      }),
      baseRevision: Number(row.base_revision),
      lifecycle: String(
        row.lifecycle,
      ) as HistoryCoreExecutionState['lifecycle'],
      outcome: String(row.outcome) as HistoryCoreExecutionState['outcome'],
      adoption: String(row.adoption) as HistoryCoreExecutionState['adoption'],
      latestOrdinal: Number(row.latest_ordinal),
      occurrenceCount: Number(row.occurrence_count),
      ...(row.terminal_record_id === null ? {} : {
        terminalOccurrenceId: String(row.terminal_record_id),
      }),
      unresolvedMandatoryCount: Number(row.unresolved_mandatory_count),
    };
  }

  readOccurrence(
    occurrenceId: string,
    db: DatabaseSync = this.#db,
  ): HistorySemanticOccurrence {
    const row = requiredRow(
      db,
      'SELECT * FROM semantic_records WHERE record_id=?',
      occurrenceId,
    );
    return {
      executionId: String(row.execution_id),
      occurrenceId: String(row.record_id),
      ordinal: Number(row.ordinal),
      kind: String(row.kind) as HistorySemanticOccurrence['kind'],
      observedAt: String(row.observed_at),
      payload: JSON.parse(String(row.payload_json)) as JsonValue,
      ...(row.content_digest === null ? {} : { contentDigest: String(row.content_digest) }),
    };
  }

  listOccurrences(
    executionId: string,
    db: DatabaseSync = this.#db,
  ): readonly HistorySemanticOccurrence[] {
    return (db.prepare(`
      SELECT record_id FROM semantic_records
      WHERE execution_id=? ORDER BY ordinal
    `).all(executionId) as Row[]).map((row) => this.readOccurrence(String(row.record_id), db));
  }

  /** Sort only references; never collect the cumulative event text for replay. */
  *readConversationEvents(
    executionId: string,
    db: DatabaseSync = this.#db,
  ): IterableIterator<StoredSessionConversationEvent> {
    const references: {
      occurrenceId: string;
      sourceOrdinal: number;
      ordinal: number;
      textKey?: HistoryAssistantTextKey;
    }[] = (db.prepare(`
      SELECT record_id,
        json_extract(payload_json, '$.event.firstEventOrdinal') AS first_ordinal,
        json_extract(payload_json, '$.event.ordinal') AS event_ordinal
      FROM semantic_records
      WHERE execution_id=? AND json_type(payload_json, '$.event')='object'
    `).all(executionId) as Row[]).map((row) => ({
      occurrenceId: String(row.record_id),
      sourceOrdinal: Number(row.first_ordinal ?? row.event_ordinal),
      ordinal: Number(row.event_ordinal),
    }));
    for (
      const row of db.prepare(`
        SELECT lane, model_step, request_ordinal, first_event_ordinal,
          json_extract(event_json, '$.ordinal') AS event_ordinal
        FROM assistant_text_states WHERE execution_id=?
      `).all(executionId) as Row[]
    ) {
      references.push({
        occurrenceId: '',
        sourceOrdinal: Number(row.first_event_ordinal),
        ordinal: Number(row.event_ordinal),
        textKey: {
          modelStep: Number(row.model_step),
          ...(row.lane === '' ? {} : {
            lane: String(row.lane) as HistoryAssistantTextKey['lane'],
          }),
          ...(Number(row.request_ordinal) === -1 ? {} : {
            requestOrdinal: Number(row.request_ordinal),
          }),
        },
      });
    }
    references.sort((left, right) =>
      left.sourceOrdinal - right.sourceOrdinal ||
      left.ordinal - right.ordinal ||
      left.occurrenceId.localeCompare(right.occurrenceId)
    );
    for (const reference of references) {
      if (reference.textKey !== undefined) {
        const state = this.readAssistantTextState(
          executionId,
          reference.textKey,
          db,
        )!;
        yield {
          event: { ...state.event, firstEventOrdinal: state.firstEventOrdinal },
        };
      } else {
        const occurrence = this.readOccurrence(reference.occurrenceId, db);
        const event = (occurrence.payload as { event: unknown })
          .event as StoredExecutionEvent;
        yield { event, semanticOccurrenceId: occurrence.occurrenceId };
      }
    }
  }

  /** Read current incomplete text through the caller's transaction snapshot. */
  listAssistantTextStates(
    executionId: string,
    db: DatabaseSync = this.#db,
  ): readonly HistoryAssistantTextState[] {
    return (db.prepare(`
      SELECT * FROM assistant_text_states
      WHERE execution_id=? ORDER BY first_event_ordinal
    `).all(executionId) as Row[]).map((row) => ({
      key: {
        modelStep: Number(row.model_step),
        ...(row.lane === '' ? {} : {
          lane: String(row.lane) as HistoryAssistantTextState['key']['lane'],
        }),
        ...(Number(row.request_ordinal) === -1 ? {} : {
          requestOrdinal: Number(row.request_ordinal),
        }),
      },
      firstEventOrdinal: Number(row.first_event_ordinal),
      event: JSON.parse(
        String(row.event_json),
      ) as HistoryAssistantTextState['event'],
    }));
  }

  readAssistantTextState(
    executionId: string,
    key: HistoryAssistantTextKey,
    db: DatabaseSync = this.#db,
  ): HistoryAssistantTextState | undefined {
    const row = db.prepare(`
      SELECT * FROM assistant_text_states
      WHERE execution_id=? AND lane=? AND model_step=? AND request_ordinal=?
    `).get(
      executionId,
      key.lane ?? '',
      key.modelStep,
      key.requestOrdinal ?? -1,
    ) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      key: {
        modelStep: Number(row.model_step),
        ...(row.lane === '' ? {} : {
          lane: String(row.lane) as HistoryAssistantTextState['key']['lane'],
        }),
        ...(Number(row.request_ordinal) === -1 ? {} : {
          requestOrdinal: Number(row.request_ordinal),
        }),
      },
      firstEventOrdinal: Number(row.first_event_ordinal),
      event: JSON.parse(
        String(row.event_json),
      ) as HistoryAssistantTextState['event'],
    };
  }

  readAssistantTextFirstEventOrdinal(
    executionId: string,
    key: HistoryAssistantTextKey,
    db: DatabaseSync = this.#db,
  ): number | undefined {
    const row = db.prepare(`
      SELECT first_event_ordinal FROM assistant_text_states
      WHERE execution_id=? AND lane=? AND model_step=? AND request_ordinal=?
    `).get(
      executionId,
      key.lane ?? '',
      key.modelStep,
      key.requestOrdinal ?? -1,
    ) as Row | undefined;
    return row === undefined ? undefined : Number(row.first_event_ordinal);
  }

  readContent(contentDigest: string, db: DatabaseSync = this.#db): Uint8Array {
    const row = requiredRow(
      db,
      'SELECT byte_length, content_bytes FROM contents WHERE content_digest=?',
      contentDigest,
    );
    const content = (row.content_bytes as Uint8Array).slice();
    if (
      content.byteLength !== Number(row.byte_length) ||
      exactByteDigest(content) !== contentDigest
    ) throw new Error('history content digest mismatch');
    return content;
  }

  hasContent(contentDigest: string, byteLength: number): boolean {
    const row = this.#db.prepare(
      'SELECT byte_length FROM contents WHERE content_digest=?',
    ).get(contentDigest) as Row | undefined;
    return row !== undefined && Number(row.byte_length) === byteLength;
  }

  tableNames(): readonly string[] {
    return (this.#db.prepare(`
      SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Row[]).map((row) => String(row.name));
  }

  #insertContent(db: DatabaseSync, digest: string, content: Uint8Array): void {
    db.prepare(`
      INSERT INTO contents(content_digest, byte_length, content_bytes)
      VALUES(?, ?, ?) ON CONFLICT(content_digest) DO NOTHING
    `).run(digest, content.byteLength, content);
    const stored = requiredRow(
      db,
      'SELECT byte_length FROM contents WHERE content_digest=?',
      digest,
    );
    if (Number(stored.byte_length) !== content.byteLength) {
      throw new Error('history content length mismatch');
    }
  }

  #row(sql: string, ...params: readonly SqlValue[]): Row {
    return requiredRow(this.#db, sql, ...params);
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
