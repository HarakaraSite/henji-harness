import { assert, assertEquals } from './test_helpers.ts';
import { PROFILE } from '../../v0/model.ts';
import {
  type AgentDefinitionInput,
  DEFAULT_AGENT_MAX_STEPS,
  defaultAgentDefinition,
  PLANNER_AGENT_INSTRUCTION,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from '../../v0/agent/agent_definition.ts';
import { composeSystemInstruction } from '../../v0/agent/agent_instructions.ts';
import { type SkillCatalog } from '../../v0/agent/skills.ts';
import {
  createAgentResourceSelection,
  validateAgentResourceSelection,
  validateResolvedAgentResources,
} from '../../v0/agent/resource_identity.ts';

Deno.test('default Agent Definition projects the canonical pure composition contract', () => {
  const skillCatalog: SkillCatalog = Object.freeze({
    skills: Object.freeze([{
      name: 'review',
      description: 'Review code.',
      sourceDirectory: '/workspace/.zot/skills/review',
      body: 'private skill body',
      toolResult: 'formatted skill result',
    }]),
    manifest: 'Available project skills.\n- review — Review code.',
  });
  const input: AgentDefinitionInput = {
    workspace: { root: '/workspace' },
    agentInstructions: 'local instructions',
    skillCatalog,
  };

  const resolved = defaultAgentDefinition(input);

  assertEquals(resolved.model.provider, 'openrouter');
  assert(resolved.model.profile === PROFILE);
  assertEquals(resolved.registry.kind, 'production');
  assert(resolved.registry.kind === 'production');
  assertEquals(resolved.registry.plannerDelegation, true);
  assert(resolved.registry.workspace === input.workspace);
  assert(resolved.registry.skillCatalog === skillCatalog);
  assert(resolved.agentInstructions === input.agentInstructions);
  assert(resolved.skillCatalog === skillCatalog);
  assertEquals(
    resolved.systemInstruction,
    composeSystemInstruction(input.agentInstructions, skillCatalog.manifest),
  );
  assertEquals(resolved.resourceSelection.parameters.maxSteps, DEFAULT_AGENT_MAX_STEPS);
  assertEquals(resourceNames(resolved.resourceSelection.resources), [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'instruction:project-skill-manifest',
    'instruction:workspace-agents',
    'skill:review',
    'tool:bash',
    'tool:delegate_to_planner',
    'tool:edit',
    'tool:read',
    'tool:skill',
    'tool:submit_json_result',
    'tool:write',
    'subagent:planner',
  ]);
  assert(Object.isFrozen(resolved.resourceSelection));
  assert(Object.isFrozen(resolved.resourceSelection.resources));
  assert(Object.isFrozen(resolved.resourceSelection.parameters));
  assert(!resolved.systemInstruction?.includes('private skill body'));
});

Deno.test('default Agent Definition keeps absent instruction and empty skills absent', () => {
  const skillCatalog: SkillCatalog = Object.freeze({
    skills: Object.freeze([]),
    manifest: undefined,
  });

  const resolved = defaultAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog,
  });

  assertEquals(resolved.systemInstruction, undefined);
  assertEquals(resolved.agentInstructions, undefined);
  assert(resolved.skillCatalog === skillCatalog);
});

Deno.test('planner Definition appends its fixed policy after workspace context and manifest', () => {
  const skillCatalog: SkillCatalog = Object.freeze({
    skills: Object.freeze([]),
    manifest: undefined,
  });
  const input: AgentDefinitionInput = {
    workspace: { root: '/workspace' },
    agentInstructions: 'local instructions',
    skillCatalog,
  };
  const resolved = plannerAgentDefinition(input);
  assertEquals(resolved.model.provider, 'openrouter');
  assert(resolved.model.profile === PROFILE);
  assertEquals(resolved.registry.kind, 'planner');
  assert(resolved.registry.workspace === input.workspace);
  assert(resolved.registry.skillCatalog === skillCatalog);
  assert(resolved.agentInstructions === input.agentInstructions);
  assert(resolved.skillCatalog === skillCatalog);
  assertEquals(
    resolved.systemInstruction,
    composeSystemInstruction(
      composeSystemInstruction(input.agentInstructions, skillCatalog.manifest),
      PLANNER_AGENT_INSTRUCTION,
    ),
  );
  assert(resolved.systemInstruction?.endsWith(PLANNER_AGENT_INSTRUCTION));
  assertEquals(resolved.resourceSelection.parameters.maxSteps, 8);
});

