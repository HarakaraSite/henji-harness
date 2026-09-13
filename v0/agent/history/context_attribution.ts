import type { JsonValue, ModelRequest, ToolDefinition } from '../core/contracts.ts';
import type { AgentInstructionSource } from '../definitions/agent_instructions.ts';
import type { DiscoveredSkill } from '../definitions/skills.ts';
import type { InstructionComponent } from '../instructions/component.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import { isStoredModelSelection } from '../provider/model_selection.ts';

/** Content-addressed data used by Increment 42 context attribution. */
export const CONTEXT_ATTRIBUTION_SCHEMA_VERSION = 1 as const;
export const CONTEXT_DIGEST_PREFIX = 'sha256:';

export type ContextBlobMediaType =
  | 'text/plain; charset=utf-8'
  | 'application/json'
  | 'application/vnd.henji.message+json'
  | 'application/vnd.henji.tool+json'
  | 'application/octet-stream';

export interface ContextBlobDescriptor {
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: ContextBlobMediaType;
}

export interface ContextBlobInput extends ContextBlobDescriptor {
  readonly bytes: Uint8Array;
}

export type ContextRelationStage =
  | 'discovered'
  | 'resolved'
  | 'loaded'
  | 'observed'
  | 'projected';

export type ContextResourceKind =
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

export type ContextRequestPurpose = 'user_turn' | 'web_search';

export type ContextModelRequestItemKind =
  | 'system'
  | 'message'
  | 'tool_contract'
  | 'provider_wire_body';

export interface ContextModelRequestItem {
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
  readonly request?: ModelRequest;
  readonly providerBody?: string;
  readonly sourceCallId?: string;
  readonly items: readonly ContextModelRequestItem[];
}

/**
 * The final, Worker-owned description of the context operation for one turn.  The digest covers
 * the ordered request/item descriptors and source relation references; Host compares it with the
 * rows materialized from the live journal before accepting a normal settlement.
 */
export interface ExecutionContextManifestV1 {
  readonly schemaVersion: 1;
  readonly requestCount: number;
  readonly requests: readonly {
    readonly requestOrdinal: number;
    readonly itemDigests: readonly string[];
    readonly sourceRelations: readonly ContextSourceRelation[];
    /** Exact relation boundary for every ordered request item. */
    readonly items: readonly {
      readonly ordinal: number;
      readonly digest: string;
      readonly relations: readonly ContextSourceRelation[];
    }[];
  }[];
  readonly relations: readonly ContextSourceRelation[];
  /** Worker-known observations not projected into a request item. */
  readonly externalRelations: readonly ContextSourceRelation[];
  readonly digest: string;
}

export interface ContextSkillSnapshot extends DiscoveredSkill {}

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
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

const isJson = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && value !== null &&
    Object.values(value).every(isJson);
};

/** Canonical JSON keeps arrays ordered and recursively sorts object keys. */
export const canonicalJson = (value: JsonValue): string => {
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

export const textContentBytes = (value: string): Uint8Array => {
  if (value.includes('\0')) throw new TypeError('context text must not contain NUL');
  const bytes = encoder.encode(value);
  // A fatal decode verifies that the exact string has no unpaired surrogate replacement.
  if (decoder.decode(bytes) !== value) throw new TypeError('context text must be valid UTF-8');
  return bytes;
};

export const contextDigest = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return `${CONTEXT_DIGEST_PREFIX}${
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }`;
};

const contextManifestBody = (
  value: Pick<
    ExecutionContextManifestV1,
    | 'schemaVersion'
    | 'requestCount'
    | 'requests'
    | 'relations'
    | 'externalRelations'
  >,
): JsonValue => structuredClone(value) as unknown as JsonValue;

export const contextManifestDigest = (
  value: Pick<
    ExecutionContextManifestV1,
    | 'schemaVersion'
    | 'requestCount'
    | 'requests'
    | 'relations'
    | 'externalRelations'
  >,
): Promise<string> => contextDigest(canonicalJsonBytes(contextManifestBody(value)));

