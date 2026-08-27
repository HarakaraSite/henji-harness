import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  CONTEXT_TARGET_ESTIMATED_TOKENS,
  CONTEXT_TRIGGER_ESTIMATED_TOKENS,
  type ContextMetrics,
  OMITTED_TOOL_RESULT_TEXT,
  prepareModelContext,
} from '../../v0/agent/context.ts';
import {
  type LoopOutcome,
  type Message,
  type ModelRequest,
  type ToolCall,
  type ToolDefinition,
} from '../../v0/agent/contracts.ts';
import { TurnCancellationOwner } from '../../v0/agent/cancellation.ts';
import {
  createTurnExecutionContext,
  ParentTurnExecutionContext,
} from '../../v0/agent/execution_context.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { OpenRouterAgentModel } from '../../v0/agent/openrouter_model.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { Registry, type Tool } from '../../v0/agent/tools.ts';

const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const tools: readonly ToolDefinition[] = [];

const userRequest = (text: string, systemInstruction?: string): ModelRequest =>
  systemInstruction === undefined
    ? { transcript: [{ role: 'user', content: { kind: 'text', text } }], tools }
    : {
      systemInstruction,
      transcript: [{ role: 'user', content: { kind: 'text', text } }],
      tools,
    };

const result = (
  callId: string,
  text: string,
  outcome: 'success' | 'error' = 'success',
): Message => ({
  role: 'tool',
  content: [{ kind: 'tool_result', callId, name: 'capture', text, outcome }],
});

const call = (callId: string): ToolCall => ({
  callId,
  name: 'capture',
  arguments: { nested: { callId } },
});

const contextRequest = (transcript: readonly Message[]): ModelRequest => ({ transcript, tools });

const exactUserRequest = (bytes: number): ModelRequest => {
  const empty = userRequest('');
  const prefixBytes = jsonBytes({ transcript: empty.transcript });
  return userRequest('x'.repeat(bytes - prefixBytes));
};

const snapshotMetrics = (metrics: ContextMetrics | undefined): ContextMetrics | undefined =>
  metrics === undefined ? undefined : { ...metrics };

Deno.test('context constants and envelope estimates use UTF-8 stable JSON bytes', () => {
  const request = userRequest('😀"\\\n', 'system π');
  const prepared = prepareModelContext(request);
  assertEquals(
    prepared.metrics.messageEstimatedTokensBefore,
    jsonBytes({
      systemInstruction: 'system π',
      transcript: request.transcript,
    }),
  );
  assertEquals(prepared.metrics.toolEstimatedTokens, jsonBytes([]));
  assertEquals(
    prepared.metrics.requestEstimatedTokensBefore,
    jsonBytes({
      systemInstruction: 'system π',
      transcript: request.transcript,
      tools: [],
    }),
  );
  assertEquals(prepared.metrics.triggerTokens, CONTEXT_TRIGGER_ESTIMATED_TOKENS);
  assertEquals(prepared.metrics.targetTokens, CONTEXT_TARGET_ESTIMATED_TOKENS);
  assertEquals(encoder.encode(OMITTED_TOOL_RESULT_TEXT).byteLength, 39);
  assertEquals(prepared.request, request);
});

Deno.test('below-threshold requests retain shape, values, and independent nested snapshots', () => {
  const request: ModelRequest = {
    systemInstruction: 'instruction',
    transcript: [
      { role: 'user', content: { kind: 'text', text: 'user' } },
      {
        role: 'assistant',
        content: [{ kind: 'tool_call', ...call('one'), arguments: { nested: { value: 'x' } } }],
      },
      result('one', 'small'),
    ],
    tools: [{ name: 'capture', description: 'capture', inputSchema: { nested: { value: 'x' } } }],
  };
  const prepared = prepareModelContext(request);
  assert(!prepared.metrics.triggered);
  assertEquals(
    prepared.metrics.messageEstimatedTokensAfter,
    prepared.metrics.messageEstimatedTokensBefore,
  );
  assertEquals(
    prepared.metrics.requestEstimatedTokensAfter,
    prepared.metrics.requestEstimatedTokensBefore,
  );
  assertEquals(prepared.metrics.compressedResultCount, 0);
  assertEquals(prepared.request, request);
  const preparedAssistant = prepared.request.transcript[1];
  assert(preparedAssistant.role === 'assistant' && Array.isArray(preparedAssistant.content));
  (preparedAssistant.content[0].arguments as { nested: { value: string } }).nested.value =
    'changed';
  (prepared.request.tools[0].inputSchema as { nested: { value: string } }).nested.value = 'changed';
  const originalAssistant = request.transcript[1];
  assert(originalAssistant.role === 'assistant' && Array.isArray(originalAssistant.content));
  assertEquals(
    (originalAssistant.content[0].arguments as { nested: { value: string } }).nested.value,
    'x',
  );
  assertEquals((request.tools[0].inputSchema as { nested: { value: string } }).nested.value, 'x');
});