Deno.test('planner Definition preserves lazy skill bodies and empty context shape', () => {
  const skillCatalog: SkillCatalog = Object.freeze({
    skills: Object.freeze([{
      name: 'plan',
      description: 'Plan.',
      sourceDirectory: './.zot/skills/plan',
      body: 'PRIVATE-PLANNER-SKILL-BODY',
      toolResult: 'PRIVATE-PLANNER-SKILL-BODY',
    }]),
    manifest: 'Available project skills.\n- plan — Plan.',
  });
  const resolved = plannerAgentDefinition({ workspace: { root: '/workspace' }, skillCatalog });
  assertEquals(
    resolved.systemInstruction,
    `${skillCatalog.manifest}\n\n${PLANNER_AGENT_INSTRUCTION}`,
  );
  assert(!resolved.systemInstruction?.includes('PRIVATE-PLANNER-SKILL-BODY'));
  assert(resolved.skillCatalog.skills[0].body === 'PRIVATE-PLANNER-SKILL-BODY');
});

const assertSyncRejects = (fn: () => unknown): void => {
  let rejected = false;
  try {
    fn();
  } catch {
    rejected = true;
  }
  assert(rejected, 'expected synchronous rejection');
};
const assertSanitizedRejects = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.name, 'AgentResourceIdentityError');
    assertEquals(error.message, 'invalid agent resource selection');
    return;
  }
  assert(false, 'expected sanitized synchronous rejection');
};
const resourceNames = (resources: readonly string[]): string[] =>
  resources.map((resource) => `${resource}`);

Deno.test('resource identity grammar accepts exact bounds and rejects unsafe forms', () => {
  const provider = 'a'.repeat(32);
  const component = 'a'.repeat(128);
  const skill = 'a'.repeat(64);
  for (
    const identity of [
      `model:${provider}:${component}`,
      `instruction:${component}`,
      `skill:${skill}`,
      `tool:${component}`,
      `subagent:${component}`,
    ]
  ) {
    const resolved = createAgentResourceSelection([identity], 1);
    assertEquals(resourceNames(resolved.resources), [identity]);
  }
  for (
    const identity of [
      '',
      'MODEL:openrouter:profile',
      'model:OpenRouter:profile',
      'model:openrouter:',
      'model:openrouter:profile:extra',
      'instruction:with space',
      'skill:with/slash',
      'tool:with\\backslash',
      'subagent:planner\0hidden',
      `skill:${'a'.repeat(65)}`,
      `tool:${'a'.repeat(129)}`,
      'unknown:value',
    ]
  ) {
    assertSyncRejects(() => createAgentResourceSelection([identity], 1));
  }
});

Deno.test('resource selection enforces canonical order, uniqueness, and positive safe maxSteps', () => {
  assertSyncRejects(() =>
    createAgentResourceSelection([
      'tool:read',
      'model:openrouter:profile',
    ], 8)
  );
  assertSyncRejects(() =>
    createAgentResourceSelection([
      'model:openrouter:profile',
      'tool:read',
      'tool:read',
    ], 8)
  );
  assertSyncRejects(() => createAgentResourceSelection(['model:openrouter:profile'], 0));
  assertSyncRejects(() => createAgentResourceSelection(['model:openrouter:profile'], -1));
  assertSyncRejects(() => createAgentResourceSelection(['model:openrouter:profile'], NaN));
  assertSyncRejects(() => createAgentResourceSelection(['model:openrouter:profile'], Infinity));
  assertSyncRejects(() => createAgentResourceSelection(['model:openrouter:profile'], 2 ** 53));
});

