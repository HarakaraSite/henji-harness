import {
  type AgentDefinitionInput,
  type ResolvedAgentDefinition,
} from '../definitions/agent_definition.ts';
import {
  createAgentResourceIdentity,
  validateResolvedAgentResources,
} from '../definitions/resource_identity.ts';
import {
  type AgentResolvedManifestIdentity,
  type AgentResolvedManifestV1,
  validateAgentResolvedManifest,
} from '../definitions/resolved_manifest.ts';
import {
  type AgentReplayEnvelopeIdentity,
  type AgentReplayEnvelopeV1,
  createAgentReplayEnvelope,
  validateAgentReplayEnvelope,
} from '../session/replay_envelope.ts';
import {
  type ComparisonVariantEvaluation,
  evaluateComparisonVariant,
  validateComparisonVariantRelationship,
} from './comparison_variant.ts';
import type { Workspace } from '../tools/work_tools.ts';
import {
  type AgentFreshRuntimeComparisonPair,
  FRESH_RUNTIME_COMPARISON_CASE_ID,
  FRESH_RUNTIME_MAX_WALL_TIME_MICROS,
  FRESH_RUNTIME_MODEL_IDENTITY,
  FRESH_RUNTIME_SCRIPT_ID,
  FRESH_RUNTIME_TASK,
  FRESH_RUNTIME_TOOL_FIXTURE_ID,
  type FreshRuntimeComparisonCaseV1,
  type FreshRuntimeComparisonTestHooks,
  type FreshRuntimeRunSpec,
} from './fresh_runtime_comparison_contract.ts';
import {
  equalJson,
  exactArray,
  exactDataProperties,
  invalid,
  plain,
} from './fresh_runtime_comparison_value.ts';

const AGENTS_DIGEST =
  'henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf';
const DENO_DIGEST =
  'henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4';
export const CURRENT_MANIFEST_ID =
  'henji-agent-resolved-manifest:v1:sha256:301d404246ac739de558f4e422427b4287aeaea4a8d6ebd5427c72eaf1ff580d' as AgentResolvedManifestIdentity;
export const VARIANT_MANIFEST_ID =
  'henji-agent-resolved-manifest:v1:sha256:095d3981d1839ea05cc0f8cc85538325b891c03476ea8379ba40cf493240008d' as AgentResolvedManifestIdentity;
export const CURRENT_ENVELOPE_ID =
  'henji-agent-replay-envelope:v1:sha256:5e2e6cc31a999585a7f516adb215782de36b0c9524b6b0e8669dcc59c2fc05b3' as AgentReplayEnvelopeIdentity;
export const VARIANT_ENVELOPE_ID =
  'henji-agent-replay-envelope:v1:sha256:4030bbc18b2427581f054dead53c1025616201b7c785bf75e101234cf84c72f6' as AgentReplayEnvelopeIdentity;

export const MODEL_ID = createAgentResourceIdentity(FRESH_RUNTIME_MODEL_IDENTITY);
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
export const expectedManifestIdentity = (
  side: 'current' | 'variant',
): AgentResolvedManifestIdentity => side === 'current' ? CURRENT_MANIFEST_ID : VARIANT_MANIFEST_ID;
export const expectedEnvelopeIdentity = (
  side: 'current' | 'variant',
): AgentReplayEnvelopeIdentity => side === 'current' ? CURRENT_ENVELOPE_ID : VARIANT_ENVELOPE_ID;
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

export const createFreshRuntimeRunSpecsForTest = async (
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
