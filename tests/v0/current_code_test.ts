import * as agentCli from '../../v0/agent/cli/fixture_cli.ts';
import type { LoopOutcome, ModelRequest, ToolCall } from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/core/execution_context.ts';
import { runAgent } from '../../v0/agent/core/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/tools/planner_delegation.ts';
import { AgentSession } from '../../v0/agent/session/session.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools/tools.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import {
  DEFAULT_AGENT_MAX_STEPS,
  defaultAgentDefinition,
  plannerAgentDefinition,
} from '../../v0/agent/definitions/agent_definition.ts';
import { PRODUCTION_MAX_COMPLETION_TOKENS } from '../../v0/agent/provider/provider_profile.ts';
import { admitInternalAgentDefinition } from '../../v0/agent/definitions/agent_catalog.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { createDeclaredRegistry } from '../../v0/agent/tools/registries.ts';
import {
  decodeSessionRecord,
  encodeSessionRecord,
  restoredMessages,
} from '../../v0/agent/session/session_store.ts';
import { MAX_REPLAY_MESSAGE_TEXT_BYTES } from '../../v0/agent/session/replay_value.ts';
import { historyPage, searchSessionHistory } from '../../v0/agent/session/session_history.ts';
import { boundedPresentationText } from '../../v0/presentation/contract.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import {
  createAgentResourceSelection,
  validateResolvedAgentResources,
} from '../../v0/agent/definitions/resource_identity.ts';
import { type AgentResolvedManifestV1 } from '../../v0/agent/definitions/resolved_manifest.ts';
import {
  materializePreparedRuntimeComposition,
  prepareRuntimeComposition,
} from '../../v0/agent/runtime/runtime.ts';
import { displayWorkspaceLabel } from '../../v0/agent/runtime/startup_orientation.ts';
import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  createPlannerAgentComposition,
  type ExecutableAgentDefinition,
  finalizeRootAgentComposition,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import {
  freshRuntimeComparisonCase,
  runFreshRuntimeComparison,
} from '../../v0/agent/validation/fresh_runtime_comparison.ts';
import type { WebSearchBackend } from '../../v0/agent/tools/web_search.ts';
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
  search: (query) => ({
    answer: `search result for ${query}`,
    sources: [{ title: 'test source', url: 'provider-free://web-search' }],
  }),
};

const delegationCall = (): ToolCall => ({
  callId: 'delegate-1',
  name: 'delegate_to_planner',
  arguments: { task: 'make a plan' },
});

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
  assertEquals({ stop: plain.stopReason, text: plain.finalText, steps: plain.steps }, {
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

Deno.test('session commits turns and reports occurrence-bound request counts', async () => {
  let requests = 0;
  const seen: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate: (request) => {
        requests += 1;
        seen.push(request);
        return { kind: 'final', text: `answer-${requests}` };
      },
    },
    new Registry([]),
    {
      providerRequestCount: () => requests,
      eventSink: (event) => events.push(event),
    },
  );

  const first = await session.submit('one');
  const second = await session.submit('two');
  assert(first.ok && second.ok);
  assertEquals(seen[1].transcript.map((message) => message.role), [
    'user',
    'assistant',
    'user',
  ]);
  assertEquals(
    [first.turnProviderRequestCount, first.runtimeProviderRequestCount],
    [1, 1],
  );
  assertEquals(
    [second.turnProviderRequestCount, second.runtimeProviderRequestCount],
    [1, 2],
  );
  const ends = events.filter((event) => event.kind === 'turn_end');
  assertEquals(ends.map((event) => event.committed), [true, true]);
});

