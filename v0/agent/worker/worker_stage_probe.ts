/** Process-local diagnostic stages for one Worker generation. */
export const WORKER_STAGE_PROBE_SCHEMA_VERSION = 1 as const;

export const WORKER_STAGE_CODES = Object.freeze({
  idle: 0,
  aux_context_post_entered: 1,
  aux_context_post_returned: 2,
  aux_context_await_resumed: 3,
  evidence_start_entered: 4,
  provider_start_post_entered: 5,
  provider_start_post_returned: 6,
  aux_request_provider_entered: 7,
  credential_resolve_entered: 8,
  credential_resolve_returned: 9,
  fetch_entered: 10,
  response_headers_received: 11,
  response_body_read_entered: 12,
  response_body_read_returned: 13,
  /** Narrow Slice-F probe: the synchronous fetch() call returned its Promise. */
  fetch_call_returned: 14,
});

export type WorkerStageName = keyof typeof WORKER_STAGE_CODES;

const WORKER_STAGE_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKER_STAGE_CODES).map(([name, code]) => [code, name]),
  ) as Readonly<Record<number, WorkerStageName>>,
);

const INDEX = Object.freeze({
  schemaVersion: 0,
  epoch: 1,
  stageOrdinal: 2,
  stageCode: 3,
  expectedWorkerSequence: 4,
});
const SLOT_COUNT = Object.keys(INDEX).length;

export interface WorkerStageSnapshot {
  readonly schemaVersion: 1;
  readonly epoch: number;
  readonly stageOrdinal: number;
  readonly stage: WorkerStageName;
  readonly expectedWorkerSequence: number;
}

export type WorkerStageSnapshotTrigger =
  | 'auxiliary_gap'
  | 'cancel_requested'
  | 'cancel_escalated'
  | 'terminal';

export interface WorkerStageHistorySnapshot extends WorkerStageSnapshot {
  readonly trigger: WorkerStageSnapshotTrigger;
  readonly workerGeneration: string;
  readonly contextRequestOrdinal?: number;
  readonly lastWorkerSequenceReceived: number;
  readonly lastWorkerSequenceBuffered: number;
  readonly lastWorkerSequenceDurable: number;
}

export type WorkerStageClassification =
  | 'not_started'
  | 'context_post'
  | 'worker_microtask_resume'
  | 'evidence_record_construction'
  | 'worker_message_enqueue'
  | 'worker_message_delivery'
  | 'host_validation_or_buffer'
  | 'history_flush_or_persistence'
  | 'credential_resolution'
  | 'provider_fetch'
  | 'provider_response_body'
  | 'provider_path_advanced';

const view = (buffer: SharedArrayBuffer): Int32Array => {
  if (buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT * SLOT_COUNT) {
    throw new RangeError('invalid Worker stage probe buffer');
  }
  return new Int32Array(buffer);
};

export const createWorkerStageProbeBuffer = (): SharedArrayBuffer => {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOT_COUNT);
  const slots = view(buffer);
  Atomics.store(slots, INDEX.schemaVersion, WORKER_STAGE_PROBE_SCHEMA_VERSION);
  return buffer;
};

/** Host-owned turn boundary. The Worker only advances stages inside the selected epoch. */
export const beginWorkerStageProbeEpoch = (
  buffer: SharedArrayBuffer,
  epoch: number,
): void => {
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch > 0x7fff_ffff) {
    throw new RangeError('Worker stage epoch must be a positive 32-bit integer');
  }
  const slots = view(buffer);
  Atomics.add(slots, INDEX.stageOrdinal, 1);
  Atomics.store(slots, INDEX.epoch, epoch);
  Atomics.store(slots, INDEX.stageCode, WORKER_STAGE_CODES.idle);
  Atomics.store(slots, INDEX.expectedWorkerSequence, 0);
  Atomics.add(slots, INDEX.stageOrdinal, 1);
};

/** Worker-local fixed-cost update; it emits no message and retains no request data. */
export const recordWorkerStage = (
  buffer: SharedArrayBuffer,
  stage: WorkerStageName,
  expectedWorkerSequence = 0,
): void => {
  if (
    !Number.isSafeInteger(expectedWorkerSequence) || expectedWorkerSequence < 0 ||
    expectedWorkerSequence > 0x7fff_ffff
  ) throw new RangeError('invalid expected Worker sequence');
  const slots = view(buffer);
  Atomics.add(slots, INDEX.stageOrdinal, 1);
  Atomics.store(slots, INDEX.stageCode, WORKER_STAGE_CODES[stage]);
  Atomics.store(slots, INDEX.expectedWorkerSequence, expectedWorkerSequence);
  Atomics.add(slots, INDEX.stageOrdinal, 1);
};

/** Stable Host read while the Worker may be updating the same fixed-size latch. */
export const readWorkerStageSnapshot = (
  buffer: SharedArrayBuffer,
): WorkerStageSnapshot => {
  const slots = view(buffer);
  for (;;) {
    const before = Atomics.load(slots, INDEX.stageOrdinal);
    if (before % 2 !== 0) continue;
    const schemaVersion = Atomics.load(slots, INDEX.schemaVersion);
    const epoch = Atomics.load(slots, INDEX.epoch);
    const stageCode = Atomics.load(slots, INDEX.stageCode);
    const expectedWorkerSequence = Atomics.load(
      slots,
      INDEX.expectedWorkerSequence,
    );
    const after = Atomics.load(slots, INDEX.stageOrdinal);
    if (before !== after || after % 2 !== 0) continue;
    const stage = WORKER_STAGE_NAMES[stageCode];
    if (
      schemaVersion !== WORKER_STAGE_PROBE_SCHEMA_VERSION || stage === undefined
    ) throw new TypeError('invalid Worker stage probe state');
    return {
      schemaVersion,
      epoch,
      stageOrdinal: after,
      stage,
      expectedWorkerSequence,
    };
  }
};

export const classifyWorkerStageSnapshot = (
  snapshot: WorkerStageHistorySnapshot,
): WorkerStageClassification => {
  if (
    snapshot.lastWorkerSequenceReceived >
      snapshot.lastWorkerSequenceBuffered
  ) return 'host_validation_or_buffer';
  if (
    snapshot.lastWorkerSequenceBuffered >
      snapshot.lastWorkerSequenceDurable
  ) return 'history_flush_or_persistence';
  if (
    snapshot.stage === 'provider_start_post_returned' &&
    snapshot.expectedWorkerSequence > snapshot.lastWorkerSequenceReceived
  ) return 'worker_message_delivery';
  switch (snapshot.stage) {
    case 'idle':
      return 'not_started';
    case 'aux_context_post_entered':
      return 'context_post';
    case 'aux_context_post_returned':
      return 'worker_microtask_resume';
    case 'aux_context_await_resumed':
    case 'evidence_start_entered':
      return 'evidence_record_construction';
    case 'provider_start_post_entered':
      return 'worker_message_enqueue';
    case 'provider_start_post_returned':
    case 'aux_request_provider_entered':
      return 'provider_path_advanced';
    case 'credential_resolve_entered':
      return 'credential_resolution';
    case 'credential_resolve_returned':
    case 'fetch_entered':
    case 'fetch_call_returned':
      return 'provider_fetch';
    case 'response_headers_received':
    case 'response_body_read_entered':
      return 'provider_response_body';
    case 'response_body_read_returned':
      return 'provider_path_advanced';
  }
};
