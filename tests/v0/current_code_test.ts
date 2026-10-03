import * as agentCli from '../../v0/agent/cli/fixture_cli.ts';
import type { Message, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { runAgent, runAgentTurn } from '../../v0/agent/core/loop.ts';
import { SteeringOwner } from '../../v0/agent/core/steering.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools/tools.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { PRODUCTION_MAX_COMPLETION_TOKENS } from '../../v0/agent/provider/provider_profile.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { type SessionRecord, validateSessionRecord } from '../../v0/agent/session/session_store.ts';
import {
  MAX_REPLAY_MESSAGE_TEXT_BYTES,
  MAX_REPLAY_PLANNER_RESULT_BYTES,
} from '../../v0/agent/session/replay_value.ts';
import { boundedPresentationText } from '../../v0/presentation/contract.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { displayWorkspaceLabel } from '../../v0/agent/runtime/startup_orientation.ts';
import {
  createWorkerComposition,
  DEFAULT_AGENT_MAX_STEPS,
  finalizeWorkerComposition,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import type { WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { createWebSearchTool } from '../../v0/agent/tools/web_search.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';
import {
  MAX_COMPLETE_MODEL_REQUEST_BYTES,
  MAX_CONVERSATION_TEXT_BYTES,
  MAX_PLANNER_RESULT_ENVELOPE_BYTES,
  MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS,
  MAX_SERIALIZED_MODEL_MESSAGES_BYTES,
} from '../../v0/resource_limits.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const providerFreeWebSearchBackend: WebSearchBackend = {
  search: ({ query }) => ({
    results: [{
      title: 'test source',
      url: 'provider-free://web-search',
      highlights: [`search result for ${query}`],
    }],
  }),
};

/** Component set matching the bundled default parent declaration for direct composition tests. */
const bundledWorkToolComponents = (
  webSearchBackend: WebSearchBackend,
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
    materialize: (bindings) => createWebSearchTool(bindings.webSearchBackend ?? webSearchBackend),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
  {
    identity: createAgentResourceIdentity('tool:submit_json_result'),
    materialize: () => createJsonResultSubmissionTool(),
  },
];

Deno.test('public CLI API exposes only the intended runtime entry points', () => {
  assertEquals(Object.keys(agentCli).sort(), ['main']);
});

Deno.test('agent loop completes plain and terminal-tool turns', async () => {
  const plain = await runAgent(
    'plain',
    { generate: () => ({ kind: 'final', text: 'done' }) },
    new Registry([]),
  );
  assert(plain.ok);
  assertEquals({
    stop: plain.stopReason,
    text: plain.finalText,
    steps: plain.steps,
  }, {
    stop: 'final',
    text: 'done',
    steps: 1,
  });

  let requests = 0;
  const terminal = await runAgent(
    'json',
    {
      generate: () => {
        requests += 1;
        return {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'submit-1',
            name: 'submit_json_result',
            arguments: { json: '{"ok":true}' },
          }],
        };
      },
    },
    new Registry([createJsonResultSubmissionTool()]),
  );
  assert(terminal.ok);
  assertEquals(
    { requests, stop: terminal.stopReason, text: terminal.finalText },
    { requests: 1, stop: 'tool_terminal', text: '{"ok":true}' },
  );
});

Deno.test('agent loop retains one terminal request-count snapshot beyond sixteen requests', async () => {
  let requests = 0;
  let turnCountReads = 0;
  let runtimeCountReads = 0;
  const events: AgentEvent[] = [];
  const outcome = await runAgentTurn(
    'seventeen requests',
    [],
    {
      generate: () => {
        requests += 1;
        if (requests < 17) {
          return {
            kind: 'tool_calls' as const,
            calls: [{
              callId: `continue-${requests}`,
              name: 'continue',
              arguments: {},
            }],
          };
        }
        return { kind: 'final' as const, text: 'done' };
      },
    },
    new Registry([{
      name: 'continue',
      description: 'Continue to the next model step',
      inputSchema: {},
      execute: () => 'continued',
    }]),
    {
      maxSteps: 17,
      eventSink: (event) => events.push(event),
      turnProviderRequestCount: () => {
        turnCountReads += 1;
        return requests;
      },
      runtimeProviderRequestCount: () => {
        runtimeCountReads += 1;
        return requests;
      },
    },
  );
  assert(outcome.ok);
  const terminal = events.at(-1);
  assert(terminal?.kind === 'turn_end');
  assertEquals(
    {
      requests,
      outcomeTurn: outcome.turnProviderRequestCount,
      outcomeRuntime: outcome.runtimeProviderRequestCount,
      eventTurn: terminal.turnProviderRequestCount,
      eventRuntime: terminal.runtimeProviderRequestCount,
      turnCountReads,
      runtimeCountReads,
    },
    {
      requests: 17,
      outcomeTurn: 17,
      outcomeRuntime: 17,
      eventTurn: 17,
      eventRuntime: 17,
      turnCountReads: 1,
      runtimeCountReads: 1,
    },
  );
});