Deno.test('default Definition selects the exact no-context no-skill resources', () => {
  const resolved = defaultAgentDefinition({
    workspace: { root: '/disposable/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]), manifest: undefined }),
  });
  assertEquals(resourceNames(resolved.resourceSelection.resources), [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'tool:bash',
    'tool:delegate_to_planner',
    'tool:edit',
    'tool:read',
    'tool:submit_json_result',
    'tool:write',
    'subagent:planner',
  ]);
  assertEquals(resolved.resourceSelection.parameters, { maxSteps: 8 });
  assertEquals(validateResolvedAgentResources(resolved), resolved.resourceSelection);
});

Deno.test('default Definition canonicalizes unsorted skills without exposing their bodies', () => {
  const resolved = defaultAgentDefinition({
    workspace: { root: '/secret/workspace' },
    agentInstructions: 'private instructions',
    skillCatalog: {
      skills: [
        {
          name: 'review',
          description: 'Review',
          sourceDirectory: '/secret/review',
          body: 'PRIVATE REVIEW BODY',
          toolResult: 'PRIVATE REVIEW RESULT',
        },
        {
          name: 'format',
          description: 'Format',
          sourceDirectory: '/secret/format',
          body: 'PRIVATE FORMAT BODY',
          toolResult: 'PRIVATE FORMAT RESULT',
        },
      ],
      manifest: 'private manifest',
    },
  });
  assertEquals(resourceNames(resolved.resourceSelection.resources), [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'instruction:project-skill-manifest',
    'instruction:workspace-agents',
    'skill:format',
    'skill:review',
    'tool:bash',
    'tool:delegate_to_planner',
    'tool:edit',
    'tool:read',
    'tool:skill',
    'tool:submit_json_result',
    'tool:write',
    'subagent:planner',
  ]);
  const serialized = JSON.stringify(resolved.resourceSelection);
  assert(!serialized.includes('PRIVATE'));
  assert(!serialized.includes('/secret'));
  assert(!serialized.includes('private manifest'));
  assert(!serialized.includes(PROFILE.origin));
  assert(!serialized.includes(PROFILE.path));
  assert(!serialized.includes(PROFILE.secretEnv));
  assert(!serialized.includes('dummy-credential'));

  const sameScalars = defaultAgentDefinition({
    workspace: { root: '/another/disposable/root' },
    agentInstructions: 'private instructions',
    skillCatalog: {
      skills: [
        {
          name: 'format',
          description: 'Changed source metadata',
          sourceDirectory: '/another/format',
          body: 'CHANGED FORMAT BODY',
          toolResult: 'CHANGED FORMAT RESULT',
        },
        {
          name: 'review',
          description: 'Changed source metadata',
          sourceDirectory: '/another/review',
          body: 'CHANGED REVIEW BODY',
          toolResult: 'CHANGED REVIEW RESULT',
        },
      ],
      manifest: 'private manifest',
    },
  });
  assertEquals(
    JSON.stringify(sameScalars.resourceSelection),
    JSON.stringify(resolved.resourceSelection),
  );
});

Deno.test('planner Definition exposes policy and planner-only resources exactly', () => {
  const noSkills = plannerAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]), manifest: undefined }),
  });
  assertEquals(resourceNames(noSkills.resourceSelection.resources), [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'instruction:builtin-planner-policy',
    'tool:read',
    'tool:submit_json_result',
  ]);
  const withSkills = plannerAgentDefinition({
    workspace: { root: '/workspace' },
    agentInstructions: 'instructions',
    skillCatalog: {
      skills: [
        {
          name: 'review',
          description: 'Review',
          sourceDirectory: '/workspace/review',
          body: 'body',
          toolResult: 'result',
        },
        {
          name: 'format',
          description: 'Format',
          sourceDirectory: '/workspace/format',
          body: 'body',
          toolResult: 'result',
        },
      ],
      manifest: 'manifest',
    },
  });
  assertEquals(resourceNames(withSkills.resourceSelection.resources), [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'instruction:builtin-planner-policy',
    'instruction:project-skill-manifest',
    'instruction:workspace-agents',
    'skill:format',
    'skill:review',
    'tool:read',
    'tool:skill',
    'tool:submit_json_result',
  ]);
  assert(
    !resourceNames(withSkills.resourceSelection.resources).some((resource) =>
      resource.includes('bash') || resource.includes('delegate') || resource.includes('subagent')
    ),
  );
});

