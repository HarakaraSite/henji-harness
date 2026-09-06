import { type AgentDefinitionInput, type ResolvedAgentDefinition } from './agent_definition.ts';
import {
  type AgentComparisonExecutionObserver,
  runAgentTurnObservedForComparison,
} from './loop.ts';
import { Registry, type Tool } from './tools.ts';
import {
  type AgentResourceIdentity,
  createAgentResourceIdentity,
  validateResolvedAgentResources,
} from './resource_identity.ts';
import {
  type AgentResolvedManifestIdentity,
  type AgentResolvedManifestV1,
  validateAgentResolvedManifest,
} from './resolved_manifest.ts';
import {
  type AgentReplayEnvelopeIdentity,
  type AgentReplayEnvelopeV1,
  createAgentReplayEnvelope,
  validateAgentReplayEnvelope,
} from './replay_envelope.ts';
import {
  type AgentExecutionRecordV1,
  createAgentExecutionRecorder,
  validateAgentExecutionRecord,
} from './execution_record.ts';
import {
  type ComparisonVariantEvaluation,
  evaluateComparisonVariant,
  validateComparisonVariantRelationship,
} from './comparison_variant.ts';
import type {
  Message,
  Model,
  ModelRequest,
  ModelResult,
  ToolCall,
  ToolResultContent,
} from './contracts.ts';
import type { Workspace } from './work_tools.ts';

export const FRESH_RUNTIME_COMPARISON_SCHEMA_VERSION = 1 as const;
export const FRESH_RUNTIME_COMPARISON_CASE_ID = 'v1.default-max-steps-comparison' as const;
export const FRESH_RUNTIME_SCRIPT_ID = 'five-step-uppercase-v1' as const;
export const FRESH_RUNTIME_TOOL_FIXTURE_ID = 'uppercase-text-v1' as const;
export const FRESH_RUNTIME_TASK = 'Complete four uppercase checks, then finish.' as const;
export const FRESH_RUNTIME_MODEL_IDENTITY =
  'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0' as const;
export const FRESH_RUNTIME_MAX_WALL_TIME_MICROS = 1_000_000 as const;

const AGENTS_DIGEST =
  'henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf';
const DENO_DIGEST =
  'henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4';
const CURRENT_MANIFEST_ID =
  'henji-agent-resolved-manifest:v1:sha256:12c53d857e34bb44046d701e0c4144c228138111970f91bde0e3a0854f8a7b3c' as AgentResolvedManifestIdentity;
const VARIANT_MANIFEST_ID =
  'henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389' as AgentResolvedManifestIdentity;
const CURRENT_ENVELOPE_ID =
  'henji-agent-replay-envelope:v1:sha256:e780cb275901d7d479b646f79b767f08a8094a99d6046fe490ef1635f2dbefc1' as AgentReplayEnvelopeIdentity;
const VARIANT_ENVELOPE_ID =
  'henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633' as AgentReplayEnvelopeIdentity;

const MODEL_ID = createAgentResourceIdentity(FRESH_RUNTIME_MODEL_IDENTITY);

export interface FreshRuntimeComparisonCaseV1 {
  readonly schemaVersion: 1;
  readonly caseId: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly task: typeof FRESH_RUNTIME_TASK;
  readonly workspace: AgentReplayEnvelopeV1['workspace'];
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscript: readonly Message[];
  readonly ceilings: {
    readonly plannerModelRequests: 0;
    readonly maxExternalRequests: 0;
    readonly maxWallTimeMicros: 1_000_000;
  };
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface FreshRuntimeRunSpec {
  readonly side: 'current' | 'variant';
  readonly runOrdinal: 1 | 2;
  readonly definitionId: 'default' | 'default-max-steps-4';
  readonly definition: ResolvedAgentDefinition;
  readonly manifest: AgentResolvedManifestV1;
  readonly envelope: AgentReplayEnvelopeV1;
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface AgentFreshRuntimeComparisonPair {
  readonly current: FreshRuntimeRunSpec;
  readonly variant: FreshRuntimeRunSpec;
}

export class AgentFreshRuntimeComparisonError extends Error {
  constructor() {
    super('agent fresh-runtime comparison failed');
    this.name = 'AgentFreshRuntimeComparisonError';
  }
}

export type FreshRuntimeComparisonFailurePhase =
  | 'setup'
  | 'model'
  | 'tool'
  | 'observer'
  | 'recorder'
  | 'clock'
  | 'correlation'
  | 'partial-second-run';
export type FreshRuntimeComparisonExecutionPosition = 'first' | 'second';
export type FreshRuntimeComparisonConstructionKind =
  | 'evaluator'
  | 'model'
  | 'tool'
  | 'registry'
  | 'clock'
  | 'abort'
  | 'recorder'
  | 'commit'
  | 'counters'
  | 'transcript';
export interface FreshRuntimeComparisonTestHooks {
  readonly failure?: {
    readonly phase: FreshRuntimeComparisonFailurePhase;
    readonly position: FreshRuntimeComparisonExecutionPosition | 'any';
  };
  readonly onConstruct?: (
    kind: FreshRuntimeComparisonConstructionKind,
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
  ) => void;
  readonly onRunComplete?: (
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
  ) => void;
  /** Test-only marker emitted after each model settlement has entered the recorder. */
  readonly onProgress?: (
    marker: 'model-settled-recorded',
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
    ordinal: number,
  ) => void;
}

const invalid = (): never => {
  throw new AgentFreshRuntimeComparisonError();
};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const exactDataProperties = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean => {
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 || ownNames.length !== names.length ||
    ownNames.some((name, index) => name !== names[index])
  ) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

const exactArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  return length !== undefined && 'value' in length && !length.enumerable &&
    length.value === value.length &&
    names.length === value.length + 1 &&
    names.slice(0, -1).every((name, index) => name === String(index)) &&
    names.at(-1) === 'length' && Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
    }).every(Boolean);
};

const normalizeTestHooks = (value: unknown): FreshRuntimeComparisonTestHooks => {
  if (value === undefined) return Object.freeze({});
  if (!plain(value)) return invalid();
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length > 4) return invalid();
  if (
    names.some((name) =>
      name !== 'failure' && name !== 'onConstruct' && name !== 'onRunComplete' &&
      name !== 'onProgress'
    )
  ) return invalid();
  const failure = value.failure;
  if (failure !== undefined) {
    if (
      !plain(failure) || !exactDataProperties(failure, ['phase', 'position']) ||
      ![
        'setup',
        'model',
        'tool',
        'observer',
        'recorder',
        'clock',
        'correlation',
        'partial-second-run',
      ].includes(failure.phase as string) ||
      (failure.position !== 'first' && failure.position !== 'second' && failure.position !== 'any')
    ) return invalid();
  }
  if (value.onConstruct !== undefined && typeof value.onConstruct !== 'function') return invalid();
  if (value.onRunComplete !== undefined && typeof value.onRunComplete !== 'function') {
    return invalid();
  }
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') return invalid();
  const normalizedFailure = failure === undefined ? undefined : {
    phase: failure.phase as FreshRuntimeComparisonFailurePhase,
    position: failure.position as FreshRuntimeComparisonExecutionPosition | 'any',
  };
  const normalizedOnConstruct = value.onConstruct === undefined
    ? undefined
    : value.onConstruct as FreshRuntimeComparisonTestHooks['onConstruct'];
  const normalizedOnRunComplete = value.onRunComplete === undefined
    ? undefined
    : value.onRunComplete as FreshRuntimeComparisonTestHooks['onRunComplete'];
  const normalizedOnProgress = value.onProgress === undefined
    ? undefined
    : value.onProgress as FreshRuntimeComparisonTestHooks['onProgress'];
  return Object.freeze({
    ...(normalizedFailure === undefined ? {} : { failure: normalizedFailure }),
    ...(normalizedOnConstruct === undefined ? {} : { onConstruct: normalizedOnConstruct }),
    ...(normalizedOnRunComplete === undefined ? {} : { onRunComplete: normalizedOnRunComplete }),
    ...(normalizedOnProgress === undefined ? {} : { onProgress: normalizedOnProgress }),
  });
};