Deno.test('event sink mutation stays isolated from tool input and transcript', async () => {
  let requests = 0;
  let toolInput: unknown;
  let continuedRequest: ModelRequest | undefined;
  const outcome = await runAgentTurn(
    'isolate event delivery',
    [],
    {
      generate: (request) => {
        requests += 1;
        if (requests === 1) {
          return {
            kind: 'tool_calls' as const,
            calls: [{
              callId: 'observe-1',
              name: 'observe',
              arguments: { value: 'original' },
            }],
          };
        }
        continuedRequest = structuredClone(request);
        return { kind: 'final' as const, text: 'done' };
      },
    },
    new Registry([{
      name: 'observe',
      description: 'Observe the supplied value',
      inputSchema: {},
      execute: (argumentsValue) => {
        toolInput = structuredClone(argumentsValue);
        return 'original result';
      },
    }]),
    {
      eventSink: (event) => {
        if (event.kind === 'assistant_message') {
          if (Array.isArray(event.message.content)) {
            const argumentsValue = event.message.content[0]
              ?.arguments as unknown as Record<
                string,
                unknown
              >;
            argumentsValue.value = 'mutated by sink';
          } else {
            (event.message.content as { text: string }).text = 'mutated by sink';
          }
        } else if (event.kind === 'tool_call') {
          const argumentsValue = event.call.arguments as unknown as Record<
            string,
            unknown
          >;
          argumentsValue.value = 'mutated by sink';
        } else if (event.kind === 'tool_result') {
          (event.result as { text: string }).text = 'mutated by sink';
        }
      },
    },
  );
  assert(outcome.ok);
  assertEquals(toolInput, { value: 'original' });
  assert(continuedRequest !== undefined);
  const assistant = continuedRequest.transcript[1];
  assert(assistant?.role === 'assistant' && Array.isArray(assistant.content));
  assertEquals(assistant.content[0]?.arguments, { value: 'original' });
  const tool = continuedRequest.transcript[2];
  assert(tool?.role === 'tool');
  assertEquals(tool.content[0]?.text, 'original result');
  assertEquals(outcome.finalText, 'done');
});

Deno.test('steering admits and consumes one message with stable close results', () => {
  const neverAdmitted = new SteeringOwner();
  neverAdmitted.close();
  assertEquals(neverAdmitted.admit('late'), 'idle');

  const steering = new SteeringOwner();
  assertEquals(steering.admit('first'), 'accepted');
  assertEquals(steering.admit('second'), 'already_accepted');
  assertEquals(steering.consume(), 'first');
  assertEquals(steering.consume(), undefined);
  steering.close();
  assertEquals(steering.admit('late'), 'already_accepted');
});

