import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  AgentResolvedManifestError,
  createAgentResolvedManifest,
  RESOLVED_MANIFEST_DOMAIN,
  resolvedManifestPayload,
  validateAgentResolvedManifest,
} from '../../v0/agent/resolved_manifest.ts';
import {
  compareAgentResourceIdentities,
  createAgentResourceIdentity,
  createAgentResourceSelection,
  validateResolvedAgentResources,
} from '../../v0/agent/resource_identity.ts';
import { defaultAgentDefinition, plannerAgentDefinition } from '../../v0/agent/agent_definition.ts';
import {
  discoverSkills,
  type SkillCatalog,
  type SkillFileHandle,
  type SkillFileSystem,
  type SkillPathInfo,
} from '../../v0/agent/skills.ts';
import type { AgentManifestDefinitionId } from '../../v0/agent/agent_identity.ts';

const DEFAULT_RESOURCES = [
  'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
  'tool:bash',
  'tool:delegate_to_planner',
  'tool:edit',
  'tool:read',
  'tool:submit_json_result',
  'tool:write',
  'subagent:planner',
] as const;
const PLANNER_RESOURCES = [
  'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0',
  'instruction:builtin-planner-policy',
  'tool:read',
  'tool:submit_json_result',
] as const;
const VARIANT_RESOURCES = DEFAULT_RESOURCES;
const selection = (resources: readonly string[]) => createAgentResourceSelection(resources, 8);
const canonical = (resources: readonly string[]): string[] =>
  resources.map((resource) => createAgentResourceIdentity(resource)).sort(
    compareAgentResourceIdentities,
  ).map((resource) => `${resource}`);