export const createExecutionContextManifest = async (
  records: readonly ContextModelRequestRecord[],
  externalRelations: readonly ContextSourceRelation[] = [],
): Promise<ExecutionContextManifestV1> => {
  const requests = records.slice().sort((left, right) => left.requestOrdinal - right.requestOrdinal)
    .map((record) => {
      const items = record.items.map((item) => {
        const relations = (item.sourceRelations ?? []).map((relation) => ({
          ...structuredClone(relation),
          // Projected relations qualify the enclosing item; loaded skill/tool-result relations
          // may carry the digest of the exact returned body instead.
          contentDigest: relation.contentDigest ?? item.content.digest,
        }));
        return { ordinal: item.ordinal, digest: item.content.digest, relations };
      });
      const sourceRelations = items.flatMap((item) => item.relations)
        .map((relation) => structuredClone(relation));
      return {
        requestOrdinal: record.requestOrdinal,
        itemDigests: record.items.map((item) => item.content.digest),
        sourceRelations,
        items,
      };
    });
  const external: ContextSourceRelation[] = externalRelations.map((relation) =>
    structuredClone(relation)
  );
  const relations: ContextSourceRelation[] = [
    ...requests.flatMap((request) => request.sourceRelations),
    ...external,
  ].map((relation) => structuredClone(relation) as ContextSourceRelation);
  const body = {
    schemaVersion: CONTEXT_ATTRIBUTION_SCHEMA_VERSION,
    requestCount: requests.length,
    requests,
    relations,
    externalRelations: external,
  } as const;
  return { ...body, digest: await contextManifestDigest(body) };
};

export const contextBlob = async (
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

export const isContextDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA256.test(value);

export const isContextBlobDescriptor = (value: unknown): value is ContextBlobDescriptor =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 3 && isContextDigest((value as Record<string, unknown>).digest) &&
  Number.isSafeInteger((value as Record<string, unknown>).byteLength) &&
  Number((value as Record<string, unknown>).byteLength) >= 0 &&
  ((value as Record<string, unknown>).mediaType === 'text/plain; charset=utf-8' ||
    (value as Record<string, unknown>).mediaType === 'application/json' ||
    (value as Record<string, unknown>).mediaType === 'application/vnd.henji.message+json' ||
    (value as Record<string, unknown>).mediaType === 'application/vnd.henji.tool+json' ||
    (value as Record<string, unknown>).mediaType === 'application/octet-stream');

const hasSnapshotKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};

export const validateWorkerContextSnapshot = (value: unknown): value is WorkerContextSnapshot => {
  if (
    !hasSnapshotKeys(value, [
      'schemaVersion',
      'workspaceRoot',
      'skillCatalog',
      'instructionComponents',
      'toolDefinitions',
      'runtimeFacts',
    ], ['workspaceInstruction', 'systemInstruction'])
  ) return false;
  const snapshot = value;
  if (
    snapshot.schemaVersion !== 1 || typeof snapshot.workspaceRoot !== 'string' ||
    snapshot.workspaceRoot.length === 0 || snapshot.workspaceRoot.includes('\0') ||
    !hasSnapshotKeys(snapshot.skillCatalog, ['skills'], ['manifest']) ||
    !Array.isArray(snapshot.instructionComponents) || !Array.isArray(snapshot.toolDefinitions) ||
    !hasSnapshotKeys(snapshot.runtimeFacts, ['cwd'])
  ) return false;
  const workspace = snapshot.workspaceInstruction;
  if (
    workspace !== undefined && (!hasSnapshotKeys(workspace, ['source', 'text', 'formatted']) ||
      (workspace.source !== 'AGENTS.md' && workspace.source !== 'AGENTS.MD') ||
      !validText(workspace.text) || !validText(workspace.formatted))
  ) return false;
  const catalog = snapshot.skillCatalog;
  if (catalog.manifest !== undefined && !validText(catalog.manifest)) return false;
  if (
    !Array.isArray(catalog.skills) || catalog.skills.some((skill) => {
      if (
        !hasSnapshotKeys(skill, ['name', 'description', 'sourceDirectory', 'body', 'toolResult'])
      ) return true;
      return !validText(skill.name, false) || !validText(skill.description) ||
        !validText(skill.sourceDirectory, false) || !validText(skill.body) ||
        !validText(skill.toolResult);
    })
  ) return false;
  const facts = snapshot.runtimeFacts;
  return hasSnapshotKeys(facts, ['cwd']) && validText(facts.cwd, false) &&
    (snapshot.systemInstruction === undefined || validText(snapshot.systemInstruction)) &&
    snapshot.instructionComponents.every((component) =>
      hasSnapshotKeys(component, ['identity', 'text']) &&
      validText(component.identity, false) && validText(component.text, false)
    ) &&
    snapshot.toolDefinitions.every((tool) =>
      hasSnapshotKeys(tool, ['name', 'description', 'inputSchema']) &&
      validText(tool.name, false) && validText(tool.description) && isJson(tool.inputSchema)
    );
};

const exactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};

const validText = (value: unknown, allowEmpty = true): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && !value.includes('\0');

const validToolCall = (value: unknown): boolean =>
  exactKeys(value, ['kind', 'callId', 'name', 'arguments']) && value.kind === 'tool_call' &&
  validText(value.callId, false) && validText(value.name, false) && isJson(value.arguments);

const validToolResult = (value: unknown): boolean =>
  exactKeys(value, ['kind', 'callId', 'name', 'text', 'outcome'], ['terminal']) &&
  value.kind === 'tool_result' && validText(value.callId, false) &&
  validText(value.name, false) && validText(value.text) &&
  (value.outcome === 'success' || value.outcome === 'error') &&
  (value.terminal === undefined || value.terminal === 'json_result') &&
  (value.terminal === undefined || value.outcome === 'success');

const validMessage = (value: unknown): boolean => {
  if (exactKeys(value, ['role', 'content']) && value.role === 'user') {
    return exactKeys(value.content, ['kind', 'text']) && value.content.kind === 'text' &&
      validText(value.content.text);
  }
  if (
    !exactKeys(value, ['role', 'content'], ['text', 'providerState']) || value.role !== 'assistant'
  ) {
    if (exactKeys(value, ['role', 'content']) && value.role === 'tool') {
      return Array.isArray(value.content) && value.content.length > 0 &&
        value.content.every(validToolResult);
    }
    return false;
  }
  const content = value.content;
  const contentValid = exactKeys(content, ['kind', 'text']) && content.kind === 'text' &&
      validText(content.text) ||
    Array.isArray(content) && content.every(validToolCall);
  const providerState = value.providerState;
  const stateValid = providerState === undefined ||
    exactKeys(providerState, ['provider', 'reasoningDetails']) &&
      providerState.provider === 'openrouter' &&
      Array.isArray(providerState.reasoningDetails) &&
      providerState.reasoningDetails.every(isJson) ||
    exactKeys(providerState, ['provider', 'replayItems']) && providerState.provider === 'openai' &&
      Array.isArray(providerState.replayItems) && providerState.replayItems.every(isJson);
  return contentValid && (value.text === undefined || validText(value.text)) && stateValid;
};

const validModelRequest = (value: unknown): value is ModelRequest =>
  exactKeys(value, ['transcript', 'tools'], ['systemInstruction']) &&
  (value.systemInstruction === undefined || validText(value.systemInstruction)) &&
  Array.isArray(value.transcript) && Array.isArray(value.tools) &&
  value.transcript.every(validMessage) && value.tools.every((tool) =>
    exactKeys(tool, ['name', 'description', 'inputSchema']) &&
    validText(tool.name, false) && validText(tool.description) && isJson(tool.inputSchema)
  );

