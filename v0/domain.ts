export const SCHEMA_VERSION = 1 as const;
export const ENVELOPE_VERSION = 1 as const;

export type FailureCode =
  | 'invalid_input'
  | 'invalid_manifest'
  | 'source_rejected'
  | 'digest_mismatch'
  | 'state_invalid'
  | 'state_conflict'
  | 'not_found'
  | 'already_active'
  | 'no_active'
  | 'lock_busy'
  | 'protocol_violation'
  | 'process_timeout'
  | 'process_output_limit'
  | 'process_permission'
  | 'plugin_exit'
  | 'host_handler_failed'
  | 'model_error'
  | 'external_not_authorized'
  | 'external_attempt_used'
  | 'limit_exceeded';

export interface Failure {
  readonly code: FailureCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export const failure = (
  code: FailureCode,
  message: string,
  details?: Record<string, unknown>,
): Failure => ({ code, message, ...(details ? { details } : {}) });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

export const nonEmpty = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

export interface Manifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly revision: string;
  readonly entrypoint: 'main.ts';
}

export interface InstalledExtension extends Manifest {
  readonly digest: string;
  readonly sourceOrigin: string;
  readonly installedAt: string;
}

export interface ActiveExtension {
  readonly id: string;
  readonly version: string;
  readonly revision: string;
  readonly digest: string;
}

export type ActionKind = 'install' | 'activate' | 'switch' | 'rollback';
export interface Action {
  readonly sequence: number;
  readonly kind: ActionKind;
  readonly id: string;
  readonly digest: string;
  readonly at: string;
  readonly explicit: true;
}

export type AttemptStatus = 'authorized' | 'started' | 'succeeded' | 'failed' | 'indeterminate';
export interface Attempt {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly maxRequests: 1;
  readonly maxUsd: number;
  readonly requestCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode?: string;
}

export interface State {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sequence: number;
  readonly installed: readonly InstalledExtension[];
  readonly active?: ActiveExtension;
  readonly actions: readonly Action[];
  readonly attempts: readonly Attempt[];
}

export const emptyState = (): State => ({
  schemaVersion: SCHEMA_VERSION,
  sequence: 0,
  installed: [],
  actions: [],
  attempts: [],
});

const isHexDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const parseManifest = (value: unknown): Manifest | Failure => {
  if (!isRecord(value)) return failure('invalid_manifest', 'manifest must be an object');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'entrypoint,id,revision,schemaVersion,version') {
    return failure('invalid_manifest', 'manifest has unknown or missing fields');
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !nonEmpty(value.id, 128) ||
    !nonEmpty(value.version, 64) ||
    !nonEmpty(value.revision, 128) ||
    value.entrypoint !== 'main.ts'
  ) {
    return failure('invalid_manifest', 'manifest fields are invalid');
  }
  if (value.id.includes('/') || value.id.includes('\\') || value.id.includes('..')) {
    return failure('invalid_manifest', 'manifest id cannot contain a path');
  }
  return value as unknown as Manifest;
};

