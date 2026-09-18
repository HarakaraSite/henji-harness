import type { Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import { emptySkillCatalog, type SkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { resolveBuiltinInstructionComposition } from '../../v0/agent/instructions/compose.ts';
import {
  finalizeWorkerInstructionComposition,
  finalSystemInstructionForContribution,
} from '../../v0/agent/instructions/worker_core_finalizer.ts';
import { DEFAULT_ROLE_INSTRUCTION } from '../../v0/agent/instructions/roles/default.ts';
import { PLANNER_AGENT_INSTRUCTION } from '../../v0/agent/instructions/roles/planner.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import { OPENAI_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openai_model_catalog.ts';
import { encodeRequest } from '../../v0/agent/provider/openrouter_request.ts';
import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  createPlannerAgentComposition,
  type PhysicalIoBindings,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import { createRuntimeComposition } from '../../v0/agent/runtime/runtime.ts';
import { createWebSearchTool, type WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';

const bundledToolComponents = (physicalIo: PhysicalIoBindings): readonly ToolComponent[] => [
  {
    identity: createAgentResourceIdentity('tool:bash'),
    materialize: (bindings) =>
      createBashTool(bindings.workspace, bindings.bashOutputStore, bindings.workTools.bash ?? {}),
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
  search: (query) => ({
    answer: 'result for ' + query,
    sources: [{ title: 'fixture', url: 'provider-free://increment-16' }],
  }),
};

const finalModel = (): Model => ({
  generate: () => ({ kind: 'final', text: 'done' }),
});

const noInstructionFileSystem = {
  lstat: () => Promise.reject(new Deno.errors.NotFound()),
  open: () => Promise.reject(new Deno.errors.NotFound()),
};

const noSkillFileSystem = {
  lstat: () => Promise.reject(new Deno.errors.NotFound()),
  async *readDirectory(): AsyncIterable<string> {},
  open: () => Promise.reject(new Deno.errors.NotFound()),
};

Deno.test('Increment 16 composes the Definition contribution in the canonical order', () => {
  const composition = resolveBuiltinInstructionComposition({
    role: 'default',
    workspaceRoot: '/work/increment-16',
    toolGuidelines: [{ tool: 'read', text: 'Prefer read for workspace files.' }],
    workspaceInstruction: 'WORKSPACE INSTRUCTION',
    skillManifest: 'SKILL MANIFEST',
  });
  assertEquals(composition.components.map((component) => String(component.identity)), [
    'instruction:builtin-default-role',
    'instruction:active-tool-guidelines',
    'instruction:workspace-agents',
    'instruction:project-skill-manifest',
    'instruction:runtime-facts',
  ]);
  const positions = [
    DEFAULT_ROLE_INSTRUCTION,
    '## Active tool guidelines',
    'WORKSPACE INSTRUCTION',
    'SKILL MANIFEST',
    '## Runtime facts',
    'Current working directory: /work/increment-16',
  ].map((text) => composition.systemInstruction.indexOf(text));
  assert(positions.every((position) => position >= 0));
  assert(positions.every((position, index) => index === 0 || positions[index - 1] < position));
  const finalizedInstruction = finalSystemInstructionForContribution(composition.systemInstruction);
  for (
    const sourceGroundedBehavior of [
      'read the designated current sources directly',
      'When summarizing',
      'compare the result with the sources',
      'Do not modify unrelated tracked files',
      'distinguish assumptions and unverified sources',
      'reuse successful tool results already present in the conversation',
      'the previous result was truncated or indicated a continuation',
      'request only the missing non-overlapping range',
      'make each query address that specific information need',
      'stop investigating and answer',
      'Identify source conflicts and unverified matters',
      'Do not use tools to read or source credential configuration',
      'explicitly asks to use that real instance or authenticated client',
      'inspect, research, explain, or summarize a repository, source code, documentation, API, product, or service',
      'does not by itself authorize reading or sourcing credential configuration',
      'do not display credential values',
    ]
  ) {
    assert(finalizedInstruction.includes(sourceGroundedBehavior));
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

Deno.test('Increment 16 isolates default/planner roles, active tools, and manifest identities', () => {
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
    toolDefinitions: bundledToolComponents(physicalIo),
  };
  const root = finalizeWorkerInstructionComposition(createDefaultAgentComposition(input));
  const planner = finalizeWorkerInstructionComposition(createPlannerAgentComposition(input));

  assert(root.systemInstruction?.includes(DEFAULT_ROLE_INSTRUCTION));
  assert(!root.systemInstruction?.includes(PLANNER_AGENT_INSTRUCTION));
  assert(planner.systemInstruction?.includes(PLANNER_AGENT_INSTRUCTION));
  assert(!planner.systemInstruction?.includes(DEFAULT_ROLE_INSTRUCTION));
  assert(root.systemInstruction?.includes('- bash_output:'));
  assert(
    root.systemInstruction?.includes(
      '- bash: Each bash call starts in the current workspace directory shown in Runtime facts',
    ),
  );
  assert(root.systemInstruction?.includes('- web_search:'));
  assert(!planner.systemInstruction?.includes('- bash:'));
  assert(!planner.systemInstruction?.includes('- bash_output:'));
  assert(!planner.systemInstruction?.includes('- web_search:'));
  assert(planner.systemInstruction?.includes('- read:'));
  for (const composition of [root, planner]) {
    assert(
      composition.systemInstruction?.includes(
        'reuse successful tool results already present in the conversation',
      ),
    );
    assert(composition.systemInstruction?.includes('stop investigating and answer'));
    assert(
      composition.systemInstruction?.includes(
        'Do not use tools to read or source credential configuration',
      ),
    );
  }

  for (const manifest of [root.manifest, planner.manifest]) {
    assert(manifest.resources.includes('instruction:henji-base'));
    assert(manifest.resources.includes('instruction:active-tool-guidelines'));
    assert(manifest.resources.includes('instruction:workspace-agents'));
    assert(manifest.resources.includes('instruction:project-skill-manifest'));
    assert(manifest.resources.includes('instruction:runtime-facts'));
  }
  assert(root.manifest.resources.includes('instruction:builtin-default-role'));
  assert(!root.manifest.resources.includes('instruction:builtin-planner-policy'));
  assert(planner.manifest.resources.includes('instruction:builtin-planner-policy'));
  assert(!planner.manifest.resources.includes('instruction:builtin-default-role'));
});

Deno.test('Increment 16 gives Worker and direct built-in runtimes the same resolved instruction', async () => {
  const workspace = { root: '/work/increment-16-parity' };
  const workerPhysicalIo = {
    createModel: finalModel,
    webSearchBackend: providerFreeWebSearchBackend,
  };
  const worker = finalizeWorkerInstructionComposition(
    createDefaultAgentComposition({
      workspace,
      skillCatalog: emptySkillCatalog(),
      physicalIo: workerPhysicalIo,
      toolDefinitions: bundledToolComponents(workerPhysicalIo),
    }),
  );
  const direct = await createRuntimeComposition({
    workspace,
    instructionFileSystem: noInstructionFileSystem,
    skillFileSystem: noSkillFileSystem,
    webSearchBackend: providerFreeWebSearchBackend,
  });
  assertEquals(direct.systemInstruction, worker.systemInstruction);
  assert(
    direct.systemInstruction?.includes('Current working directory: /work/increment-16-parity'),
  );
});

const openAICompletedStream = (text: string): string => {
  const response = {
    id: 'resp_increment_16',
    object: 'response',
    created_at: 1_788_800_000,
    status: 'completed',
    model: OPENAI_DEFAULT_MODEL_SELECTION.modelId,
    output: [{
      id: 'msg_increment_16',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
  };
  return 'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n';
};

Deno.test('Increment 16 maps one semantic instruction to both provider wire contracts', async () => {
  const resolved = finalSystemInstructionForContribution(
    resolveBuiltinInstructionComposition({
      role: 'default',
      workspaceRoot: '/work/provider-wire',
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
    selection: OPENAI_DEFAULT_MODEL_SELECTION,
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
