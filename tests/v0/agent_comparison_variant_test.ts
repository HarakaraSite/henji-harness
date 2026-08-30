import { assert, assertEquals } from './test_helpers.ts';
import {
  AgentComparisonVariantError,
  evaluateComparisonVariant,
  evaluateComparisonVariantForTest,
  isComparisonVariantId,
  resolveComparisonVariant,
  validateComparisonVariantCatalog,
  validateComparisonVariantRelationship,
} from '../../v0/agent/comparison_variant.ts';
import { defaultAgentDefinition } from '../../v0/agent/agent_definition.ts';
import { COMPARISON_VARIANT_IDS } from '../../v0/agent/agent_identity.ts';
import {
  type AgentResourceSelection,
  createAgentResourceSelection,
} from '../../v0/agent/resource_identity.ts';
import * as catalogModule from '../../v0/agent/agent_catalog.ts';
import type { SkillCatalog } from '../../v0/agent/skills.ts';

const skills: SkillCatalog = Object.freeze({
  skills: Object.freeze([
    Object.freeze({
      name: 'format',
      description: 'format files',
      sourceDirectory: '/first/.zot/skills/format',
      body: 'FORMAT BODY',
      toolResult: 'FORMAT RESULT',
    }),
    Object.freeze({
      name: 'review',
      description: 'review files',
      sourceDirectory: '/first/.zot/skills/review',
      body: 'REVIEW BODY',
      toolResult: 'REVIEW RESULT',
    }),
  ]),
  manifest: 'Available project skills.',
});

const input = {
  workspace: { root: '/first/workspace' },
  agentInstructions: 'FIRST INSTRUCTIONS',
  skillCatalog: skills,
};

const expectInvalid = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof AgentComparisonVariantError);
    assertEquals(error.name, 'AgentComparisonVariantError');
    assertEquals(error.message, 'invalid agent comparison variant');
    return;
  }
  assert(false, 'expected comparison variant rejection');
};

Deno.test('comparison catalog has one exact frozen internal variant', () => {
  assertEquals(COMPARISON_VARIANT_IDS, ['default-max-steps-4']);
  const entry = resolveComparisonVariant('default-max-steps-4');
  assert(Object.isFrozen(entry));
  assertEquals(entry, {
    id: 'default-max-steps-4',
    parentId: 'default',
    topologyId: 'default',
    changedAxis: 'maxSteps',
    parentMaxSteps: 8,
    variantMaxSteps: 4,
  });
  assert(isComparisonVariantId(entry.id));
  assert(!isComparisonVariantId('default'));
  for (const value of [undefined, '', 'default', 'planner', 'constructor', 'default-max-steps-5']) {
    expectInvalid(() => resolveComparisonVariant(value));
  }
});

Deno.test('public catalog module exports only its built-in selection surface', () => {
  assertEquals(Object.keys(catalogModule).sort(), [
    'AgentSelectionError',
    'BUILTIN_AGENT_IDS',
    'DEFAULT_AGENT_SELECTION',
    'resolveBuiltinAgent',
  ]);
  for (
    const name of [
      'COMPARISON_VARIANT_IDS',
      'resolveComparisonVariant',
      'evaluateComparisonVariant',
      'evaluateComparisonVariantForTest',
      'isComparisonVariantId',
    ]
  ) assert(!(name in catalogModule), name);
});

Deno.test('comparison catalog rejects duplicate, drifted, and unsafe declarations', () => {
  const raw = {
    id: 'default-max-steps-4',
    parentId: 'default',
    changedAxis: 'maxSteps',
    parentMaxSteps: 8,
    variantMaxSteps: 4,
  };
  const mutations: unknown[] = [
    [],
    [raw, raw],
    [{ ...raw, id: 'default-max-steps-5' }],
    [{ ...raw, parentId: 'planner' }],
    [{ ...raw, changedAxis: 'model' }],
    [{ ...raw, parentMaxSteps: 4 }],
    [{ ...raw, variantMaxSteps: 8 }],
    [{ ...raw, extra: true }],
    [{
      id: raw.id,
      parentId: raw.parentId,
      changedAxis: raw.changedAxis,
      parentMaxSteps: raw.parentMaxSteps,
    }],
  ];
  for (const mutation of mutations) expectInvalid(() => validateComparisonVariantCatalog(mutation));
  const symbol = { ...raw, [Symbol('extra')]: true };
  expectInvalid(() => validateComparisonVariantCatalog([symbol]));
  const accessor = { ...raw };
  Object.defineProperty(accessor, 'id', { enumerable: true, get: () => raw.id });
  expectInvalid(() => validateComparisonVariantCatalog([accessor]));
  expectInvalid(() => validateComparisonVariantCatalog([Object.assign(Object.create(null), raw)]));
  const result = validateComparisonVariantCatalog([raw]);
  raw.variantMaxSteps = 9;
  assertEquals(result[0].variantMaxSteps, 4);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result[0]));
});