Deno.test('exact 65,535 and 65,536 message-byte boundaries select trigger deterministically', () => {
  const below = prepareModelContext(exactUserRequest(CONTEXT_TRIGGER_ESTIMATED_TOKENS - 1));
  const exact = prepareModelContext(exactUserRequest(CONTEXT_TRIGGER_ESTIMATED_TOKENS));
  assertEquals(below.metrics.messageEstimatedTokensBefore, CONTEXT_TRIGGER_ESTIMATED_TOKENS - 1);
  assertEquals(exact.metrics.messageEstimatedTokensBefore, CONTEXT_TRIGGER_ESTIMATED_TOKENS);
  assert(!below.metrics.triggered);
  assert(exact.metrics.triggered);
  assert(!exact.metrics.targetReached);
  assertEquals(exact.metrics.compressedResultCount, 0);
});

Deno.test('oldest tool messages and batch results compress until target while newest is protected', () => {
  const oldFirst = result('old-first', 'a'.repeat(25_000));
  const oldBatch: Message = {
    role: 'tool',
    content: [
      {
        kind: 'tool_result',
        callId: 'batch-one',
        name: 'capture',
        text: 'b'.repeat(25_000),
        outcome: 'success',
      },
      {
        kind: 'tool_result',
        callId: 'batch-two',
        name: 'capture',
        text: 'c'.repeat(25_000),
        outcome: 'error',
      },
    ],
  };
  const newest = result('newest', 'newest'.repeat(6_250));
  const request = contextRequest([
    { role: 'user', content: { kind: 'text', text: 'task' } },
    oldFirst,
    oldBatch,
    newest,
  ]);
  const prepared = prepareModelContext(request);
  assert(prepared.metrics.triggered);
  assert(prepared.metrics.targetReached);
  assertEquals(prepared.metrics.compressedResultCount, 3);
  assertEquals(prepared.metrics.compressedMessageCount, 2);
  assertEquals(prepared.request.transcript[1], result('old-first', OMITTED_TOOL_RESULT_TEXT));
  assertEquals(prepared.request.transcript[2], {
    role: 'tool',
    content: [
      {
        kind: 'tool_result',
        callId: 'batch-one',
        name: 'capture',
        text: OMITTED_TOOL_RESULT_TEXT,
        outcome: 'success',
      },
      {
        kind: 'tool_result',
        callId: 'batch-two',
        name: 'capture',
        text: OMITTED_TOOL_RESULT_TEXT,
        outcome: 'error',
      },
    ],
  });
  assertEquals(prepared.request.transcript[3], newest);
  assertEquals(request.transcript[1], oldFirst);
  assertEquals(request.transcript[2], oldBatch);
});

