import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { ConversationFlow } from '../../v0/tui/conversation_flow.ts';
import { BodyDocument } from '../../v0/tui/body_document.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';
import {
  KeyedConversationStore,
  mapConversationEntity,
} from '../../v0/tui/keyed_conversation_store.ts';
import {
  createUiState,
  freezeUiLogEntry,
  reduceUiAction,
  type UiLogEntry,
} from '../../v0/tui/state.ts';

const entry = (
  id: string,
  text: string,
  kind: UiLogEntry['kind'] = 'assistant',
  live = false,
): UiLogEntry => freezeUiLogEntry({ id, kind, text, label: `${kind}>`, live, revision: 1 });
const state = (entries: readonly UiLogEntry[], running = false) => {
  const store = new KeyedConversationStore();
  for (const value of entries) store.set(value.id, value);
  store.replaceSemanticOrder(entries.map((value) => value.id));
  let result = reduceUiAction(createUiState(), {
    kind: 'keyed_conversation',
    store,
  });
  result = reduceUiAction(result, {
    kind: 'footer',
    footer: { activity: running ? 'working' : 'ready', controls: [] },
  });
  return result;
};
const texts = (rows: readonly { text: string; kind?: string }[]) =>
  rows.filter((row) => row.kind !== 'separator').map((row) => row.text);

Deno.test('212 opening a new Session does not append the previous Session passive header', () => {
  const flow = new ConversationFlow();
  const position = {
    sessionId: 'previous-session',
    createdAt: '2026-10-07T00:00:00Z',
    title: 'untitled',
    agent: 'default',
    committedTurn: 0,
    messageCount: 0,
  };
  const initial = reduceUiAction(state([]), {
    kind: 'startup',
    position,
    state: {
      ...apiStartupFixture({
        status: 'unevaluated',
        sessionMode: { kind: 'new' },
        baseInstruction: {
          resourceId: 'builtin/henji-base',
          selectionSource: 'built-in',
          revisionDigest: 'a'.repeat(64),
        },
      }),
      startupEvaluation: 'unevaluated',
    },
  });
  const header = flow.drain(initial, 120, 24).committed;
  strictEqual(header.filter((row) => row.text.includes('Henji Harness')).length, 1);
  ok(header.some((row) => row.text.includes('builtin/henji-base')));
  const passive = reduceUiAction(initial, {
    kind: 'startup',
    position,
    state: {
      ...apiStartupFixture({ status: 'unevaluated', sessionMode: { kind: 'exact' } }),
      startupEvaluation: 'unevaluated',
    },
  });
  deepStrictEqual(flow.drain(passive, 120, 24), { committed: [], live: [] });
  flow.reset();
  const next = reduceUiAction(initial, {
    kind: 'startup',
    state: initial.startup!.state,
    position: { ...position, sessionId: 'next-session' },
  });
  strictEqual(
    flow.drain(next, 120, 24).committed.filter((row) => row.text.includes('Henji Harness')).length,
    1,
  );
});

Deno.test('212 header stays at opening state and a reopened saved Session uses latest metadata', () => {
  const flow = new ConversationFlow();
  const position = {
    sessionId: 'saved-session',
    createdAt: '2026-10-07T00:00:00Z',
    title: 'Original title',
    agent: 'default',
    committedTurn: 0,
    messageCount: 0,
  };
  const initial = reduceUiAction(state([]), {
    kind: 'startup',
    position,
    state: {
      ...apiStartupFixture({ status: 'unevaluated' }),
      startupEvaluation: 'unevaluated',
    },
  });
  ok(flow.drain(initial, 120, 24).committed.some((row) => row.text.includes('Original title')));
  const renamed = reduceUiAction(initial, {
    kind: 'startup',
    position: { ...position, title: 'Renamed title' },
    state: initial.startup!.state,
  });
  deepStrictEqual(flow.drain(renamed, 120, 24), { committed: [], live: [] });
  const evaluated = reduceUiAction(renamed, {
    kind: 'startup',
    position: renamed.startup!.position,
    state: apiStartupFixture({
      instructions: { loaded: true, source: 'AGENTS.md' },
      skills: { count: 1, names: ['updated-skill'], omitted: 0 },
    }),
  });
  deepStrictEqual(flow.drain(evaluated, 120, 24), { committed: [], live: [] });
  flow.reset();
  const restored = flow.drain(evaluated, 120, 24).committed;
  strictEqual(restored.filter((row) => row.text.includes('Henji Harness')).length, 1);
  for (const value of ['Renamed title', 'AGENTS.md', 'updated-skill']) {
    ok(restored.some((row) => row.text.includes(value)), value);
  }
  deepStrictEqual(flow.drain(evaluated, 120, 24), { committed: [], live: [] });
});

