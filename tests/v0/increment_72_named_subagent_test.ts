import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  createPlannerAgentComposition,
  createProviderFreeWebSearchBackend,
  type ExecutableAgentDefinition,
  type PhysicalIoBindings,
} from '../../v0/agent/worker_agent_api.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import type { DefinitionRevisionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { subagentDelegationDescription } from '../../v0/agent/tools/planner_delegation.ts';
import { bundledToolComponents } from './bundled_tool_components.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};

const assertEquals = (left: unknown, right: unknown): void => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
};

const researcherRef: DefinitionRevisionRef = {
  schemaVersion: 1,
  resourceKind: 'agent-definition',
  resourceId: 'example/researcher',
  revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
};

Deno.test('Increment 79 keeps planner delegation description valid for external bindings', () => {
  const description = subagentDelegationDescription('planner');
  assertEquals(
    description,
    'Delegate one explicit planning task to the planner subagent for this parent turn. The subagent receives only the task and returns one bounded synchronous result. Call at most once per turn.',
  );
  assert(!description.includes('built-in'));
  assert(!description.includes('cannot mutate'));
});

Deno.test('Increment 72 delegates to a named subagent with per-name admission', async () => {
  const requests: ModelRequest[] = [];
  const physicalIo: PhysicalIoBindings = {
    createModel: () => ({
      generate: (request: ModelRequest) => {
        requests.push(request);
        return { kind: 'final' as const, text: 'researcher result' };
      },
    }),
    webSearchBackend: createProviderFreeWebSearchBackend(),
  };
  const researcher: ExecutableAgentDefinition = (input) => {
    const base = createPlannerAgentComposition(input);
    return { ...base, systemInstruction: 'researcher instruction' };
  };
  const composition = createDefaultAgentComposition({
    workspace: { root: '/increment-72' },
    skillCatalog: emptySkillCatalog(),
    physicalIo,
    subagents: [{ subagentName: 'researcher', ref: researcherRef, definition: researcher }],
    toolDefinitions: bundledToolComponents(physicalIo),
  }, {
    additionalTools: [createAgentResourceIdentity('tool:delegate_to_researcher')],
    additionalSubagents: [createAgentResourceIdentity('subagent:researcher')],
  });

  assert(
    composition.registry.definitions().some((tool) => tool.name === 'delegate_to_researcher'),
  );
  assert(composition.manifest.subagents?.some((s) => s.subagentName === 'researcher'));

  const execution = new ParentTurnExecutionContext(1);
  const first = await composition.registry.dispatch({
    callId: 'call-researcher-1',
    name: 'delegate_to_researcher',
    arguments: { task: 'research something' },
  }, execution);
  const envelope = JSON.parse(String(first.content.text)) as {
    ok: boolean;
    agent: string;
    output: { kind: string; text: string };
  };
  assertEquals(envelope.ok, true);
  assertEquals(envelope.agent, 'researcher');
  assertEquals(envelope.output.text, 'researcher result');
  assert(requests.length >= 1);

  let limitError: unknown;
  try {
    await composition.registry.dispatch({
      callId: 'call-researcher-2',
      name: 'delegate_to_researcher',
      arguments: { task: 'research again' },
    }, execution);
  } catch (error) {
    limitError = error;
  }
  assert(limitError instanceof Error);
  assert((limitError as Error).message.includes('one execution per turn'));

  assert(composition.registry.definitions().some((tool) => tool.name === 'delegate_to_planner'));
});