Deno.test('context stops at the target with an older terminal candidate still beneficial', () => {
  const oldFirst = result('old-first', 'a'.repeat(22_000));
  const oldTerminal: Message = {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'old-terminal',
      name: 'capture',
      text: 'b'.repeat(22_000),
      outcome: 'success',
      terminal: 'json_result',
    }],
  };
  const remaining = result('remaining', 'c'.repeat(22_000));
  const newest: Message = {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'newest-terminal',
      name: 'capture',
      text: 'd'.repeat(22_000),
      outcome: 'success',
      terminal: 'json_result',
    }],
  };
  const request = contextRequest([
    { role: 'user', content: { kind: 'text', text: 'target stop' } },
    oldFirst,
    oldTerminal,
    remaining,
    newest,
  ]);
  const prepared = prepareModelContext(request);
  assert(prepared.metrics.triggered);
  assert(prepared.metrics.targetReached);
  assertEquals(prepared.metrics.compressedResultCount, 2);
  assertEquals(prepared.metrics.compressedMessageCount, 2);
  assert(prepared.metrics.messageEstimatedTokensAfter <= CONTEXT_TARGET_ESTIMATED_TOKENS);
  assertEquals(
    prepared.metrics.messageEstimatedTokensAfter,
    jsonBytes({
      transcript: prepared.request.transcript,
    }),
  );
  assertEquals(
    prepared.metrics.requestEstimatedTokensAfter,
    jsonBytes({
      transcript: prepared.request.transcript,
      tools: [],
    }),
  );
  assertEquals(prepared.request.transcript[1], result('old-first', OMITTED_TOOL_RESULT_TEXT));
  assertEquals(prepared.request.transcript[2], {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'old-terminal',
      name: 'capture',
      text: OMITTED_TOOL_RESULT_TEXT,
      outcome: 'success',
      terminal: 'json_result',
    }],
  });
  // The next older candidate would also help, but the exact target made it unnecessary.
  assertEquals(prepared.request.transcript[3], remaining);
  assertEquals(prepared.request.transcript[4], newest);
  assertEquals(request.transcript, [
    { role: 'user', content: { kind: 'text', text: 'target stop' } },
    oldFirst,
    oldTerminal,
    remaining,
    newest,
  ]);
});

Deno.test('context can land on the exact 49,152 target and leave another candidate verbatim', () => {
  // This fixed ASCII fixture puts the request exactly at the target after one 20,000-byte result
  // is replaced. The following 20,000-byte result remains beneficial but must not be touched.
  const request = contextRequest([
    { role: 'user', content: { kind: 'text', text: 'u'.repeat(28_694) } },
    result('first', 'a'.repeat(20_000)),
    result('remaining', 'b'.repeat(20_000)),
    result('newest', 'n'),
  ]);
  const prepared = prepareModelContext(request);
  assert(prepared.metrics.triggered);
  assert(prepared.metrics.targetReached);
  assertEquals(prepared.metrics.messageEstimatedTokensAfter, CONTEXT_TARGET_ESTIMATED_TOKENS);
  assertEquals(
    prepared.metrics.requestEstimatedTokensAfter,
    jsonBytes({
      transcript: prepared.request.transcript,
      tools: [],
    }),
  );
  assertEquals(prepared.metrics.compressedResultCount, 1);
  assertEquals(prepared.metrics.compressedMessageCount, 1);
  assertEquals(prepared.request.transcript[1], result('first', OMITTED_TOOL_RESULT_TEXT));
  assertEquals(prepared.request.transcript[2], result('remaining', 'b'.repeat(20_000)));
  assertEquals(prepared.request.transcript[3], result('newest', 'n'));
  assertEquals(
    prepared.metrics.messageEstimatedTokensAfter,
    jsonBytes({
      transcript: prepared.request.transcript,
    }),
  );
});

Deno.test('marker-sized and shorter result text is never replaced, and no candidate may miss target', () => {
  const markerEqual = result('equal', OMITTED_TOOL_RESULT_TEXT);
  const short = result('short', 'short');
  const request = contextRequest([
    { role: 'user', content: { kind: 'text', text: 'x'.repeat(70_000) } },
    markerEqual,
    short,
  ]);
  const prepared = prepareModelContext(request);
  assert(prepared.metrics.triggered);
  assert(!prepared.metrics.targetReached);
  assertEquals(prepared.metrics.compressedResultCount, 0);
  assertEquals(prepared.request.transcript, request.transcript);
});

Deno.test('metadata, causal order, arguments, and user/assistant text survive replacement', () => {
  const request: ModelRequest = {
    systemInstruction: 'system',
    transcript: [
      { role: 'user', content: { kind: 'text', text: 'user ' + 'u'.repeat(20_000) } },
      {
        role: 'assistant',
        content: [{
          kind: 'tool_call',
          callId: 'call-1',
          name: 'capture',
          arguments: { nested: ['π'] },
        }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'call-1',
          name: 'capture',
          text: 'old'.repeat(20_000),
          outcome: 'success',
        }],
      },
      { role: 'assistant', content: { kind: 'text', text: 'assistant ' + 'a'.repeat(20_000) } },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'call-2',
          name: 'capture',
          text: 'new'.repeat(20_000),
          outcome: 'success',
          terminal: 'json_result',
        }],
      },
    ],
    tools: [{ name: 'capture', description: 'capture', inputSchema: { type: 'object' } }],
  };
  const prepared = prepareModelContext(request);
  assert(prepared.metrics.compressedResultCount > 0);
  assertEquals(prepared.request.transcript[0], request.transcript[0]);
  assertEquals(prepared.request.transcript[1], request.transcript[1]);
  assertEquals(prepared.request.transcript[2], {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'call-1',
      name: 'capture',
      text: OMITTED_TOOL_RESULT_TEXT,
      outcome: 'success',
    }],
  });
  assertEquals(prepared.request.transcript[3], request.transcript[3]);
  assertEquals(prepared.request.transcript[4], request.transcript[4]);
});