Deno.test('212 saved conversation is emitted in order once and replayed on a new display scope', () => {
  const flow = new ConversationFlow();
  const snapshot = state([
    entry('u', 'question', 'user'),
    entry('t', 'stopped thought', 'thinking', true),
    entry('a', 'saved answer'),
  ]);
  deepStrictEqual(texts(flow.drain(snapshot, 80, 3).committed), [
    'user> question',
    'thinking>',
    'stopped thought',
    'assistant>',
    'saved answer',
  ]);
  deepStrictEqual(flow.drain(snapshot, 80, 3), { committed: [], live: [] });
  // A full snapshot resync with replacement objects in the same scope still emits nothing.
  deepStrictEqual(
    flow.drain(
      state([
        entry('u', 'question', 'user'),
        entry('t', 'stopped thought', 'thinking', true),
        entry('a', 'saved answer'),
      ]),
      80,
      3,
    ),
    { committed: [], live: [] },
  );
  flow.reset();
  strictEqual(flow.drain(snapshot, 80, 3).committed.length, 7);
});

Deno.test('212 cumulative live body settles without repeating its prefix', () => {
  const flow = new ConversationFlow();
  deepStrictEqual(
    texts(
      flow.drain(
        state([entry('a', 'first paragraph', 'assistant', true)], true),
        80,
        5,
      ).live,
    ),
    ['assistant>', 'first paragraph'],
  );
  const final = flow.drain(state([entry('a', 'first paragraph\ncompleted answer')]), 80, 5);
  deepStrictEqual(texts(final.committed), ['assistant>', 'first paragraph', 'completed answer']);
  deepStrictEqual(final.live, []);
});

Deno.test('212 long thinking enters scrollback progressively without losing or repeating its prefix', () => {
  const flow = new ConversationFlow();
  const text = Array.from({ length: 40 }, (_, i) => `thought ${i}`).join('\n');
  const first = flow.drain(
    state([entry('t', text, 'thinking', true)], true),
    80,
    4,
  );
  strictEqual(first.live.length, 4);
  ok(first.committed.length > 30);
  const next = flow.drain(
    state([entry('t', `${text}!`, 'thinking', true)], true),
    80,
    4,
  );
  deepStrictEqual(next.committed, []);
  strictEqual(next.live.at(-1)?.text, 'thought 39!');
  const final = flow.drain(
    state([entry('t', `${text}!`, 'thinking', true)]),
    80,
    4,
  );
  deepStrictEqual(texts([...first.committed, ...final.committed]), [
    'thinking>',
    ...text.split('\n').slice(0, -1),
    'thought 39!',
  ]);
});

Deno.test('212 tool is emitted once, system notices update, and reopening shows the saved result', () => {
  const flow = new ConversationFlow();
  const start = flow.drain(
    state([entry('tool', 'read README.md …', 'tool', true)], true),
    80,
    4,
  );
  deepStrictEqual(texts(start.committed), ['tool> read README.md …']);
  const done = flow.drain(
    state([
      entry('tool', 'read README.md ✓', 'tool'),
      entry('notice', 'STARTED', 'system'),
    ]),
    80,
    4,
  );
  deepStrictEqual(texts(done.committed), [
    'system> STARTED',
  ]);
  const saved = state([
    entry('tool', 'read README.md ✓', 'tool'),
    entry('notice', 'COMPLETE', 'system'),
  ]);
  const updated = flow.drain(saved, 80, 4);
  deepStrictEqual(texts(updated.committed), ['system> COMPLETE']);
  flow.reset();
  deepStrictEqual(texts(flow.drain(saved, 80, 4).committed), [
    'tool> read README.md ✓',
    'system> COMPLETE',
  ]);
});

Deno.test('212 already emitted and unchanged live bodies do not parse again on footer redraw', () => {
  const flow = new ConversationFlow();
  const snapshot = state([
    entry('old', 'saved response'),
    entry('live', '# Answer\n\n**body**', 'assistant', true),
  ], true);
  flow.drain(snapshot, 80, 8);
  const original = BodyDocument.prototype.render;
  let renders = 0;
  BodyDocument.prototype.render = function (...args) {
    renders++;
    return original.apply(this, args);
  };
  try {
    const output = flow.drain(snapshot, 80, 8);
    deepStrictEqual(output.committed, []);
    ok(
      output.live.some((row) =>
        row.text.includes('Answer') &&
        row.spans?.some((span) => span.tone === 'heading')
      ),
    );
    strictEqual(renders, 0);
  } finally {
    BodyDocument.prototype.render = original;
  }
});

