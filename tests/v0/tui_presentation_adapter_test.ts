import { assert, assertEquals } from './test_helpers.ts';
import { TuiPresentationAdapter } from '../../v0/agent/tui_presentation_adapter.ts';
import { PresentationDeliveryError } from '../../v0/presentation/contract.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';
import { type LoopOutcome } from '../../v0/agent/contracts.ts';

const final = (task: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText: 'done',
  steps: 1,
  toolCallCount: 1,
  toolResultCount: 1,
  transcript: [],
});

Deno.test('adapter emits causal opaque tool identity and no raw provider call id', () => {
  const events: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    { submit: () => Promise.resolve(final('task')) },
    (event) => events.push(event),
  );
  const flow: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    {
      kind: 'assistant_message',
      turn: 1,
      message: {
        role: 'assistant',
        content: [{ kind: 'tool_call', callId: 'provider-secret-id', name: 'read', arguments: {} }],
      },
    },
    {
      kind: 'tool_call',
      turn: 1,
      call: { callId: 'provider-secret-id', name: 'read', arguments: {} },
    },
    {
      kind: 'tool_progress',
      turn: 1,
      callId: 'provider-secret-id',
      name: 'read',
      text: 'progress',
    },
    {
      kind: 'tool_result',
      turn: 1,
      result: {
        kind: 'tool_result',
        callId: 'provider-secret-id',
        name: 'read',
        text: 'done',
        outcome: 'success',
      },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
  ];
  for (const event of flow) adapter.deliverCoreEvent(event);
  const rendered = JSON.stringify(events);
  assert(rendered.includes('call-1'));
  assert(!rendered.includes('provider-secret-id'));
  assertEquals(
    (events as { readonly kind: string }[]).filter((event) => event.kind === 'tool_call').length,
    1,
  );
  assertEquals(
    (events as { readonly kind: string }[]).filter((event) => event.kind === 'tool_result').length,
    1,
  );
});

Deno.test('adapter maps core outcomes and retains only bounded context facts', async () => {
  const adapter = new TuiPresentationAdapter({
    submit: () => Promise.resolve(final('bounded')),
    contextSnapshot: () => ({
      messageEstimatedTokensBefore: 1,
      messageEstimatedTokensAfter: 2,
      toolEstimatedTokens: 3,
      requestEstimatedTokensBefore: 4,
      requestEstimatedTokensAfter: 5,
      triggerTokens: 65_536,
      targetTokens: 49_152,
      triggered: false,
      targetReached: true,
      compressedResultCount: 0,
      compressedMessageCount: 0,
    }),
  });
  assertEquals((await adapter.submit('bounded')).finalText, 'done');
  assertEquals(adapter.contextSnapshot()?.messageEstimatedTokensAfter, 2);
});

Deno.test('adapter turns malformed argument graphs into a sanitized delivery error', () => {
  const adapter = new TuiPresentationAdapter({ submit: () => Promise.resolve(final('task')) });
  const cyclic = {} as Record<string, import('../../v0/agent/contracts.ts').JsonValue>;
  cyclic.self = cyclic;
  let rejected = false;
  try {
    adapter.deliverCoreEvent({
      kind: 'tool_call',
      turn: 1,
      call: { callId: 'provider-secret', name: 'read', arguments: cyclic },
    });
  } catch (error) {
    rejected = error instanceof PresentationDeliveryError;
  }
  assert(rejected);
});

Deno.test('unknown core activity becomes one fixed warning without payload stringification', () => {
  const events: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    { submit: () => Promise.resolve(final('task')) },
    (event) => events.push(event),
  );
  adapter.deliverCoreEvent(
    { kind: 'future_activity', secret: 'credential-marker' } as unknown as AgentEvent,
  );
  assertEquals(events, [{
    kind: 'warning',
    code: 'unsupported_activity',
    text: 'unsupported activity omitted',
    generation: 1,
  }]);
  assert(!JSON.stringify(events).includes('credential-marker'));
});