Deno.test('linear delta metrics equal stable reserialization of the prepared request', () => {
  const request = contextRequest([
    { role: 'user', content: { kind: 'text', text: 'x'.repeat(10_000) } },
    result('old', 'old'.repeat(30_000)),
    result('new', 'new'.repeat(30_000)),
  ]);
  const prepared = prepareModelContext(request);
  const messageEnvelope = { transcript: prepared.request.transcript };
  const requestEnvelope = {
    transcript: prepared.request.transcript,
    tools: prepared.request.tools,
  };
  assertEquals(prepared.metrics.messageEstimatedTokensAfter, jsonBytes(messageEnvelope));
  assertEquals(prepared.metrics.requestEstimatedTokensAfter, jsonBytes(requestEnvelope));
  assertEquals(
    prepared.metrics.requestEstimatedTokensBefore - prepared.metrics.requestEstimatedTokensAfter,
    prepared.metrics.messageEstimatedTokensBefore - prepared.metrics.messageEstimatedTokensAfter,
  );
});

Deno.test('every loop step regenerates from the full transcript rather than an earlier marker view', async () => {
  const longText = 'tool output '.repeat(7_000);
  const requests: ModelRequest[] = [];
  const tool: Tool = {
    name: 'capture',
    description: 'capture',
    inputSchema: {},
    execute: () => longText,
  };
  const outcome = await runAgent(
    'context loop',
    {
      generate(request) {
        requests.push(request);
        if (requests.length === 1) return { kind: 'tool_calls' as const, calls: [call('one')] };
        if (requests.length === 2) {
          const old = request.transcript[2];
          assert(old?.role === 'tool');
          (old.content[0] as { text: string }).text = 'poisoned request view';
          return { kind: 'tool_calls' as const, calls: [call('two')] };
        }
        const old = request.transcript[2];
        const newest = request.transcript[4];
        assert(old?.role === 'tool' && newest?.role === 'tool');
        assertEquals(old.content[0].text, OMITTED_TOOL_RESULT_TEXT);
        assertEquals(newest.content[0].text, longText);
        return { kind: 'final' as const, text: 'done' };
      },
    },
    new Registry([tool]),
    { maxSteps: 3 },
  );
  assert(outcome.ok);
  assertEquals(requests.length, 3);
  assertEquals(outcome.transcript[2], result('one', longText));
  assertEquals(outcome.transcript[4], result('two', longText));
});

Deno.test('session context snapshot is committed only with successful turns and is defensive', async () => {
  const longText = 'session tool output '.repeat(1_700);
  let requests = 0;
  const tool: Tool = {
    name: 'capture',
    description: 'capture',
    inputSchema: {},
    execute: () => longText,
  };
  const session = new AgentSession(
    {
      generate: () => {
        requests += 1;
        if (requests === 1 || requests === 3) {
          return { kind: 'tool_calls' as const, calls: [call(`call-${requests}`)] };
        }
        if (requests === 2 || requests === 4) return { kind: 'final' as const, text: 'kept' };
        throw new Error('expected failed turn');
      },
    },
    new Registry([tool]),
  );
  assertEquals(session.contextSnapshot(), undefined);
  await session.submit('first');
  const first = session.contextSnapshot();
  assert(first !== undefined);
  assertEquals(first.compressedResultCount, 0);
  await session.submit('second');
  const committed = session.contextSnapshot();
  assert(committed !== undefined);
  assert(committed.compressedResultCount > 0);
  assert(committed.messageEstimatedTokensAfter <= CONTEXT_TARGET_ESTIMATED_TOKENS);
  const exposed = session.contextSnapshot()!;
  (exposed as { compressedResultCount: number }).compressedResultCount = 999;
  assertEquals(session.contextSnapshot()!.compressedResultCount, committed.compressedResultCount);
  const beforeFailure = snapshotMetrics(session.contextSnapshot());
  const failed = await session.submit('failure');
  assert(!failed.ok);
  assertEquals(session.contextSnapshot(), beforeFailure);
  assertEquals(session.transcriptSnapshot().filter((message) => message.role === 'user').length, 2);
});

