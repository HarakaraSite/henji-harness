import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { TurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import { readableThinkingFromState } from '../../v0/agent/core/readable_thinking.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { renderSessionTimeline } from '../../v0/agent/history/history_view.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test('Increment 120 displays only readable provider thinking and distinguishes summaries', () => {
  assertEquals(
    readableThinkingFromState({
      provider: 'openrouter-chat',
      model: 'example',
      reasoningDetails: [
        { type: 'reasoning.encrypted', data: 'ciphertext' },
        { type: 'reasoning.summary', summary: 'A short account.' },
      ],
    }),
    { kind: 'summary', text: 'A short account.' },
  );
  assertEquals(
    readableThinkingFromState({
      provider: 'openrouter-responses',
      model: 'example',
      replayItems: [{
        type: 'reasoning',
        encrypted_content: 'ciphertext',
        content: [{ type: 'reasoning_text', text: 'Readable work.' }],
        summary: [{ type: 'summary_text', text: 'Short account.' }],
      }],
    }),
    { kind: 'text', text: 'Readable work.' },
  );
  assertEquals(
    readableThinkingFromState({
      provider: 'openrouter-responses',
      replayItems: [{ type: 'reasoning', encrypted_content: 'ciphertext' }],
    }),
    undefined,
  );
});

Deno.test('Increment 120 keeps each completed model step before its tool and answer', async () => {
  const events: AgentEvent[] = [];
  let step = 0;
  const outcome = await runAgentTurn(
    'use lookup',
    [],
    {
      generate(_request, options) {
        step += 1;
        if (step === 1) {
          options?.reportThinkingDelta?.({ kind: 'text', text: 'Need the marker.' });
          return {
            kind: 'tool_calls',
            calls: [{ callId: 'c1', name: 'lookup', arguments: {} }],
            providerState: {
              provider: 'openrouter-chat',
              model: 'example',
              reasoning: { field: 'reasoning_content', text: 'Need the marker.' },
            },
          };
        }
        options?.reportThinkingDelta?.({ kind: 'summary', text: 'Checked the marker.' });
        return {
          kind: 'final',
          text: 'Done.',
          providerState: {
            provider: 'openrouter-responses',
            model: 'example',
            replayItems: [{
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Checked the marker.' }],
            }],
          },
        };
      },
    },
    new Registry([{
      name: 'lookup',
      description: 'Return marker',
      inputSchema: { type: 'object' },
      execute: () => 'marker',
    }]),
    { maxSteps: 2, eventSink: (event) => events.push(event) },
  );
  assert(outcome.ok);
  const order = events.filter((event) =>
    event.kind === 'assistant_thinking' || event.kind === 'tool_call' ||
    event.kind === 'assistant_message'
  ).map((event) =>
    event.kind === 'assistant_thinking'
      ? `${event.kind}:${event.modelStep}:${event.thinkingKind}`
      : event.kind
  );
  assertEquals(order, [
    'assistant_thinking:1:text',
    'assistant_message',
    'tool_call',
    'assistant_thinking:2:summary',
    'assistant_message',
  ]);
  let ui = createUiState();
  ui = reduceUiEvent(ui, { kind: 'turn_start', turn: 1 });
  ui = reduceUiEvent(ui, {
    kind: 'assistant_progress',
    turn: 1,
    text: 'Working',
  });
  ui = reduceUiEvent(ui, {
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'Need the marker.',
    complete: true,
  });
  ui = reduceUiEvent(ui, {
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 2,
    thinkingKind: 'summary',
    text: 'Checked the marker.',
    complete: true,
  });
  ui = reduceUiEvent(ui, {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: 'Done.' } },
  });
  assertEquals(
    ui.log.entries.filter((entry) => entry.kind === 'thinking').map((entry) => [
      entry.label,
      entry.text,
    ]),
    [
      ['thinking>', 'Need the marker.'],
      ['thinking summary>', 'Checked the marker.'],
    ],
  );
  assertEquals(ui.log.entries.map((entry) => entry.kind), [
    'thinking',
    'thinking',
    'assistant',
  ]);
});

Deno.test('Increment 120 retains the observed thinking when a model step fails', async () => {
  const events: AgentEvent[] = [];
  const outcome = await runAgentTurn(
    'fail after thinking',
    [],
    {
      generate(_request, options) {
        options?.reportThinkingDelta?.({ kind: 'text', text: 'First part. ' });
        options?.reportThinkingDelta?.({ kind: 'text', text: 'Second part.' });
        throw new Error('provider failed');
      },
    },
    new Registry([]),
    { eventSink: (event) => events.push(event) },
  );
  assertEquals(outcome.stopReason, 'contract_failure');
  assertEquals(events.filter((event) => event.kind === 'assistant_thinking'), [{
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'First part. Second part.',
    complete: false,
  }]);
});

Deno.test('Increment 120 retains partial thinking after cancellation', async () => {
  const events: AgentEvent[] = [];
  const outcome = await runAgentTurn(
    'cancel after thinking',
    [],
    {
      generate(_request, options) {
        options?.reportThinkingDelta?.({ kind: 'text', text: 'Observed before cancel.' });
        throw new TurnCancelledError();
      },
    },
    new Registry([]),
    { eventSink: (event) => events.push(event) },
  );
  assertEquals(outcome.stopReason, 'cancelled');
  assertEquals(events.filter((event) => event.kind === 'assistant_thinking'), [{
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'Observed before cancel.',
    complete: false,
  }]);
});

Deno.test('Increment 120 reads cancelled thinking in the normal Session view from semantic rows', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i120-session-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const created = await createWorkerSession({
    workspaceRoot,
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  const sessionId = created.session.sessionId;
  assert((await created.session.submit('initial turn')).ok);
  await created.close();
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {
    captureProfile: 'normal-v1',
  });
  const record = await store.readWorker(sessionId);
  const executionId = '12000000-0000-4000-8000-000000000001';
  const input = {
    taskId: '12000000-0000-4000-8000-000000000002',
    executionId,
    createdAt: '2026-09-24T00:00:00.000Z',
    sessionCorrelation: sessionId,
    canonicalSessionId: sessionId,
    turn: record.nextTurn,
    task: 'compare README files',
    baseStateRevision: record.stateRevision,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition: record.definition,
  };
  try {
    await store.beginExecution({ ...input, sessionMode: 'persistent' });
    store.appendExecutionEvent({
      executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'runtime_event',
        correlation: {
          session: sessionId,
          instanceCorrelation: 'i120-instance',
          workerGeneration: 'i120-generation',
          baseStateRevision: record.stateRevision,
          command: 'turn-1',
        },
        sequence: 1,
        event: {
          kind: 'agent_event',
          event: {
            kind: 'assistant_thinking',
            turn: record.nextTurn,
            modelStep: 1,
            thinkingKind: 'text',
            text: 'The sections correspond.',
            complete: false,
          },
        },
      },
    });
    store.settleNonCanonicalExecution({
      ...input,
      outcome: {
        ok: false,
        task: input.task,
        outcome: 'cancelled',
        stopReason: 'cancelled',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [
          ...record.transcript,
          { role: 'user', content: { kind: 'text', text: input.task } },
        ],
      },
    });
    const timeline = store.readSessionHistory(sessionId);
    assertEquals(timeline.length, 2);
    assertEquals(timeline[1].thinking[0].text, 'The sections correspond.');
    const view = renderSessionTimeline(timeline);
    assert(view.includes('non_canonical · cancelled'));
    assert(view.includes('thinking~ The sections correspond.'));
    assert(view.indexOf('user> compare README files') < view.indexOf('thinking~'));
  } finally {
    store.close();
  }
});