const failureFor = (
  hooks: FreshRuntimeComparisonTestHooks | undefined,
  phase: FreshRuntimeComparisonFailurePhase,
  position: FreshRuntimeComparisonExecutionPosition | undefined,
): void => {
  const failure = hooks?.failure;
  if (
    failure !== undefined && failure.phase === phase &&
    (failure.position === 'any' || failure.position === position)
  ) throw new AgentFreshRuntimeComparisonError();
};

const clonePlain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const frozenCase = (): FreshRuntimeComparisonCaseV1 =>
  Object.freeze({
    schemaVersion: 1 as const,
    caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
    task: FRESH_RUNTIME_TASK,
    workspace: Object.freeze({
      entries: Object.freeze([
        Object.freeze({ path: 'AGENTS.md', digest: AGENTS_DIGEST }),
        Object.freeze({ path: 'deno.v0.json', digest: DENO_DIGEST }),
      ]),
    }),
    modelIdentity: MODEL_ID,
    initialTranscript: Object.freeze([]),
    ceilings: Object.freeze({
      plannerModelRequests: 0 as const,
      maxExternalRequests: 0 as const,
      maxWallTimeMicros: FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
    }),
    scriptId: FRESH_RUNTIME_SCRIPT_ID,
    toolFixtureId: FRESH_RUNTIME_TOOL_FIXTURE_ID,
  });

export const FRESH_RUNTIME_COMPARISON_CASE = frozenCase();
export const freshRuntimeComparisonCase = FRESH_RUNTIME_COMPARISON_CASE;

const snapshotCase = (value: unknown): FreshRuntimeComparisonCaseV1 => {
  if (
    !plain(value) || !exactDataProperties(value, [
      'schemaVersion',
      'caseId',
      'task',
      'workspace',
      'modelIdentity',
      'initialTranscript',
      'ceilings',
      'scriptId',
      'toolFixtureId',
    ]) || value.schemaVersion !== 1 || value.caseId !== FRESH_RUNTIME_COMPARISON_CASE_ID ||
    value.task !== FRESH_RUNTIME_TASK || value.modelIdentity !== FRESH_RUNTIME_MODEL_IDENTITY ||
    value.scriptId !== FRESH_RUNTIME_SCRIPT_ID ||
    value.toolFixtureId !== FRESH_RUNTIME_TOOL_FIXTURE_ID
  ) return invalid();
  const workspace = value.workspace;
  if (
    !plain(workspace) || !exactDataProperties(workspace, ['entries']) ||
    !exactArray(workspace.entries) || workspace.entries.length !== 2
  ) {
    return invalid();
  }
  const entries = workspace.entries.map((entry, index) => {
    if (
      !plain(entry) || !exactDataProperties(entry, ['path', 'digest']) ||
      typeof entry.path !== 'string' || typeof entry.digest !== 'string'
    ) return invalid();
    const expected = index === 0
      ? { path: 'AGENTS.md', digest: AGENTS_DIGEST }
      : { path: 'deno.v0.json', digest: DENO_DIGEST };
    if (entry.path !== expected.path || entry.digest !== expected.digest) return invalid();
    return Object.freeze({ path: entry.path, digest: entry.digest });
  });
  if (!exactArray(value.initialTranscript) || value.initialTranscript.length !== 0) {
    return invalid();
  }
  const ceilings = value.ceilings;
  if (
    !plain(ceilings) || !exactDataProperties(ceilings, [
      'plannerModelRequests',
      'maxExternalRequests',
      'maxWallTimeMicros',
    ]) || ceilings.plannerModelRequests !== 0 || ceilings.maxExternalRequests !== 0 ||
    ceilings.maxWallTimeMicros !== FRESH_RUNTIME_MAX_WALL_TIME_MICROS
  ) return invalid();
  return Object.freeze({
    schemaVersion: 1 as const,
    caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
    task: FRESH_RUNTIME_TASK,
    workspace: Object.freeze({ entries: Object.freeze(entries) }),
    modelIdentity: MODEL_ID,
    initialTranscript: Object.freeze([]),
    ceilings: Object.freeze({
      plannerModelRequests: 0 as const,
      maxExternalRequests: 0 as const,
      maxWallTimeMicros: FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
    }),
    scriptId: FRESH_RUNTIME_SCRIPT_ID,
    toolFixtureId: FRESH_RUNTIME_TOOL_FIXTURE_ID,
  });
};

export const validateFreshRuntimeComparisonCase = (
  value: unknown,
): FreshRuntimeComparisonCaseV1 => {
  try {
    return snapshotCase(value);
  } catch {
    return invalid();
  }
};

interface DefinitionProjection {
  readonly provider: string;
  readonly profileId: string;
  readonly profileModel: string;
  readonly profileOrigin: string;
  readonly profilePath: string;
  readonly profileMethod: string;
  readonly profileSecretEnv: string;
  readonly profileMaxCompletionTokens: number;
  readonly profileStream: boolean;
  readonly agentInstructions: string | undefined;
  readonly systemInstruction: string | undefined;
  readonly instructions: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly subagents: readonly string[];
  readonly resources: readonly string[];
}

const definitionProjection = (definition: ResolvedAgentDefinition): DefinitionProjection => {
  const profile = definition.model.profile;
  return {
    provider: definition.model.provider,
    profileId: profile.id,
    profileModel: profile.model,
    profileOrigin: profile.origin,
    profilePath: profile.path,
    profileMethod: profile.method,
    profileSecretEnv: profile.secretEnv,
    profileMaxCompletionTokens: profile.maxCompletionTokens,
    profileStream: profile.stream,
    agentInstructions: definition.agentInstructions,
    systemInstruction: definition.systemInstruction,
    instructions: definition.capabilities.instructions.map((resource) => `${resource}`),
    skills: definition.capabilities.skills.map((resource) => `${resource}`),
    tools: definition.capabilities.tools.map((resource) => `${resource}`),
    subagents: definition.capabilities.subagents.map((resource) => `${resource}`),
    resources: definition.resourceSelection.resources.map((resource) => `${resource}`),
  };
};

const equalStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

