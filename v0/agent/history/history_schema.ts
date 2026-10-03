export const HISTORY_SCHEMA_VERSION = 1 as const;
export const HISTORY_BUSY_TIMEOUT_MS = 5_000;

export const HISTORY_SCHEMA_SQL = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE contents (
  content_digest TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  content_bytes BLOB NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  agent_choice_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT,
  state_revision INTEGER NOT NULL,
  next_turn INTEGER NOT NULL,
  active_model_json TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  model_change_count INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  checkpoint_json TEXT
);

CREATE TABLE configurations (
  configuration_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  snapshot_content_digest TEXT NOT NULL REFERENCES contents(content_digest)
);

CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  canonical_session_id TEXT REFERENCES sessions(session_id),
  session_correlation TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_content_digest TEXT NOT NULL REFERENCES contents(content_digest),
  parent_execution_id TEXT REFERENCES executions(execution_id),
  spawn_call_id TEXT,
  turn_number INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  base_message_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  agent_name TEXT NOT NULL,
  configuration_id TEXT REFERENCES configurations(configuration_id),
  build_json TEXT NOT NULL,
  model_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL,
  instance_correlation TEXT,
  worker_generation TEXT,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  adoption TEXT NOT NULL,
  latest_ordinal INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL,
  terminal_record_id TEXT REFERENCES semantic_records(record_id),
  unresolved_mandatory_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  runtime_outcome_json TEXT
);

CREATE INDEX executions_session_turn
  ON executions(session_correlation, turn_number, created_at, execution_id);
CREATE INDEX executions_parent_created
  ON executions(parent_execution_id, created_at);

CREATE TABLE messages (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  content_digest TEXT NOT NULL REFERENCES contents(content_digest),
  PRIMARY KEY(execution_id, message_ordinal)
);

CREATE TABLE session_turns (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_ordinal INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
  PRIMARY KEY(session_id, turn_ordinal),
  UNIQUE(session_id, turn_number)
);

CREATE TABLE conversation_messages (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_ordinal INTEGER NOT NULL,
  turn_number INTEGER NOT NULL,
  execution_id TEXT NOT NULL,
  execution_message_ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id, message_ordinal),
  FOREIGN KEY(session_id, turn_number)
    REFERENCES session_turns(session_id, turn_number),
  FOREIGN KEY(execution_id, execution_message_ordinal)
    REFERENCES messages(execution_id, message_ordinal)
);

CREATE TABLE session_model_changes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  change_ordinal INTEGER NOT NULL,
  effective_from_turn INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  PRIMARY KEY(session_id, change_ordinal)
);

CREATE TABLE semantic_records (
  record_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_digest TEXT REFERENCES contents(content_digest),
  UNIQUE(execution_id, ordinal)
);
CREATE INDEX semantic_records_execution_ordinal
  ON semantic_records(execution_id, ordinal);

CREATE TABLE semantic_relations (
  record_id TEXT NOT NULL REFERENCES semantic_records(record_id) ON DELETE CASCADE,
  relation_ordinal INTEGER NOT NULL,
  relation TEXT NOT NULL,
  target_record_id TEXT NOT NULL,
  mandatory INTEGER NOT NULL,
  resolved INTEGER NOT NULL,
  PRIMARY KEY(record_id, relation_ordinal)
);
CREATE INDEX semantic_relations_unresolved
  ON semantic_relations(resolved, target_record_id);

CREATE TABLE assistant_text_states (
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  model_step INTEGER NOT NULL,
  request_ordinal INTEGER NOT NULL,
  first_event_ordinal INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(execution_id, lane, model_step, request_ordinal)
);

CREATE TABLE execution_contexts (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL
);

CREATE TABLE diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  content_digest TEXT NOT NULL REFERENCES contents(content_digest)
);

CREATE TABLE recall_relations (
  source_execution_id TEXT NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  target_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  record_id TEXT NOT NULL UNIQUE REFERENCES semantic_records(record_id),
  PRIMARY KEY(source_execution_id, target_execution_id)
);

INSERT INTO store_metadata(singleton, schema_version, created_at)
VALUES(1, ${HISTORY_SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = ${HISTORY_SCHEMA_VERSION};
`;