Deno.test('skill catalog and manifest presence must agree in both directions', () => {
  const noManifest = defaultAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: {
      skills: [{
        name: 'review',
        description: 'Review',
        sourceDirectory: '/workspace/review',
        body: 'body',
        toolResult: 'result',
      }],
      manifest: undefined,
    },
  });
  assertSyncRejects(() => validateResolvedAgentResources(noManifest));
  const noSkills = defaultAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: { skills: [], manifest: 'manifest' },
  });
  assertSyncRejects(() => validateResolvedAgentResources(noSkills));
});

Deno.test('resolved resource validation rejects declaration drift and unknown selections', () => {
  const resolved = defaultAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]), manifest: undefined }),
  });
  const replace = (resources: readonly string[]) => ({
    ...resolved,
    resourceSelection: createAgentResourceSelection(resources, 8),
  });
  const resources = resourceNames(resolved.resourceSelection.resources);
  resources[0] = 'model:openrouter:other-profile';
  assertSyncRejects(() => validateResolvedAgentResources(replace(resources)));
  assertSyncRejects(() => validateResolvedAgentResources(replace(resources.slice(1))));
  const unknown = resourceNames(resolved.resourceSelection.resources);
  unknown[unknown.indexOf('tool:write')] = 'tool:unknown';
  assertSanitizedRejects(() => validateResolvedAgentResources(replace(unknown)));
  const missing = resourceNames(resolved.resourceSelection.resources).filter((name) =>
    name !== 'tool:write'
  );
  assertSyncRejects(() => validateResolvedAgentResources(replace(missing)));
  const extra = [
    'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
    'tool:bash',
    'tool:delegate_to_planner',
    'tool:edit',
    'tool:read',
    'tool:skill',
    'tool:submit_json_result',
    'tool:write',
    'subagent:planner',
  ];
  assertSanitizedRejects(() => validateResolvedAgentResources(replace(extra)));
  const withoutDelegate = resourceNames(resolved.resourceSelection.resources).filter((name) =>
    name !== 'tool:delegate_to_planner'
  );
  assertSanitizedRejects(() => validateResolvedAgentResources(replace(withoutDelegate)));
  const withoutPlanner = resourceNames(resolved.resourceSelection.resources).filter((name) =>
    name !== 'subagent:planner'
  );
  assertSanitizedRejects(() => validateResolvedAgentResources(replace(withoutPlanner)));
  const delegated = {
    ...resolved,
    registry: { ...resolved.registry, plannerDelegation: false as true },
  };
  assertSyncRejects(() =>
    validateResolvedAgentResources(delegated as unknown as ResolvedAgentDefinition)
  );
  const planner = plannerAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]), manifest: undefined }),
  });
  const plannerWithDelegation = {
    ...planner,
    resourceSelection: createAgentResourceSelection([
      'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
      'instruction:builtin-planner-policy',
      'tool:delegate_to_planner',
      'tool:read',
      'tool:submit_json_result',
    ], 8),
  };
  assertSanitizedRejects(() =>
    validateResolvedAgentResources(plannerWithDelegation as unknown as ResolvedAgentDefinition)
  );
  const plannerWithSubagent = {
    ...planner,
    resourceSelection: createAgentResourceSelection([
      'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
      'instruction:builtin-planner-policy',
      'tool:read',
      'tool:submit_json_result',
      'subagent:planner',
    ], 8),
  };
  assertSanitizedRejects(() =>
    validateResolvedAgentResources(plannerWithSubagent as unknown as ResolvedAgentDefinition)
  );

  const missingPlannerPolicy = plannerAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]), manifest: undefined }),
  });
  const withoutPolicy = resourceNames(missingPlannerPolicy.resourceSelection.resources).filter((
    name,
  ) => name !== 'instruction:builtin-planner-policy');
  assertSyncRejects(() =>
    validateResolvedAgentResources({
      ...missingPlannerPolicy,
      resourceSelection: createAgentResourceSelection(withoutPolicy, 8),
    })
  );

  const withSkill = defaultAgentDefinition({
    workspace: { root: '/workspace' },
    skillCatalog: {
      skills: [{
        name: 'review',
        description: 'Review',
        sourceDirectory: '/workspace/review',
        body: 'body',
        toolResult: 'result',
      }],
      manifest: 'manifest',
    },
  });
  const withoutSkillIdentity = resourceNames(withSkill.resourceSelection.resources).filter((name) =>
    name !== 'skill:review'
  );
  assertSyncRejects(() =>
    validateResolvedAgentResources({
      ...withSkill,
      resourceSelection: createAgentResourceSelection(withoutSkillIdentity, 8),
    })
  );
});

