/**
 * The provider-neutral, deliberately small failure diagnostic contract.
 *
 * This module has no host, provider, filesystem, or presentation dependencies.  In particular,
 * there is no field here which can contain a message, path, header, payload, model text, or stack.
 */

export const FAILURE_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_REQUESTS = Number.MAX_SAFE_INTEGER;
export const MAX_DIAGNOSTIC_MODEL_STEP = Number.MAX_SAFE_INTEGER;
export const MAX_DIAGNOSTIC_BYTES = 1_024;
export const DIAGNOSTIC_RETRY_COUNT = 0 as const;

/** Publicly safe projection of a diagnostic persistence failure. */
export type FailureDiagnosticPersistenceErrorCode =
  | 'diagnostic_not_found'
  | 'diagnostic_busy'
  | 'diagnostic_invalid'
  | 'diagnostic_capacity'
  | 'diagnostic_io_failure';

export type FailureDiagnosticDurability = 'yes' | 'failed' | 'unknown';

export type FailureStage =
  | 'credential_resolution'
  | 'request_build'
  | 'request_admission'
  | 'transport'
  | 'http'
  | 'response_parse'
  | 'model_result_validation'
  | 'session_commit'
  | 'cancellation_cleanup'
  | 'turn_control'
  | 'unknown_stage';

export type FailureCode =
  | 'missing_credential'
  | 'invalid_input'
  | 'request_budget_exhausted'
  | 'provider_timeout'
  | 'transport_error'
  | 'http_error'
  | 'response_error'
  | 'limit_exceeded'
  | 'invalid_model_result'
  | 'commit_error'
  | 'cleanup_error'
  | 'turn_cancelled'
  | 'model_step_limit'
  | 'unknown_code';

export type ParseReason =
  | 'unsupported_media_type'
  | 'response_body_missing'
  | 'response_body_too_large'
  | 'response_stream_failed'
  | 'invalid_utf8'
  | 'invalid_sse_framing'
  | 'invalid_sse_json'
  | 'provider_reported_error'
  | 'invalid_completion_identity'
  | 'unsupported_choice_shape'
  | 'unsupported_finish_reason'
  | 'unsupported_delta_shape'
  | 'mixed_text_and_tool_calls'
  | 'invalid_tool_arguments'
  | 'incomplete_tool_call'
  | 'invalid_usage_frame'
  | 'data_after_terminal'
  | 'empty_terminal_result'
  | 'stream_ended_before_done'
  | 'unsupported_response_shape';

export type DiagnosticLane = 'parent' | 'planner';

export interface FailureDiagnosticV1 {
  readonly schemaVersion: 1;
  readonly diagnosticId: string;
  readonly stage: FailureStage;
  readonly code: FailureCode;
  readonly lane: DiagnosticLane;
  readonly providerRequestCount: number;
  readonly httpStatus?: number;
  readonly parseReason?: ParseReason;
  readonly occurredAt: string;
  readonly turnNumber: number;
  readonly modelStep: number;
  readonly retryCount: number;
}

export interface FailureDiagnosticFact {
  readonly stage: FailureStage;
  readonly code: FailureCode;
  readonly lane?: DiagnosticLane;
  readonly providerRequestCount: number;
  readonly retryCount?: number;
  readonly httpStatus?: number;
  readonly parseReason?: ParseReason;
  readonly turnNumber: number;
  readonly modelStep: number;
  readonly occurredAt?: string;
}

export type FailureDiagnosticPersister = (
  diagnostic: FailureDiagnosticV1,
) => void | PromiseLike<void>;