Deno.test('event-delivery rollback restores the exact prior transcript and context snapshot', async () => {
  const longText = 'rollback output '.repeat(2_200);
  let requests = 0;
  let rejectTurnEnd = false;
  const session = new AgentSession(
    {
      generate: () => {
        requests += 1;
        if (requests === 1 || requests === 2) {
          return { kind: 'tool_calls' as const, calls: [call(`call-${requests}`)] };
        }
        if (requests === 3) return { kind: 'final' as const, text: 'first committed' };
        if (requests === 4) return { kind: 'final' as const, text: 'second draft' };
        throw new Error('unexpected model request');
      },
    },
    new Registry([{
      name: 'capture',
      description: 'capture',
      inputSchema: {},
      execute: () => longText,
    }]),
    {
      eventSink: (event) => {
        if (rejectTurnEnd && event.kind === 'turn_end') throw new Error('reject turn end');
      },
    },
  );
  const first = await session.submit('first');
  assert(first.ok);
  const priorTranscript = session.transcriptSnapshot();
  const priorContext = snapshotMetrics(session.contextSnapshot());
  assert(priorContext !== undefined);
  assert(priorContext.compressedResultCount > 0);
  rejectTurnEnd = true;
  await assertRejects(() => session.submit('rejected second'));
  assertEquals(session.transcriptSnapshot(), priorTranscript);
  assertEquals(session.contextSnapshot(), priorContext);
  assertEquals(requests, 4);
});

Deno.test('parent and child loops keep independent marker views and exact shared budget snapshots', async () => {
  const longText = 'lane output '.repeat(2_900);
  const parentRequests: ModelRequest[] = [];
  const childRequests: ModelRequest[] = [];
  const childOutcomes: Array<{ readonly outcome: LoopOutcome }> = [];
  let beforeChild: ReturnType<ParentTurnExecutionContext['snapshot']> | undefined;
  let afterChild: ReturnType<ParentTurnExecutionContext['snapshot']> | undefined;
  const capture: Tool = {
    name: 'capture',
    description: 'capture long lane output',
    inputSchema: {},
    execute: () => longText,
  };
  const childModel = {
    generate(request: ModelRequest) {
      childRequests.push(request);
      if (childRequests.length <= 2) {
        return { kind: 'tool_calls' as const, calls: [call(`child-${childRequests.length}`)] };
      }
      const old = request.transcript[2];
      const newest = request.transcript[4];
      assert(old?.role === 'tool' && newest?.role === 'tool');
      assertEquals(old.content[0].text, OMITTED_TOOL_RESULT_TEXT);
      assertEquals(newest.content[0].text, longText);
      return { kind: 'final' as const, text: 'child plan' };
    },
  };
  const planner = createPlannerDelegationTool((task, childContext) => {
    assertEquals(task, 'child task');
    beforeChild = childContext.snapshot();
    const outcome = runAgent(
      task,
      childModel,
      new Registry([capture]),
      { maxSteps: 3, executionContext: childContext, ownsCancellation: false },
    );
    return outcome.then((childOutcome) => {
      childOutcomes.push({ outcome: childOutcome });
      afterChild = childContext.snapshot();
      return { outcome: childOutcome, externalRequests: 1 };
    });
  });
  const parentContext = new ParentTurnExecutionContext(1);
  const parentModel = {
    generate(request: ModelRequest) {
      parentRequests.push(request);
      if (parentRequests.length <= 2) {
        return { kind: 'tool_calls' as const, calls: [call(`parent-${parentRequests.length}`)] };
      }
      if (parentRequests.length === 3) {
        const old = request.transcript[2];
        const newest = request.transcript[4];
        assert(old?.role === 'tool' && newest?.role === 'tool');
        assertEquals(old.content[0].text, OMITTED_TOOL_RESULT_TEXT);
        assertEquals(newest.content[0].text, longText);
        return {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'delegate',
            name: 'delegate_to_planner',
            arguments: { task: 'child task' },
          }],
        };
      }
      const delegateResult = request.transcript.at(-1);
      assert(delegateResult?.role === 'tool');
      assert(delegateResult.content[0].text.includes('child plan'));
      assertEquals(
        request.transcript.filter((message) => message.role === 'tool').slice(0, 2).map(
          (message) => message.content[0].text,
        ),
        [OMITTED_TOOL_RESULT_TEXT, longText],
      );
      return { kind: 'final' as const, text: 'parent final' };
    },
  };
  const parentOutcome = await runAgent(
    'parent task',
    parentModel,
    new Registry([capture, planner]),
    { maxSteps: 4, executionContext: parentContext },
  );
  assert(parentOutcome.ok);
  assertEquals(childOutcomes.length, 1);
  assert(childOutcomes[0].outcome.ok);
  assertEquals(parentRequests.length, 4);
  assertEquals(childRequests.length, 3);
  assertEquals(beforeChild, { parent: 3, child: 0, aggregate: 3 });
  assertEquals(afterChild, { parent: 3, child: 3, aggregate: 6 });
  assertEquals(parentContext.snapshot(), { parent: 4, child: 3, aggregate: 7 });
  assertEquals(parentOutcome.transcript[2], result('parent-1', longText));
  assertEquals(childOutcomes[0].outcome.transcript[2], result('child-1', longText));
  assert(!JSON.stringify(parentOutcome.transcript).includes(OMITTED_TOOL_RESULT_TEXT));
  assert(!JSON.stringify(childOutcomes[0].outcome.transcript).includes(OMITTED_TOOL_RESULT_TEXT));
});

