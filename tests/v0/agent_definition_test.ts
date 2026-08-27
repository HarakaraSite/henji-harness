import { assert, assertEquals } from './test_helpers.ts';
import { PROFILE } from '../../v0/model.ts';
import {
  type AgentDefinitionInput,
  DEFAULT_AGENT_MAX_STEPS,
  defaultAgentDefinition,
  PLANNER_AGENT_INSTRUCTION,
  plannerAgentDefinition,
} from '../../v0/agent/agent_definition.ts';
import { composeSystemInstruction } from '../../v0/agent/agent_instructions.ts';
import { type SkillCatalog } from '../../v0/agent/skills.ts';

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
  assertEquals(resolved.maxSteps, DEFAULT_AGENT_MAX_STEPS);
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
    manifest: 'Available project skills.',
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
  assertEquals(resolved.maxSteps, 8);
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
