import { createWorkerComposition, type ToolComponent } from '../../v0/agent/worker_agent_api.ts';
import type { Model } from '../../v0/agent/core/contracts.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};

const probeModel: Model = { generate: () => ({ kind: 'final', text: 'probe' }) };

Deno.test('Worker composition materializes and dispatches a selected tool', async () => {
  let materializations = 0;
  const component: ToolComponent = {
    identity: createAgentResourceIdentity('tool:custom_fetch'),
    materialize: () => {
      materializations += 1;
      return {
        name: 'custom_fetch',
        description: 'custom fetch',
        inputSchema: { type: 'object' },
        execute: () => 'custom fetch result',
      };
    },
  };
  const composition = createWorkerComposition({
    workspace: { root: '/increment-70' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: {
      createModel: () => probeModel,
    },
    toolComponents: [component],
    asyncAgentNames: [],
  }, { roleInstruction: 'Use custom_fetch when asked.' });

  assertEquals(materializations, 1);
  assert(composition.registry.definitions().some((tool) => tool.name === 'custom_fetch'));
  assert(composition.manifest.resources.includes('tool:custom_fetch'));
  assert(composition.resolved.capabilities.tools.map(String).includes('tool:custom_fetch'));
  const result = await composition.registry.dispatch({
    callId: 'custom-fetch',
    name: 'custom_fetch',
    arguments: {},
  });
  assertEquals(result.content.text, 'custom fetch result');
});

const assertEquals = (left: unknown, right: unknown): void => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
};