Deno.test('cancellation and context preparation failure claim no model request', async () => {
  const cancelledOwner = new TurnCancellationOwner();
  cancelledOwner.request();
  const cancelledContext = createTurnExecutionContext(1, cancelledOwner.signal, cancelledOwner);
  let cancelledModelCalls = 0;
  const cancelled = await runAgent(
    'cancel before preparation',
    {
      generate: () => {
        cancelledModelCalls += 1;
        return { kind: 'final' as const, text: 'must not run' };
      },
    },
    new Registry([]),
    {
      executionContext: cancelledContext,
      cancellation: cancelledOwner,
      signal: cancelledOwner.signal,
    },
  );
  assert(!cancelled.ok);
  assertEquals(cancelled.stopReason, 'cancelled');
  assertEquals(cancelledModelCalls, 0);
  assertEquals(cancelledContext.snapshot(), { parent: 0, child: 0, aggregate: 0 });

  const failedContext = createTurnExecutionContext(1);
  let failedModelCalls = 0;
  const invalidSchema = BigInt(1) as never;
  const failed = await runAgent(
    'preparation failure',
    {
      generate: () => {
        failedModelCalls += 1;
        return { kind: 'final' as const, text: 'must not run' };
      },
    },
    new Registry([{
      name: 'invalid-schema',
      description: 'invalid only for this regression',
      inputSchema: invalidSchema,
      execute: () => 'unreachable',
    }]),
    { executionContext: failedContext },
  );
  assert(!failed.ok);
  assertEquals(failed.stopReason, 'contract_failure');
  assert(failed.error?.startsWith('context preparation failure:'));
  assertEquals(failedModelCalls, 0);
  assertEquals(failed.steps, 0);
  assertEquals(failedContext.snapshot(), { parent: 0, child: 0, aggregate: 0 });
});

Deno.test('fake OpenRouter accepts irreducible 64–76 KiB input and rejects over-limit before fetch', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'accepted' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const accepted = await runAgent(
    'x'.repeat(70 * 1024),
    new OpenRouterAgentModel({ fetcher, credential: 'offline-test-credential' }),
    new Registry([]),
    { maxSteps: 1 },
  );
  assert(accepted.ok);
  assertEquals(accepted.finalText, 'accepted');
  assertEquals(calls.length, 1);

  calls.length = 0;
  const rejected = await runAgent(
    'x'.repeat(77 * 1024),
    new OpenRouterAgentModel({ fetcher, credential: 'offline-test-credential' }),
    new Registry([]),
    { maxSteps: 1 },
  );
  assert(!rejected.ok);
  assertEquals(rejected.stopReason, 'contract_failure');
  assert(rejected.error?.includes('76 KiB'));
  assertEquals(rejected.steps, 1);
  assertEquals(calls.length, 0);
});