const equalDefinitionProjection = (
  left: DefinitionProjection,
  right: DefinitionProjection,
): boolean =>
  Object.is(left.provider, right.provider) &&
  Object.is(left.profileId, right.profileId) &&
  Object.is(left.profileModel, right.profileModel) &&
  Object.is(left.profileOrigin, right.profileOrigin) &&
  Object.is(left.profilePath, right.profilePath) &&
  Object.is(left.profileMethod, right.profileMethod) &&
  Object.is(left.profileSecretEnv, right.profileSecretEnv) &&
  Object.is(left.profileMaxCompletionTokens, right.profileMaxCompletionTokens) &&
  Object.is(left.profileStream, right.profileStream) &&
  Object.is(left.agentInstructions, right.agentInstructions) &&
  Object.is(left.systemInstruction, right.systemInstruction) &&
  equalStringArray(left.instructions, right.instructions) &&
  equalStringArray(left.skills, right.skills) &&
  equalStringArray(left.tools, right.tools) &&
  equalStringArray(left.subagents, right.subagents) &&
  equalStringArray(left.resources, right.resources);

const equalJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && equalJson(leftObject[key], rightObject[key])
    );
};

const expectedManifestIdentity = (side: 'current' | 'variant'): AgentResolvedManifestIdentity =>
  side === 'current' ? CURRENT_MANIFEST_ID : VARIANT_MANIFEST_ID;
const expectedEnvelopeIdentity = (side: 'current' | 'variant'): AgentReplayEnvelopeIdentity =>
  side === 'current' ? CURRENT_ENVELOPE_ID : VARIANT_ENVELOPE_ID;
const expectedMaxSteps = (side: 'current' | 'variant'): 64 | 4 => side === 'current' ? 64 : 4;

const validateRunSpec = async (
  value: unknown,
  comparisonCase: FreshRuntimeComparisonCaseV1,
  side: 'current' | 'variant',
): Promise<FreshRuntimeRunSpec> => {
  if (
    !plain(value) || !exactDataProperties(value, [
      'side',
      'runOrdinal',
      'definitionId',
      'definition',
      'manifest',
      'envelope',
      'scriptId',
      'toolFixtureId',
    ]) || value.side !== side || value.runOrdinal !== (side === 'current' ? 1 : 2) ||
    value.definitionId !== (side === 'current' ? 'default' : 'default-max-steps-4') ||
    value.scriptId !== comparisonCase.scriptId ||
    value.toolFixtureId !== comparisonCase.toolFixtureId
  ) return invalid();
  const definition = value.definition as ResolvedAgentDefinition;
  if (
    !Object.isFrozen(definition) || !plain(definition) || !exactDataProperties(definition, [
      'model',
      'agentInstructions',
      'systemInstruction',
      'capabilities',
      'limits',
      'resourceSelection',
    ])
  ) return invalid();
  const manifest = await validateAgentResolvedManifest(value.manifest);
  const envelope = await validateAgentReplayEnvelope(value.envelope);
  const selection = validateResolvedAgentResources(definition, 'default');
  if (
    manifest.resources.length !== selection.resources.length ||
    manifest.resources.some((resource, index) => resource !== selection.resources[index]) ||
    manifest.parameters.maxSteps !== selection.parameters.maxSteps
  ) return invalid();
  if (
    manifest.definitionId !== value.definitionId ||
    manifest.identity !== expectedManifestIdentity(side) ||
    manifest.parameters.maxSteps !== expectedMaxSteps(side) ||
    envelope.identity !== expectedEnvelopeIdentity(side) ||
    envelope.manifest.identity !== manifest.identity ||
    envelope.manifest.definitionId !== manifest.definitionId ||
    envelope.manifest.parameters.maxSteps !== manifest.parameters.maxSteps ||
    envelope.caseId !== comparisonCase.caseId ||
    envelope.task !== comparisonCase.task ||
    envelope.modelIdentity !== comparisonCase.modelIdentity ||
    !equalJson(envelope.workspace, comparisonCase.workspace) ||
    !equalJson(envelope.initialTranscript, comparisonCase.initialTranscript) ||
    envelope.budget.maxSteps !== expectedMaxSteps(side) ||
    envelope.budget.modelRequests.parent !== expectedMaxSteps(side) ||
    envelope.budget.modelRequests.planner !== comparisonCase.ceilings.plannerModelRequests ||
    envelope.budget.modelRequests.aggregate !== expectedMaxSteps(side) ||
    envelope.budget.maxExternalRequests !== comparisonCase.ceilings.maxExternalRequests ||
    envelope.budget.maxWallTimeMicros !== comparisonCase.ceilings.maxWallTimeMicros
  ) return invalid();
  return Object.freeze({
    side,
    runOrdinal: side === 'current' ? 1 as const : 2 as const,
    definitionId: side === 'current' ? 'default' as const : 'default-max-steps-4' as const,
    definition,
    manifest,
    envelope,
    scriptId: comparisonCase.scriptId,
    toolFixtureId: comparisonCase.toolFixtureId,
  });
};

/** Validate the pair before constructing any run-local model, tool, recorder, or registry. */
export const validateFreshRuntimeRunPair = async (
  value: unknown,
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
): Promise<AgentFreshRuntimeComparisonPair> => {
  try {
    const snapshot = validateFreshRuntimeComparisonCase(comparisonCase);
    if (!plain(value) || !exactDataProperties(value, ['current', 'variant'])) return invalid();
    const current = await validateRunSpec(value.current, snapshot, 'current');
    const variant = await validateRunSpec(value.variant, snapshot, 'variant');
    if (
      current.definition === variant.definition || current.manifest === variant.manifest ||
      current.envelope === variant.envelope ||
      current.definition.resourceSelection === variant.definition.resourceSelection ||
      !equalDefinitionProjection(
        definitionProjection(current.definition),
        definitionProjection(variant.definition),
      )
    ) return invalid();
    const currentResources =
      validateResolvedAgentResources(current.definition, 'default').resources;
    const variantResources =
      validateResolvedAgentResources(variant.definition, 'default').resources;
    if (
      currentResources.length !== variantResources.length ||
      currentResources.some((resource, index) => resource !== variantResources[index]) ||
      current.envelope.budget.modelRequests.planner !==
        variant.envelope.budget.modelRequests.planner ||
      current.envelope.budget.maxExternalRequests !== variant.envelope.budget.maxExternalRequests ||
      current.envelope.budget.maxWallTimeMicros !== variant.envelope.budget.maxWallTimeMicros
    ) return invalid();
    return Object.freeze({ current, variant });
  } catch {
    return invalid();
  }
};

const comparisonInput = (): AgentDefinitionInput =>
  Object.freeze({
    workspace: COMPARISON_WORKSPACE,
    skillCatalog: COMPARISON_SKILLS,
  });

const COMPARISON_WORKSPACE: Workspace = Object.freeze({ root: '/step80-fresh-runtime-comparison' });
const COMPARISON_SKILLS = Object.freeze({ skills: Object.freeze([]) });

