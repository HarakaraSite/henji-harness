import * as agentCli from '../../v0/agent/cli.ts';
import type { LoopOutcome, ModelRequest, ToolCall } from '../../v0/agent/contracts.ts';
import type { AgentEvent } from '../../v0/agent/events.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import { defaultAgentDefinition, plannerAgentDefinition } from '../../v0/agent/agent_definition.ts';
import { PRODUCTION_MAX_COMPLETION_TOKENS } from '../../v0/agent/provider_profile.ts';
import { admitInternalAgentDefinition } from '../../v0/agent/agent_catalog.ts';
import { emptySkillCatalog } from '../../v0/agent/skills.ts';
import { createDeclaredRegistry } from '../../v0/agent/registries.ts';
import {
  decodeSessionRecord,
  encodeSessionRecord,
  restoredMessages,
} from '../../v0/agent/session_store.ts';
import { MAX_REPLAY_MESSAGE_TEXT_BYTES } from '../../v0/agent/replay_value.ts';
import { boundedPresentationText } from '../../v0/presentation/contract.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import {
  createAgentResourceSelection,
  validateResolvedAgentResources,
} from '../../v0/agent/resource_identity.ts';
import { type AgentResolvedManifestV1 } from '../../v0/agent/resolved_manifest.ts';
import {
  materializePreparedRuntimeComposition,
  prepareRuntimeComposition,
} from '../../v0/agent/runtime.ts';

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

Deno.test('retained UI records exact per-turn and runtime request counts once', () => {
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
  assertEquals(first.log.entries, [{
    id: 'turn-2:requests',
    kind: 'system',
    label: 'requests>',
    text: 'turn=2 · actual=3 · runtime=7',
    revision: 0,
    live: false,
    turn: 2,
  }]);
  assertEquals(second.log.entries, first.log.entries);
});

Deno.test('Definitions declare capabilities while the host materializes matching registries', async () => {
  const input = {
    workspace: { root: '/definition-test' },
    skillCatalog: emptySkillCatalog(),
  };
  const defaultDefinition = defaultAgentDefinition(input);
  const plannerDefinition = plannerAgentDefinition(input);
  assert(!('registry' in defaultDefinition));
  assert(!('skillCatalog' in defaultDefinition));
  assertEquals(defaultDefinition.capabilities.tools.map(String), [
    'tool:bash',
    'tool:edit',
    'tool:read',
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
    }).definitions().map((tool) => tool.name),
    ['bash', 'delegate_to_planner', 'edit', 'read', 'submit_json_result', 'write'],
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
});

Deno.test('production definitions and saved messages use the expanded text ceilings', () => {
  const input = { workspace: { root: '/definition-test' }, skillCatalog: emptySkillCatalog() };
  assertEquals(defaultAgentDefinition(input).model.profile.maxCompletionTokens, 65_536);
  assertEquals(plannerAgentDefinition(input).model.profile.maxCompletionTokens, 65_536);
  assertEquals(PRODUCTION_MAX_COMPLETION_TOKENS, 65_536);
  assertEquals(MAX_REPLAY_MESSAGE_TEXT_BYTES, 1024 * 1024);

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
