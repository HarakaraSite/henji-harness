import type { Message } from './contracts.ts';
import { canonicalDomainSeparatedDigest, canonicalUtf8Bytes } from './canonical_identity.ts';
import {
  type AgentResolvedManifestV1,
  validateAgentResolvedManifest,
} from './resolved_manifest.ts';
import type { AgentResourceIdentity } from './resource_identity.ts';
import {
  cloneReplayTranscript,
  isReplayText,
  parseReplayCausalTranscript,
} from './replay_value.ts';

export const REPLAY_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const REPLAY_ENVELOPE_DOMAIN = 'henji-agent-replay-envelope:v1\n';
export const REPLAY_ENVELOPE_IDENTITY_PREFIX = 'henji-agent-replay-envelope:v1:sha256:';
export const WORKSPACE_CONTENT_DOMAIN = 'henji-workspace-content:v1\n';
export const WORKSPACE_CONTENT_IDENTITY_PREFIX = 'henji-workspace-content:v1:sha256:';
export const MAX_REPLAY_ENVELOPE_PAYLOAD_BYTES = 524_288;
export const MAX_WORKSPACE_ENTRIES = 256;
export const MAX_WORKSPACE_PAYLOAD_BYTES = 294_912;
export const MAX_INITIAL_TRANSCRIPT_MESSAGES = 128;
export const MAX_INITIAL_TRANSCRIPT_BYTES = 262_144;

const ENVELOPE_IDENTITY = /^henji-agent-replay-envelope:v1:sha256:[0-9a-f]{64}$/;
const CONTENT_IDENTITY = /^henji-workspace-content:v1:sha256:[0-9a-f]{64}$/;
const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MODEL_IDENTITY = /^model:[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/;
const encoder = new TextEncoder();

export class AgentReplayEnvelopeError extends Error {
  constructor() {
    super('invalid agent replay envelope');
    this.name = 'AgentReplayEnvelopeError';
  }
}

const invalid = (): never => {
  throw new AgentReplayEnvelopeError();
};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const ownDataKeys = (value: Record<string, unknown>, names: readonly string[]): boolean => {
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys.length !== names.length) {
    return false;
  }
  if (keys.some((key, index) => key !== names[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const arrayData = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  return length !== undefined && 'value' in length && !length.enumerable &&
    length.value === value.length &&
    names.length === value.length + 1 && names[names.length - 1] === 'length' &&
    names.slice(0, -1).every((name, index) => name === String(index)) &&
    (() => {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return false;
        }
      }
      return true;
    })();
};

const exactInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const snapshotWorkspace = (
  value: unknown,
): { readonly entries: readonly { readonly path: string; readonly digest: string }[] } => {
  if (
    !plain(value) || !ownDataKeys(value, ['entries']) || !arrayData(value.entries) ||
    value.entries.length > MAX_WORKSPACE_ENTRIES
  ) return invalid();
  const entries = value.entries.map((entry) => {
    if (
      !plain(entry) || !ownDataKeys(entry, ['path', 'digest']) ||
      !isReplayText(entry.path, 1024, true) ||
      typeof entry.digest !== 'string' || !CONTENT_IDENTITY.test(entry.digest)
    ) return invalid();
    if (
      entry.path.includes('\\') || entry.path.includes(':') || entry.path.includes('\0') ||
      entry.path.endsWith('/')
    ) return invalid();
    if (
      entry.path.startsWith('/') ||
      entry.path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
    ) return invalid();
    for (const code of entry.path) {
      if (code.charCodeAt(0) < 0x20 || code.charCodeAt(0) === 0x7f) return invalid();
    }
    if (entry.path.split('/').some((part) => !isReplayText(part, 128, true))) return invalid();
    return { path: entry.path, digest: entry.digest };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path >= entries[index].path) return invalid();
  }
  const result = Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_WORKSPACE_PAYLOAD_BYTES) {
    return invalid();
  }
  return result;
};