Deno.test('max-step failure is diagnosed and not committed', async () => {
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate: () => ({
        kind: 'tool_calls',
        calls: [{ callId: 'again', name: 'again', arguments: {} }],
      }),
    },
    new Registry([{
      name: 'again',
      description: 'continue',
      inputSchema: {},
      execute: () => 'again',
    }]),
    { maxSteps: 1, eventSink: (event) => events.push(event) },
  );
  const result = await session.submit('bounded');
  assert(!result.ok);
  assertEquals(
    { stop: result.stopReason, stage: result.diagnostic?.stage, code: result.diagnostic?.code },
    { stop: 'max_steps', stage: 'turn_control', code: 'model_step_limit' },
  );
  assertEquals(session.transcriptSnapshot(), []);
  const end = events.at(-1);
  assert(end?.kind === 'turn_end');
  assertEquals(end.committed, false);
});

Deno.test('planner delegation succeeds once and child failure stops the parent immediately', async () => {
  const successContext = new ParentTurnExecutionContext(1);
  const successTool = createPlannerDelegationTool((_task, child) => {
    assert(child.claimModelRequest());
    return {
      externalRequests: 1,
      outcome: {
        ok: true,
        task: 'make a plan',
        outcome: 'final',
        stopReason: 'final',
        finalText: 'child plan',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    };
  });
  const success = await new Registry([successTool]).dispatch(delegationCall(), successContext);
  assertEquals(success.content.outcome, 'success');
  assert(success.content.text.includes('child plan'));

  let parentRequests = 0;
  const failure: LoopOutcome = {
    ok: false,
    task: 'make a plan',
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    error: 'child failed',
    steps: 1,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [],
  };
  const failedParent = await runAgent(
    'parent',
    {
      generate: () => {
        parentRequests += 1;
        if (parentRequests > 1) throw new Error('parent continued after child failure');
        return { kind: 'tool_calls', calls: [delegationCall()] };
      },
    },
    new Registry([createPlannerDelegationTool(() => ({
      externalRequests: 1,
      outcome: failure,
    }))]),
    { executionContext: new ParentTurnExecutionContext(1) },
  );
  assert(!failedParent.ok);
  assertEquals(
    { requests: parentRequests, stop: failedParent.stopReason },
    { requests: 1, stop: 'contract_failure' },
  );
});

Deno.test('planner and terminal JSON results retain output above 64 KiB', async () => {
  const text = 'p'.repeat(300_000);
  const context = new ParentTurnExecutionContext(1);
  const planner = createPlannerDelegationTool((_task, child) => {
    assert(child.claimModelRequest());
    return {
      externalRequests: 1,
      outcome: {
        ok: true,
        task: 'large plan',
        outcome: 'final',
        stopReason: 'final',
        finalText: text,
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    };
  });
  const plannerResult = await new Registry([planner]).dispatch({
    callId: 'delegate-large',
    name: 'delegate_to_planner',
    arguments: { task: 'large plan' },
  }, context);
  assertEquals(plannerResult.content.outcome, 'success');
  assert(plannerResult.content.text.includes(text));
  assert(new TextEncoder().encode(plannerResult.content.text).byteLength > 65_536);

  const json = JSON.stringify({ text });
  const terminal = await new Registry([createJsonResultSubmissionTool()]).dispatch({
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

Deno.test('Definitions declare capabilities while the host materializes matching registries', async () => {
  const input = {
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
  };
  const defaultDefinition = defaultAgentDefinition(input);
  const plannerDefinition = plannerAgentDefinition(input);
  assertEquals(DEFAULT_AGENT_MAX_STEPS, 64);
  assertEquals(defaultDefinition.limits.maxSteps, 64);
  assertEquals(plannerDefinition.limits.maxSteps, 64);
  assert(!('registry' in defaultDefinition));
  assert(!('skillCatalog' in defaultDefinition));
  assertEquals(defaultDefinition.capabilities.tools.map(String), [
    'tool:bash',
    'tool:bash_output',
    'tool:edit',
    'tool:read',
    'tool:web_search',
    'tool:write',
    'tool:delegate_to_planner',
    'tool:submit_json_result',
  ]);
  const plannerDelegation = () => {
    throw new Error('test planner delegation');
  };
  assertEquals(
    createDeclaredRegistry(defaultDefinition.capabilities, {
      ...input,
      plannerDelegation,
      webSearchBackend: providerFreeWebSearchBackend,
    }).definitions().map((tool) => tool.name),
    [
      'bash',
      'bash_output',
      'delegate_to_planner',
      'edit',
      'read',
      'submit_json_result',
      'web_search',
      'write',
    ],
  );
  assertEquals(
    createDeclaredRegistry(plannerDefinition.capabilities, input).definitions().map((tool) =>
      tool.name
    ),
    ['read', 'submit_json_result'],
  );
  validateResolvedAgentResources(defaultDefinition, 'default');
  validateResolvedAgentResources(plannerDefinition, 'planner');

  let observedManifest: AgentResolvedManifestV1 | undefined;
  const synthetic = admitInternalAgentDefinition('default', (definitionInput) => {
    const base = defaultAgentDefinition(definitionInput);
    const customTools = Object.freeze(
      base.capabilities.tools.filter((resource) =>
        resource === 'tool:read' || resource === 'tool:submit_json_result'
      ),
    );
    const custom = Object.freeze({
      ...base,
      capabilities: Object.freeze({
        ...base.capabilities,
        tools: customTools,
        subagents: Object.freeze([]),
      }),
      limits: Object.freeze({ maxSteps: 5 }),
      resourceSelection: createAgentResourceSelection(
        base.resourceSelection.resources.filter((resource) =>
          !resource.startsWith('tool:') || customTools.includes(resource)
        ).filter((resource) => resource !== 'subagent:planner'),
        5,
      ),
    });
    validateResolvedAgentResources(custom);
    return custom;
  });
  const prepared = await prepareRuntimeComposition({
    workspace: input.workspace,
    instructionFileSystem: {
      lstat: () => Promise.reject(new Error('no instruction fixture')),
      open: () => Promise.reject(new Error('no instruction fixture')),
    },
    skillFileSystem: {
      lstat: () => Promise.reject(new Error('no skill fixture')),
      readDirectory: async function* () {},
      open: () => Promise.reject(new Error('no skill fixture')),
    },
    onResolvedManifestValidated: (_role, manifest) => {
      observedManifest = manifest;
    },
  }, synthetic);
  const composition = materializePreparedRuntimeComposition(prepared);
  assert(observedManifest !== undefined);
  assertEquals(
    composition.registry.definitions().map((tool) => `tool:${tool.name}`),
    prepared.definition.capabilities.tools,
  );
  assertEquals(observedManifest.resources, prepared.resourceSelection.resources);
  assertEquals(observedManifest.parameters.maxSteps, 5);
  assertEquals(observedManifest.definitionId, 'default');
  assertEquals(
    composition.registry.definitions().map((tool) => tool.name),
    ['read', 'submit_json_result'],
  );
  const requestBudget = composition.createTurnExecutionContext(1);
  for (let step = 0; step < 5; step += 1) assert(requestBudget.claimModelRequest());
  assert(!requestBudget.claimModelRequest());
});

Deno.test('active tool guidelines compose only where their tools are materialized', async () => {
  const requests: Array<{ role: 'parent' | 'planner'; request: ModelRequest }> = [];
  const input = {
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
    agentInstructions: 'workspace instructions',
    physicalIo: {
      createModel: (role: 'parent' | 'planner') => ({
        generate: (request: ModelRequest) => {
          requests.push({ role, request });
          return { kind: 'final' as const, text: 'done' };
        },
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
  };
  const parent = createDefaultAgentComposition(input);
  const directPlanner = createPlannerAgentComposition(input);
  const guideline =
    'File調査ではcatやsedをbashで実行するよりreadを優先し、続きはoffset・limitで読む。';
  const bashGuideline =
    'Each bash call starts in the current workspace directory shown in Runtime facts and runs in a fresh shell. For commands targeting that directory, use relative paths and do not cd to the same directory. Change directory within the call only when the command must run from a different directory. State created by cd, variable assignment, export, source, aliases, or functions does not persist to later tool calls. When a command needs that setup, perform the setup and the command that consumes it in the same bash call; do not run setup-only commands whose effect ends with that call.';
  const bashOutputGuideline =
    'When bash reports truncated saved output, call bash_output with the exact outputId and stream from that result. Continue with each returned nextOffset instead of rerunning or reshaping the command.';
  const webSearchGuideline =
    'Use web_search when current or external information is needed. Pass a complete, specific research question that states the information needed; prefer this over a bare keyword or Boolean query. Treat the returned answer as sourced material: use its inline source links near supported claims in the final answer, never copy provider-local citation markers such as [1], and do not add factual details that the returned material does not support. Say explicitly when the sources do not answer the question, and label inference instead of presenting it as verified fact.';
  assert(parent.systemInstruction?.includes(guideline));
  assert(parent.systemInstruction?.includes(bashGuideline));
  assert(parent.systemInstruction?.includes(bashOutputGuideline));
  assertEquals(parent.systemInstruction, parent.resolved.systemInstruction);
  assert(directPlanner.systemInstruction?.includes(guideline));
  assert(!directPlanner.systemInstruction?.includes(bashGuideline));
  assert(!directPlanner.systemInstruction?.includes(bashOutputGuideline));
  assert(parent.systemInstruction?.includes(webSearchGuideline));
  assert(!directPlanner.systemInstruction?.includes(webSearchGuideline));
  assertEquals(directPlanner.systemInstruction, directPlanner.resolved.systemInstruction);
  assertEquals(parent.registry.promptGuidelines(), [
    { tool: 'bash', text: bashGuideline },
    { tool: 'bash_output', text: bashOutputGuideline },
    { tool: 'read', text: guideline },
    { tool: 'web_search', text: webSearchGuideline },
  ]);
  assertEquals(new Registry([]).promptGuidelines(), []);
  const bashDefinition = parent.registry.definitions().find((tool) => tool.name === 'bash');
  assert(bashDefinition?.description.includes('fresh shell'));
  assert(
    bashDefinition?.description.includes('current workspace directory shown in Runtime facts'),
  );
  assert(bashDefinition?.description.includes('does not persist to later bash calls'));
  const readDefinition = parent.registry.definitions().find((tool) => tool.name === 'read');
  assert(readDefinition !== undefined);
  assert(!('promptGuidelines' in readDefinition));
  assertEquals(parent.systemInstruction?.split(guideline).length, 2);
  assertEquals(parent.systemInstruction?.split(bashGuideline).length, 2);
  assertEquals(parent.systemInstruction?.split(bashOutputGuideline).length, 2);
  assertEquals(parent.systemInstruction?.split(webSearchGuideline).length, 2);

  const delegated = await parent.registry.dispatch(
    delegationCall(),
    new ParentTurnExecutionContext(1),
  );
  assertEquals(delegated.content.outcome, 'success');
  const plannerRequest = requests.find((entry) => entry.role === 'planner');
  assert(plannerRequest !== undefined);
  assert(plannerRequest.request.systemInstruction?.includes(guideline));
  assertEquals(plannerRequest.request.systemInstruction?.split(guideline).length, 2);
});

Deno.test('Executable Definition replaces one selected root tool component only', async () => {
  const plannerRequests: ModelRequest[] = [];
  let readMaterializations = 0;
  const replacement: ToolComponent = {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: () => {
      readMaterializations += 1;
      return {
        name: 'read',
        description: 'Definition-local read replacement',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        promptGuidelines: ['Use the Definition-local read replacement.'],
        execute: () => 'replacement result',
      };
    },
  };
  const input = {
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: {
      createModel: (role: 'parent' | 'planner') => ({
        generate: (request: ModelRequest) => {
          if (role === 'planner') plannerRequests.push(request);
          return { kind: 'final' as const, text: 'done' };
        },
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
  };
  const definition: ExecutableAgentDefinition = (definitionInput) =>
    createDefaultAgentComposition(definitionInput, { toolComponents: [replacement] });
  const root = definition(input);
  assertEquals(readMaterializations, 1);
  assertEquals(
    root.registry.definitions().find((tool) => tool.name === 'read'),
    {
      name: 'read',
      description: 'Definition-local read replacement',
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
  assert(root.systemInstruction?.includes('Use the Definition-local read replacement.'));
  assert(root.manifest.resources.includes('tool:read'));
  assert(!JSON.stringify(root.manifest).includes('replacement result'));

  const delegated = await root.registry.dispatch(
    delegationCall(),
    new ParentTurnExecutionContext(1),
  );
  assertEquals(delegated.content.outcome, 'success');
  assertEquals(plannerRequests.length, 1);
  const plannerRead = plannerRequests[0].tools.find((tool) => tool.name === 'read');
  assert(plannerRead !== undefined);
  assertEquals(
    plannerRead.description,
    'Read complete lines from one UTF-8 workspace file (64 KiB result). offset is 1-based; use offset/limit and the continuation notice for large files.',
  );
  assert(!plannerRequests[0].systemInstruction?.includes('Definition-local'));

  const builtin = createDefaultAgentComposition(input);
  assertEquals(
    builtin.registry.definitions().find((tool) => tool.name === 'read')?.description,
    plannerRead.description,
  );
});

Deno.test('root maxSteps finalization keeps Definition evidence coherent', () => {
  const composition = createDefaultAgentComposition({
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
    physicalIo: {
      createModel: () => ({
        generate: () => ({ kind: 'final' as const, text: 'done' }),
      }),
      webSearchBackend: providerFreeWebSearchBackend,
    },
  });
  const finalized = finalizeRootAgentComposition(composition, 12);
  assertEquals(composition.maxSteps, 64);
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

Deno.test('fresh runtime comparison keeps the current 64 versus variant 4 axis', async () => {
  const result = await runFreshRuntimeComparison(freshRuntimeComparisonCase);
  assertEquals({
    currentMaxSteps: result.current.maxSteps,
    variantMaxSteps: result.variant.maxSteps,
    currentState: result.current.state,
    variantState: result.variant.state,
  }, {
    currentMaxSteps: 64,
    variantMaxSteps: 4,
    currentState: 'completed',
    variantState: 'stopped',
  });
});

Deno.test('production definitions and saved messages use the expanded text ceilings', () => {
  const input = { workspace: { root: '/definition-test' }, skillCatalog: emptySkillCatalog() };
  assertEquals(defaultAgentDefinition(input).model.profile.maxCompletionTokens, 65_536);
  assertEquals(plannerAgentDefinition(input).model.profile.maxCompletionTokens, 65_536);
  assertEquals(PRODUCTION_MAX_COMPLETION_TOKENS, MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS);
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
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    nextTurn: 2,
    transcript: [
      { role: 'user' as const, content: { kind: 'text' as const, text: 'task' } },
      { role: 'assistant' as const, content: { kind: 'text' as const, text } },
    ],
  };
  const decoded = decodeSessionRecord(encodeSessionRecord(record));
  assertEquals(decoded.transcript[1].role, 'assistant');
  const decodedAssistant = decoded.transcript[1];
  if (decodedAssistant.role !== 'assistant' || Array.isArray(decodedAssistant.content)) {
    throw new Error('assistant text was not retained');
  }
  assertEquals((decodedAssistant.content as { readonly text: string }).text, text);
  const restored = restoredMessages(decoded.transcript);
  assertEquals(restored.omitted, 0);
  const restoredAssistant = restored.messages[1];
  if (restoredAssistant.role !== 'assistant' || Array.isArray(restoredAssistant.content)) {
    throw new Error('restored assistant text was not retained');
  }
  assertEquals((restoredAssistant.content as { readonly text: string }).text, text);
  assertEquals(boundedPresentationText(text), text);

  const ui = reduceUiEvent(createUiState(), {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text } },
  });
  const entry = ui.log.entries.find((item) => item.id === 'turn-1:assistant');
  assert(entry !== undefined && entry.text === text);
  const layout = layoutUi(ui, 80, 24);
  assert(layout.allLog.some((row) => row.entryId === 'turn-1:assistant'));
});

Deno.test('saved sessions preserve assistant text accompanying tool calls', () => {
  const record = {
    schemaVersion: 1 as const,
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceRoot: '/mixed-tool-message-test',
    agent: 'default' as const,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    nextTurn: 2,
    transcript: [
      { role: 'user' as const, content: { kind: 'text' as const, text: 'inspect' } },
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
      { role: 'assistant' as const, content: { kind: 'text' as const, text: 'done' } },
    ],
  };
  const decoded = decodeSessionRecord(encodeSessionRecord(record));
  assertEquals(decoded.transcript, record.transcript);
  assertEquals(restoredMessages(decoded.transcript).messages, record.transcript);
  assertEquals(
    historyPage(decoded.transcript, 1)?.entries.map((entry) => [entry.role, entry.text]),
    [
      ['user', 'inspect'],
      ['tool>', 'read README.md ✓'],
      ['assistant', 'done'],
    ],
  );
});

Deno.test('history search uses the settled visible log and excludes tool result bodies', () => {
  const transcript = [
    { role: 'user' as const, content: { kind: 'text' as const, text: 'Alpha first' } },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: 'middle' } },
    { role: 'user' as const, content: { kind: 'text' as const, text: '日本語を探す' } },
    {
      role: 'assistant' as const,
      content: [{
        kind: 'tool_call' as const,
        callId: 'search-1',
        name: 'read',
        arguments: { path: 'visible-ALPHA.txt' },
      }],
    },
    {
      role: 'tool' as const,
      content: [{
        kind: 'tool_result' as const,
        callId: 'search-1',
        name: 'read',
        text: 'hidden ALPHA, tool-only-token, and 日本語',
        outcome: 'success' as const,
      }],
    },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: 'done' } },
  ];

  const oldest = searchSessionHistory(transcript, 'alpha', 0);
  assertEquals(oldest?.match, {
    query: 'alpha',
    ordinal: 0,
    total: 2,
    turn: 1,
    role: 'user',
    messageIndex: 0,
    sourceScalarStart: 0,
    sourceScalarLength: 5,
    pageEntry: 0,
  });
  const newer = searchSessionHistory(transcript, 'alpha', 1);
  assertEquals(newer?.match.role, 'tool>');
  assertEquals(newer?.match.sourceScalarStart, 13);
  assertEquals(newer?.page.entries[newer.match.pageEntry].text, 'read visible-ALPHA.txt ✓');
  assertEquals(searchSessionHistory(transcript, 'tool-only-token', 0), undefined);

  const japanese = searchSessionHistory(transcript, '日本語', 0);
  assertEquals(japanese?.match.turn, 2);
  assertEquals(japanese?.match.role, 'user');
  assertEquals(japanese?.match.total, 1);

  const longTranscript = Array.from({ length: 101 }, (_, index) => [
    {
      role: 'user' as const,
      content: {
        kind: 'text' as const,
        text: index === 0 ? 'older-than-resume-limit' : `question ${index + 1}`,
      },
    },
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: `answer ${index + 1}` },
    },
  ]).flat();
  const oldMatch = searchSessionHistory(longTranscript, 'older-than-resume-limit', 0);
  assertEquals(oldMatch?.match.turn, 1);
  assertEquals(oldMatch?.match.messageIndex, 0);
  assertEquals(oldMatch?.page.entries[oldMatch.match.pageEntry].sourceScalarStart, 0);
});