Deno.test('Worker max-step failure does not advance the committed turn', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-current-code-max-steps-' });
  const created = await createWorkerSession({
    stateRoot,
    persistence: 'none',
    rootMaxSteps: 1,
    physicalIoMode: 'provider-free',
  });
  try {
    const before = created.session.currentPosition();
    const result = await created.session.submit('read worker protocol');
    assert(!result.ok);
    assertEquals(result.stopReason, 'max_steps');
    assertEquals(created.session.currentPosition().committedTurn, before.committedTurn);
  } finally {
    await created.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('terminal JSON results retain output above 64 KiB', async () => {
  const text = 'p'.repeat(300_000);
  const json = JSON.stringify({ text });
  const terminal = await new Registry([createJsonResultSubmissionTool()])
    .dispatch({
      callId: 'submit-large',
      name: 'submit_json_result',
      arguments: { json },
    });
  assert(terminal.terminal !== null);
  assertEquals(terminal.terminal?.finalText, json);
});

Deno.test('retained UI keeps operational metadata out of the conversation log', () => {
  const event = {
    kind: 'turn_end' as const,
    turn: 2,
    outcome: 'final' as const,
    committed: true,
    turnProviderRequestCount: 3,
    runtimeProviderRequestCount: 7,
  };
  const first = reduceUiEvent(createUiState(), event);
  const second = reduceUiEvent(first, event);
  assertEquals(first.log.entries, []);
  assertEquals(second.log.entries, first.log.entries);
});

Deno.test('common Worker composition starts with the runtime step limit', () => {
  const composition = createWorkerComposition({
    workspace: { root: '/configuration-test' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: { createModel: () => ({ generate: () => ({ kind: 'final', text: 'done' }) }) },
    toolComponents: [],
    asyncAgentNames: [],
  }, { roleInstruction: 'Complete the task.' });
  assertEquals(DEFAULT_AGENT_MAX_STEPS, 128);
  assertEquals(composition.maxSteps, 128);
  assertEquals(composition.manifest.maxSteps, 128);
});

Deno.test('active tool guidelines compose only where their tools are materialized', () => {
  const requests: Array<{ role: 'parent'; request: ModelRequest }> = [];
  const input = {
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
    agentInstructions: 'workspace instructions',
    physicalIo: {
      createModel: (role: 'parent') => ({
        generate: (request: ModelRequest) => {
          requests.push({ role, request });
          return { kind: 'final' as const, text: 'done' };
        },
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
    toolComponents: bundledWorkToolComponents(providerFreeWebSearchBackend),
  };
  const parent = createWorkerComposition({
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    agentInstructions: input.agentInstructions,
    physicalIo: input.physicalIo,
    toolComponents: input.toolComponents,
    asyncAgentNames: [],
  }, { roleInstruction: 'Complete the requested task.' });
  const reviewerTools = input.toolComponents.filter((component) =>
    ['tool:read', 'tool:submit_json_result'].includes(String(component.identity))
  );
  const reviewer = createWorkerComposition({
    workspace: input.workspace,
    skillCatalog: input.skillCatalog,
    agentInstructions: input.agentInstructions,
    physicalIo: input.physicalIo,
    toolComponents: reviewerTools,
    asyncAgentNames: [],
  }, { roleInstruction: 'Review the requested change without editing files.' });
  const guideline =
    'For file inspection, prefer read over running cat or sed through bash; use offset and limit to read further.';
  const bashGuideline =
    'Each bash call starts in the current workspace directory shown in Runtime facts and runs in a fresh shell. For commands targeting that directory, use relative paths and do not cd to the same directory. Change directory within the call only when the command must run from a different directory. State created by cd, variable assignment, export, source, aliases, or functions does not persist to later tool calls. When a command needs that setup, perform the setup and the command that consumes it in the same bash call; do not run setup-only commands whose effect ends with that call.';
  const bashOutputGuideline =
    'When bash reports truncated saved output, call bash_output with the exact outputId and stream from that result. Continue with each returned nextOffset instead of rerunning or reshaping the command.';
  const webSearchGuidelines = [
    'Choose the task source before exploring. If the user explicitly identifies the current repository, a local file, or a canonical URL or API, use that source first and do not add web search unless it leaves a current or external question unresolved. If current or external information is requested and the target identity or canonical source is not already established, use web_search as the first source-discovery tool; do not inspect the workspace, sibling repositories, handoff files, or try guessed endpoints with bash or curl merely because a software workspace exists. When external sources alone can answer the task, stay on that route. After discovery, obtain fast-changing lists or precise current values from the direct canonical source with web_fetch and disclose retrieval time or conflicts with search results. Put independent read-only retrievals in distinct tool calls in the same model step when their targets are already known; perform result-dependent retrievals sequentially. Give a specific query describing the information needed. Treat results[].text and results[].highlights as source material; summary and output are synthesized material. Cite direct source URLs near supported claims, do not copy provider-local citation numbers, and do not add facts unsupported by the returned material. Say when sources do not answer the question and label inference.',
    'Choose type and contents for the task. Use contents.text for full page text, highlights for relevant excerpts, and outputSchema for synthesized text or structured output. AdditionalQueries apply to deep search modes. Category accepts custom hints; company and people do not support published-date filters or excludeDomains. Dates use ISO 8601 and userLocation is a two-letter country code. Tool results are complete JSON; transport streaming is disabled. Dynamic highlights and verbosity automatically enable the documented Exa beta header.',
  ];
  const webFetchGuidelines = createWebFetchTool().promptGuidelines ?? [];
  assert(parent.systemInstruction?.includes(guideline));
  assert(parent.systemInstruction?.includes(bashGuideline));
  assert(parent.systemInstruction?.includes(bashOutputGuideline));
  assertEquals(parent.systemInstruction, parent.resolved.systemInstruction);
  assert(reviewer.systemInstruction?.includes(guideline));
  assert(!reviewer.systemInstruction?.includes(bashGuideline));
  assert(!reviewer.systemInstruction?.includes(bashOutputGuideline));
  for (const webSearchGuideline of webSearchGuidelines) {
    assert(parent.systemInstruction?.includes(webSearchGuideline));
    assert(!reviewer.systemInstruction?.includes(webSearchGuideline));
  }
  for (const webFetchGuideline of webFetchGuidelines) {
    assert(parent.systemInstruction?.includes(webFetchGuideline));
    assert(!reviewer.systemInstruction?.includes(webFetchGuideline));
  }
  for (
    const sourceSelectionBehavior of [
      'use that source first and do not add web search unless it leaves',
      'use web_search as the first source-discovery tool',
      'do not inspect the workspace, sibling repositories, handoff files',
      'When external sources alone can answer the task, stay on that route',
      'obtain fast-changing lists or precise current values from the direct canonical source with web_fetch',
      'Put independent read-only retrievals in distinct tool calls in the same model step',
      'perform result-dependent retrievals sequentially',
    ]
  ) {
    assert(parent.systemInstruction?.includes(sourceSelectionBehavior));
    assert(!reviewer.systemInstruction?.includes(sourceSelectionBehavior));
  }
  assertEquals(reviewer.systemInstruction, reviewer.resolved.systemInstruction);
  assertEquals(parent.registry.promptGuidelines(), [
    { tool: 'bash', text: bashGuideline },
    { tool: 'bash_output', text: bashOutputGuideline },
    { tool: 'read', text: guideline },
    ...webFetchGuidelines.map((text) => ({ tool: 'web_fetch', text })),
    ...webSearchGuidelines.map((text) => ({ tool: 'web_search', text })),
  ]);
  assertEquals(new Registry([]).promptGuidelines(), []);
  const bashDefinition = parent.registry.definitions().find((tool) => tool.name === 'bash');
  assert(bashDefinition?.description.includes('fresh shell'));
  assert(
    bashDefinition?.description.includes(
      'current workspace directory shown in Runtime facts',
    ),
  );
  assert(
    bashDefinition?.description.includes(
      'does not persist to later bash calls',
    ),
  );
  assert(
    bashDefinition?.description.includes(
      'parent process environment is not inherited at startup',
    ),
  );
  assert(
    bashDefinition?.description.includes('only PATH, LANG, and LC_ALL are set'),
  );
  assert(
    bashDefinition?.description.includes(
      "specify them within that bash call's command",
    ),
  );
  const readDefinition = parent.registry.definitions().find((tool) => tool.name === 'read');
  assert(readDefinition !== undefined);
  assert(!('promptGuidelines' in readDefinition));
  assertEquals(parent.systemInstruction?.split(guideline).length, 2);
  assertEquals(parent.systemInstruction?.split(bashGuideline).length, 2);
  assertEquals(parent.systemInstruction?.split(bashOutputGuideline).length, 2);
  for (const webSearchGuideline of webSearchGuidelines) {
    assertEquals(parent.systemInstruction?.split(webSearchGuideline).length, 2);
  }
});

Deno.test('Worker composition materializes the configured tool implementation', async () => {
  let readMaterializations = 0;
  const replacement: ToolComponent = {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: () => {
      readMaterializations += 1;
      return {
        name: 'read',
        description: 'Configured read replacement',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        promptGuidelines: ['Use the configured read replacement.'],
        execute: () => 'replacement result',
      };
    },
  };
  const input = {
    workspace: { root: '/configuration-test' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: {
      createModel: (role: 'parent' | 'planner') => ({
        generate: (_request: ModelRequest) => {
          void role;
          return { kind: 'final' as const, text: 'done' };
        },
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
  };
  const root = createWorkerComposition({
    ...input,
    toolComponents: [replacement],
    asyncAgentNames: [],
  }, { roleInstruction: 'Use the configured tools.' });
  assertEquals(readMaterializations, 1);
  assertEquals(
    root.registry.definitions().find((tool) => tool.name === 'read'),
    {
      name: 'read',
      description: 'Configured read replacement',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  );
  const replacementResult = await root.registry.dispatch({
    callId: 'read-replacement',
    name: 'read',
    arguments: { query: 'README.md' },
  });
  assertEquals(replacementResult.content.text, 'replacement result');
  assert(
    root.systemInstruction?.includes(
      'Use the configured read replacement.',
    ),
  );
  assert(root.manifest.resources.includes('tool:read'));
  assert(!JSON.stringify(root.manifest).includes('replacement result'));

  const builtin = createWorkerComposition({
    ...input,
    toolComponents: bundledWorkToolComponents(providerFreeWebSearchBackend),
    asyncAgentNames: [],
  }, { roleInstruction: 'Use the bundled tools.' });
  assertEquals(
    builtin.registry.definitions().find((tool) => tool.name === 'read')
      ?.description,
    'Read complete lines from one UTF-8 workspace file (64 KiB result). offset is 1-based; use offset/limit and the continuation notice for large files.',
  );
});

Deno.test('root maxSteps finalization keeps Worker composition evidence coherent', () => {
  const composition = createWorkerComposition({
    workspace: { root: '/configuration-test' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: {
      createModel: () => ({
        generate: () => ({ kind: 'final' as const, text: 'done' }),
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
    toolComponents: bundledWorkToolComponents(providerFreeWebSearchBackend),
    asyncAgentNames: [],
  }, { roleInstruction: 'Complete the task.' });
  const finalized = finalizeWorkerComposition(composition, 12);
  assertEquals(composition.maxSteps, 128);
  assertEquals({
    maxSteps: finalized.maxSteps,
    resolved: finalized.resolved.limits.maxSteps,
    selection: finalized.resolved.resourceSelection.parameters.maxSteps,
    manifest: finalized.manifest.maxSteps,
  }, { maxSteps: 12, resolved: 12, selection: 12, manifest: 12 });
});

Deno.test('workspace display keeps a short physical path and bounds a long path from the front', () => {
  assertEquals(
    displayWorkspaceLabel('/home/masat.guest/src/henji-harness'),
    '/home/masat.guest/src/henji-harness',
  );
  const long = `/home/${'deep/'.repeat(30)}henji-harness`;
  const displayed = displayWorkspaceLabel(long);
  assert(displayed.startsWith('…'));
  assert(displayed.endsWith('/henji-harness'));
  assert(new TextEncoder().encode(displayed).byteLength <= 96);
});

Deno.test('production model and saved messages use the expanded text ceilings', () => {
  assertEquals(
    PRODUCTION_MAX_COMPLETION_TOKENS,
    MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS,
  );
  assertEquals(MAX_REPLAY_MESSAGE_TEXT_BYTES, MAX_CONVERSATION_TEXT_BYTES);
  assertEquals(MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS, 65_536);
  assertEquals(MAX_CONVERSATION_TEXT_BYTES, 1024 * 1024);
  assertEquals(MAX_PLANNER_RESULT_ENVELOPE_BYTES, 2 * 1024 * 1024);
  assertEquals(MAX_SERIALIZED_MODEL_MESSAGES_BYTES, 5 * 1024 * 1024);
  assertEquals(MAX_COMPLETE_MODEL_REQUEST_BYTES, 6 * 1024 * 1024);

  const text = 'x'.repeat(300_000);
  const record = {
    schemaVersion: 1 as const,
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceRoot: '/output-limit-test',
    agent: 'default' as const,
    agentChoice: {},
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    title: null,
    stateRevision: 1,
    nextTurn: 2,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: '2026-09-02T00:00:00.000Z',
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
    turnExecutions: [{
      turn: 1,
      executionId: '11111111-1111-4111-8111-111111111111',
      build: buildManifest(),
      configurationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }],
    transcript: [
      {
        role: 'user' as const,
        content: { kind: 'text' as const, text: 'task' },
      },
      { role: 'assistant' as const, content: { kind: 'text' as const, text } },
    ],
  };
  assert(validateSessionRecord(record));
  assertEquals(record.transcript[1].role, 'assistant');
  const decodedAssistant = record.transcript[1];
  if (
    decodedAssistant.role !== 'assistant' ||
    Array.isArray(decodedAssistant.content)
  ) {
    throw new Error('assistant text was not retained');
  }
  assertEquals(
    (decodedAssistant.content as { readonly text: string }).text,
    text,
  );
  const restoredAssistant = record.transcript[1];
  if (
    restoredAssistant.role !== 'assistant' ||
    Array.isArray(restoredAssistant.content)
  ) {
    throw new Error('restored assistant text was not retained');
  }
  assertEquals(
    (restoredAssistant.content as { readonly text: string }).text,
    text,
  );
  assertEquals(boundedPresentationText(text), text);

  const ui = reduceUiEvent(createUiState(), {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text } },
  });
  const entry = ui.log.entries.find((item) => item.id === 'turn-1:attempt-0:assistant');
  assert(entry !== undefined && entry.text === text);
  const layout = layoutUi(ui, 80, 24);
  assert(
    layout.allLog.some((row) => row.entryId === 'turn-1:attempt-0:assistant'),
  );
});

Deno.test('saved sessions preserve assistant text accompanying tool calls', () => {
  const record = {
    schemaVersion: 1 as const,
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceRoot: '/mixed-tool-message-test',
    agent: 'default' as const,
    agentChoice: {},
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    title: null,
    stateRevision: 1,
    nextTurn: 2,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: '2026-09-10T00:00:00.000Z',
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
    turnExecutions: [{
      turn: 1,
      executionId: '22222222-2222-4222-8222-222222222222',
      build: buildManifest(),
      configurationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }],
    transcript: [
      {
        role: 'user' as const,
        content: { kind: 'text' as const, text: 'inspect' },
      },
      {
        role: 'assistant' as const,
        content: [{
          kind: 'tool_call' as const,
          callId: 'read-1',
          name: 'read',
          arguments: { path: 'README.md' },
        }],
        text: 'I will inspect the current source.',
      },
      {
        role: 'tool' as const,
        content: [{
          kind: 'tool_result' as const,
          callId: 'read-1',
          name: 'read',
          text: 'contents',
          outcome: 'success' as const,
        }],
      },
      {
        role: 'assistant' as const,
        content: { kind: 'text' as const, text: 'done' },
      },
    ],
  };
  assert(validateSessionRecord(record));
});

Deno.test('saved message limits retain the user, assistant, and planner result boundaries', () => {
  const base: Omit<SessionRecord, 'transcript'> = {
    schemaVersion: 1,
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workspaceRoot: '/saved-message-limits',
    agent: 'default',
    agentChoice: {},
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    title: null,
    stateRevision: 1,
    nextTurn: 2,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: '2026-09-23T00:00:00.000Z',
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
    turnExecutions: [{
      turn: 1,
      executionId: '33333333-3333-4333-8333-333333333333',
      build: buildManifest(),
      configurationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }],
  };
  const accepts = (transcript: readonly Message[]): boolean =>
    validateSessionRecord({ ...base, transcript });
  const rejects = (transcript: readonly Message[]): void => {
    assert(!accepts(transcript));
  };
  const user = (text: string): Message => ({
    role: 'user',
    content: { kind: 'text', text },
  });
  const assistant = (text: string): Message => ({
    role: 'assistant',
    content: { kind: 'text', text },
  });
  assert(accepts([
    user('x'.repeat(MAX_REPLAY_MESSAGE_TEXT_BYTES)),
    assistant('done'),
  ]));
  rejects([
    user('x'.repeat(MAX_REPLAY_MESSAGE_TEXT_BYTES + 1)),
    assistant('done'),
  ]);
  rejects([
    user('task'),
    assistant('x'.repeat(MAX_REPLAY_MESSAGE_TEXT_BYTES + 1)),
  ]);
  const plannerTranscript = (text: string): Message[] => [
    user('delegate task'),
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'planner-1',
        name: 'delegate_to_planner',
        arguments: { task: 'plan' },
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'planner-1',
        name: 'delegate_to_planner',
        text,
        outcome: 'success',
      }],
    },
    assistant('done'),
  ];
  const accepted = plannerTranscript(
    'x'.repeat(MAX_REPLAY_PLANNER_RESULT_BYTES),
  );
  assert(accepts(accepted));
  assert(accepted[2]?.role === 'tool');
  assert(
    accepted[2].content[0]?.text.length === MAX_REPLAY_PLANNER_RESULT_BYTES,
  );
  rejects(plannerTranscript('x'.repeat(MAX_REPLAY_PLANNER_RESULT_BYTES + 1)));
});