const snapshotBudget = (value: unknown, maxSteps: number) => {
  if (
    !plain(value) ||
    !ownDataKeys(value, ['maxSteps', 'modelRequests', 'maxExternalRequests', 'maxWallTimeMicros'])
  ) return invalid();
  if (!exactInteger(value.maxSteps, 1, 8) || value.maxSteps !== maxSteps) return invalid();
  if (
    !plain(value.modelRequests) ||
    !ownDataKeys(value.modelRequests, ['parent', 'planner', 'aggregate'])
  ) return invalid();
  const modelRequests = value.modelRequests;
  if (
    !exactInteger(modelRequests.parent, 1, 8) || modelRequests.parent !== maxSteps ||
    !exactInteger(modelRequests.planner, 0, 8) ||
    !exactInteger(modelRequests.aggregate, 1, 16) ||
    modelRequests.aggregate !== modelRequests.parent + modelRequests.planner ||
    !exactInteger(value.maxExternalRequests, 0, modelRequests.aggregate) ||
    !exactInteger(value.maxWallTimeMicros, 1, 3_600_000_000)
  ) return invalid();
  return Object.freeze({
    maxSteps,
    modelRequests: Object.freeze({
      parent: modelRequests.parent,
      planner: modelRequests.planner,
      aggregate: modelRequests.aggregate,
    }),
    maxExternalRequests: value.maxExternalRequests,
    maxWallTimeMicros: value.maxWallTimeMicros,
  });
};

const modelFromManifest = (manifest: AgentResolvedManifestV1): AgentResourceIdentity => {
  const models = manifest.resources.filter((resource) => resource.startsWith('model:'));
  if (models.length !== 1 || !MODEL_IDENTITY.test(models[0])) return invalid();
  return models[0];
};

const payloadObject = (envelope: Omit<AgentReplayEnvelopeV1, 'identity'>) => ({
  schemaVersion: 1 as const,
  caseId: envelope.caseId,
  task: envelope.task,
  workspace: envelope.workspace,
  modelIdentity: envelope.modelIdentity,
  budget: envelope.budget,
  initialTranscript: envelope.initialTranscript,
  manifest: envelope.manifest,
});

const payload = (envelope: Omit<AgentReplayEnvelopeV1, 'identity'>): Uint8Array => {
  const bytes = canonicalUtf8Bytes(JSON.stringify(payloadObject(envelope)));
  if (bytes.byteLength > MAX_REPLAY_ENVELOPE_PAYLOAD_BYTES) return invalid();
  return bytes;
};

const freezeEnvelope = async (
  input: Record<string, unknown>,
  withIdentity: boolean,
): Promise<AgentReplayEnvelopeV1> => {
  // Snapshot every caller-owned envelope field before the manifest digest awaits Web Crypto.
  if (
    !isReplayText(input.caseId, 128, true) || !CASE_ID.test(input.caseId) ||
    !isReplayText(input.task, 65_536, true) || !plain(input.budget) ||
    !ownDataKeys(input.budget, [
      'maxSteps',
      'modelRequests',
      'maxExternalRequests',
      'maxWallTimeMicros',
    ]) || typeof input.budget.maxSteps !== 'number'
  ) return invalid();
  const caseId = input.caseId;
  const task = input.task;
  if (typeof input.modelIdentity !== 'string') return invalid();
  const requestedModelIdentity = input.modelIdentity;
  const suppliedIdentity = withIdentity
    ? undefined
    : (typeof input.identity === 'string' ? input.identity : invalid());
  const workspace = snapshotWorkspace(input.workspace);
  const initialTranscript = cloneReplayTranscript(input.initialTranscript, {
    max: MAX_INITIAL_TRANSCRIPT_MESSAGES,
    maxBytes: MAX_INITIAL_TRANSCRIPT_BYTES,
  });
  if (
    initialTranscript.length > 0 && parseReplayCausalTranscript(initialTranscript) === undefined
  ) return invalid();
  const budget = snapshotBudget(input.budget, input.budget.maxSteps);
  const manifest = await validateAgentResolvedManifest(input.manifest);
  const modelIdentity = modelFromManifest(manifest);
  if (
    requestedModelIdentity !== modelIdentity || budget.maxSteps !== manifest.parameters.maxSteps
  ) {
    return invalid();
  }
  const base = {
    schemaVersion: 1 as const,
    caseId,
    task,
    workspace,
    modelIdentity,
    budget,
    initialTranscript,
    manifest,
  } satisfies Omit<AgentReplayEnvelopeV1, 'identity'>;
  const bytes = payload(base);
  const expectedIdentity = await canonicalDomainSeparatedDigest(
    REPLAY_ENVELOPE_DOMAIN,
    bytes,
    REPLAY_ENVELOPE_IDENTITY_PREFIX,
  );
  const identity: string = withIdentity ? expectedIdentity : suppliedIdentity as string;
  if (!ENVELOPE_IDENTITY.test(identity)) return invalid();
  if (!withIdentity && suppliedIdentity !== expectedIdentity) return invalid();
  return Object.freeze({ ...base, identity: identity as AgentReplayEnvelopeIdentity });
};