const derivePair = async (
  comparisonCase: FreshRuntimeComparisonCaseV1,
  hooks?: FreshRuntimeComparisonTestHooks,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
): Promise<AgentFreshRuntimeComparisonPair> => {
  const firstInput = comparisonInput();
  const secondInput = comparisonInput();
  hooks?.onConstruct?.(
    'evaluator',
    'current',
    executionOrder === 'current-first' ? 'first' : 'second',
  );
  const first: ComparisonVariantEvaluation = await evaluateComparisonVariant(firstInput);
  hooks?.onConstruct?.(
    'evaluator',
    'variant',
    executionOrder === 'current-first' ? 'second' : 'first',
  );
  const second: ComparisonVariantEvaluation = await evaluateComparisonVariant(secondInput);
  validateComparisonVariantRelationship(first.entry, first.parent, first.variant);
  validateComparisonVariantRelationship(second.entry, second.parent, second.variant);
  const currentManifest = first.parentManifest;
  const variantManifest = second.variantManifest;
  const makeEnvelope = async (
    manifest: AgentResolvedManifestV1,
    maxSteps: 64 | 4,
  ): Promise<AgentReplayEnvelopeV1> =>
    await createAgentReplayEnvelope({
      caseId: comparisonCase.caseId,
      task: comparisonCase.task,
      workspace: comparisonCase.workspace,
      modelIdentity: comparisonCase.modelIdentity,
      budget: {
        maxSteps,
        modelRequests: {
          parent: maxSteps,
          planner: comparisonCase.ceilings.plannerModelRequests,
          aggregate: maxSteps,
        },
        maxExternalRequests: comparisonCase.ceilings.maxExternalRequests,
        maxWallTimeMicros: comparisonCase.ceilings.maxWallTimeMicros,
      },
      initialTranscript: comparisonCase.initialTranscript,
      manifest,
    });
  const current: FreshRuntimeRunSpec = Object.freeze({
    side: 'current',
    runOrdinal: 1,
    definitionId: 'default',
    definition: first.parent,
    manifest: currentManifest,
    envelope: await makeEnvelope(currentManifest, 64),
    scriptId: comparisonCase.scriptId,
    toolFixtureId: comparisonCase.toolFixtureId,
  });
  const variant: FreshRuntimeRunSpec = Object.freeze({
    side: 'variant',
    runOrdinal: 2,
    definitionId: 'default-max-steps-4',
    definition: second.variant,
    manifest: variantManifest,
    envelope: await makeEnvelope(variantManifest, 4),
    scriptId: comparisonCase.scriptId,
    toolFixtureId: comparisonCase.toolFixtureId,
  });
  return await validateFreshRuntimeRunPair(Object.freeze({ current, variant }), comparisonCase);
};

export const createFreshRuntimeRunSpecs = async (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
): Promise<AgentFreshRuntimeComparisonPair> => {
  try {
    return await derivePair(validateFreshRuntimeComparisonCase(comparisonCase));
  } catch {
    return invalid();
  }
};

const createFreshRuntimeRunSpecsForTest = async (
  comparisonCase: unknown,
  hooks: FreshRuntimeComparisonTestHooks,
  executionOrder: 'current-first' | 'variant-first',
): Promise<AgentFreshRuntimeComparisonPair> => {
  try {
    return await derivePair(
      validateFreshRuntimeComparisonCase(comparisonCase),
      hooks,
      executionOrder,
    );
  } catch {
    return invalid();
  }
};

const SCRIPT_CALLS: readonly ToolCall[] = Object.freeze([
  Object.freeze({ callId: 'call-1', name: 'uppercase_text', arguments: { text: 'one' } }),
  Object.freeze({ callId: 'call-2', name: 'uppercase_text', arguments: { text: 'two' } }),
  Object.freeze({ callId: 'call-3', name: 'uppercase_text', arguments: { text: 'three' } }),
  Object.freeze({ callId: 'call-4', name: 'uppercase_text', arguments: { text: 'four' } }),
]);

class FreshRuntimeScriptError extends Error {}

class FreshRuntimeScriptedModel implements Model {
  private next = 0;
  constructor(
    private readonly expected: readonly ToolCall[] = SCRIPT_CALLS,
    private readonly beforeGenerate?: () => void,
  ) {}
  generate(request: ModelRequest): Promise<ModelResult> {
    this.beforeGenerate?.();
    const ordinal = this.next++;
    if (
      !Array.isArray(request.transcript) || request.tools.length !== 1 ||
      request.tools[0]?.name !== 'uppercase_text'
    ) {
      throw new FreshRuntimeScriptError();
    }
    const expectedTranscriptLength = ordinal * 2 + 1;
    if (request.transcript.length !== expectedTranscriptLength) throw new FreshRuntimeScriptError();
    const task = request.transcript[0];
    if (
      task?.role !== 'user' || task.content.kind !== 'text' ||
      task.content.text !== FRESH_RUNTIME_TASK
    ) throw new FreshRuntimeScriptError();
    for (let index = 0; index < ordinal; index += 1) {
      const expectedCall = this.expected[index];
      const assistant = request.transcript[index * 2 + 1];
      const tool = request.transcript[index * 2 + 2];
      const expectedArguments = expectedCall?.arguments;
      if (
        expectedCall === undefined || assistant?.role !== 'assistant' ||
        !Array.isArray(assistant.content) || assistant.content.length !== 1 ||
        !equalJson(assistant.content[0], { kind: 'tool_call', ...expectedCall }) ||
        tool?.role !== 'tool' || tool.content.length !== 1 ||
        !plain(expectedArguments) || typeof expectedArguments.text !== 'string' ||
        !equalJson(tool.content[0], {
          kind: 'tool_result',
          callId: expectedCall.callId,
          name: expectedCall.name,
          text: expectedArguments.text.toUpperCase(),
          outcome: 'success',
        })
      ) throw new FreshRuntimeScriptError();
    }
    if (ordinal < this.expected.length) {
      const call = this.expected[ordinal];
      return Promise.resolve({ kind: 'tool_calls', calls: [clonePlain(call)] });
    }
    if (ordinal === this.expected.length) {
      return Promise.resolve({ kind: 'final', text: 'comparison complete' });
    }
    throw new FreshRuntimeScriptError();
  }
}

interface FreshRuntimeComparisonTool extends Tool {
  readonly verifyComplete: () => void;
}

const freshTool = (beforeExecute?: () => void): FreshRuntimeComparisonTool => {
  let next = 0;
  return {
    name: 'uppercase_text',
    description: 'Convert one input text to uppercase.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: (argumentsValue) => {
      beforeExecute?.();
      const expected = SCRIPT_CALLS[next];
      if (
        expected === undefined || !plain(expected.arguments) ||
        typeof expected.arguments.text !== 'string' ||
        !equalJson(argumentsValue, expected.arguments)
      ) throw new AgentFreshRuntimeComparisonError();
      next += 1;
      return expected.arguments.text.toUpperCase();
    },
    verifyComplete: () => {
      if (next !== SCRIPT_CALLS.length) throw new AgentFreshRuntimeComparisonError();
    },
  };
};

/** Test-only bounded fixture seam; production runtime never materializes this tool. */
export const createFreshRuntimeComparisonToolForTest = (): FreshRuntimeComparisonTool =>
  freshTool();

interface RunExecution {
  readonly record: AgentExecutionRecordV1;
  readonly committed: boolean;
}

