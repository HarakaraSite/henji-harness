import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { ModelResult } from '../../v0/agent/core/contracts.ts';
import type { ModelGenerateOptions } from '../../v0/agent/core/contracts.ts';
import { createUiState, reduceUiEvent, type UiState } from '../../v0/tui/state.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type { ExecutionEventInput } from '../../v0/agent/history/history_store_contract.ts';
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

const progressEvents = (events: readonly AgentEvent[]): string[] =>
  events.filter((event): event is Extract<AgentEvent, { kind: 'assistant_progress' }> =>
    event.kind === 'assistant_progress'
  ).map((event) => event.text);

const thinkingEvents = (
  events: readonly AgentEvent[],
): Extract<AgentEvent, { kind: 'assistant_thinking' }>[] =>
  events.filter((event): event is Extract<AgentEvent, { kind: 'assistant_thinking' }> =>
    event.kind === 'assistant_thinking'
  );

const multiLineText = (lines: number): string =>
  Array.from(
    { length: lines },
    (_, index) => `line-${String(index).padStart(3, '0')}-${'ab'.repeat(8)}`,
  ).join('\n');

Deno.test('Increment 132 streams the assistant body at line cadence past the old freeze point', async () => {
  const text = multiLineText(40);
  const events: AgentEvent[] = [];
  let clock = 1_000;
  const outcome = await runAgentTurn(
    'stream the answer',
    [],
    {
      generate(_request, options?: ModelGenerateOptions): ModelResult {
        for (let index = 0; index < text.length; index += 1) {
          clock += 10;
          options?.reportAssistantProgress?.(text.slice(0, index + 1));
        }
        return { kind: 'final', text };
      },
    },
    new Registry([]),
    { maxSteps: 1, eventSink: (event) => events.push(event), now: () => clock },
  );
  assert(outcome.ok);
  const snapshots = progressEvents(events);
  // The whole message streams: snapshots grow far beyond the prefix the old per-request
  // accepted-report cutoff (256) froze at, and each is the complete prefix generated so far.
  assert(snapshots.length >= 5, `too few snapshots: ${snapshots.length}`);
  assert(snapshots.length < text.length, `per-fragment flood: ${snapshots.length}`);
  assert(snapshots.at(-1)!.length > 256, 'stopped at the old freeze point');
  assert(snapshots.at(-1)!.length > text.length * 0.8, 'tail of the message never streamed');
  assert(snapshots.at(-1)!.includes('line-030'), 'late lines never became visible');
  for (const [index, snapshot] of snapshots.entries()) {
    assert(text.startsWith(snapshot), `snapshot ${index} is not the generated prefix`);
    if (index > 0) assert(snapshot.length > snapshots[index - 1].length);
  }
  assertEquals(
    events.find((event) => event.kind === 'assistant_message'),
    {
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text } },
    },
  );
});

Deno.test('Increment 132 shows partial single-line growth after the maximum gap', async () => {
  const text = 'x'.repeat(200);
  const events: AgentEvent[] = [];
  let clock = 1_000;
  await runAgentTurn(
    'stream one long line',
    [],
    {
      generate(_request, options?: ModelGenerateOptions): ModelResult {
        for (let index = 0; index < text.length; index += 1) {
          clock += 60;
          options?.reportAssistantProgress?.(text.slice(0, index + 1));
        }
        return { kind: 'final', text };
      },
    },
    new Registry([]),
    { maxSteps: 1, eventSink: (event) => events.push(event), now: () => clock },
  );
  const snapshots = progressEvents(events);
  assert(snapshots.length >= 3, `no partial-line updates: ${snapshots.length}`);
  assert(
    snapshots.some((snapshot) => snapshot.length > 10 && snapshot.length < 190),
    'no intermediate partial-line snapshot',
  );
});

Deno.test('Increment 132 streams thinking live before the completed settle', async () => {
  const chunks = ['Plan a line.\n', 'Plan b line.\n', 'Plan c line.\n'];
  const full = chunks.join('');
  const events: AgentEvent[] = [];
  let clock = 1_000;
  const outcome = await runAgentTurn(
    'think then answer',
    [],
    {
      generate(_request, options?: ModelGenerateOptions): ModelResult {
        for (const chunk of chunks) {
          clock += 200;
          options?.reportThinkingDelta?.({ kind: 'text', text: chunk });
        }
        return {
          kind: 'final',
          text: 'Done.',
          providerState: {
            provider: 'openrouter-chat',
            model: 'example',
            reasoning: { field: 'reasoning_content', text: full },
          },
        };
      },
    },
    new Registry([]),
    { maxSteps: 1, eventSink: (event) => events.push(event), now: () => clock },
  );
  assert(outcome.ok);
  const thinking = thinkingEvents(events);
  // Live partial snapshots precede one completed settle for the step.
  assert(thinking.length >= 3, `too few thinking events: ${thinking.length}`);
  assert(thinking.slice(0, -1).every((event) => !event.complete));
  assert(thinking.at(-1)!.complete, 'no completed settle');
  assertEquals(thinking.at(-1)!.text, full);
  assert(
    thinking.some((event) => !event.complete && event.text.length < full.length),
    'thinking never streamed as a partial snapshot',
  );
  for (const event of thinking) {
    assertEquals(event.modelStep, 1);
    assertEquals(event.thinkingKind, 'text');
  }
});

