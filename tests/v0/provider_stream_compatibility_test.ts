import {
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../../v0/agent/openrouter_model.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import {
  FakeProviderEvidenceStore,
  ProviderEvidenceRecorder,
} from '../../v0/agent/provider_evidence.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { FailureDiagnosticOwner } from '../../v0/agent/failure_diagnostic.ts';
import { createJsonResultSubmissionTool, Registry } from '../../v0/agent/tools.ts';
import type { ModelRequest } from '../../v0/agent/contracts.ts';
import {
  main as failureDiagnosticMain,
  parseFailureDiagnosticArgs,
} from '../../v0/agent/failure_diagnostic_cli.ts';
import type { AgentEvent } from '../../v0/agent/events.ts';
import { DenoProviderEvidenceStore } from '../../v0/agent/provider_evidence_store.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';

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

const PROFILE: OpenRouterAgentProfile = {
  id: 'test-profile',
  model: 'test/model',
  origin: 'https://openrouter.ai',
  path: '/api/v1/chat/completions',
  method: 'POST',
  secretEnv: 'HENJI_TEST_KEY',
  maxCompletionTokens: 128,
  stream: false,
};

const request: ModelRequest = {
  transcript: [{ role: 'user', content: { kind: 'text', text: 'hello' } }],
  tools: [],
};

const usage = (id: string, finishReason: 'stop' | 'tool_calls'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { content: '', role: 'assistant' },
        finish_reason: finishReason,
        native_finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cost: 0.01,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\n`;

const textStream = (id = 'gen-text'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      }],
    })
  }\n\n${usage(id, 'stop')}data: [DONE]\n\n`;

const largeTextStream = (text: string, id = 'gen-large-text'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
    })
  }\n\n${usage(id, 'stop')}data: [DONE]\n\n`;

const toolStream = (id = 'gen-tool'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'submit-1',
            type: 'function',
            function: {
              name: 'submit_json_result',
              arguments: JSON.stringify({ json: '{"ok":true}' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\n${usage(id, 'tool_calls')}data: [DONE]\n\n`;