export const parseState = (value: unknown): State | Failure => {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return failure('state_invalid', 'unknown state schema');
  }
  const sequence = value.sequence;
  if (
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0 ||
    !Array.isArray(value.installed) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.attempts) ||
    value.actions.length > 256
  ) {
    return failure('state_invalid', 'state shape or bounds are invalid');
  }
  const installed: InstalledExtension[] = [];
  for (const item of value.installed) {
    if (!isRecord(item)) return failure('state_invalid', 'installed item is invalid');
    const manifest = parseManifest({
      schemaVersion: item.schemaVersion,
      id: item.id,
      version: item.version,
      revision: item.revision,
      entrypoint: item.entrypoint,
    });
    if ('code' in manifest) return manifest;
    if (
      !isHexDigest(item.digest) || !nonEmpty(item.sourceOrigin, 1024) ||
      !nonEmpty(item.installedAt, 64)
    ) {
      return failure('state_invalid', 'installed identity is invalid');
    }
    installed.push({
      ...manifest,
      digest: item.digest,
      sourceOrigin: item.sourceOrigin,
      installedAt: item.installedAt,
    });
  }
  let active: ActiveExtension | undefined;
  if (value.active !== undefined) {
    if (
      !isRecord(value.active) || !nonEmpty(value.active.id) || !nonEmpty(value.active.version) ||
      !nonEmpty(value.active.revision) || !isHexDigest(value.active.digest)
    ) {
      return failure('state_invalid', 'active identity is invalid');
    }
    const activeValue = value.active as Record<string, unknown>;
    const match = installed.find((item) =>
      item.id === activeValue.id && item.digest === activeValue.digest
    );
    if (
      !match || match.version !== activeValue.version || match.revision !== activeValue.revision
    ) {
      return failure('state_invalid', 'active must refer to an installed exact revision');
    }
    active = value.active as unknown as ActiveExtension;
  }
  const actions: Action[] = [];
  for (const item of value.actions) {
    if (
      !isRecord(item) || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 ||
      !nonEmpty(item.kind, 16) || !nonEmpty(item.id) || !isHexDigest(item.digest) ||
      !nonEmpty(item.at, 64) || item.explicit !== true
    ) {
      return failure('state_invalid', 'action is invalid');
    }
    actions.push(item as unknown as Action);
  }
  const attempts: Attempt[] = [];
  for (const item of value.attempts) {
    if (
      !isRecord(item) || !nonEmpty(item.id, 128) || !nonEmpty(item.status, 32) ||
      item.maxRequests !== 1 || typeof item.maxUsd !== 'number' || item.maxUsd <= 0 ||
      item.maxUsd > 0.064 ||
      !Number.isFinite(item.maxUsd) || !Number.isSafeInteger(item.requestCount) ||
      (item.requestCount as number) < 0 || (item.requestCount as number) > 1 ||
      !nonEmpty(item.createdAt, 64) || !nonEmpty(item.updatedAt, 64)
    ) {
      return failure('state_invalid', 'attempt is invalid');
    }
    attempts.push(item as unknown as Attempt);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sequence: sequence as number,
    installed,
    ...(active ? { active } : {}),
    actions,
    attempts,
  };
};

export interface PlanStep {
  readonly id: string;
  readonly description: string;
}
export interface Plan {
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
  readonly risks?: readonly string[];
}

export const parsePlan = (value: unknown): Plan | Failure => {
  if (
    !isRecord(value) || !boundedString(value.title, 256) || value.title.length === 0 ||
    !boundedString(value.summary, 4096) || !Array.isArray(value.steps) || value.steps.length > 32
  ) {
    return failure('invalid_input', 'plan shape is invalid');
  }
  const steps: PlanStep[] = [];
  for (const step of value.steps) {
    if (
      !isRecord(step) || !boundedString(step.id, 64) || step.id.length === 0 ||
      !boundedString(step.description, 2048) || step.description.length === 0
    ) return failure('invalid_input', 'plan step is invalid');
    steps.push({ id: step.id, description: step.description });
  }
  if (
    value.risks !== undefined &&
    (!Array.isArray(value.risks) || value.risks.length > 32 ||
      value.risks.some((risk) => !boundedString(risk, 1024)))
  ) return failure('invalid_input', 'plan risks are invalid');
  return {
    title: value.title,
    summary: value.summary,
    steps,
    ...(value.risks ? { risks: value.risks as string[] } : {}),
  };
};

export interface RequestEnvelope {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly kind: 'request';
  readonly method: string;
  readonly parentId?: string;
  readonly payload: unknown;
}
export interface ResponseEnvelope {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly kind: 'response';
  readonly replyTo: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
export type Envelope = RequestEnvelope | ResponseEnvelope;

export const asFailure = (value: unknown): value is Failure =>
  isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