Deno.test('Increment 132 keeps one live thinking entry per model step in the TUI log', () => {
  const apply = (state: UiState, event: Parameters<typeof reduceUiEvent>[1]): UiState =>
    reduceUiEvent(state, event);
  let ui = createUiState();
  ui = apply(ui, { kind: 'turn_start', turn: 1 });
  ui = apply(ui, { kind: 'assistant_progress', turn: 1, text: 'Hel' });
  ui = apply(ui, {
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'Thi',
    complete: false,
  });
  ui = apply(ui, {
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'Thinking now.',
    complete: false,
  });
  const streaming = ui.log.entries.filter((entry) => entry.kind === 'thinking');
  assertEquals(streaming.length, 1);
  assertEquals([streaming[0].label, streaming[0].text], ['thinking~', 'Thinking now.']);
  ui = apply(ui, {
    kind: 'assistant_thinking',
    turn: 1,
    modelStep: 1,
    thinkingKind: 'text',
    text: 'Thinking now.',
    complete: true,
  });
  ui = apply(ui, { kind: 'assistant_progress', turn: 1, text: 'Hello world.' });
  const thinking = ui.log.entries.filter((entry) => entry.kind === 'thinking');
  assertEquals(thinking.length, 1);
  assertEquals([thinking[0].label, thinking[0].text], ['thinking>', 'Thinking now.']);
  const assistant = ui.log.entries.filter((entry) => entry.kind === 'assistant');
  assertEquals(assistant.length, 1);
  assertEquals([assistant[0].label, assistant[0].text], ['assistant~', 'Hello world.']);
  assert(
    ui.log.entries.findIndex((entry) => entry.kind === 'thinking') <
      ui.log.entries.findIndex((entry) => entry.kind === 'assistant'),
  );
});

Deno.test('Increment 132 shows one settled thinking entry per step in the human timeline', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i132-session-' });
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
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {});
  const record = await store.readWorker(sessionId);
  const executionId = '13200000-0000-4000-8000-000000000001';
  const input = {
    taskId: '13200000-0000-4000-8000-000000000002',
    executionId,
    createdAt: '2026-09-26T00:00:00.000Z',
    sessionCorrelation: sessionId,
    canonicalSessionId: sessionId,
    turn: record.nextTurn,
    task: 'stream a reply',
    baseStateRevision: record.stateRevision,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build: buildManifest(),
    definition: record.definition,
  };
  const thinkingRow = (
    workerSequence: number,
    modelStep: number,
    text: string,
    complete: boolean,
  ): ExecutionEventInput => ({
    executionId,
    direction: 'worker_to_host' as const,
    source: 'worker' as const,
    kind: 'runtime_event',
    workerSequence,
    payload: {
      kind: 'runtime_event',
      correlation: {
        session: sessionId,
        instanceCorrelation: 'i132-instance',
        workerGeneration: 'i132-generation',
        baseStateRevision: record.stateRevision,
        command: 'turn-1',
      },
      sequence: workerSequence,
      event: {
        kind: 'agent_event',
        event: {
          kind: 'assistant_thinking',
          turn: record.nextTurn,
          modelStep,
          thinkingKind: 'text',
          text,
          complete,
        },
      },
    },
  });
  try {
    await store.beginExecution({ ...input, sessionMode: 'persistent' });
    // One streamed step (partial snapshot + completed settle) and one settled step.
    store.appendExecutionEvent(thinkingRow(1, 1, 'Par', false));
    store.appendExecutionEvent(thinkingRow(2, 1, 'Partial then complete.', true));
    store.appendExecutionEvent(thinkingRow(3, 2, 'Second step.', true));
    store.settleNonCanonicalExecution({
      ...input,
      outcome: {
        ok: false,
        task: input.task,
        outcome: 'cancelled',
        stopReason: 'cancelled',
        steps: 2,
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
    // No sequential replay: the streamed step keeps only its last snapshot.
    assertEquals(
      timeline[1].thinking.map((item) => [item.modelStep, item.text]),
      [[1, 'Partial then complete.'], [2, 'Second step.']],
    );
  } finally {
    store.close();
  }
});