const plannerDelegationStream = (id = 'gen-planner'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'delegate-large',
            type: 'function',
            function: {
              name: 'delegate_to_planner',
              arguments: JSON.stringify({ task: 'large plan' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\n${usage(id, 'tool_calls')}data: [DONE]\n\n`;

const failingPostTerminalStream = (): string =>
  `${textStream('gen-failure').replace('data: [DONE]\n\n', '')}data: ${
    JSON.stringify({
      id: 'gen-failure',
      choices: [{ index: 0, delta: { content: 'late content' }, finish_reason: null }],
    })
  }\n\n`;

const modelFor = (
  body: string,
  seen: { requests: number },
  contentType = 'text/event-stream; charset=utf-8',
): OpenRouterAgentModel =>
  new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      seen.requests += 1;
      assert(init?.headers !== undefined);
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': contentType,
            'x-generation-id': `gen-${seen.requests}`,
          },
        }),
      );
    },
  });

Deno.test('documented text accounting reaches ModelResult through HTTP and SSE', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceStore();
  const recorder = new ProviderEvidenceRecorder(
    '11111111-1111-4111-8111-111111111111',
    1,
    '2026-09-02T00:00:00.000Z',
    store,
  );
  const model = modelFor(textStream(), seen);
  const result = await model.generate(request, {
    providerEvidence: recorder,
    providerEvidenceLane: 'parent',
    modelStep: 1,
  });
  assertEquals(result, { kind: 'final', text: 'hello' });
  recorder.finalize({
    outcome: {
      ok: true,
      task: 'hello',
      outcome: 'final',
      stopReason: 'final',
      finalText: 'hello',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      turnProviderRequestCount: seen.requests,
      runtimeProviderRequestCount: seen.requests,
      transcript: [],
    },
  });
  await recorder.persist();
  const evidence = await store.read(recorder.evidenceId);
  assertEquals(seen.requests, 1);
  assertEquals(evidence.requests.length, 1);
  assertEquals(
    evidence.requests[0].request.requestBodyBytes,
    evidence.requests[0].request.requestBody.length,
  );
  assertEquals(evidence.requests[0].response?.status, 200);
  assert(evidence.requests[0].response?.rawBody?.includes('late') === false);
  assertEquals(evidence.requests[0].sseEvents.length, 3);
  assert(evidence.requests[0].sseEvents[0].data.includes('"content":"hello"'));
  assert(evidence.requests[0].sseEvents[1].data.includes('"usage"'));
  assert(evidence.requests[0].sseEvents.some((event) => event.data === '[DONE]'));
  assertEquals(
    evidence.requests[0].parserTransitions.filter((transition) => transition.kind === 'terminal')
      .length,
    1,
  );
  assertEquals(evidence.outcome, 'final');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assertEquals(evidence.runtimeProviderRequestCount, 1);
  const serialized = JSON.stringify(evidence);
  assert(!serialized.includes('dummy-credential-value'));
  assert(!serialized.toLowerCase().includes('authorization'));

  const unsupportedRecorder = new ProviderEvidenceRecorder(
    '66666666-6666-4666-8666-666666666666',
    1,
    '2026-09-02T00:00:00.000Z',
  );
  try {
    await modelFor('raw unsupported-media body', { requests: 0 }, 'application/json').generate(
      request,
      { providerEvidence: unsupportedRecorder, providerEvidenceLane: 'parent', modelStep: 1 },
    );
  } catch {
    // The existing unsupported-media classification is expected; evidence must retain the body.
  }
  assertEquals(
    unsupportedRecorder.snapshot().requests[0].response?.rawBody,
    'raw unsupported-media body',
  );
});

Deno.test('assistant output above 64 KiB remains reachable through the provider adapter', async () => {
  const text = 'x'.repeat(300_000);
  const seen = { requests: 0 };
  const progress: string[] = [];
  const result = await modelFor(largeTextStream(text), seen).generate(request, {
    reportAssistantProgress: (snapshot) => progress.push(snapshot),
  });
  assertEquals(result, { kind: 'final', text });
  assertEquals(seen.requests, 1);
  assert(progress.at(-1) === text);
});

Deno.test('planner result above 76 KiB reaches the parent continuation request', async () => {
  const plannerText = 'p'.repeat(300_000);
  const seen = { requests: 0 };
  let parentToolContent: string | undefined;
  const model = new OpenRouterAgentModel({
    profile: PROFILE,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    fetcher: (_input, init) => {
      seen.requests += 1;
      if (seen.requests === 2) {
        const body = JSON.parse(String(init?.body)) as {
          readonly messages?: readonly {
            readonly role?: unknown;
            readonly content?: unknown;
          }[];
        };
        const toolMessage = body.messages?.find((message) => message.role === 'tool');
        assert(toolMessage !== undefined);
        assert(typeof toolMessage.content === 'string');
        parentToolContent = toolMessage.content;
        assert(
          new TextEncoder().encode(JSON.stringify(body.messages)).byteLength > 76 * 1024,
        );
      }
      const responseBody = seen.requests === 1
        ? plannerDelegationStream()
        : textStream('gen-parent-final');
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'x-generation-id': `gen-${seen.requests}`,
          },
        }),
      );
    },
  });
  const outcome = await runAgent(
    'parent task',
    model,
    new Registry([createPlannerDelegationTool((_task, child) => {
      assert(child.claimModelRequest());
      return {
        externalRequests: 1,
        outcome: {
          ok: true,
          task: 'large plan',
          outcome: 'final',
          stopReason: 'final',
          finalText: plannerText,
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
      };
    })]),
    { executionContext: new ParentTurnExecutionContext(1) },
  );
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'hello');
  assertEquals(seen.requests, 2);
  assert(parentToolContent?.includes(plannerText));
});

Deno.test('documented tool accounting dispatches normally through the same transport', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceStore();
  const model = modelFor(toolStream(), seen);
  const events: unknown[] = [];
  const session = new AgentSession(model, new Registry([createJsonResultSubmissionTool()]), {
    eventSink: (event) => events.push(event),
    providerEvidenceStore: store,
    providerRequestCount: () => seen.requests,
  });
  const outcome = await session.submit('submit');
  assert(outcome.ok);
  assertEquals(outcome.stopReason, 'tool_terminal');
  assertEquals(outcome.finalText, '{"ok":true}');
  assertEquals(seen.requests, 1);
  assert(outcome.providerEvidenceId !== undefined);
  const evidence = await store.read(outcome.providerEvidenceId!);
  assertEquals(evidence.requests[0].request.lane, 'parent');
  assertEquals(evidence.outcome, 'tool_terminal');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assert(evidence.runtimeEvents.some((event) => event.kind === 'tool_call'));
  assert(evidence.runtimeEvents.some((event) => event.kind === 'tool_result'));
  assert(events.some((event) => (event as { readonly kind?: string }).kind === 'turn_end'));
});

Deno.test('post-terminal content is rejected and diagnostic ID reaches the saved artifact', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceStore();
  const diagnostics: string[] = [];
  const model = modelFor(failingPostTerminalStream(), seen);
  const session = new AgentSession(model, new Registry([]), {
    providerEvidenceStore: store,
    providerRequestCount: () => seen.requests,
    diagnosticOwnerFactory: (turn) =>
      new FailureDiagnosticOwner(turn, {
        uuid: () => '22222222-2222-4222-8222-222222222222',
        now: () => '2026-09-02T00:00:00.000Z',
        persist: (diagnostic) => {
          diagnostics.push(diagnostic.diagnosticId);
        },
      }),
  });
  const outcome = await session.submit('fail');
  assert(!outcome.ok);
  assertEquals(outcome.diagnostic?.parseReason, 'data_after_terminal');
  assert(typeof outcome.providerEvidenceId === 'string');
  const evidence = await store.read(outcome.providerEvidenceId!);
  const failure = evidence.requests[0].parserTransitions.find((transition) =>
    transition.kind === 'failure'
  );
  assertEquals(failure?.reason, 'data_after_terminal');
  assertEquals(failure?.field, 'choices[0].delta.content');
  assertEquals(evidence.outcome, 'contract_failure');
  assertEquals(evidence.turnProviderRequestCount, 1);
  assertEquals(diagnostics, [outcome.diagnostic?.diagnosticId]);
  assertEquals(
    await store.readDiagnosticLink(outcome.diagnostic!.diagnosticId),
    outcome.providerEvidenceId,
  );
});

Deno.test('evidence persistence failure does not replace a valid provider result', async () => {
  const seen = { requests: 0 };
  const store = new FakeProviderEvidenceStore();
  store.failWrites();
  const events: AgentEvent[] = [];
  const session = new AgentSession(modelFor(textStream('gen-persist'), seen), new Registry([]), {
    eventSink: (event) => events.push(event),
    providerEvidenceStore: store,
    providerRequestCount: () => seen.requests,
  });
  const outcome = await session.submit('persist');
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'hello');
  assertEquals(outcome.providerEvidenceDurability, 'failed');
  assertEquals(outcome.providerEvidencePersistenceError, 'provider_evidence_io_failure');
  const turnEnd = events.find((event) => event.kind === 'turn_end');
  assert(turnEnd?.kind === 'turn_end');
  assertEquals(turnEnd.providerEvidenceDurability, 'failed');
  assertEquals(turnEnd.providerEvidencePersistenceError, 'provider_evidence_io_failure');

  const linkSeen = { requests: 0 };
  const linkStore = new FakeProviderEvidenceStore();
  linkStore.failLinks();
  const linkSession = new AgentSession(
    modelFor(failingPostTerminalStream(), linkSeen),
    new Registry([]),
    { providerEvidenceStore: linkStore, providerRequestCount: () => linkSeen.requests },
  );
  const linkOutcome = await linkSession.submit('link');
  assert(!linkOutcome.ok);
  assert(typeof linkOutcome.providerEvidenceId === 'string');
  assertEquals(linkOutcome.providerEvidenceDurability, 'yes');
  assertEquals(linkOutcome.providerEvidencePersistenceError, 'provider_evidence_io_failure');
  assertEquals(
    (await linkStore.read(linkOutcome.providerEvidenceId!)).evidenceId,
    linkOutcome.providerEvidenceId,
  );
});

Deno.test('Deno evidence store and diagnostics readback retain one parent/planner artifact', async () => {
  const tempRoot = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-provider-evidence-' });
  const workspaceRoot = `${tempRoot}/workspace`;
  const stateRoot = `${tempRoot}/state`;
  await Deno.mkdir(workspaceRoot);
  const evidenceId = '55555555-5555-4555-8555-555555555555';
  const diagnosticId = '33333333-3333-4333-8333-333333333333';
  try {
    const store = new DenoProviderEvidenceStore(stateRoot, workspaceRoot);
    assertEquals(await store.list(), []);
    const recorder = new ProviderEvidenceRecorder(evidenceId, 1, '2026-09-02T00:00:00.000Z', store);
    recorder.startRequest({
      lane: 'parent',
      modelStep: 1,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      requestBody: '{"lane":"parent"}',
      requestMetadata: { contentType: 'application/json', responseMode: 'sse' },
    });
    recorder.recordResponse({
      status: 200,
      headers: { 'x-provider-evidence': 'retained', Authorization: 'response-metadata' },
    });
    recorder.appendResponseBytes(new TextEncoder().encode('parent-response'));
    recorder.startRequest({
      lane: 'planner',
      modelStep: 1,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      requestBody: '{"lane":"planner"}',
      requestMetadata: { contentType: 'application/json', responseMode: 'sse' },
    });
    recorder.recordResponse({ status: 200, headers: { 'x-provider-evidence': 'retained' } });
    recorder.appendResponseBytes(new TextEncoder().encode('planner-response'));
    recorder.finalize({
      diagnosticId,
      outcome: {
        ok: true,
        task: 'readback',
        outcome: 'final',
        stopReason: 'final',
        finalText: 'ok',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
    });
    await recorder.persist();

    const listed: string[] = [];
    const listStatus = await failureDiagnosticMain(['evidence', 'list'], {
      stateRoot,
      workspaceRoot,
      writeStdout: (text) => {
        listed.push(text);
      },
    });
    assertEquals(listStatus, 0);
    const listPayload = JSON.parse(listed.join('')) as {
      readonly evidence: readonly { readonly evidenceId: string }[];
    };
    assertEquals(listPayload.evidence.map((entry) => entry.evidenceId), [evidenceId]);

    const shown: string[] = [];
    const showStatus = await failureDiagnosticMain(['evidence', 'show', '--id', evidenceId], {
      stateRoot,
      workspaceRoot,
      writeStdout: (text) => {
        shown.push(text);
      },
    });
    assertEquals(showStatus, 0);
    const artifact = JSON.parse(shown.join('')) as {
      readonly evidenceId: string;
      readonly requests: readonly {
        readonly request: { readonly lane: string };
        readonly response?: { readonly headers: Readonly<Record<string, string>> };
      }[];
    };
    assertEquals(artifact.evidenceId, evidenceId);
    assertEquals(artifact.requests.map((entry) => entry.request.lane), ['parent', 'planner']);
    assertEquals(artifact.requests[0].response?.headers.Authorization, 'response-metadata');

    const shownByDiagnostic: string[] = [];
    const diagnosticShowStatus = await failureDiagnosticMain(
      ['evidence', 'show', '--id', diagnosticId],
      {
        stateRoot,
        workspaceRoot,
        writeStdout: (text) => {
          shownByDiagnostic.push(text);
        },
      },
    );
    assertEquals(diagnosticShowStatus, 0);
    assertEquals(
      (JSON.parse(shownByDiagnostic.join('')) as { readonly evidenceId: string }).evidenceId,
      evidenceId,
    );
    const missingErrors: string[] = [];
    await failureDiagnosticMain(
      ['evidence', 'show', '--id', '77777777-7777-4777-8777-777777777777'],
      {
        stateRoot,
        workspaceRoot,
        writeStderr: (text) => {
          missingErrors.push(text);
        },
      },
    );
    assertEquals(
      (JSON.parse(missingErrors.join('')) as { readonly error: { readonly code: string } }).error
        .code,
      'provider_evidence_not_found',
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});

Deno.test('diagnostics evidence commands have read-only list/show grammar', () => {
  assertEquals(parseFailureDiagnosticArgs(['evidence', 'list']), { kind: 'evidence_list' });
  assertEquals(
    parseFailureDiagnosticArgs([
      'evidence',
      'show',
      '--id',
      '11111111-1111-4111-8111-111111111111',
    ]),
    { kind: 'evidence_show', id: '11111111-1111-4111-8111-111111111111' },
  );
});

Deno.test('retained UI keeps provider evidence out of the conversation log', () => {
  const evidenceId = '44444444-4444-4444-8444-444444444444';
  const state = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
  });
  assertEquals(state.log.entries, []);

  const linkedFailureState = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
    providerEvidenceDurability: 'yes',
    providerEvidencePersistenceError: 'provider_evidence_io_failure',
  });
  assertEquals(linkedFailureState.log.entries, []);

  const failedState = reduceUiEvent(createUiState(), {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    providerEvidenceId: evidenceId,
    providerEvidenceDurability: 'failed',
    providerEvidencePersistenceError: 'provider_evidence_io_failure',
  });
  assertEquals(failedState.log.entries, []);
});