export interface FailureDiagnosticOwnerOptions {
  readonly uuid?: () => string;
  readonly now?: () => string;
  readonly persist?: FailureDiagnosticPersister;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STAGES: readonly FailureStage[] = [
  'credential_resolution',
  'request_build',
  'request_admission',
  'transport',
  'http',
  'response_parse',
  'model_result_validation',
  'session_commit',
  'cancellation_cleanup',
  'turn_control',
  'unknown_stage',
];
const CODES: readonly FailureCode[] = [
  'missing_credential',
  'invalid_input',
  'request_budget_exhausted',
  'provider_timeout',
  'transport_error',
  'http_error',
  'response_error',
  'limit_exceeded',
  'invalid_model_result',
  'commit_error',
  'cleanup_error',
  'turn_cancelled',
  'model_step_limit',
  'unknown_code',
];
const PARSE_REASONS: readonly ParseReason[] = [
  'unsupported_media_type',
  'response_body_missing',
  'response_body_too_large',
  'response_stream_failed',
  'invalid_utf8',
  'invalid_sse_framing',
  'invalid_sse_json',
  'provider_reported_error',
  'invalid_completion_identity',
  'unsupported_choice_shape',
  'unsupported_finish_reason',
  'unsupported_delta_shape',
  'mixed_text_and_tool_calls',
  'invalid_tool_arguments',
  'incomplete_tool_call',
  'invalid_usage_frame',
  'data_after_terminal',
  'empty_terminal_result',
  'stream_ended_before_done',
  'unsupported_response_shape',
];

const ownKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
};
const includes = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && values.includes(value as T);
const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
};
const positiveTurn = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const modelStep = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_DIAGNOSTIC_MODEL_STEP;
const requestCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_DIAGNOSTIC_REQUESTS;
const retryCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_DIAGNOSTIC_REQUESTS;
const status = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 &&
  value <= 599;

/** Validate exact object shape and all stage-dependent invariants. */
export const validateFailureDiagnostic = (
  value: unknown,
): value is FailureDiagnosticV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'diagnosticId',
    'stage',
    'code',
    'lane',
    'providerRequestCount',
    ...(Object.hasOwn(record, 'httpStatus') ? ['httpStatus'] : []),
    ...(Object.hasOwn(record, 'parseReason') ? ['parseReason'] : []),
    'occurredAt',
    'turnNumber',
    'modelStep',
    'retryCount',
  ];
  if (
    !ownKeys(record, keys) || record.schemaVersion !== 1 ||
    typeof record.diagnosticId !== 'string' ||
    !UUID_V4.test(record.diagnosticId) ||
    !includes(STAGES, record.stage) || !includes(CODES, record.code) ||
    (record.lane !== 'parent' && record.lane !== 'planner') ||
    !requestCount(record.providerRequestCount) ||
    !validTimestamp(record.occurredAt) ||
    !positiveTurn(record.turnNumber) || !modelStep(record.modelStep) ||
    !retryCount(record.retryCount) || record.retryCount > record.providerRequestCount
  ) {
    return false;
  }
  if (Object.hasOwn(record, 'httpStatus') && !status(record.httpStatus)) {
    return false;
  }
  if (
    Object.hasOwn(record, 'parseReason') &&
    !includes(PARSE_REASONS, record.parseReason)
  ) {
    return false;
  }
  const stage = record.stage as FailureStage;
  const code = record.code as FailureCode;
  const count = record.providerRequestCount as number;
  const hasStatus = Object.hasOwn(record, 'httpStatus');
  const hasReason = Object.hasOwn(record, 'parseReason');
  switch (stage) {
    case 'credential_resolution':
      return code === 'missing_credential' && count >= 0 && !hasStatus &&
        !hasReason;
    case 'request_build':
      return (code === 'invalid_input' || code === 'limit_exceeded') &&
        count >= 0 &&
        !hasStatus && !hasReason;
    case 'request_admission':
      return code === 'request_budget_exhausted' && count >= 0 &&
        record.modelStep === 0 &&
        !hasStatus && !hasReason;
    case 'transport':
      return (code === 'transport_error' || code === 'provider_timeout') &&
        count >= 1 && !hasStatus &&
        !hasReason;
    case 'http':
      return code === 'http_error' && count >= 1 && hasStatus && !hasReason;
    case 'response_parse':
      return (code === 'response_error' || code === 'limit_exceeded') &&
        count >= 1 && hasStatus &&
        hasReason;
    case 'model_result_validation':
      return code === 'invalid_model_result' && !hasStatus && !hasReason;
    case 'session_commit':
      return code === 'commit_error' && record.modelStep === 0 && !hasStatus &&
        !hasReason;
    case 'cancellation_cleanup':
      return code === 'cleanup_error' && record.modelStep === 0 && !hasStatus &&
        !hasReason;
    case 'turn_control':
      return (code === 'turn_cancelled' || code === 'model_step_limit') &&
        record.modelStep === 0 && !hasStatus && !hasReason;
    case 'unknown_stage':
      return code === 'unknown_code' && !hasStatus && !hasReason;
  }
};