Deno.test('adapter intent dispatcher validates before admission and preserves typed outcomes', async () => {
  const calls: string[] = [];
  const adapter = new TuiPresentationAdapter({
    submit: (task) => {
      calls.push(task);
      return Promise.resolve(final(task));
    },
  });
  const result = await adapter.dispatch({ kind: 'ordinary_submit', text: 'typed task' });
  assertEquals(result.kind, 'outcome');
  assertEquals(calls, ['typed task']);
  let rejected = false;
  try {
    adapter.dispatch({ kind: 'ordinary_submit', text: 'bad\0task' });
  } catch (error) {
    rejected = error instanceof PresentationDeliveryError;
  }
  assert(rejected);
  assertEquals(calls, ['typed task']);
  const idle = adapter.dispatch({ kind: 'cancel_active' });
  assertEquals(idle, { kind: 'rejected', reason: 'idle' });
});

Deno.test('adapter owns cancellation and compaction operation settlement', async () => {
  let abortSeen = false;
  const adapter = new TuiPresentationAdapter({
    submit: () => Promise.resolve(final('task')),
    compactContext: (signal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortSeen = true;
          reject(new Error('cancelled'));
        }, { once: true });
        setTimeout(
          () => resolve({ kind: 'installed', coveredThroughTurn: 1, retainedFromTurn: 1 }),
          30,
        );
      }),
  });
  const operation = adapter.dispatch({ kind: 'compaction', action: 'confirm' });
  assert(operation instanceof Promise);
  adapter.dispatch({ kind: 'compaction', action: 'cancel' });
  try {
    await operation;
  } catch {
    // Adapter preserves the core cancellation result while owning the abort controller.
  }
  assert(abortSeen);
});

Deno.test('adapter adopts an irreversible navigation binding before authoritative event delivery', async () => {
  const events: { readonly kind: string }[] = [];
  const target = {
    submit: () => Promise.resolve(final('target')),
    currentPosition: () => ({
      sessionId: 'target',
      agent: 'default' as const,
      committedTurn: 2,
      messageCount: 4,
    }),
  };
  const adapter = new TuiPresentationAdapter(
    { submit: () => Promise.resolve(final('current')) },
    (event) => events.push(event),
    {
      persistent: true,
      list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
      switchTo: () =>
        Promise.resolve({
          session: target,
          position: target.currentPosition(),
          restored: {
            messages: [{ role: 'user', content: { kind: 'text', text: 'target task' } }],
            omitted: 0,
          },
        }),
      historyPage: () => Promise.resolve(undefined),
      currentPosition: target.currentPosition,
    },
  );
  const result = await adapter.dispatch({ kind: 'resume_session', id: 'target' });
  assertEquals(result.kind, 'binding');
  assertEquals(events.map((event) => event.kind), ['session_binding_replaced', 'restored_log']);
  assertEquals(adapter.currentPosition()?.sessionId, 'target');
  assertEquals((await adapter.submit('next')).task, 'target');
});

Deno.test('adapter owns navigation abort signals until dismissed operations settle', async () => {
  let listSignal: AbortSignal | undefined;
  let switchSignal: AbortSignal | undefined;
  const current = 'current';
  const delayed = (signal: AbortSignal | undefined): Promise<never> =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('navigation cancelled')), 4);
      }, { once: true });
    });
  const navigation = {
    persistent: true,
    list: (signal?: AbortSignal) => {
      listSignal = signal;
      return delayed(signal);
    },
    switchTo: (_id: string, signal?: AbortSignal) => {
      switchSignal = signal;
      return delayed(signal);
    },
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => ({
      sessionId: current,
      agent: 'default' as const,
      committedTurn: 0,
      messageCount: 0,
    }),
  };
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.resolve(final('task')),
      currentPosition: () => ({
        sessionId: current,
        agent: 'default' as const,
        committedTurn: 0,
        messageCount: 0,
      }),
    },
    undefined,
    navigation,
  );
  const list = adapter.dispatch({ kind: 'list_sessions' });
  assert(list instanceof Promise);
  assertEquals(adapter.dispatch({ kind: 'dismiss_overlay' }), { kind: 'accepted' });
  try {
    await list;
  } catch {
    // Cancellation is intentionally observed only after the host settles its cleanup.
  }
  assert(listSignal?.aborted === true);

  const switched = adapter.dispatch({ kind: 'resume_session', id: 'target' });
  assert(switched instanceof Promise);
  assertEquals(adapter.dispatch({ kind: 'exit', code: 0 }), { kind: 'exit', code: 0 });
  try {
    await switched;
  } catch {
    // The adapter's private operation owner receives the typed exit cancellation.
  }
  assert(switchSignal?.aborted === true);
  assertEquals(adapter.currentPosition()?.sessionId, 'current');
});
