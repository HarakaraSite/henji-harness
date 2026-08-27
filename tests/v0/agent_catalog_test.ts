import { assert, assertEquals } from './test_helpers.ts';
import {
  AgentSelectionError,
  BUILTIN_AGENT_IDS,
  DEFAULT_AGENT_SELECTION,
  resolveBuiltinAgent,
} from '../../v0/agent/agent_catalog.ts';
import { defaultAgentDefinition, plannerAgentDefinition } from '../../v0/agent/agent_definition.ts';

Deno.test('built-in catalog contains exactly frozen default and planner definitions', () => {
  assert(Object.isFrozen(BUILTIN_AGENT_IDS));
  assertEquals(BUILTIN_AGENT_IDS, ['default', 'planner']);
  assert(Object.isFrozen(DEFAULT_AGENT_SELECTION));
  assertEquals(DEFAULT_AGENT_SELECTION.id, 'default');
  assert(DEFAULT_AGENT_SELECTION.definition === defaultAgentDefinition);
  const explicitDefault = resolveBuiltinAgent('default');
  const planner = resolveBuiltinAgent('planner');
  assert(Object.isFrozen(explicitDefault));
  assert(Object.isFrozen(planner));
  assert(explicitDefault.definition === defaultAgentDefinition);
  assert(planner.definition === plannerAgentDefinition);
  assertEquals(explicitDefault.id, 'default');
  assertEquals(planner.id, 'planner');
});

Deno.test('omitted selector resolves default and does no Definition evaluation', () => {
  assert(resolveBuiltinAgent() === DEFAULT_AGENT_SELECTION);
});

Deno.test('catalog accepts only exact case-sensitive ASCII built-in names', () => {
  for (const name of ['Default', 'PLANNER', 'default_', 'planner.', 'planner/', 'planner-name']) {
    let caught: unknown;
    try {
      resolveBuiltinAgent(name);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof AgentSelectionError);
  }
  for (const name of ['', 'unknown', 'constructor', 'toString', 'd'.repeat(33)]) {
    let caught: unknown;
    try {
      resolveBuiltinAgent(name);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof AgentSelectionError);
  }
});

Deno.test('malformed and unknown selectors have one sanitized internal error', () => {
  const errors: Error[] = [];
  for (const name of ['--agent=planner', 'bad name', 'a_b', 'plannerx']) {
    try {
      resolveBuiltinAgent(name);
    } catch (error) {
      assert(error instanceof AgentSelectionError);
      errors.push(error);
    }
  }
  assertEquals(errors.map((error) => error.name), [
    'AgentSelectionError',
    'AgentSelectionError',
    'AgentSelectionError',
    'AgentSelectionError',
  ]);
  assertEquals(errors.map((error) => error.message), [
    'invalid agent selection',
    'invalid agent selection',
    'invalid agent selection',
    'invalid agent selection',
  ]);
});
