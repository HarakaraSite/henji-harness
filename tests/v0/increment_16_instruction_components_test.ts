import type { Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { SkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { bundledAgentConfiguration } from '../../v0/agent/configuration/agent_configuration.ts';
import { resolveCommonInstructionComposition } from '../../v0/agent/instructions/compose.ts';
import {
  finalizeWorkerInstructionComposition,
  finalSystemInstructionForContribution,
} from '../../v0/agent/instructions/worker_core_finalizer.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import type { OpenAIModelSelection } from '../../v0/agent/provider/model_selection.ts';
import { encodeRequest } from '../../v0/agent/provider/openrouter_request.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import {
  createWorkerComposition,
  type PhysicalIoBindings,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import { createWebSearchTool, type WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';

const bundledToolComponents = (
  physicalIo: PhysicalIoBindings,
): readonly ToolComponent[] => [
  {
    identity: createAgentResourceIdentity('tool:bash'),
    materialize: (bindings) =>
      createBashTool(
        bindings.workspace,
        bindings.processExecutor!,
        bindings.bashOutputStore,
        bindings.workTools.bash ?? {},
      ),
  },
  {
    identity: createAgentResourceIdentity('tool:bash_output'),
    materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
  },
  {
    identity: createAgentResourceIdentity('tool:edit'),
    materialize: (bindings) => createEditTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: (bindings) => createReadTool(bindings.workspace),
  },
  {
    identity: createAgentResourceIdentity('tool:write'),
    materialize: (bindings) => createWriteTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:web_search'),
    materialize: (bindings) =>
      createWebSearchTool(
        bindings.webSearchBackend ?? physicalIo.webSearchBackend!,
      ),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
];

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(left + ' !== ' + right);
};

const providerFreeWebSearchBackend: WebSearchBackend = {
  search: ({ query }) => ({
    results: [{
      title: 'fixture',
      url: 'provider-free://increment-16',
      highlights: ['result for ' + query],
    }],
  }),
};

const finalModel = (): Model => ({
  generate: () => ({ kind: 'final', text: 'done' }),
});

const openAiDefaultSelection = defaultModelSelectionFor('openai-responses');

Deno.test('Increment 16 composes JSON Agent and common instructions in canonical order', () => {
  const roleInstruction = bundledAgentConfiguration().configuration.instruction;
  const composition = resolveCommonInstructionComposition({
    workspaceRoot: '/work/increment-16',
    roleInstruction,
    toolGuidelines: [{
      tool: 'read',
      text: 'Prefer read for workspace files.',
    }],
    workspaceInstruction: 'WORKSPACE INSTRUCTION',
    skillManifest: 'SKILL MANIFEST',
  });
  assertEquals(
    composition.components.map((component) => String(component.identity)),
    [
      'instruction:agent-role',
      'instruction:active-tool-guidelines',
      'instruction:workspace-agents',
      'instruction:project-skill-manifest',
      'instruction:runtime-facts',
    ],
  );
  const positions = [
    roleInstruction,
    '## Active tool guidelines',
    'WORKSPACE INSTRUCTION',
    'SKILL MANIFEST',
    '## Runtime facts',
    'Current working directory: /work/increment-16',
  ].map((text) => composition.systemInstruction.indexOf(text));
  assert(positions.every((position) => position >= 0));
  assert(
    positions.every((position, index) => index === 0 || positions[index - 1] < position),
  );
  const finalizedInstruction = finalSystemInstructionForContribution(
    composition.systemInstruction,
  );
  for (
    const builtinCore of [
      'You are Henji',
      'Do not use tools to read or source credential configuration',
      'explicitly asks to use that real instance or authenticated client',
      'do not display credential values',
    ]
  ) {
    assert(finalizedInstruction.includes(builtinCore));
  }
  for (
    const externalDetail of [
      'read the designated current sources directly',
      'reuse successful tool results already present in the conversation',
      'Before changing implementation',
      'Prefer the smallest change that satisfies the request.',
    ]
  ) {
    assert(!finalizedInstruction.includes(externalDetail));
  }
  for (
    const staleFact of [
      'provider:openai-responses',
      'model:gpt',
      'effort:high',
      'session:',
      '2026-',
    ]
  ) {
    assert(!composition.systemInstruction.includes(staleFact));
  }
});

Deno.test('Increment 16 composes JSON Agent roles, active tools, and manifest identities', () => {
  const skillCatalog: SkillCatalog = Object.freeze({
    manifest: 'PROJECT SKILL MANIFEST',
    skills: Object.freeze([Object.freeze({
      name: 'fixture-skill',
      description: 'Fixture skill.',
      sourceDirectory: '.agents/skills/fixture-skill',
      body: 'Fixture body.',
      toolResult: 'Fixture body.',
    })]),
  });
  const physicalIo = {
    createModel: finalModel,
    webSearchBackend: providerFreeWebSearchBackend,
  };
  const input = {
    workspace: { root: '/work/increment-16' },
    agentInstructions: 'WORKSPACE INSTRUCTION',
    skillCatalog,
    physicalIo,
    toolComponents: bundledToolComponents(physicalIo),
    asyncAgentNames: [],
  };
  const defaultRoleInstruction = bundledAgentConfiguration().configuration.instruction;
  const root = finalizeWorkerInstructionComposition(
    createWorkerComposition(input, { roleInstruction: defaultRoleInstruction }),
  );
  const reviewerRoleInstruction = 'Review the requested work.';
  const reviewer = finalizeWorkerInstructionComposition(
    createWorkerComposition({
      ...input,
      toolComponents: input.toolComponents.filter((component) =>
        String(component.identity) === 'tool:read'
      ),
    }, { roleInstruction: reviewerRoleInstruction }),
  );

  assert(root.systemInstruction?.includes(defaultRoleInstruction));
  assert(reviewer.systemInstruction?.includes(reviewerRoleInstruction));
  assert(!reviewer.systemInstruction?.includes(defaultRoleInstruction));
  assert(root.systemInstruction?.includes('- bash_output:'));
  assert(
    root.systemInstruction?.includes(
      '- bash: Each bash call starts in the current workspace directory shown in Runtime facts',
    ),
  );
  assert(root.systemInstruction?.includes('- web_search:'));
  assert(!reviewer.systemInstruction?.includes('- bash:'));
  assert(!reviewer.systemInstruction?.includes('- bash_output:'));
  assert(!reviewer.systemInstruction?.includes('- web_search:'));
  assert(reviewer.systemInstruction?.includes('- read:'));
  for (const composition of [root, reviewer]) {
    assert(
      composition.systemInstruction?.includes(
        'Do not use tools to read or source credential configuration',
      ),
    );
    assert(
      !composition.systemInstruction?.includes(
        'reuse successful tool results already present in the conversation',
      ),
    );
  }

  for (const manifest of [root.manifest, reviewer.manifest]) {
    assert(manifest.resources.includes('instruction:henji-base'));
    assert(manifest.resources.includes('instruction:active-tool-guidelines'));
    assert(manifest.resources.includes('instruction:workspace-agents'));
    assert(manifest.resources.includes('instruction:project-skill-manifest'));
    assert(manifest.resources.includes('instruction:runtime-facts'));
  }
  for (const composition of [root, reviewer]) {
    assertEquals(
      composition.manifest.resources,
      composition.resolved.resourceSelection.resources.map(String).sort(),
    );
  }
  assert(root.manifest.resources.includes('instruction:agent-role'));
  assert(reviewer.manifest.resources.includes('instruction:agent-role'));
  assertEquals(
    root.instructionComponents?.find((component) =>
      component.identity === createAgentResourceIdentity('instruction:agent-role')
    )?.text,
    defaultRoleInstruction,
  );
  assertEquals(
    reviewer.instructionComponents?.find((component) =>
      component.identity === createAgentResourceIdentity('instruction:agent-role')
    )?.text,
    reviewerRoleInstruction,
  );
});

const openAICompletedStream = (text: string): string => {
  const response = {
    id: 'resp_increment_16',
    object: 'response',
    created_at: 1_788_800_000,
    status: 'completed',
    model: openAiDefaultSelection.modelId,
    output: [{
      id: 'msg_increment_16',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
  };
  return 'data: ' + JSON.stringify({ type: 'response.completed', response }) +
    '\n\n';
};

Deno.test('Increment 16 maps one semantic instruction to both provider wire contracts', async () => {
  const resolved = finalSystemInstructionForContribution(
    resolveCommonInstructionComposition({
      workspaceRoot: '/work/provider-wire',
      roleInstruction: bundledAgentConfiguration().configuration.instruction,
      toolGuidelines: [{ tool: 'read', text: 'Read files.' }],
    }).systemInstruction,
  );
  const request: ModelRequest = {
    systemInstruction: resolved,
    transcript: [{ role: 'user', content: { kind: 'text', text: 'Hello.' } }],
    tools: [],
  };
  const openRouter = encodeRequest(request);
  assertEquals(openRouter.messages[0], { role: 'system', content: resolved });

  let openAIBody: Record<string, unknown> | undefined;
  const model = new OpenAIResponsesModel({
    selection: openAiDefaultSelection as OpenAIModelSelection,
    credentialSource: () => Promise.resolve('fixture-secret'),
    fetcher: async (input, init) => {
      const wireRequest = input instanceof Request ? input : new Request(input, init);
      openAIBody = JSON.parse(await wireRequest.clone().text());
      return new Response(openAICompletedStream('done'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const result = await model.generate(request);
  assertEquals(result.kind, 'final');
  assertEquals(openAIBody?.instructions, resolved);
});