export type AgentReplayEnvelopeIdentity = string & {
  readonly __agentReplayEnvelopeIdentity: unique symbol;
};

export interface AgentReplayEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly task: string;
  readonly workspace: {
    readonly entries: readonly { readonly path: string; readonly digest: string }[];
  };
  readonly modelIdentity: AgentResourceIdentity;
  readonly budget: {
    readonly maxSteps: number;
    readonly modelRequests: {
      readonly parent: number;
      readonly planner: number;
      readonly aggregate: number;
    };
    readonly maxExternalRequests: number;
    readonly maxWallTimeMicros: number;
  };
  readonly initialTranscript: readonly Message[];
  readonly manifest: AgentResolvedManifestV1;
  readonly identity: AgentReplayEnvelopeIdentity;
}

export interface AgentReplayEnvelopeInput {
  readonly caseId: string;
  readonly task: string;
  readonly workspace: AgentReplayEnvelopeV1['workspace'];
  readonly modelIdentity: AgentResourceIdentity | string;
  readonly budget: AgentReplayEnvelopeV1['budget'];
  readonly initialTranscript: readonly Message[];
  readonly manifest: AgentResolvedManifestV1;
}

export const workspaceContentDigest = async (bytes: Uint8Array): Promise<string> =>
  await canonicalDomainSeparatedDigest(
    WORKSPACE_CONTENT_DOMAIN,
    bytes,
    WORKSPACE_CONTENT_IDENTITY_PREFIX,
  );

/** Construct a fresh immutable replay envelope and its domain-separated identity. */
export const createAgentReplayEnvelope = async (
  input: AgentReplayEnvelopeInput,
): Promise<AgentReplayEnvelopeV1> => {
  if (
    !plain(input) ||
    !ownDataKeys(input as Record<string, unknown>, [
      'caseId',
      'task',
      'workspace',
      'modelIdentity',
      'budget',
      'initialTranscript',
      'manifest',
    ])
  ) return invalid();
  try {
    return await freezeEnvelope(input as unknown as Record<string, unknown>, true);
  } catch (error) {
    if (error instanceof AgentReplayEnvelopeError) throw error;
    return invalid();
  }
};

/** Validate, rehash, and defensively snapshot an untrusted replay envelope. */
export const validateAgentReplayEnvelope = async (
  value: unknown,
): Promise<AgentReplayEnvelopeV1> => {
  if (
    !plain(value) ||
    !ownDataKeys(value, [
      'schemaVersion',
      'caseId',
      'task',
      'workspace',
      'modelIdentity',
      'budget',
      'initialTranscript',
      'manifest',
      'identity',
    ]) || value.schemaVersion !== 1
  ) return invalid();
  try {
    return await freezeEnvelope(value, false);
  } catch (error) {
    if (error instanceof AgentReplayEnvelopeError) throw error;
    return invalid();
  }
};

export const agentReplayEnvelopePayload = (envelope: AgentReplayEnvelopeV1): Uint8Array => {
  const validated = envelope as unknown as Record<string, unknown>;
  if (
    !plain(validated) ||
    !ownDataKeys(validated, [
      'schemaVersion',
      'caseId',
      'task',
      'workspace',
      'modelIdentity',
      'budget',
      'initialTranscript',
      'manifest',
      'identity',
    ])
  ) return invalid();
  const base = {
    schemaVersion: 1 as const,
    caseId: validated.caseId,
    task: validated.task,
    workspace: validated.workspace,
    modelIdentity: validated.modelIdentity,
    budget: validated.budget,
    initialTranscript: validated.initialTranscript,
    manifest: validated.manifest,
  } as Omit<AgentReplayEnvelopeV1, 'identity'>;
  const bytes = payload(base);
  return bytes.slice();
};

export const replayEnvelopePayload = agentReplayEnvelopePayload;
export const createReplayEnvelope = createAgentReplayEnvelope;
export const validateReplayEnvelope = validateAgentReplayEnvelope;
