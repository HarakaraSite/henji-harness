import type { JsonValue, ModelRequest, ToolDefinition } from '../core/contracts.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import type { DiscoveredSkill } from '../definitions/skills.ts';
import type { InstructionComponent } from '../instructions/component.ts';
import type { ModelSelection } from '../provider/model_selection.ts';

/** Increment 89's delta protocol. Hydrated read models intentionally remain unversioned. */
const CONTEXT_ATTRIBUTION_SCHEMA_VERSION = 2 as const;
const CONTEXT_DIGEST_PREFIX = 'sha256:';

type ContextBlobMediaType =
  | 'text/plain; charset=utf-8'
  | 'application/json'
  | 'application/vnd.henji.message+json'
  | 'application/vnd.henji.tool+json'
  | 'application/octet-stream';

interface ContextBlobDescriptor {
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: ContextBlobMediaType;
}

interface ContextBlobInput extends ContextBlobDescriptor {
  readonly bytes: Uint8Array;
}

type ContextRelationStage =
  | 'discovered'
  | 'resolved'
  | 'loaded'
  | 'observed'
  | 'projected';

type ContextResourceKind =
  | 'workspace_instruction'
  | 'skill'
  | 'skill_catalog'
  | 'instruction_component'
  | 'definition_output'
  | 'tool_contract'
  | 'runtime_fact'
  | 'message'
  | 'tool_result'
  | 'model_request'
  | 'provider_wire_body';

/** One occurrence, never deduplicated merely because its content digest matches another row. */
export interface ExecutionContextRelation {
  readonly ordinal: number;
  readonly stage: ContextRelationStage;
  readonly resourceKind: ContextResourceKind;
  readonly logicalIdentity?: string;
  readonly sourceLocator?: string;
  readonly contentDigest?: string;
  readonly lane?: 'parent' | 'planner';
  readonly modelStep?: number;
  readonly callId?: string;
  readonly requestOrdinal?: number;
  readonly sourceEventOrdinal?: number;
}

/** Provenance sidecar carried with one request occurrence; identity is never inferred from bytes. */
export interface ContextSourceRelation {
  readonly stage: ContextRelationStage;
  readonly resourceKind: ContextResourceKind;
  readonly logicalIdentity?: string;
  readonly sourceLocator?: string;
  /** Digest of the exact source occurrence, when it is not the enclosing item bytes. */
  readonly contentDigest?: string;
  readonly lane?: 'parent' | 'planner';
  readonly modelStep?: number;
  readonly callId?: string;
  readonly requestOrdinal?: number;
  readonly sourceEventOrdinal?: number;
}

/** Worker-side causal reference. Host resolves this to a journal ordinal by indexed lookup. */
export interface ContextOccurrenceSource
  extends Omit<ContextSourceRelation, 'requestOrdinal' | 'sourceEventOrdinal'> {
  readonly sourceWorkerSequence?: number;
}

type ContextRequestPurpose = 'user_turn' | 'web_search';

type ContextModelRequestItemKind =
  | 'system'
  | 'message'
  | 'tool_contract'
  | 'provider_wire_body';

interface ContextModelRequestItem {
  readonly ordinal: number;
  readonly kind: ContextModelRequestItemKind;
  readonly content: ContextBlobDescriptor;
  readonly relationOrdinals: readonly number[];
  /** Explicit per-occurrence provenance, kept alongside the message/tool descriptor. */
  readonly sourceRelations?: readonly ContextSourceRelation[];
  /** Transport copy used by Host to materialize the immutable blob. */
  readonly bytesBase64?: string;
}

export interface ContextModelRequestRecord {
  readonly requestOrdinal: number;
  readonly lane: 'parent' | 'planner';
  readonly purpose: ContextRequestPurpose;
  readonly modelStep: number;
  readonly modelSelection?: ModelSelection;
  /** Short estimated admission facts; full request remains semantic evidence. */
  readonly budget?: Readonly<Record<string, JsonValue>>;
  readonly request?: ModelRequest;
  readonly providerBody?: string;
  readonly sourceCallId?: string;
  readonly items: readonly ContextModelRequestItem[];
}

export interface ContextOccurrenceInput {
  readonly occurrenceId: string;
  readonly kind: ContextModelRequestItemKind;
  readonly content: ContextBlobDescriptor;
  readonly sourceRelations: readonly ContextOccurrenceSource[];
  readonly occurrenceDigest: string;
  /** Present only the first time these content bytes appear in one execution. */
  readonly bytesBase64?: string;
}

interface ContextSequenceSplice {
  readonly start: number;
  readonly deleteCount: number;
  readonly insertions: readonly {
    readonly occurrenceId: string;
    readonly occurrenceDigest: string;
  }[];
}

/** The only live Worker-to-Host request history transport. */
export interface ContextModelRequestDelta {
  readonly schemaVersion: 2;
  readonly requestOrdinal: number;
  readonly lane: 'parent' | 'planner';
  readonly purpose: ContextRequestPurpose;
  readonly modelStep: number;
  readonly modelSelection?: ModelSelection;
  /** Short estimated admission facts; full request remains semantic evidence. */
  readonly budget?: Readonly<Record<string, JsonValue>>;
  readonly sourceCallId?: string;
  readonly baseRevisionDigest?: string;
  readonly revisionDigest: string;
  readonly resultItemCount: number;
  readonly splices: readonly ContextSequenceSplice[];
  readonly occurrences: readonly ContextOccurrenceInput[];
}