const rehashed = async (
  definitionId: AgentManifestDefinitionId,
  resources: readonly string[],
  maxSteps = 8,
): Promise<Record<string, unknown>> => {
  const payload = {
    schemaVersion: 1,
    definitionId,
    resources: canonical(resources),
    parameters: { maxSteps },
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${RESOLVED_MANIFEST_DOMAIN}${JSON.stringify(payload)}`),
  );
  const identity = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    ...payload,
    identity: `henji-agent-resolved-manifest:v1:sha256:${identity}`,
  };
};
const discoveredCatalog = async (
  root: string,
  order: readonly string[],
  marker: string,
): Promise<SkillCatalog> => {
  const location = `${root}/.zot/skills`;
  const directory: SkillPathInfo = { isFile: false, isDirectory: true, isSymlink: false };
  const file: SkillPathInfo = { isFile: true, isDirectory: false, isSymlink: false };
  const files = new Map<string, Uint8Array>();
  for (const name of order) {
    files.set(
      `${location}/${name}/SKILL.md`,
      new TextEncoder().encode(`---\ndescription: ${marker}-${name}\n---\n${marker}-${name}-BODY`),
    );
  }
  const fileSystem: SkillFileSystem = {
    lstat(path) {
      if (path === location || order.some((name) => path === `${location}/${name}`)) {
        return Promise.resolve(directory);
      }
      if (files.has(path)) return Promise.resolve(file);
      return Promise.reject(new Deno.errors.NotFound());
    },
    async *readDirectory(path) {
      if (path !== location) throw new Deno.errors.NotFound();
      for (const name of order) yield name;
    },
    open(path): Promise<SkillFileHandle> {
      const bytes = files.get(path);
      if (bytes === undefined) return Promise.reject(new Deno.errors.NotFound());
      let offset = 0;
      return Promise.resolve({
        read(buffer) {
          if (offset === bytes.byteLength) return Promise.resolve(null);
          const count = Math.min(buffer.byteLength, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + count));
          offset += count;
          return Promise.resolve(count);
        },
        stat: () => Promise.resolve(file),
        close() {},
      });
    },
  };
  return await discoverSkills(root, fileSystem);
};
const assertInvalid = async (value: unknown): Promise<void> => {
  try {
    await validateAgentResolvedManifest(value);
  } catch (error) {
    assert(error instanceof AgentResolvedManifestError);
    assertEquals(error.name, 'AgentResolvedManifestError');
    assertEquals(error.message, 'invalid agent resolved manifest');
    return;
  }
  assert(false, 'expected manifest rejection');
};

Deno.test('resolved manifest matches all six schema-v1 known answers', async () => {
  const answers = [
    {
      id: 'default-max-steps-4' as const,
      resources: VARIANT_RESOURCES,
      maxSteps: 4,
      payload:
        '{"schemaVersion":1,"definitionId":"default-max-steps-4","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":4}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389',
    },
    {
      id: 'default-max-steps-4' as const,
      resources: [
        VARIANT_RESOURCES[0],
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
      ],
      maxSteps: 4,
      payload:
        '{"schemaVersion":1,"definitionId":"default-max-steps-4","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:skill","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":4}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:26c9197ad70e1f2b89cc574f7da67d2bb9d1c78b3d80879450518fb3e5ab54e0',
    },
    {
      id: 'default' as const,
      resources: DEFAULT_RESOURCES,
      payload:
        '{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58',
    },
    {
      id: 'default' as const,
      resources: [
        DEFAULT_RESOURCES[0],
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
      ],
      payload:
        '{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:skill","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:7b45d146eecac2dd0f1126889f5d0728b64535e1294ad68556b42d1825545505',
    },
    {
      id: 'planner' as const,
      resources: PLANNER_RESOURCES,
      payload:
        '{"schemaVersion":1,"definitionId":"planner","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:builtin-planner-policy","tool:read","tool:submit_json_result"],"parameters":{"maxSteps":8}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:fc23e5faaddf628f2d30adee4793c196db3e9b5cfc5714629193fbc6c3bd30eb',
    },
    {
      id: 'planner' as const,
      resources: [
        PLANNER_RESOURCES[0],
        'instruction:builtin-planner-policy',
        'instruction:project-skill-manifest',
        'instruction:workspace-agents',
        'skill:format',
        'skill:review',
        'tool:read',
        'tool:skill',
        'tool:submit_json_result',
      ],
      payload:
        '{"schemaVersion":1,"definitionId":"planner","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:builtin-planner-policy","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:read","tool:skill","tool:submit_json_result"],"parameters":{"maxSteps":8}}',
      identity:
        'henji-agent-resolved-manifest:v1:sha256:6974dafb9c9ea74c7bfc93046d5920cc829c5d7d6c75629d51e885d3b75ecc5a',
    },
  ];
  for (const answer of answers) {
    const manifest = await createAgentResolvedManifest(
      answer.id,
      createAgentResourceSelection(answer.resources, answer.maxSteps ?? 8),
    );
    assertEquals(
      new TextDecoder().decode(resolvedManifestPayload(manifest)),
      answer.payload,
    );
    assertEquals(manifest.identity, answer.identity);
    assertEquals(
      JSON.stringify(
        await validateAgentResolvedManifest(
          JSON.parse(JSON.stringify(manifest)),
        ),
      ),
      JSON.stringify(manifest),
    );
    assert(Object.isFrozen(manifest));
    assert(Object.isFrozen(manifest.resources));
    assert(Object.isFrozen(manifest.parameters));
  }
});

Deno.test('manifest is path/content/profile independent and identity excludes its field', async () => {
  const first = await createAgentResolvedManifest(
    'default',
    selection(DEFAULT_RESOURCES),
  );
  const second = await createAgentResolvedManifest(
    'default',
    selection([...DEFAULT_RESOURCES]),
  );
  assertEquals(first.identity, second.identity);
  assertEquals(
    new TextDecoder().decode(resolvedManifestPayload(first)),
    new TextDecoder().decode(resolvedManifestPayload(second)),
  );
  assert(
    !new TextDecoder().decode(resolvedManifestPayload(first)).includes(
      'identity',
    ),
  );
  assert(RESOLVED_MANIFEST_DOMAIN.endsWith('\n'));
  const changed = await createAgentResolvedManifest(
    'default',
    createAgentResourceSelection(DEFAULT_RESOURCES, 7),
  );
  assert(changed.identity !== first.identity);
  assert(
    changed.identity.startsWith(`${RESOLVED_MANIFEST_DOMAIN.trim()}:sha256:`),
  );
});

Deno.test('manifest validator rejects strict shape and encoding mutations', async () => {
  const valid = await createAgentResolvedManifest(
    'default',
    selection(DEFAULT_RESOURCES),
  );
  const base = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  const mutations: unknown[] = [
    { ...base, unknown: true },
    {
      schemaVersion: 1,
      definitionId: 'default',
      parameters: base.parameters,
      resources: base.resources,
      identity: base.identity,
    },
    { ...base, schemaVersion: 2 },
    { ...base, definitionId: 'unknown' },
    { ...base, identity: 'henji-agent-resolved-manifest:v1:sha256:ABC' },
    { ...base, resources: [...(base.resources as string[]), 'tool:read'] },
    { ...base, resources: (base.resources as string[]).slice(1) },
    { ...base, resources: [...(base.resources as string[])].reverse() },
    { ...base, parameters: { maxSteps: 0 } },
    { ...base, parameters: { maxSteps: '8' } },
  ];
  for (const mutation of mutations) await assertInvalid(mutation);

  const symbols = { ...base, [Symbol('extra')]: true };
  await assertInvalid(symbols);
  const accessor = { ...base };
  Object.defineProperty(accessor, 'identity', {
    enumerable: true,
    get: () => base.identity,
  });
  await assertInvalid(accessor);
  const nonEnumerable = { ...base };
  Object.defineProperty(nonEnumerable, 'identity', {
    enumerable: false,
    value: base.identity,
  });
  await assertInvalid(nonEnumerable);
  const nullPrototype = Object.assign(Object.create(null), base);
  await assertInvalid(nullPrototype);
  const customPrototype = Object.assign(Object.create({}), base);
  await assertInvalid(customPrototype);
  const sparse = [...(base.resources as string[])];
  delete sparse[1];
  await assertInvalid({ ...base, resources: sparse });
  const extraArrayProperty = [...(base.resources as string[])] as string[] & {
    extra?: boolean;
  };
  extraArrayProperty.extra = true;
  await assertInvalid({ ...base, resources: extraArrayProperty });
  class ResourceArray extends Array<string> {}
  await assertInvalid({
    ...base,
    resources: new ResourceArray(...(base.resources as string[])),
  });
});

Deno.test('manifest validator rejects every extra or missing known-topology resource', async () => {
  const cases: readonly {
    readonly id: 'default' | 'planner';
    readonly resources: readonly string[];
    readonly extra: readonly string[];
  }[] = [
    { id: 'default', resources: DEFAULT_RESOURCES, extra: ['instruction:unexpected'] },
    { id: 'default', resources: DEFAULT_RESOURCES, extra: ['tool:unexpected'] },
    { id: 'default', resources: DEFAULT_RESOURCES, extra: ['subagent:unexpected'] },
    { id: 'default', resources: DEFAULT_RESOURCES.slice(0, -1), extra: [] },
    { id: 'planner', resources: PLANNER_RESOURCES, extra: ['instruction:unexpected'] },
    { id: 'planner', resources: PLANNER_RESOURCES, extra: ['tool:unexpected'] },
    { id: 'planner', resources: PLANNER_RESOURCES, extra: ['subagent:unexpected'] },
    { id: 'planner', resources: PLANNER_RESOURCES.slice(0, -1), extra: [] },
  ];
  for (const testCase of cases) {
    const input = await rehashed(testCase.id, [...testCase.resources, ...testCase.extra]);
    await assertInvalid(input);
  }
});

Deno.test('manifest snapshots before async digest and does not alias caller data', async () => {
  const valid = await createAgentResolvedManifest('default', selection(DEFAULT_RESOURCES));
  const input = JSON.parse(JSON.stringify(valid)) as {
    resources: string[];
    parameters: { maxSteps: number };
    identity: string;
  };
  const originalResources = [...input.resources];
  const originalIdentity = input.identity;
  const pending = validateAgentResolvedManifest(input);
  input.resources[0] = 'model:openrouter:mutated-after-call';
  input.resources = ['tool:late-replacement'];
  input.parameters.maxSteps = 1;
  input.identity =
    'henji-agent-resolved-manifest:v1:sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const result = await pending;
  assertEquals(result.resources.map((resource) => `${resource}`), originalResources);
  assertEquals(result.parameters.maxSteps, 8);
  assertEquals(result.identity, originalIdentity);
  assert((result.resources as unknown) !== input.resources);
  assert((result.parameters as unknown) !== input.parameters);
});

Deno.test('real Definition selections remain invariant while non-resource markers vary', async () => {
  const firstSkills = await discoveredCatalog('/first/discovery', ['review', 'format'], 'FIRST');
  const secondSkills = await discoveredCatalog('/second/discovery', ['format', 'review'], 'SECOND');
  assertEquals(firstSkills.skills.map((skill) => skill.name), ['format', 'review']);
  assertEquals(secondSkills.skills.map((skill) => skill.name), ['format', 'review']);
  const first = defaultAgentDefinition({
    workspace: { root: '/first/workspace' },
    agentInstructions: 'FIRST-INSTRUCTIONS',
    skillCatalog: firstSkills,
  });
  const secondBase = defaultAgentDefinition({
    workspace: { root: '/second/workspace' },
    agentInstructions: 'SECOND-INSTRUCTIONS',
    skillCatalog: secondSkills,
  });
  const second = {
    ...secondBase,
    model: {
      ...secondBase.model,
      profile: { ...secondBase.model.profile, origin: 'SECOND-PROFILE-ORIGIN' },
    },
  };
  const firstManifest = await createAgentResolvedManifest(
    'default',
    validateResolvedAgentResources(first),
  );
  const secondManifest = await createAgentResolvedManifest(
    'default',
    validateResolvedAgentResources(second),
  );
  assertEquals(resolvedManifestPayload(firstManifest), resolvedManifestPayload(secondManifest));
  assertEquals(firstManifest.identity, secondManifest.identity);
  const serialized = JSON.stringify(secondManifest);
  for (
    const marker of [
      '/first/',
      '/second/',
      'FIRST-',
      'SECOND-',
      'PROFILE-ORIGIN',
    ]
  ) assert(!serialized.includes(marker), marker);

  const plannerFirst = plannerAgentDefinition({
    workspace: { root: '/planner-first' },
    agentInstructions: 'PLANNER-FIRST-INSTRUCTIONS',
    skillCatalog: firstSkills,
  });
  const plannerSecond = plannerAgentDefinition({
    workspace: { root: '/planner-second' },
    agentInstructions: 'PLANNER-SECOND-INSTRUCTIONS',
    skillCatalog: secondSkills,
  });
  const plannerFirstManifest = await createAgentResolvedManifest(
    'planner',
    validateResolvedAgentResources(plannerFirst),
  );
  const plannerSecondManifest = await createAgentResolvedManifest(
    'planner',
    validateResolvedAgentResources(plannerSecond),
  );
  assertEquals(
    resolvedManifestPayload(plannerFirstManifest),
    resolvedManifestPayload(plannerSecondManifest),
  );
  assertEquals(plannerFirstManifest.identity, plannerSecondManifest.identity);
});

Deno.test('one-resource differences change payload identity before invalid topology rejection', async () => {
  const base = await createAgentResolvedManifest('default', selection(DEFAULT_RESOURCES));
  const validDifferences = [
    ['model', [...DEFAULT_RESOURCES.slice(1), 'model:openrouter:alternate-model']],
    ['instruction', [...DEFAULT_RESOURCES, 'instruction:workspace-agents']],
    ['maxSteps', [...DEFAULT_RESOURCES]],
  ] as const;
  for (const [name, resources] of validDifferences) {
    const changed = await createAgentResolvedManifest(
      'default',
      selection(name === 'maxSteps' ? resources : canonical(resources)),
    );
    if (name === 'maxSteps') {
      const maxChanged = await createAgentResolvedManifest(
        'default',
        createAgentResourceSelection(DEFAULT_RESOURCES, 9),
      );
      assert(
        new TextDecoder().decode(resolvedManifestPayload(maxChanged)) !==
          new TextDecoder().decode(resolvedManifestPayload(base)),
      );
      assert(maxChanged.identity !== base.identity);
    } else {
      assert(
        new TextDecoder().decode(resolvedManifestPayload(changed)) !==
          new TextDecoder().decode(resolvedManifestPayload(base)),
      );
      assert(changed.identity !== base.identity);
    }
  }
  for (
    const [name, resources] of [
      ['skill', [...DEFAULT_RESOURCES, 'skill:extra']],
      ['tool', [...DEFAULT_RESOURCES, 'tool:extra']],
      ['subagent', [...DEFAULT_RESOURCES, 'subagent:extra']],
    ] as const
  ) {
    const raw = await rehashed('default', resources);
    assert(JSON.stringify(raw).includes(name === 'skill' ? 'skill:extra' : `${name}:extra`));
    assert(JSON.stringify(raw) !== JSON.stringify(base));
    await assertInvalid(raw);
  }
});

Deno.test('correct digest cannot cross-bind default and planner topology', async () => {
  const planner = await createAgentResolvedManifest(
    'planner',
    selection(PLANNER_RESOURCES),
  );
  const defaultBound = {
    ...JSON.parse(JSON.stringify(planner)),
    definitionId: 'default',
  };
  const defaultDigest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${RESOLVED_MANIFEST_DOMAIN}${
      JSON.stringify({
        schemaVersion: 1,
        definitionId: 'default',
        resources: PLANNER_RESOURCES,
        parameters: { maxSteps: 8 },
      })
    }`),
  );
  defaultBound.identity = `henji-agent-resolved-manifest:v1:sha256:${
    [...new Uint8Array(defaultDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }`;
  await assertInvalid(defaultBound);
  const defaultManifest = await createAgentResolvedManifest(
    'default',
    selection(DEFAULT_RESOURCES),
  );
  const plannerBound = {
    ...JSON.parse(JSON.stringify(defaultManifest)),
    definitionId: 'planner',
  };
  await assertInvalid(plannerBound);
});

Deno.test('variant manifest binds default topology and fixed maxSteps four', async () => {
  const valid = await createAgentResolvedManifest(
    'default-max-steps-4',
    createAgentResourceSelection(VARIANT_RESOURCES, 4),
  );
  await assertInvalid(await rehashed('default-max-steps-4', VARIANT_RESOURCES, 8));
  await assertInvalid(
    await rehashed('default-max-steps-4', PLANNER_RESOURCES, 4),
  );
  await assertInvalid(
    await rehashed('default-max-steps-4', [...VARIANT_RESOURCES, 'tool:extra'], 4),
  );
  assertEquals(valid.definitionId, 'default-max-steps-4');
  assertEquals(valid.parameters.maxSteps, 4);
});

Deno.test('validator snapshots caller data and reports one sanitized error', async () => {
  const valid = await createAgentResolvedManifest(
    'default',
    selection(DEFAULT_RESOURCES),
  );
  const input = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  const result = await validateAgentResolvedManifest(input);
  assert((result as unknown) !== input);
  assert((result.resources as unknown) !== input.resources);
  assert((result.parameters as unknown) !== input.parameters);
  await assertRejects(() => validateAgentResolvedManifest({}));
});