Deno.test('comparison evaluator evaluates default exactly once for both contexts', async () => {
  const noContextInput = {
    workspace: { root: '/no-context/workspace' },
    skillCatalog: Object.freeze({ skills: Object.freeze([]) }),
  };
  let noContextEvaluations = 0;
  const noContextResult = await evaluateComparisonVariantForTest(
    noContextInput,
    (definitionInput) => {
      noContextEvaluations += 1;
      return defaultAgentDefinition(definitionInput);
    },
  );
  assertEquals(noContextEvaluations, 1);
  assertEquals(noContextResult.variantManifest.definitionId, 'default-max-steps-4');

  let workspaceEvaluations = 0;
  const result = await evaluateComparisonVariantForTest(
    input,
    (definitionInput) => {
      workspaceEvaluations += 1;
      return defaultAgentDefinition(definitionInput);
    },
  );
  assertEquals(workspaceEvaluations, 1);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.entry));
  assert(Object.isFrozen(result.parent));
  assert(Object.isFrozen(result.variant));
  assert(result.parent !== result.variant);
  assert(result.parent.model === result.variant.model);
  assert(result.parent.registry === result.variant.registry);
  assert(result.parent.model.profile === result.variant.model.profile);
  assert(result.parent.registry.workspace === result.variant.registry.workspace);
  assert(result.parent.registry.skillCatalog === result.variant.registry.skillCatalog);
  assert(result.parent.skillCatalog === result.variant.skillCatalog);
  assert(result.parent.agentInstructions === result.variant.agentInstructions);
  assert(result.parent.systemInstruction === result.variant.systemInstruction);
  assert(result.parent.resourceSelection !== result.variant.resourceSelection);
  assert(result.parent.resourceSelection.resources !== result.variant.resourceSelection.resources);
  assert(
    result.parent.resourceSelection.parameters !== result.variant.resourceSelection.parameters,
  );
  assertEquals(result.parent.resourceSelection.parameters.maxSteps, 8);
  assertEquals(result.variant.resourceSelection.parameters.maxSteps, 4);
  assertEquals(
    result.parent.resourceSelection.resources,
    result.variant.resourceSelection.resources,
  );
  validateComparisonVariantRelationship(result.entry, result.parent, result.variant);
  assertEquals(result.parentManifest.definitionId, 'default');
  assertEquals(result.parentManifest.parameters.maxSteps, 8);
  assertEquals(result.variantManifest.definitionId, 'default-max-steps-4');
  assertEquals(result.variantManifest.parameters.maxSteps, 4);
  assertEquals(
    result.variantManifest.identity,
    'henji-agent-resolved-manifest:v1:sha256:26c9197ad70e1f2b89cc574f7da67d2bb9d1c78b3d80879450518fb3e5ab54e0',
  );
});