const validSourceRelation = (value: unknown): value is ContextSourceRelation => {
  if (
    !exactKeys(value, ['stage', 'resourceKind'], [
      'logicalIdentity',
      'sourceLocator',
      'contentDigest',
      'lane',
      'modelStep',
      'callId',
      'requestOrdinal',
      'sourceEventOrdinal',
    ])
  ) return false;
  const relation = value as Record<string, unknown>;
  return ['discovered', 'resolved', 'loaded', 'observed', 'projected'].includes(
    relation.stage as string,
  ) && [
    'workspace_instruction',
    'skill',
    'skill_catalog',
    'instruction_component',
    'definition_output',
    'tool_contract',
    'runtime_fact',
    'message',
    'tool_result',
    'model_request',
    'provider_wire_body',
  ].includes(relation.resourceKind as string) &&
    (relation.logicalIdentity === undefined || validText(relation.logicalIdentity, false)) &&
    (relation.sourceLocator === undefined || validText(relation.sourceLocator, false)) &&
    (relation.contentDigest === undefined || isContextDigest(relation.contentDigest)) &&
    (relation.lane === undefined || relation.lane === 'parent' || relation.lane === 'planner') &&
    (relation.modelStep === undefined ||
      (Number.isSafeInteger(relation.modelStep) && Number(relation.modelStep) >= 1)) &&
    (relation.callId === undefined || validText(relation.callId, false)) &&
    (relation.requestOrdinal === undefined ||
      (Number.isSafeInteger(relation.requestOrdinal) && Number(relation.requestOrdinal) >= 1)) &&
    (relation.sourceEventOrdinal === undefined ||
      (Number.isSafeInteger(relation.sourceEventOrdinal) &&
        Number(relation.sourceEventOrdinal) >= 1));
};

const validManifestRelation = (value: unknown): value is ContextSourceRelation =>
  validSourceRelation(value) &&
  isContextDigest((value as unknown as Record<string, unknown>).contentDigest);

/** Strict protocol/storage validation for one logical model request observation. */
export const validateContextModelRequestRecord = (
  value: unknown,
): value is ContextModelRequestRecord => {
  if (
    !exactKeys(value, ['requestOrdinal', 'lane', 'purpose', 'modelStep', 'items'], [
      'modelSelection',
      'request',
      'providerBody',
      'sourceCallId',
    ])
  ) return false;
  if (
    !Number.isSafeInteger(value.requestOrdinal) || (value.requestOrdinal as number) < 1 ||
    (value.lane !== 'parent' && value.lane !== 'planner') ||
    (value.purpose !== 'user_turn' && value.purpose !== 'web_search') ||
    !Number.isSafeInteger(value.modelStep) || (value.modelStep as number) < 1 ||
    (value.modelSelection !== undefined && !isStoredModelSelection(value.modelSelection)) ||
    !Array.isArray(value.items)
  ) return false;
  if (value.purpose === 'user_turn') {
    if (
      value.request === undefined || !validModelRequest(value.request) ||
      value.providerBody !== undefined || value.sourceCallId !== undefined
    ) return false;
  } else if (
    value.request !== undefined || !validText(value.providerBody, false) ||
    value.sourceCallId === undefined || !validText(value.sourceCallId, false)
  ) return false;
  return value.items.every((item, index) => {
    if (
      !exactKeys(item, ['ordinal', 'kind', 'content', 'relationOrdinals', 'bytesBase64'], [
        'sourceRelations',
      ])
    ) {
      return false;
    }
    if (
      item.ordinal !== index + 1 ||
      !['system', 'message', 'tool_contract', 'provider_wire_body'].includes(item.kind as string) ||
      !isContextBlobDescriptor(item.content) || typeof item.bytesBase64 !== 'string' ||
      !Array.isArray(item.relationOrdinals) ||
      new Set(item.relationOrdinals).size !== item.relationOrdinals.length ||
      item.relationOrdinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 1)
    ) return false;
    if (
      item.sourceRelations !== undefined &&
      (!Array.isArray(item.sourceRelations) ||
        item.sourceRelations.some((relation) => !validSourceRelation(relation)))
    ) return false;
    try {
      const bytes = Uint8Array.fromBase64(item.bytesBase64);
      return bytes.byteLength === item.content.byteLength;
    } catch {
      return false;
    }
  }) && (value.purpose === 'web_search'
    ? value.items.length === 1 && value.items[0].kind === 'provider_wire_body'
    : value.items.every((item) =>
      item.kind !== 'provider_wire_body'
    ));
};

