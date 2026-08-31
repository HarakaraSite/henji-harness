import { assert, assertEquals } from './test_helpers.ts';
import {
  HISTORY_PAGE_ESCAPED_BYTES,
  HISTORY_PAGE_ROWS,
  HISTORY_PAGE_SOURCE_BYTES,
  historyPage,
  historyPageWindow,
  indexSessionHistory,
} from '../../v0/agent/session_history.ts';
import {
  movePickerSelection,
  SESSION_PICKER_PAGE_SIZE,
} from '../../v0/agent/session_navigation.ts';
import { InputDecoder } from '../../v0/tui/input.ts';
import type { Message } from '../../v0/agent/contracts.ts';
import { historyPageText } from '../../v0/tui/render.ts';

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

Deno.test('picker page movement keeps the selected full UUID visible and wraps locally', () => {
  const count = SESSION_PICKER_PAGE_SIZE + 1;
  assertEquals(movePickerSelection(count, 0, 0, 'right'), { selected: 8, page: 1 });
  assertEquals(movePickerSelection(count, 8, 1, 'down'), { selected: 8, page: 1 });
  assertEquals(movePickerSelection(count, 8, 1, 'up'), { selected: 8, page: 1 });
  assertEquals(movePickerSelection(count, 8, 1, 'left'), { selected: 0, page: 0 });
  assertEquals(movePickerSelection(count, 7, 0, 'down'), { selected: 0, page: 0 });
  assertEquals(movePickerSelection(count, 0, 0, 'up'), { selected: 7, page: 0 });
});

const transcript: readonly Message[] = [
  { role: 'user', content: { kind: 'text', text: 'first goal' } },
  {
    role: 'assistant',
    content: [{ kind: 'tool_call', callId: 'one', name: 'capture', arguments: { value: 1 } }],
  },
  {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'one',
      name: 'capture',
      text: 'not terminal',
      outcome: 'success',
    }],
  },
  { role: 'user', content: { kind: 'text', text: 'steer once' } },
  { role: 'assistant', content: { kind: 'text', text: 'first answer' } },
  { role: 'user', content: { kind: 'text', text: 'second goal' } },
  {
    role: 'assistant',
    content: [{ kind: 'tool_call', callId: 'two', name: 'submit_json_result', arguments: {} }],
  },
  {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'two',
      name: 'submit_json_result',
      text: '{"ok":true}',
      outcome: 'success',
      terminal: 'json_result',
    }],
  },
];

Deno.test('history index preserves causal turns, steering, and terminal tool batches', () => {
  const index = indexSessionHistory(transcript);
  assert(index !== undefined);
  assertEquals(index.turnCount, 2);
  assertEquals(index.turns.map((turn) => [turn.turn, turn.start, turn.end]), [
    [1, 0, 5],
    [2, 5, 8],
  ]);
  assertEquals(index.turns[0].messages.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'user',
    'assistant',
  ]);
  const page = historyPageWindow(transcript, 1, 0, { sessionId: 's', agent: 'default', rows: 16 });
  assert(page !== undefined);
  assertEquals(page.entries.map((entry) => entry.role), [
    'user',
    'assistant',
    'tool>',
    'tool<',
    'steer',
    'assistant',
  ]);
  assertEquals(page.sessionId, 's');
  assertEquals(page.agent, 'default');
});

Deno.test('history pages clamp to bounded rows and source bytes without mutating the transcript', () => {
  const large: Message[] = [
    { role: 'user', content: { kind: 'text', text: '😀\u0001'.repeat(10_000) } },
    { role: 'assistant', content: { kind: 'text', text: 'answer' } },
  ];
  const before = structuredClone(large);
  const page = historyPageWindow(large, 1, 0, { rows: HISTORY_PAGE_ROWS + 100 });
  assert(page !== undefined);
  assert(page.entries.length <= HISTORY_PAGE_ROWS);
  assert(page.sourceBytes <= HISTORY_PAGE_SOURCE_BYTES);
  assert(page.entries.every((entry) => bytes(entry.text) <= HISTORY_PAGE_SOURCE_BYTES));
  assert(!page.omitted);
  assert(page.pageCount > 1);
  assertEquals(large, before);

  const many: Message[] = [
    { role: 'user', content: { kind: 'text', text: 'u' } },
    { role: 'assistant', content: { kind: 'text', text: 'a' } },
  ];
  const simple = historyPage(many, 99, { rows: 0 });
  assert(simple !== undefined);
  assertEquals(simple.page, 0);
  assertEquals(simple.pageCount, 2);
  assert(simple.sourceBytes <= HISTORY_PAGE_SOURCE_BYTES);
  assert(HISTORY_PAGE_ESCAPED_BYTES > HISTORY_PAGE_SOURCE_BYTES);
});

Deno.test('history pagination keeps every oversized scalar-safe message tail reachable', () => {
  const user = 'α\u0001\u202e😀'.repeat(8_000);
  const assistant = 'answer '.repeat(3_000);
  const large: Message[] = [
    { role: 'user', content: { kind: 'text', text: user } },
    { role: 'assistant', content: { kind: 'text', text: assistant } },
  ];
  const first = historyPageWindow(large, 1, 0, { sessionId: 's', agent: 'default', rows: 21 });
  assert(first !== undefined);
  const pages = [first];
  for (let page = 1; page < first.pageCount; page += 1) {
    const next = historyPageWindow(large, 1, page, {
      sessionId: 's',
      agent: 'default',
      rows: 21,
    });
    assert(next !== undefined);
    pages.push(next);
  }
  assert(pages.length > 1);
  assert(pages.every((page) => page.sourceBytes <= HISTORY_PAGE_SOURCE_BYTES));
  assert(pages.every((page) => bytes(historyPageText(page)) <= HISTORY_PAGE_ESCAPED_BYTES));
  const byMessage = new Map<number, string>();
  for (const page of pages) {
    for (const entry of page.entries) {
      byMessage.set(entry.messageIndex, `${byMessage.get(entry.messageIndex) ?? ''}${entry.text}`);
    }
  }
  assertEquals(byMessage.get(0), user);
  assertEquals(byMessage.get(1), assistant);
  assert(
    pages.flatMap((page) => page.entries).every((entry) =>
      entry.text.length === 0 || !/\uD800/u.test(entry.text)
    ),
  );
});

Deno.test('history rejects malformed causal transcripts and page windows remain read-only', () => {
  assertEquals(
    indexSessionHistory([{ role: 'assistant', content: { kind: 'text', text: 'orphan' } }]),
    undefined,
  );
  const page = historyPageWindow(transcript, 1, Number.MAX_SAFE_INTEGER, { rows: 1 });
  assert(page !== undefined);
  assertEquals(page.page, page.pageCount - 1);
  assertEquals(page.entries.length, 1);
});

Deno.test('Ctrl-G, Ctrl-T, and Ctrl-K decode as dedicated non-text events', () => {
  const decoder = new InputDecoder();
  assertEquals(decoder.feed(new Uint8Array([0x07, 0x14, 0x0b])), [
    { kind: 'ctrl_g' },
    { kind: 'ctrl_t' },
    { kind: 'ctrl_k' },
  ]);
  decoder.end();
});
