import { AgentSession } from '../../v0/agent/session/session.ts';
import type { Message, ModelResult } from '../../v0/agent/core/contracts.ts';
import type { SemanticContextCheckpointV1 } from '../../v0/agent/session/session_store.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
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

const big = (prefix: string): string => `${prefix}-${'x'.repeat(100_000)}`;

const longRecord = (turns: number) => {
  const transcript: Message[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    transcript.push({ role: 'user', content: { kind: 'text', text: `task-${turn}` } });
    transcript.push({
      role: 'assistant',
      content: { kind: 'text', text: big(`answer-${turn}`) },
    });
  }
  return {
    schemaVersion: 1 as const,
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspaceRoot: '/workspace',
    agent: 'default' as const,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    nextTurn: turns + 1,
    transcript,
  };
};

const installed: SemanticContextCheckpointV1[] = [];

const persistence = () => ({
  record: undefined,
  commit: () => {},
  rollback: () => {},
  installCheckpoint: (checkpoint: SemanticContextCheckpointV1) => {
    installed.push(checkpoint);
  },
  close: () => {},
});

const summaryResult = (): ModelResult => ({
  kind: 'final' as const,
  text: '{"schemaVersion":1,"summary":"condensed history"}',
});

Deno.test('Auto compaction installs before the turn once tokens are reached', async () => {
  installed.length = 0;
  let summaryCalls = 0;
  let turnCalls = 0;
  const session = new AgentSession(
    {
      generate: () => {
        turnCalls += 1;
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: longRecord(2),
      persistence: persistence(),
      summarizeContext: () => {
        summaryCalls += 1;
        return summaryResult();
      },
      sourceProfileId: 'test-profile',
    },
  );
  const outcome = await session.submit('next question');
  assert(outcome.ok);
  assertEquals(summaryCalls, 1);
  assertEquals(turnCalls, 1);
  assertEquals(installed.length, 1);
  const notice = session.consumeAutoCompactionNotice();
  assert(notice !== null);
  assertEquals(notice.retainedFromTurn, notice.coveredThroughTurn + 1);
  assertEquals(session.consumeAutoCompactionNotice(), null);
});

Deno.test('Auto compaction failure stops the submit without starting a turn', async () => {
  installed.length = 0;
  let turnCalls = 0;
  const before = longRecord(2);
  const session = new AgentSession(
    {
      generate: () => {
        turnCalls += 1;
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: before,
      persistence: persistence(),
      summarizeContext: () => {
        throw new Error('summary boom');
      },
      sourceProfileId: 'test-profile',
    },
  );
  const outcome = await session.submit('next question');
  assert(!outcome.ok);
  assertEquals(outcome.stopReason, 'contract_failure');
  assertEquals(outcome.steps, 0);
  assertEquals(turnCalls, 0);
  assertEquals(installed.length, 0);
  assertEquals(session.transcriptSnapshot().length, before.transcript.length);
});

Deno.test('Short sessions submit without automatic compaction', async () => {
  installed.length = 0;
  const session = new AgentSession(
    { generate: () => ({ kind: 'final', text: 'answer' }) },
    new Registry([]),
    {
      persistence: persistence(),
      summarizeContext: () => summaryResult(),
      sourceProfileId: 'test-profile',
    },
  );
  const outcome = await session.submit('hello');
  assert(outcome.ok);
  assertEquals(installed.length, 0);
  assertEquals(session.consumeAutoCompactionNotice(), null);
});

Deno.test('Notice events land on the normal log without changing lifecycle', () => {
  const state = reduceUiEvent(createUiState(), {
    kind: 'notice',
    generation: 7,
    text: 'context auto-compacted through turn 2; retained from turn 3; sending your message',
  });
  assertEquals(state.log.entries.length, 1);
  assertEquals(state.log.entries[0].label, 'system>');
  assert(state.log.entries[0].text.includes('auto-compacted through turn 2'));
  assertEquals(state.lifecycle, 'starting');
});

Deno.test('Adapter emits a notice row after automatic compaction', async () => {
  const { TuiPresentationAdapter } = await import(
    '../../v0/presentation/adapter.ts'
  );
  const seen: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    {
      submit: () =>
        Promise.resolve({
          ok: true,
          task: 'q',
          outcome: 'final' as const,
          stopReason: 'final' as const,
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [{ role: 'user', content: { kind: 'text', text: 'q' } }],
        }),
      consumeAutoCompactionNotice: () => ({ coveredThroughTurn: 2, retainedFromTurn: 3 }),
    },
    (event: unknown) => seen.push(event),
  );
  const result = await adapter.dispatch({ kind: 'ordinary_submit', text: 'q' });
  assertEquals((result as { kind: string }).kind, 'outcome');
  const notice = seen.find((event) =>
    typeof event === 'object' && event !== null &&
    (event as { kind: string }).kind === 'notice'
  ) as { kind: string; text: string } | undefined;
  assert(notice !== undefined);
  assert(notice.text.includes('through turn 2'));
});

Deno.test('No automatic compaction below the token threshold', async () => {
  installed.length = 0;
  let summaryCalls = 0;
  let turnCalls = 0;
  const mid: Message[] = [];
  for (let turn = 1; turn <= 2; turn += 1) {
    mid.push({ role: 'user', content: { kind: 'text', text: `task-${turn}` } });
    mid.push({
      role: 'assistant',
      content: { kind: 'text', text: `mid-${'y'.repeat(20_000)}` },
    });
  }
  const session = new AgentSession(
    {
      generate: () => {
        turnCalls += 1;
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: {
        schemaVersion: 1 as const,
        sessionId: '22222222-2222-4222-8222-222222222222',
        workspaceRoot: '/workspace',
        agent: 'default' as const,
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
        nextTurn: 3,
        transcript: mid,
      },
      persistence: persistence(),
      summarizeContext: () => {
        summaryCalls += 1;
        return {
          kind: 'final' as const,
          text: '{"schemaVersion":1,"summary":"condensed history"}',
        };
      },
      sourceProfileId: 'test-profile',
    },
  );
  const preview = session.contextCompactionPreview();
  assertEquals(preview.useful, true);
  assert((preview.baselineMessagesBytes ?? 0) < 65_536);
  const outcome = await session.submit('next question');
  assert(outcome.ok);
  assertEquals(summaryCalls, 0);
  assertEquals(turnCalls, 1);
  assertEquals(installed.length, 0);
  assertEquals(session.consumeAutoCompactionNotice(), null);
});