const executeRun = async (
  spec: FreshRuntimeRunSpec,
  position: FreshRuntimeComparisonExecutionPosition,
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<RunExecution> => {
  hooks?.onConstruct?.('model', spec.side, position);
  const model = new FreshRuntimeScriptedModel(
    SCRIPT_CALLS,
    () => failureFor(hooks, 'model', position),
  );
  hooks?.onConstruct?.('tool', spec.side, position);
  const tool = freshTool(() => failureFor(hooks, 'tool', position));
  hooks?.onConstruct?.('registry', spec.side, position);
  const registry = new Registry([tool]);
  hooks?.onConstruct?.('clock', spec.side, position);
  let clockReads = 0;
  hooks?.onConstruct?.('abort', spec.side, position);
  const abortController = new AbortController();
  hooks?.onConstruct?.('counters', spec.side, position);
  hooks?.onConstruct?.('transcript', spec.side, position);
  const recorder = createAgentExecutionRecorder({
    envelope: spec.envelope,
    runOrdinal: spec.runOrdinal,
    clock: () => {
      const read = clockReads++;
      if (read > 0) failureFor(hooks, 'clock', position);
      return read === 0 ? 1000 : 2250;
    },
  });
  hooks?.onConstruct?.('recorder', spec.side, position);
  let commitCount = 0;
  let committedTranscript: readonly Message[] | undefined;
  hooks?.onConstruct?.('commit', spec.side, position);
  let modelSettlementCount = 0;
  const observer: AgentComparisonExecutionObserver = {
    modelSettled: (kind) => {
      failureFor(hooks, 'observer', position);
      failureFor(hooks, 'recorder', position);
      recorder.recordModelCall({ role: 'parent', resultKind: kind });
      modelSettlementCount += 1;
      hooks?.onProgress?.(
        'model-settled-recorded',
        spec.side,
        position,
        modelSettlementCount,
      );
      // The partial-second seam fires only after the second run has recorded its first
      // actual model settlement, leaving observable recorder/runtime progress to discard.
      if (modelSettlementCount === 1) failureFor(hooks, 'partial-second-run', position);
    },
    toolCallAccepted: (call) =>
      (() => {
        failureFor(hooks, 'observer', position);
        failureFor(hooks, 'recorder', position);
        recorder.recordToolCall({
          role: 'parent',
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
      })(),
    toolResultAccepted: (result: ToolResultContent) => {
      failureFor(hooks, 'observer', position);
      failureFor(hooks, 'recorder', position);
      recorder.recordToolResult({
        role: 'parent',
        callId: result.callId,
        name: result.name,
        outcome: result.outcome,
        ...(Object.hasOwn(result, 'terminal') ? { terminal: 'json_result' as const } : {}),
        result: { text: result.text },
      });
    },
  };
  const outcome = await runAgentTurnObservedForComparison(
    spec.envelope.task,
    spec.envelope.initialTranscript,
    model,
    registry,
    observer,
    {
      maxSteps: spec.manifest.parameters.maxSteps,
      systemInstruction: spec.definition.systemInstruction,
      signal: abortController.signal,
      commit: (transcript) => {
        commitCount += 1;
        committedTranscript = transcript;
      },
    },
  );
  const expectedStop = spec.side === 'current' ? 'final' : 'max_steps';
  const expectedOk = spec.side === 'current';
  if (
    outcome.ok !== expectedOk || outcome.stopReason !== expectedStop ||
    outcome.steps !== (spec.side === 'current' ? 5 : 4) || outcome.toolCallCount !== 4 ||
    outcome.toolResultCount !== 4 ||
    (spec.side === 'current' ? commitCount !== 1 : commitCount !== 0) ||
    (spec.side === 'current'
      ? committedTranscript === undefined
      : committedTranscript !== undefined)
  ) throw new FreshRuntimeScriptError();
  tool.verifyComplete();
  failureFor(hooks, 'recorder', position);
  const record = recorder.finish({
    outcome: {
      ok: expectedOk,
      stopReason: expectedStop,
      committed: spec.side === 'current',
      terminalKind: 'none',
    },
    externalRequests: 0,
    transcript: outcome.transcript,
  });
  const execution = { record, committed: spec.side === 'current' };
  hooks?.onRunComplete?.(spec.side, position);
  return execution;
};

export interface AgentFreshRuntimeRunCounts {
  readonly modelRequests: number;
  readonly externalRequests: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

export interface AgentFreshRuntimeCausalToolNode {
  readonly ordinal: number;
  readonly name: string;
  readonly outcome: 'success' | 'error';
}

export interface AgentFreshRuntimeRunResult {
  readonly runOrdinal: 1 | 2;
  readonly definitionId: 'default' | 'default-max-steps-4';
  readonly manifestIdentity: AgentResolvedManifestIdentity;
  readonly envelopeIdentity: AgentReplayEnvelopeIdentity;
  readonly maxSteps: 64 | 4;
  readonly state: 'completed' | 'stopped';
  readonly counts: AgentFreshRuntimeRunCounts;
  readonly record: AgentExecutionRecordV1;
  readonly causalToolPath: readonly AgentFreshRuntimeCausalToolNode[];
}

export interface AgentFreshRuntimePair<T> {
  readonly current: T;
  readonly variant: T;
}

export interface AgentFreshRuntimeAllowedEnvelopeDiff {
  readonly definitionId: AgentFreshRuntimePair<'default' | 'default-max-steps-4'>;
  readonly maxSteps: AgentFreshRuntimePair<64 | 4>;
  readonly parentModelRequestCeiling: AgentFreshRuntimePair<64 | 4>;
  readonly aggregateModelRequestCeiling: AgentFreshRuntimePair<64 | 4>;
  readonly manifestIdentity: AgentFreshRuntimePair<AgentResolvedManifestIdentity>;
  readonly envelopeIdentity: AgentFreshRuntimePair<AgentReplayEnvelopeIdentity>;
}

export interface AgentFreshRuntimeExecutionDelta {
  readonly state: AgentFreshRuntimePair<'completed' | 'stopped'>;
  readonly stopReason: AgentFreshRuntimePair<'final' | 'max_steps'>;
  readonly committed: AgentFreshRuntimePair<boolean>;
  readonly modelRequests: AgentFreshRuntimePair<number>;
  readonly externalRequests: AgentFreshRuntimePair<number>;
  readonly steps: AgentFreshRuntimePair<number>;
  readonly toolCalls: AgentFreshRuntimePair<number>;
  readonly toolResults: AgentFreshRuntimePair<number>;
  readonly durationMicros: AgentFreshRuntimePair<number>;
  readonly providerTokenUsage: AgentFreshRuntimePair<'unsupported'>;
  readonly cost: AgentFreshRuntimePair<'unsupported'>;
}

export interface AgentFreshRuntimeComparisonShared {
  readonly taskIdentifier: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly workspaceEntryCount: 2;
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscriptCount: 0;
  readonly plannerModelRequestCeiling: 0;
  readonly maxExternalRequestCeiling: 0;
  readonly maxWallTimeMicros: 1_000_000;
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface AgentFreshRuntimeComparisonResultV1 {
  readonly schemaVersion: 1;
  readonly caseId: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly shared: AgentFreshRuntimeComparisonShared;
  readonly current: AgentFreshRuntimeRunResult;
  readonly variant: AgentFreshRuntimeRunResult;
  readonly allowedEnvelopeDiff: AgentFreshRuntimeAllowedEnvelopeDiff;
  readonly executionDelta: AgentFreshRuntimeExecutionDelta;
}

const causalPath = (record: AgentExecutionRecordV1): readonly AgentFreshRuntimeCausalToolNode[] => {
  if (record.toolCalls.length > 32 || record.toolResults.length > 32) return invalid();
  const resultByCall = new Map(record.toolResults.map((result) => [result.callOrdinal, result]));
  return Object.freeze(record.toolCalls.map((call) => {
    const result = resultByCall.get(call.ordinal);
    if (result === undefined) return invalid();
    return Object.freeze({ ordinal: call.ordinal, name: call.name, outcome: result.outcome });
  }));
};

const runResult = (
  spec: FreshRuntimeRunSpec,
  execution: RunExecution,
): AgentFreshRuntimeRunResult => {
  const record = validateAgentExecutionRecord(execution.record, spec.envelope);
  const expected = spec.side === 'current'
    ? { state: 'completed' as const, stopReason: 'final' as const, model: 5 }
    : { state: 'stopped' as const, stopReason: 'max_steps' as const, model: 4 };
  if (
    record.runOrdinal !== spec.runOrdinal || record.manifestIdentity !== spec.manifest.identity ||
    record.envelopeIdentity !== spec.envelope.identity ||
    record.outcome.stopReason !== expected.stopReason ||
    record.outcome.ok !== (spec.side === 'current') ||
    record.outcome.committed !== execution.committed ||
    record.usage.modelRequests.aggregate !== expected.model ||
    record.usage.steps !== expected.model ||
    record.usage.externalRequests !== 0 || record.usage.toolCalls.aggregate !== 4 ||
    record.usage.toolResults.aggregate !== 4
  ) return invalid();
  const path = causalPath(record);
  if (
    path.length !== 4 ||
    path.some((node, index) =>
      node.ordinal !== index + 1 || node.name !== 'uppercase_text' || node.outcome !== 'success'
    )
  ) return invalid();
  return Object.freeze({
    runOrdinal: spec.runOrdinal,
    definitionId: spec.definitionId,
    manifestIdentity: spec.manifest.identity,
    envelopeIdentity: spec.envelope.identity,
    maxSteps: spec.manifest.parameters.maxSteps as 64 | 4,
    state: expected.state,
    counts: Object.freeze({
      modelRequests: record.usage.modelRequests.aggregate,
      externalRequests: record.usage.externalRequests,
      steps: record.usage.steps,
      toolCalls: record.usage.toolCalls.aggregate,
      toolResults: record.usage.toolResults.aggregate,
    }),
    record,
    causalToolPath: path,
  });
};

const expectedResultShape = (value: unknown): value is AgentFreshRuntimeComparisonResultV1 => {
  if (
    !plain(value) || !exactDataProperties(value, [
      'schemaVersion',
      'caseId',
      'shared',
      'current',
      'variant',
      'allowedEnvelopeDiff',
      'executionDelta',
    ]) || value.schemaVersion !== 1 || value.caseId !== FRESH_RUNTIME_COMPARISON_CASE_ID
  ) return false;
  return true;
};

const validateFixedRunRecord = (
  record: AgentExecutionRecordV1,
  side: 'current' | 'variant',
): void => {
  const expectedModelCalls: Array<{
    readonly ordinal: number;
    readonly role: 'parent';
    readonly roleOrdinal: number;
    readonly resultKind: 'tool_calls' | 'final';
  }> = SCRIPT_CALLS.map((_, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    resultKind: 'tool_calls' as const,
  }));
  if (side === 'current') {
    expectedModelCalls.push({
      ordinal: SCRIPT_CALLS.length + 1,
      role: 'parent',
      roleOrdinal: SCRIPT_CALLS.length + 1,
      resultKind: 'final',
    });
  }
  const expectedToolCalls = SCRIPT_CALLS.map((call, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    modelCallOrdinal: index + 1,
    callId: call.callId,
    name: call.name,
    arguments: call.arguments,
  }));
  const expectedToolResults = SCRIPT_CALLS.map((call, index) => ({
    ordinal: index + 1,
    role: 'parent' as const,
    roleOrdinal: index + 1,
    callOrdinal: index + 1,
    callId: call.callId,
    name: call.name,
    outcome: 'success' as const,
    terminal: 'none' as const,
    result: { text: (call.arguments as { readonly text: string }).text.toUpperCase() },
  }));
  const expectedTranscript: Message[] = [
    { role: 'user', content: { kind: 'text', text: FRESH_RUNTIME_TASK } },
  ];
  for (let index = 0; index < SCRIPT_CALLS.length; index += 1) {
    const call = SCRIPT_CALLS[index];
    const result = expectedToolResults[index];
    expectedTranscript.push({
      role: 'assistant',
      content: [{ kind: 'tool_call', ...call }],
    });
    expectedTranscript.push({
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: result.callId,
        name: result.name,
        text: result.result.text,
        outcome: result.outcome,
      }],
    });
  }
  if (side === 'current') {
    expectedTranscript.push({
      role: 'assistant',
      content: { kind: 'text', text: 'comparison complete' },
    });
  }
  if (
    !equalJson(record.modelCalls, expectedModelCalls) ||
    !equalJson(record.toolCalls, expectedToolCalls) ||
    !equalJson(record.toolResults, expectedToolResults) ||
    !equalJson(record.transcript, expectedTranscript)
  ) return invalid();
};

/** Validate and freeze the bounded result; no result is accepted as a partial comparison. */
export const validateAgentFreshRuntimeComparisonResult = (
  value: unknown,
): AgentFreshRuntimeComparisonResultV1 => {
  try {
    if (!expectedResultShape(value)) return invalid();
    const shared = value.shared;
    if (
      !plain(shared) || !exactDataProperties(shared, [
        'taskIdentifier',
        'workspaceEntryCount',
        'modelIdentity',
        'initialTranscriptCount',
        'plannerModelRequestCeiling',
        'maxExternalRequestCeiling',
        'maxWallTimeMicros',
        'scriptId',
        'toolFixtureId',
      ]) || shared.taskIdentifier !== FRESH_RUNTIME_COMPARISON_CASE_ID ||
      shared.workspaceEntryCount !== 2 ||
      shared.modelIdentity !== FRESH_RUNTIME_MODEL_IDENTITY ||
      shared.initialTranscriptCount !== 0 ||
      shared.plannerModelRequestCeiling !== 0 || shared.maxExternalRequestCeiling !== 0 ||
      shared.maxWallTimeMicros !== FRESH_RUNTIME_MAX_WALL_TIME_MICROS ||
      shared.scriptId !== FRESH_RUNTIME_SCRIPT_ID ||
      shared.toolFixtureId !== FRESH_RUNTIME_TOOL_FIXTURE_ID
    ) return invalid();
    const current = value.current;
    const variant = value.variant;
    const validateRun = (run: unknown, side: 'current' | 'variant'): AgentFreshRuntimeRunResult => {
      if (
        !plain(run) || !exactDataProperties(run, [
          'runOrdinal',
          'definitionId',
          'manifestIdentity',
          'envelopeIdentity',
          'maxSteps',
          'state',
          'counts',
          'record',
          'causalToolPath',
        ])
      ) return invalid();
      const expected = side === 'current'
        ? {
          ordinal: 1,
          definitionId: 'default',
          maxSteps: 64,
          state: 'completed',
          stop: 'final',
          model: 5,
        }
        : {
          ordinal: 2,
          definitionId: 'default-max-steps-4',
          maxSteps: 4,
          state: 'stopped',
          stop: 'max_steps',
          model: 4,
        };
      if (
        run.runOrdinal !== expected.ordinal || run.definitionId !== expected.definitionId ||
        run.manifestIdentity !== expectedManifestIdentity(side) ||
        run.envelopeIdentity !== expectedEnvelopeIdentity(side) ||
        run.maxSteps !== expected.maxSteps || run.state !== expected.state
      ) return invalid();
      const counts = run.counts;
      if (
        !plain(counts) ||
        !exactDataProperties(counts, [
          'modelRequests',
          'externalRequests',
          'steps',
          'toolCalls',
          'toolResults',
        ]) ||
        counts.modelRequests !== expected.model || counts.externalRequests !== 0 ||
        counts.steps !== expected.model || counts.toolCalls !== 4 || counts.toolResults !== 4
      ) return invalid();
      const path = run.causalToolPath;
      if (!exactArray(path) || path.length !== 4) return invalid();
      for (let index = 0; index < path.length; index += 1) {
        const node = path[index];
        if (
          !plain(node) || !exactDataProperties(node, ['ordinal', 'name', 'outcome']) ||
          node.ordinal !== index + 1 || node.name !== 'uppercase_text' || node.outcome !== 'success'
        ) return invalid();
      }
      const nodes = path as readonly AgentFreshRuntimeCausalToolNode[];
      const record = validateAgentExecutionRecord(run.record, {
        schemaVersion: 1,
        caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
        task: FRESH_RUNTIME_TASK,
        workspace: { entries: [] },
        modelIdentity: FRESH_RUNTIME_MODEL_IDENTITY,
        budget: {
          maxSteps: run.maxSteps,
          modelRequests: { parent: run.maxSteps, planner: 0, aggregate: run.maxSteps },
          maxExternalRequests: 0,
          maxWallTimeMicros: FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
        },
        initialTranscript: [],
        manifest: {
          schemaVersion: 1,
          definitionId: run.definitionId,
          resources: [],
          parameters: { maxSteps: run.maxSteps },
          identity: run.manifestIdentity,
        },
        identity: run.envelopeIdentity,
      } as unknown as AgentReplayEnvelopeV1);
      validateFixedRunRecord(record, side);
      if (
        record.outcome.stopReason !== expected.stop ||
        record.outcome.committed !== (side === 'current') ||
        record.runOrdinal !== expected.ordinal ||
        record.manifestIdentity !== expectedManifestIdentity(side) ||
        record.envelopeIdentity !== expectedEnvelopeIdentity(side) ||
        record.usage.steps !== expected.model ||
        record.usage.modelRequests.parent !== expected.model ||
        record.usage.modelRequests.planner !== 0 ||
        record.usage.modelRequests.aggregate !== expected.model ||
        record.usage.externalRequests !== 0 ||
        record.usage.toolCalls.parent !== 4 || record.usage.toolCalls.planner !== 0 ||
        record.usage.toolCalls.aggregate !== 4 ||
        record.usage.toolResults.parent !== 4 || record.usage.toolResults.planner !== 0 ||
        record.usage.toolResults.aggregate !== 4 ||
        record.usage.providerTokenUsage !== 'unsupported' || record.usage.cost !== 'unsupported'
      ) return invalid();
      return Object.freeze({
        runOrdinal: run.runOrdinal as 1 | 2,
        definitionId: run.definitionId as 'default' | 'default-max-steps-4',
        manifestIdentity: run.manifestIdentity as AgentResolvedManifestIdentity,
        envelopeIdentity: run.envelopeIdentity as AgentReplayEnvelopeIdentity,
        maxSteps: run.maxSteps as 64 | 4,
        state: run.state as 'completed' | 'stopped',
        counts: Object.freeze({
          modelRequests: counts.modelRequests,
          externalRequests: counts.externalRequests,
          steps: counts.steps,
          toolCalls: counts.toolCalls,
          toolResults: counts.toolResults,
        }),
        record,
        causalToolPath: Object.freeze(nodes.map((node) =>
          Object.freeze({
            ordinal: node.ordinal,
            name: node.name,
            outcome: node.outcome,
          })
        )),
      }) as unknown as AgentFreshRuntimeRunResult;
    };
    const validatedCurrent = validateRun(current, 'current');
    const validatedVariant = validateRun(variant, 'variant');
    const allowed = value.allowedEnvelopeDiff;
    if (
      !plain(allowed) || !exactDataProperties(allowed, [
        'definitionId',
        'maxSteps',
        'parentModelRequestCeiling',
        'aggregateModelRequestCeiling',
        'manifestIdentity',
        'envelopeIdentity',
      ])
    ) return invalid();
    const pairKeys = [
      ['definitionId', 'default', 'default-max-steps-4'],
      ['maxSteps', 64, 4],
      ['parentModelRequestCeiling', 64, 4],
      ['aggregateModelRequestCeiling', 64, 4],
      ['manifestIdentity', CURRENT_MANIFEST_ID, VARIANT_MANIFEST_ID],
      ['envelopeIdentity', CURRENT_ENVELOPE_ID, VARIANT_ENVELOPE_ID],
    ] as const;
    for (const [key, expectedCurrent, expectedVariant] of pairKeys) {
      const pair = allowed[key];
      if (
        !plain(pair) || !exactDataProperties(pair, ['current', 'variant']) ||
        pair.current !== expectedCurrent || pair.variant !== expectedVariant
      ) return invalid();
    }
    const delta = value.executionDelta;
    if (
      !plain(delta) || !exactDataProperties(delta, [
        'state',
        'stopReason',
        'committed',
        'modelRequests',
        'externalRequests',
        'steps',
        'toolCalls',
        'toolResults',
        'durationMicros',
        'providerTokenUsage',
        'cost',
      ])
    ) return invalid();
    const deltaValues = [
      ['state', 'completed', 'stopped'],
      ['stopReason', 'final', 'max_steps'],
      ['committed', true, false],
      ['modelRequests', 5, 4],
      ['externalRequests', 0, 0],
      ['steps', 5, 4],
      ['toolCalls', 4, 4],
      ['toolResults', 4, 4],
      ['providerTokenUsage', 'unsupported', 'unsupported'],
      ['cost', 'unsupported', 'unsupported'],
    ] as const;
    for (const [key, expectedCurrent, expectedVariant] of deltaValues) {
      const pair = delta[key];
      if (
        !plain(pair) || !exactDataProperties(pair, ['current', 'variant']) ||
        pair.current !== expectedCurrent || pair.variant !== expectedVariant
      ) return invalid();
    }
    const duration = delta.durationMicros;
    if (
      !plain(duration) || !exactDataProperties(duration, ['current', 'variant']) ||
      duration.current !== validatedCurrent.record.durationMicros ||
      duration.variant !== validatedVariant.record.durationMicros
    ) return invalid();
    return Object.freeze({
      schemaVersion: 1 as const,
      caseId: FRESH_RUNTIME_COMPARISON_CASE_ID,
      shared: Object.freeze({ ...shared, modelIdentity: MODEL_ID }),
      current: validatedCurrent,
      variant: validatedVariant,
      allowedEnvelopeDiff: Object.freeze({
        definitionId: Object.freeze({ ...allowed.definitionId }),
        maxSteps: Object.freeze({ ...allowed.maxSteps }),
        parentModelRequestCeiling: Object.freeze({ ...allowed.parentModelRequestCeiling }),
        aggregateModelRequestCeiling: Object.freeze({ ...allowed.aggregateModelRequestCeiling }),
        manifestIdentity: Object.freeze({ ...allowed.manifestIdentity }),
        envelopeIdentity: Object.freeze({ ...allowed.envelopeIdentity }),
      }),
      executionDelta: Object.freeze({
        state: Object.freeze({ ...delta.state }),
        stopReason: Object.freeze({ ...delta.stopReason }),
        committed: Object.freeze({ ...delta.committed }),
        modelRequests: Object.freeze({ ...delta.modelRequests }),
        externalRequests: Object.freeze({ ...delta.externalRequests }),
        steps: Object.freeze({ ...delta.steps }),
        toolCalls: Object.freeze({ ...delta.toolCalls }),
        toolResults: Object.freeze({ ...delta.toolResults }),
        durationMicros: Object.freeze({ ...delta.durationMicros }),
        providerTokenUsage: Object.freeze({ ...delta.providerTokenUsage }),
        cost: Object.freeze({ ...delta.cost }),
      }),
    });
  } catch {
    return invalid();
  }
};

const runFreshRuntimeComparisonInternal = async (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<AgentFreshRuntimeComparisonResultV1> => {
  try {
    failureFor(hooks, 'setup', undefined);
    if (executionOrder !== 'current-first' && executionOrder !== 'variant-first') return invalid();
    const snapshot = validateFreshRuntimeComparisonCase(comparisonCase);
    const pair = hooks === undefined
      ? await createFreshRuntimeRunSpecs(snapshot)
      : await createFreshRuntimeRunSpecsForTest(snapshot, hooks, executionOrder);
    let currentExecution: RunExecution;
    let variantExecution: RunExecution;
    if (executionOrder === 'variant-first') {
      variantExecution = await executeRun(pair.variant, 'first', hooks);
      currentExecution = await executeRun(pair.current, 'second', hooks);
    } else {
      currentExecution = await executeRun(pair.current, 'first', hooks);
      variantExecution = await executeRun(pair.variant, 'second', hooks);
    }
    failureFor(hooks, 'correlation', undefined);
    const current = runResult(pair.current, currentExecution);
    const variant = runResult(pair.variant, variantExecution);
    const result = Object.freeze({
      schemaVersion: 1 as const,
      caseId: snapshot.caseId,
      shared: Object.freeze({
        taskIdentifier: snapshot.caseId,
        workspaceEntryCount: 2 as const,
        modelIdentity: snapshot.modelIdentity,
        initialTranscriptCount: 0 as const,
        plannerModelRequestCeiling: snapshot.ceilings.plannerModelRequests,
        maxExternalRequestCeiling: snapshot.ceilings.maxExternalRequests,
        maxWallTimeMicros: snapshot.ceilings.maxWallTimeMicros,
        scriptId: snapshot.scriptId,
        toolFixtureId: snapshot.toolFixtureId,
      }),
      current,
      variant,
      allowedEnvelopeDiff: Object.freeze({
        definitionId: Object.freeze({
          current: current.definitionId,
          variant: variant.definitionId,
        }),
        maxSteps: Object.freeze({ current: current.maxSteps, variant: variant.maxSteps }),
        parentModelRequestCeiling: Object.freeze({
          current: pair.current.envelope.budget.modelRequests.parent as 64,
          variant: pair.variant.envelope.budget.modelRequests.parent as 4,
        }),
        aggregateModelRequestCeiling: Object.freeze({
          current: pair.current.envelope.budget.modelRequests.aggregate as 64,
          variant: pair.variant.envelope.budget.modelRequests.aggregate as 4,
        }),
        manifestIdentity: Object.freeze({
          current: current.manifestIdentity,
          variant: variant.manifestIdentity,
        }),
        envelopeIdentity: Object.freeze({
          current: current.envelopeIdentity,
          variant: variant.envelopeIdentity,
        }),
      }),
      executionDelta: Object.freeze({
        state: Object.freeze({ current: current.state, variant: variant.state }),
        stopReason: Object.freeze({
          current: current.record.outcome.stopReason as 'final',
          variant: variant.record.outcome.stopReason as 'max_steps',
        }),
        committed: Object.freeze({
          current: current.record.outcome.committed,
          variant: variant.record.outcome.committed,
        }),
        modelRequests: Object.freeze({
          current: current.counts.modelRequests,
          variant: variant.counts.modelRequests,
        }),
        externalRequests: Object.freeze({
          current: current.counts.externalRequests,
          variant: variant.counts.externalRequests,
        }),
        steps: Object.freeze({ current: current.counts.steps, variant: variant.counts.steps }),
        toolCalls: Object.freeze({
          current: current.counts.toolCalls,
          variant: variant.counts.toolCalls,
        }),
        toolResults: Object.freeze({
          current: current.counts.toolResults,
          variant: variant.counts.toolResults,
        }),
        durationMicros: Object.freeze({
          current: current.record.durationMicros,
          variant: variant.record.durationMicros,
        }),
        providerTokenUsage: Object.freeze({
          current: 'unsupported' as const,
          variant: 'unsupported' as const,
        }),
        cost: Object.freeze({ current: 'unsupported' as const, variant: 'unsupported' as const }),
      }),
    });
    return validateAgentFreshRuntimeComparisonResult(result);
  } catch {
    throw new AgentFreshRuntimeComparisonError();
  }
};

export const runFreshRuntimeComparison = (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
): Promise<AgentFreshRuntimeComparisonResultV1> =>
  runFreshRuntimeComparisonInternal(comparisonCase, executionOrder);

/** Test-only bounded runner seam for construction accounting and sanitized fault injection. */
export const runFreshRuntimeComparisonForTest = (
  comparisonCase: unknown = FRESH_RUNTIME_COMPARISON_CASE,
  executionOrder: 'current-first' | 'variant-first' = 'current-first',
  hooks?: FreshRuntimeComparisonTestHooks,
): Promise<AgentFreshRuntimeComparisonResultV1> => {
  try {
    return runFreshRuntimeComparisonInternal(
      comparisonCase,
      executionOrder,
      normalizeTestHooks(hooks),
    );
  } catch {
    return Promise.reject(new AgentFreshRuntimeComparisonError());
  }
};

export const runAgentFreshRuntimeComparison = runFreshRuntimeComparison;
export const createFreshRuntimeComparison = runFreshRuntimeComparison;
