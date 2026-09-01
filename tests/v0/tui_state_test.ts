import { assert, assertEquals } from './test_helpers.ts';
import { type PresentationEvent } from '../../v0/presentation/contract.ts';
import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  UI_MAX_LOG_ENTRIES,
} from '../../v0/tui/state.ts';

const event = (index: number): PresentationEvent => ({
  kind: 'user_message',
  turn: index,
  message: { role: 'user', content: { kind: 'text', text: `task-${index}` } },
});

Deno.test('retained UI reducer leaves prior state untouched and coalesces assistant progress', () => {
  const initial = createUiState();
  const withUser = reduceUiEvent(initial, event(1));
  const withProgress = reduceUiEvent(withUser, {
    kind: 'assistant_progress',
    turn: 1,
    text: 'first',
  });
  const updated = reduceUiEvent(withProgress, {
    kind: 'assistant_progress',
    turn: 1,
    text: 'second',
  });
  assertEquals(initial.log.entries.length, 0);
  assertEquals(withUser.log.entries.length, 1);
  assertEquals(updated.log.entries.length, 2);
  assertEquals(updated.log.entries[1].text, 'second');
  assertEquals(updated.log.entries[1].revision, 1);
});

Deno.test('retained log uses bounded omission and latest action resets new-below count', () => {
  let state = createUiState();
  for (let index = 1; index <= UI_MAX_LOG_ENTRIES + 8; index += 1) {
    state = reduceUiEvent(state, event(index));
  }
  assert(state.log.entries.length <= UI_MAX_LOG_ENTRIES);
  assert(state.log.omittedCount > 0);
  const anchored = reduceUiAction(state, {
    kind: 'scroll',
    mode: { kind: 'anchored', entryId: 'turn-1:user', sourceScalarOffset: 0 },
  });
  const latest = reduceUiAction(anchored, { kind: 'latest' });
  assertEquals(latest.newBelowCount, 0);
  assertEquals(latest.scroll.kind, 'followLatest');
});

Deno.test('resize action clamps terminal dimensions without mutating source state', () => {
  const state = createUiState();
  const resized = reduceUiAction(state, { kind: 'resize', columns: 9_999, rows: -1 });
  assertEquals(state.terminalSize.columns, 80);
  assertEquals(resized.terminalSize.columns, 512);
  assertEquals(resized.terminalSize.rows, 1);
});

Deno.test('tool results retain causal call order when completion arrives out of order', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { kind: 'tool_call', callId: 'call-a', name: 'read', arguments: {} },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { kind: 'tool_call', callId: 'call-b', name: 'write', arguments: {} },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'call-b',
      name: 'write',
      text: 'b',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'call-a',
      name: 'read',
      text: 'a',
      outcome: 'success',
    },
  });
  const results = state.log.entries.filter((entry) => entry.label.startsWith('tool<'));
  assertEquals(results.map((entry) => entry.callId), ['call-a', 'call-b']);
});

Deno.test('active assistant and tool entries survive retention pressure', () => {
  let state = createUiState();
  for (let index = 1; index <= UI_MAX_LOG_ENTRIES; index += 1) {
    state = reduceUiEvent(state, event(index));
  }
  state = reduceUiEvent(state, { kind: 'assistant_progress', turn: 900, text: 'working' });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 900,
    call: { kind: 'tool_call', callId: 'call-live', name: 'bash', arguments: {} },
  });
  for (let index = 0; index < 12; index += 1) {
    state = reduceUiEvent(state, {
      kind: 'tool_progress',
      turn: 900,
      callId: 'call-live',
      name: 'bash',
      text: `step ${index}`,
    });
  }
  assert(state.log.entries.some((entry) => entry.id === 'turn-900:assistant'));
  assert(state.log.entries.some((entry) => entry.id === 'turn-900:tool:call-live'));
});

Deno.test('tool call, progress, and result use one retained identity in phase order', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { kind: 'tool_call', callId: 'opaque', name: 'bash', arguments: {} },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_progress',
    turn: 1,
    callId: 'opaque',
    name: 'bash',
    text: 'running',
  });
  const progress = state.log.entries.find((entry) => entry.callId === 'opaque');
  assert(progress !== undefined);
  assertEquals(state.log.entries.filter((entry) => entry.callId === 'opaque').length, 1);
  assertEquals(progress?.live, true);
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'opaque',
      name: 'bash',
      text: 'done',
      outcome: 'success',
    },
  });
  const result = state.log.entries.find((entry) => entry.callId === 'opaque');
  assertEquals(state.log.entries.filter((entry) => entry.callId === 'opaque').length, 1);
  assertEquals(result?.live, false);
  assertEquals(result?.text, 'done');
});

Deno.test('all-active retained pressure compacts text without exceeding the hard byte bound', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'assistant_progress',
    turn: 1,
    text: 'a'.repeat(64 * 1024),
  });
  for (let index = 0; index < 4; index += 1) {
    state = reduceUiEvent(state, {
      kind: 'tool_call',
      turn: 1,
      call: { kind: 'tool_call', callId: `active-${index}`, name: 'bash', arguments: {} },
    });
    state = reduceUiEvent(state, {
      kind: 'tool_progress',
      turn: 1,
      callId: `active-${index}`,
      name: 'bash',
      text: 'b'.repeat(64 * 1024),
    });
  }
  const total = state.log.entries.reduce(
    (sum, entry) => sum + new TextEncoder().encode(entry.text).byteLength,
    0,
  );
  assert(total <= 256 * 1024);
  assertEquals(state.log.entries.filter((entry) => entry.live).length, 5);
});

Deno.test('restored log replaces the previous session projection exactly', () => {
  let state = reduceUiEvent(createUiState(), event(1));
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: 'old result' } },
  });
  const restored = reduceUiEvent(state, {
    kind: 'restored_log',
    messages: [
      { role: 'user', content: { kind: 'text', text: 'new task' } },
      { role: 'assistant', content: { kind: 'text', text: 'new result' } },
    ],
    omitted: 0,
  });
  assert(!restored.log.entries.some((entry) => entry.text.includes('old')));
  assertEquals(restored.log.entries.map((entry) => entry.text), ['new task', 'new result']);
  assertEquals(restored.overlay, { kind: 'none' });
});