const freezeDeep = (value: FailureDiagnosticV1): FailureDiagnosticV1 => Object.freeze({ ...value });

/** Build a canonical record from allowlisted facts.  Invalid facts fail closed. */
export const createFailureDiagnostic = (
  fact: FailureDiagnosticFact,
  options: { readonly uuid?: () => string; readonly now?: () => string } = {},
): FailureDiagnosticV1 => {
  const diagnostic: FailureDiagnosticV1 = {
    schemaVersion: 1,
    diagnosticId: (options.uuid ?? (() => crypto.randomUUID()))().toLowerCase(),
    stage: fact.stage,
    code: fact.code,
    lane: fact.lane ?? 'parent',
    providerRequestCount: fact.providerRequestCount,
    ...(fact.httpStatus === undefined ? {} : { httpStatus: fact.httpStatus }),
    ...(fact.parseReason === undefined ? {} : { parseReason: fact.parseReason }),
    occurredAt: fact.occurredAt ??
      (options.now ?? (() => new Date().toISOString()))(),
    turnNumber: fact.turnNumber,
    modelStep: fact.modelStep,
    retryCount: fact.retryCount ?? DIAGNOSTIC_RETRY_COUNT,
  };
  if (!validateFailureDiagnostic(diagnostic)) {
    throw new RangeError('invalid failure diagnostic');
  }
  const encoded = encodeFailureDiagnostic(diagnostic);
  if (
    new TextEncoder().encode(`${encoded}\n`).byteLength > MAX_DIAGNOSTIC_BYTES
  ) {
    throw new RangeError('failure diagnostic exceeds 1 KiB');
  }
  return freezeDeep(diagnostic);
};

export class FailureDiagnosticCollisionError extends Error {
  constructor() {
    super('multiple failure diagnostics for one turn');
    this.name = 'FailureDiagnosticCollisionError';
  }
}