Deno.test('212 thinking settlement preserves its first label and committed body prefix', () => {
  const flow = new ConversationFlow();
  const text = Array.from({ length: 40 }, (_, i) => `thought ${i}`).join('\n');
  const entity = {
    kind: 'thinking' as const,
    id: 't',
    executionId: 'e',
    turn: 1,
    version: 0,
    position: {
      executionOrder: 0,
      requestOrder: 1,
      phase: 0,
      eventOrdinal: 0,
      itemOrdinal: 0,
    },
    requestKey: { executionId: 'e', modelStep: 1, requestOrdinal: 1 },
    thinkingKind: 'text' as const,
    text,
    complete: false,
  };
  const initial = mapConversationEntity(entity)!;
  const final = mapConversationEntity(
    { ...entity, complete: true, version: 1 },
    initial,
  )!;
  const first = flow.drain(state([initial], true), 80, 4);
  const last = flow.drain(state([final]), 80, 4);
  deepStrictEqual(
    texts([...first.committed, ...last.committed]).filter((text) => text.startsWith('thought ')),
    text.split('\n'),
  );
  const labels = texts([...first.committed, ...last.committed]).filter((text) =>
    text.startsWith('thinking')
  );
  deepStrictEqual(labels, [initial.label]);
  deepStrictEqual(flow.drain(state([final]), 80, 4), { committed: [], live: [] });
});

Deno.test('212 cumulative body after a queued-task notice appends only the continuation', () => {
  const flow = new ConversationFlow();
  const first = flow.drain(
    state([entry('a', 'first paragraph', 'assistant', true)], true),
    80,
    6,
  );
  deepStrictEqual(first.committed, []);
  const notified = flow.drain(
    state(
      [
        entry('a', 'first paragraph', 'assistant', true),
        entry('queue', 'RESERVED', 'system'),
      ],
      true,
    ),
    80,
    6,
  );
  const next = flow.drain(
    state([
      entry('a', 'first paragraph\ncontinued answer', 'assistant', true),
      entry('queue', 'RESERVED', 'system'),
    ], true),
    80,
    6,
  );
  strictEqual(
    texts([...notified.committed, ...next.committed, ...next.live]).filter((
      text,
    ) => text === 'first paragraph').length,
    1,
  );
  ok(next.live.some((row) => row.text === 'continued answer'));
  const final = flow.drain(
    state([
      entry('a', 'first paragraph\ncontinued answer'),
      entry('queue', 'RESERVED', 'system'),
    ]),
    80,
    6,
  );
  ok(final.committed.some((row) => row.text === 'continued answer'));
  strictEqual(
    texts([...notified.committed, ...final.committed]).filter((row) => row === 'assistant>').length,
    1,
  );
});

Deno.test('212 an overflowing Markdown table is sealed before later cells change its widths', () => {
  const flow = new ConversationFlow();
  const text = '| key | value |\n| --- | --- |\n' +
    Array.from({ length: 25 }, (_, i) => `| key${i} | cell${i} |`).join('\n');
  const first = flow.drain(
    state([entry('a', text, 'assistant', true)], true),
    40,
    6,
  );
  const next = flow.drain(
    state(
      [entry(
        'a',
        text + '\n| a much longer column name | new cell |',
        'assistant',
        true,
      )],
      true,
    ),
    40,
    6,
  );
  const output = texts([...first.committed, ...next.committed, ...next.live])
    .join('\n');
  for (let i = 0; i < 25; i++) {
    strictEqual(output.match(new RegExp(`cell${i}\\b`, 'g'))?.length, 1);
  }
  ok(output.includes('new cell'));
});

Deno.test('212 resize seals displayed live text and later output appends only its new source', () => {
  const flow = new ConversationFlow();
  const text = Array.from({ length: 40 }, (_, i) => `thought ${i}`).join('\n');
  const first = flow.drain(
    state([entry('t', text, 'thinking', true)], true),
    80,
    10,
  );
  flow.sealVisibleTail();
  deepStrictEqual(
    flow.drain(state([entry('t', text, 'thinking', true)], true), 40, 4),
    { committed: [], live: [] },
  );
  const next = flow.drain(
    state([entry('t', text + '\ncontinued thought', 'thinking', true)], true),
    40,
    4,
  );
  const displayed = texts([
    ...first.committed,
    ...first.live,
    ...next.committed,
    ...next.live,
  ]);
  for (let i = 0; i < 40; i++) {
    strictEqual(displayed.filter((row) => row === `thought ${i}`).length, 1);
  }
  ok(displayed.includes('continued thought'));
  strictEqual(displayed.filter((row) => row === 'thinking>').length, 1);
});

Deno.test('Increment 218 page eviction releases receipts and same-scope old resync does not reprint', () => {
  const flow = new ConversationFlow();
  const located = (index: number): UiLogEntry => ({
    ...entry(`position-${index}`, `body ${index}`),
    position: { executionOrder: index, requestOrder: 0, phase: 0, eventOrdinal: 0, itemOrdinal: 0 },
  });
  const first = located(0);
  const second = located(1);
  ok(flow.drain(state([first]), 80, 4).committed.length > 0);
  ok(flow.drain(state([second]), 80, 4).committed.length > 0);
  deepStrictEqual(flow.drain(state([first, second]), 80, 4).committed, []);
  const receipts = (flow as unknown as { printed: Map<string, unknown> }).printed;
  strictEqual(receipts.size, 1);
});