Deno.test('selection envelope is frozen, data-only, and exact-shaped', () => {
  const valid = createAgentResourceSelection(['model:openrouter:profile'], 8);
  assert(Object.isFrozen(valid));
  assert(Object.isFrozen(valid.resources));
  assert(Object.isFrozen(valid.parameters));
  assertEquals(JSON.parse(JSON.stringify(valid)), {
    resources: ['model:openrouter:profile'],
    parameters: { maxSteps: 8 },
  });
  const extra = Object.freeze({ ...valid, extra: true });
  assertSyncRejects(() => validateAgentResourceSelection(extra));
  const symbols = Object.freeze({ ...valid, [Symbol('extra')]: true });
  assertSyncRejects(() => validateAgentResourceSelection(symbols));
  const accessor = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(accessor, 'resources', { enumerable: true, get: () => valid.resources });
  Object.defineProperty(accessor, 'parameters', {
    enumerable: true,
    value: valid.parameters,
  });
  Object.freeze(accessor);
  assertSyncRejects(() => validateAgentResourceSelection(accessor));

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.resources = valid.resources;
  nullPrototype.parameters = valid.parameters;
  Object.freeze(nullPrototype);
  assertSyncRejects(() => validateAgentResourceSelection(nullPrototype));

  for (const maxSteps of [undefined, '8', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
    const parameters = Object.freeze({ maxSteps });
    const malformed = Object.freeze({ resources: valid.resources, parameters });
    assertSyncRejects(() => validateAgentResourceSelection(malformed));
  }

  const missingResources = Object.freeze({ parameters: valid.parameters });
  assertSyncRejects(() => validateAgentResourceSelection(missingResources));
  const extraParameters = Object.freeze({ ...valid.parameters, extra: true });
  assertSyncRejects(() =>
    validateAgentResourceSelection(Object.freeze({
      resources: valid.resources,
      parameters: extraParameters,
    }))
  );
  const parameterSymbols = Object.freeze({ ...valid.parameters, [Symbol('extra')]: true });
  assertSyncRejects(() =>
    validateAgentResourceSelection(Object.freeze({
      resources: valid.resources,
      parameters: parameterSymbols,
    }))
  );
  const parameterAccessor = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(parameterAccessor, 'maxSteps', { enumerable: true, get: () => 8 });
  Object.freeze(parameterAccessor);
  assertSyncRejects(() =>
    validateAgentResourceSelection(Object.freeze({
      resources: valid.resources,
      parameters: parameterAccessor,
    }))
  );
  const parameterNullPrototype = Object.create(null) as Record<string, unknown>;
  parameterNullPrototype.maxSteps = 8;
  Object.freeze(parameterNullPrototype);
  assertSyncRejects(() =>
    validateAgentResourceSelection(Object.freeze({
      resources: valid.resources,
      parameters: parameterNullPrototype,
    }))
  );
  assertSyncRejects(() =>
    validateAgentResourceSelection(Object.freeze({
      resources: valid.resources,
      parameters: Object.freeze({}),
    }))
  );
});