Deno.test('comparison relationship rejects every non-axis declaration or ownership drift', async () => {
  const result = await evaluateComparisonVariant(input);
  const parent = result.parent;
  const variant = result.variant;
  const mutateVariant = (change: Record<string, unknown>): typeof variant =>
    Object.freeze({ ...variant, ...change }) as typeof variant;
  const mutateEntry = (change: Record<string, unknown>): typeof result.entry =>
    Object.freeze({ ...result.entry, ...change }) as typeof result.entry;
  const mutatedSelection = (resources: readonly string[], maxSteps = 4) =>
    createAgentResourceSelection(resources, maxSteps);
  const exactSelection = (
    resources: readonly string[],
    maxSteps: unknown,
  ): AgentResourceSelection =>
    Object.freeze({
      resources: Object.freeze([...resources]) as unknown as AgentResourceSelection['resources'],
      parameters: Object.freeze({ maxSteps }),
    }) as unknown as AgentResourceSelection;
  const baseResources = variant.resourceSelection.resources.map((resource) => `${resource}`);
  const invalidDelegationRegistry = Object.freeze({
    ...parent.registry,
    plannerDelegation: false,
  });
  const invalidDelegationParent = Object.freeze({
    ...parent,
    registry: invalidDelegationRegistry,
  }) as typeof parent;
  const invalidDelegationVariant = Object.freeze({
    ...variant,
    registry: invalidDelegationRegistry,
  }) as typeof variant;
  const invalidParentMaxSteps = Object.freeze({
    ...parent,
    resourceSelection: exactSelection(baseResources, 7),
  }) as typeof parent;
  const sorted = (resources: string[]): string[] =>
    [...resources].sort((left, right) => {
      const leftKind = left.split(':')[0];
      const rightKind = right.split(':')[0];
      const rank = (
        kind: string,
      ): number => ({ model: 0, instruction: 1, skill: 2, tool: 3, subagent: 4 }[kind] ?? 99);
      return rank(leftKind) - rank(rightKind) || (left < right ? -1 : left > right ? 1 : 0);
    });
  const cases: Array<{
    name: string;
    value: typeof variant;
    parent?: typeof parent;
    entry?: typeof result.entry;
  }> = [
    {
      name: 'model provider',
      value: mutateVariant({ model: Object.freeze({ ...variant.model, provider: 'other' }) }),
    },
    {
      name: 'model profile',
      value: mutateVariant({
        model: Object.freeze({ ...variant.model, profile: { id: 'different' } }),
      }),
    },
    {
      name: 'registry kind',
      value: mutateVariant({ registry: Object.freeze({ ...variant.registry, kind: 'planner' }) }),
    },
    {
      name: 'registry planner delegation',
      parent: invalidDelegationParent,
      value: invalidDelegationVariant,
    },
    {
      name: 'registry workspace',
      value: mutateVariant({
        registry: Object.freeze({ ...variant.registry, workspace: { root: '/other' } }),
      }),
    },
    {
      name: 'registry catalog',
      value: mutateVariant({
        registry: Object.freeze({
          ...variant.registry,
          skillCatalog: Object.freeze({ skills: Object.freeze([]) }),
        }),
      }),
    },
    { name: 'instructions', value: mutateVariant({ agentInstructions: 'different' }) },
    { name: 'system instruction', value: mutateVariant({ systemInstruction: 'different' }) },
    {
      name: 'resource added',
      value: mutateVariant({
        resourceSelection: mutatedSelection(sorted([...baseResources, 'tool:extra'])),
      }),
    },
    {
      name: 'resource removed',
      value: mutateVariant({
        resourceSelection: mutatedSelection(
          baseResources.filter((resource) => resource !== 'tool:write'),
        ),
      }),
    },
    {
      name: 'resource replaced',
      value: mutateVariant({
        resourceSelection: mutatedSelection(
          sorted(
            baseResources.map((resource) => resource === 'tool:write' ? 'tool:other' : resource),
          ),
        ),
      }),
    },
    {
      name: 'resource reordered',
      value: mutateVariant({
        resourceSelection: exactSelection([...baseResources].reverse(), 4),
      }),
    },
    {
      name: 'max steps 5',
      value: mutateVariant({ resourceSelection: mutatedSelection(baseResources, 5) }),
    },
    {
      name: 'parent max steps 7',
      parent: invalidParentMaxSteps,
      value: variant,
    },
    {
      name: 'max steps 3',
      value: mutateVariant({ resourceSelection: exactSelection(baseResources, 3) }),
    },
    {
      name: 'max steps 0',
      value: mutateVariant({ resourceSelection: exactSelection(baseResources, 0) }),
    },
    {
      name: 'max steps negative',
      value: mutateVariant({ resourceSelection: exactSelection(baseResources, -1) }),
    },
    {
      name: 'max steps unsafe integer',
      value: mutateVariant({
        resourceSelection: exactSelection(baseResources, Number.MAX_SAFE_INTEGER + 1),
      }),
    },
    {
      name: 'max steps non-number',
      value: mutateVariant({ resourceSelection: exactSelection(baseResources, '4') }),
    },
    {
      name: 'selection alias',
      value: mutateVariant({ resourceSelection: parent.resourceSelection }),
    },
    {
      name: 'resources alias',
      value: mutateVariant({
        resourceSelection: Object.freeze({
          resources: parent.resourceSelection.resources,
          parameters: Object.freeze({ maxSteps: 4 }),
        }),
      }),
    },
    {
      name: 'parameters alias',
      value: mutateVariant({
        resourceSelection: Object.freeze({
          resources: Object.freeze([...baseResources.map((resource) => resource as string)]),
          parameters: parent.resourceSelection.parameters,
        }),
      }),
    },
    {
      name: 'top-level missing key',
      value: (() => {
        const missing = { ...variant } as Record<string, unknown>;
        delete missing.systemInstruction;
        Object.freeze(missing);
        return missing as unknown as typeof variant;
      })(),
    },
  ];
  for (const testCase of cases) {
    expectInvalid(() =>
      validateComparisonVariantRelationship(
        testCase.entry ?? result.entry,
        testCase.parent ?? parent,
        testCase.value,
      )
    );
  }

  const extra = { ...variant, extra: true };
  Object.freeze(extra);
  expectInvalid(() =>
    validateComparisonVariantRelationship(result.entry, parent, extra as typeof variant)
  );
  const accessor = { ...variant };
  Object.defineProperty(accessor, 'systemInstruction', {
    enumerable: true,
    get: () => variant.systemInstruction,
  });
  Object.freeze(accessor);
  expectInvalid(() =>
    validateComparisonVariantRelationship(result.entry, parent, accessor as typeof variant)
  );
  const symbol = { ...variant, [Symbol('comparison-metadata')]: true };
  Object.freeze(symbol);
  expectInvalid(() =>
    validateComparisonVariantRelationship(result.entry, parent, symbol as typeof variant)
  );
  const nonPlain = Object.assign(Object.create({ inherited: true }), variant);
  Object.freeze(nonPlain);
  expectInvalid(() =>
    validateComparisonVariantRelationship(result.entry, parent, nonPlain as typeof variant)
  );
  expectInvalid(() =>
    validateComparisonVariantRelationship(
      mutateEntry({ variantMaxSteps: 8 }),
      parent,
      variant,
    )
  );
  expectInvalid(() =>
    validateComparisonVariantRelationship(
      mutateEntry({ parentId: 'planner' }),
      parent,
      variant,
    )
  );
  expectInvalid(() =>
    validateComparisonVariantRelationship(
      mutateEntry({ topologyId: 'planner' }),
      parent,
      variant,
    )
  );
  expectInvalid(() =>
    validateComparisonVariantRelationship(
      mutateEntry({ parentMaxSteps: 7 }),
      parent,
      variant,
    )
  );
});

Deno.test('workspace and skill markers do not affect comparison identity or ownership', async () => {
  const first = await evaluateComparisonVariant(input);
  const second = await evaluateComparisonVariant({
    workspace: { root: '/second/workspace' },
    agentInstructions: 'SECOND INSTRUCTIONS',
    skillCatalog: Object.freeze({
      skills: Object.freeze(skills.skills.map((skill) =>
        Object.freeze({
          ...skill,
          sourceDirectory: `/second/${skill.name}`,
          body: `SECOND ${skill.name}`,
          toolResult: `SECOND RESULT ${skill.name}`,
        })
      )),
      manifest: 'Second manifest',
    }),
  });
  assertEquals(first.parentManifest.identity, second.parentManifest.identity);
  assertEquals(first.variantManifest.identity, second.variantManifest.identity);
  assert(first.parent.registry.workspace !== second.parent.registry.workspace);
  assert(first.parent.skillCatalog !== second.parent.skillCatalog);
  assert(
    first.parent.model === second.parent.model ||
      first.parent.model.profile === second.parent.model.profile,
  );
});