/**
 * The final, Worker-owned description of the context operation for one turn.  The digest covers
 * the ordered request/item descriptors and source relation references; Host compares it with the
 * rows materialized from the live journal before accepting a normal settlement.
 */
export interface ExecutionContextManifestV2 {
  readonly schemaVersion: 2;
  readonly requestCount: number;
  readonly requests: readonly {
    readonly requestOrdinal: number;
    readonly revisionDigest: string;
  }[];
  /** Worker-known observations not projected into a request item. */
  readonly externalRelations: readonly ContextSourceRelation[];
  readonly digest: string;
}

interface ContextSkillSnapshot extends DiscoveredSkill {}

export interface WorkerContextSnapshot {
  readonly schemaVersion: 1;
  readonly workspaceRoot: string;
  readonly workspaceInstruction?: {
    readonly source: AgentInstructionSource;
    readonly text: string;
    readonly formatted: string;
  };
  readonly skillCatalog: {
    readonly manifest?: string;
    readonly skills: readonly ContextSkillSnapshot[];
  };
  readonly instructionComponents: readonly InstructionComponent[];
  readonly systemInstruction?: string;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly runtimeFacts: {
    readonly cwd: string;
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const isJson = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && value !== null &&
    Object.values(value).every(isJson);
};

/** Canonical JSON keeps arrays ordered and recursively sorts object keys. */
const canonicalJson = (value: JsonValue): string => {
  if (!isJson(value)) throw new TypeError('context value must be finite JSON');
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, JsonValue>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
      ).join(',')
    }}`;
  }
  return JSON.stringify(value);
};

export const canonicalJsonBytes = (value: JsonValue): Uint8Array =>
  encoder.encode(canonicalJson(value));

const textContentBytes = (value: string): Uint8Array => {
  if (value.includes('\0')) {
    throw new TypeError('context text must not contain NUL');
  }
  const bytes = encoder.encode(value);
  // A fatal decode verifies that the exact string has no unpaired surrogate replacement.
  if (decoder.decode(bytes) !== value) {
    throw new TypeError('context text must be valid UTF-8');
  }
  return bytes;
};

export const contextDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return `${CONTEXT_DIGEST_PREFIX}${
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }`;
};

const contextManifestBody = (
  value: Pick<
    ExecutionContextManifestV2,
    | 'schemaVersion'
    | 'requestCount'
    | 'requests'
    | 'externalRelations'
  >,
): JsonValue => structuredClone(value) as unknown as JsonValue;

const contextManifestDigest = (
  value: Pick<
    ExecutionContextManifestV2,
    | 'schemaVersion'
    | 'requestCount'
    | 'requests'
    | 'externalRelations'
  >,
): Promise<string> => contextDigest(canonicalJsonBytes(contextManifestBody(value)));

export const contextOccurrenceDigest = (
  occurrence: Pick<
    ContextOccurrenceInput,
    'occurrenceId' | 'kind' | 'content' | 'sourceRelations'
  >,
): Promise<string> =>
  contextDigest(canonicalJsonBytes({
    occurrenceId: occurrence.occurrenceId,
    kind: occurrence.kind,
    content: occurrence.content,
    sourceRelations: occurrence.sourceRelations.map((source) => ({
      ...source,
      contentDigest: source.contentDigest ?? occurrence.content.digest,
    })),
  } as unknown as JsonValue));

export const contextRevisionDigest = (
  value: Pick<
    ContextModelRequestDelta,
    | 'lane'
    | 'purpose'
    | 'baseRevisionDigest'
    | 'resultItemCount'
    | 'splices'
  >,
): Promise<string> =>
  contextDigest(canonicalJsonBytes({
    schemaVersion: CONTEXT_ATTRIBUTION_SCHEMA_VERSION,
    lane: value.lane,
    sequenceKind: value.purpose,
    baseRevisionDigest: value.baseRevisionDigest ?? null,
    splices: value.splices,
    resultItemCount: value.resultItemCount,
  } as unknown as JsonValue));

export const createExecutionContextManifest = async (
  records: readonly ContextModelRequestDelta[],
  externalRelations: readonly ContextSourceRelation[] = [],
): Promise<ExecutionContextManifestV2> => {
  const requests = records.slice().sort((left, right) => left.requestOrdinal - right.requestOrdinal)
    .map((record) => ({
      requestOrdinal: record.requestOrdinal,
      revisionDigest: record.revisionDigest,
    }));
  const external: ContextSourceRelation[] = externalRelations.map((relation) =>
    structuredClone(relation)
  );
  const body = {
    schemaVersion: CONTEXT_ATTRIBUTION_SCHEMA_VERSION,
    requestCount: requests.length,
    requests,
    externalRelations: external,
  } as const;
  return { ...body, digest: await contextManifestDigest(body) };
};

const contextBlob = async (
  bytes: Uint8Array,
  mediaType: ContextBlobMediaType,
): Promise<ContextBlobInput> => ({
  digest: await contextDigest(bytes),
  byteLength: bytes.byteLength,
  mediaType,
  bytes: bytes.slice(),
});

export const textBlob = (
  value: string,
  mediaType: ContextBlobMediaType = 'text/plain; charset=utf-8',
): Promise<ContextBlobInput> => contextBlob(textContentBytes(value), mediaType);

export const jsonBlob = (
  value: JsonValue,
  mediaType: ContextBlobMediaType = 'application/json',
): Promise<ContextBlobInput> => contextBlob(canonicalJsonBytes(value), mediaType);