/** Owns the one immutable diagnostic slot for an accepted turn. */
export class FailureDiagnosticOwner {
  private current?: FailureDiagnosticV1;
  private collision = false;
  private persistence?: Promise<void>;
  private persistenceError?: unknown;
  private persisted = false;
  constructor(
    readonly turnNumber: number,
    private readonly options: FailureDiagnosticOwnerOptions = {},
  ) {
    if (!positiveTurn(turnNumber)) {
      throw new RangeError('turnNumber must be positive');
    }
  }
  record(fact: Omit<FailureDiagnosticFact, 'turnNumber'>): FailureDiagnosticV1 {
    if (this.current !== undefined) {
      this.collision = true;
      throw new FailureDiagnosticCollisionError();
    }
    this.current = createFailureDiagnostic({
      ...fact,
      turnNumber: this.turnNumber,
    }, this.options);
    return this.current;
  }
  recordFailure(
    fact: Omit<FailureDiagnosticFact, 'turnNumber'>,
  ): FailureDiagnosticV1 {
    return this.record(fact);
  }
  snapshot(): FailureDiagnosticV1 | undefined {
    return this.current;
  }
  get diagnostic(): FailureDiagnosticV1 | undefined {
    return this.current;
  }
  get hasCollision(): boolean {
    return this.collision;
  }
  get durability(): FailureDiagnosticDurability {
    if (this.persisted) return 'yes';
    if (this.persistenceError !== undefined) return 'failed';
    return 'unknown';
  }
  get persistenceErrorCode(): FailureDiagnosticPersistenceErrorCode | undefined {
    if (this.persistenceError === undefined) return undefined;
    const code = typeof this.persistenceError === 'object' && this.persistenceError !== null
      ? (this.persistenceError as { readonly code?: unknown }).code
      : undefined;
    return code === 'diagnostic_not_found' || code === 'diagnostic_busy' ||
        code === 'diagnostic_invalid' || code === 'diagnostic_capacity' ||
        code === 'diagnostic_io_failure'
      ? code
      : 'diagnostic_io_failure';
  }
  async persist(): Promise<void> {
    if (
      this.current === undefined || this.options.persist === undefined ||
      this.persisted
    ) return;
    if (this.persistenceError !== undefined) throw this.persistenceError;
    if (this.persistence === undefined) {
      const persist = this.options.persist;
      this.persistence = Promise.resolve().then(() => persist(this.current!))
        .then(() => {
          this.persisted = true;
        }).catch((error) => {
          this.persistenceError = error;
          throw error;
        });
    }
    await this.persistence;
  }
}

/** Canonical compact JSON (the trailing newline is supplied by the file store). */
export const encodeFailureDiagnostic = (value: FailureDiagnosticV1): string => {
  if (!validateFailureDiagnostic(value)) {
    throw new TypeError('invalid failure diagnostic');
  }
  return JSON.stringify(value);
};

export class FailureDiagnosticCodecError extends Error {
  constructor() {
    super('invalid failure diagnostic');
    this.name = 'FailureDiagnosticCodecError';
  }
}

export const decodeFailureDiagnostic = (
  bytes: Uint8Array | string,
): FailureDiagnosticV1 => {
  try {
    const text = typeof bytes === 'string'
      ? bytes
      : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n') && text.length > 0) {
      throw new FailureDiagnosticCodecError();
    }
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const value: unknown = JSON.parse(body);
    if (
      !validateFailureDiagnostic(value) ||
      encodeFailureDiagnostic(value) !== body
    ) {
      throw new FailureDiagnosticCodecError();
    }
    return freezeDeep(value);
  } catch {
    throw new FailureDiagnosticCodecError();
  }
};

/** Single-line human projection; it contains no arbitrary runtime text. */
export const formatFailureDiagnostic = (
  value: FailureDiagnosticV1,
  durable: FailureDiagnosticDurability = 'yes',
): string => {
  if (!validateFailureDiagnostic(value)) {
    throw new TypeError('invalid failure diagnostic');
  }
  const fields = [
    `id=${value.diagnosticId}`,
    `stage=${value.stage}`,
    `code=${value.code}`,
    `lane=${value.lane}`,
    `requests=${value.providerRequestCount}`,
  ];
  if (value.httpStatus !== undefined) fields.push(`http=${value.httpStatus}`);
  if (value.parseReason !== undefined) {
    fields.push(`reason=${value.parseReason}`);
  }
  if (value.stage === 'unknown_stage' || value.code === 'unknown_code') {
    fields.push('reason=not_instrumented');
  }
  fields.push(
    `turn=${value.turnNumber}`,
    `step=${value.modelStep}`,
    `occurredAt=${value.occurredAt}`,
    'retry=0',
    `durable=${durable}`,
  );
  return `failure> ${fields.join(' · ')}`;
};

export const parseFailureDiagnostic = decodeFailureDiagnostic;
export const stringifyFailureDiagnostic = encodeFailureDiagnostic;
export const isFailureDiagnostic = validateFailureDiagnostic;