/** Strict wire/storage shape validation for the final context manifest. */
export const validateExecutionContextManifest = (
  value: unknown,
): value is ExecutionContextManifestV1 => {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'requestCount',
      'requests',
      'relations',
      'externalRelations',
      'digest',
    ])
  ) return false;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== CONTEXT_ATTRIBUTION_SCHEMA_VERSION ||
    !Number.isSafeInteger(manifest.requestCount) || Number(manifest.requestCount) < 0 ||
    !Array.isArray(manifest.requests) ||
    manifest.requests.length !== Number(manifest.requestCount) ||
    !Array.isArray(manifest.relations) || !Array.isArray(manifest.externalRelations) ||
    !isContextDigest(manifest.digest)
  ) return false;
  let previousRequest = 0;
  for (const request of manifest.requests) {
    if (
      !exactKeys(request, [
        'requestOrdinal',
        'itemDigests',
        'sourceRelations',
        'items',
      ])
    ) return false;
    const requestRecord = request as Record<string, unknown>;
    const sourceRelations = requestRecord.sourceRelations as unknown[] | undefined;
    const items = requestRecord.items as unknown[] | undefined;
    if (
      !Number.isSafeInteger(requestRecord.requestOrdinal) ||
      requestRecord.requestOrdinal !== previousRequest + 1 ||
      !Array.isArray(requestRecord.itemDigests) || requestRecord.itemDigests.length === 0 ||
      !Array.isArray(items) || items.length !== requestRecord.itemDigests.length ||
      !Array.isArray(sourceRelations) || sourceRelations.some((relation) =>
        !validSourceRelation(relation)
      ) ||
      requestRecord.itemDigests.some((digest) => !isContextDigest(digest))
    ) return false;
    previousRequest = requestRecord.requestOrdinal as number;
  }
  const externalRelations = manifest.externalRelations as unknown[];
  if (
    !externalRelations.every((relation) => validManifestRelation(relation))
  ) return false;
  const expectedSourceRelations: ContextSourceRelation[] = [];
  for (const request of manifest.requests) {
    const requestRecord = request as Record<string, unknown>;
    const itemDigests = requestRecord.itemDigests as string[];
    const items = requestRecord.items as Record<string, unknown>[];
    const itemRelations: ContextSourceRelation[] = [];
    let previousItem = 0;
    for (const [index, item] of items.entries()) {
      if (
        !exactKeys(item, ['ordinal', 'digest', 'relations']) ||
        item.ordinal !== index + 1 || item.ordinal <= previousItem ||
        item.digest !== itemDigests[index] || !isContextDigest(item.digest) ||
        !Array.isArray(item.relations) ||
        item.relations.some((relation) =>
          !validManifestRelation(relation) ||
          (relation as unknown as Record<string, unknown>).contentDigest === undefined
        )
      ) return false;
      previousItem = item.ordinal as number;
      itemRelations.push(...item.relations as ContextSourceRelation[]);
    }
    if (JSON.stringify(itemRelations) !== JSON.stringify(requestRecord.sourceRelations)) {
      return false;
    }
    expectedSourceRelations.push(...itemRelations);
  }
  const allRelations = expectedSourceRelations.concat(externalRelations as ContextSourceRelation[]);
  return manifest.relations.every((relation) => validManifestRelation(relation)) &&
    JSON.stringify(manifest.relations) === JSON.stringify(allRelations);
};
