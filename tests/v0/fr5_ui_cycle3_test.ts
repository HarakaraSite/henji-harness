import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import { slashCommandOf } from '../../v0/tui/controller.ts';

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

Deno.test('Cycle 3 shows bash head preview on one line', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'bash-1',
      name: 'bash',
      arguments: { command: 'curl https://example.com/api -v' },
    },
  });
  assertEquals(state.log.entries[0].text, 'bash curl https://example.com/api -v …');
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'bash-1',
      name: 'bash',
      text: 'full output must not leak',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries[0].text, 'bash curl https://example.com/api -v ✓');
  assert(!state.log.entries[0].text.includes('full output must not leak'));
});

Deno.test('Cycle 3 keeps only the head line for multiline commands', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'bash-2',
      name: 'bash',
      arguments: { command: 'echo one\n echo two\n echo three' },
    },
  });
  assertEquals(state.log.entries[0].text, 'bash echo one …');
  assert(!state.log.entries[0].text.includes('echo two'));
});

Deno.test('Cycle 3 preserves preview across progress updates', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'read-1', name: 'read', arguments: { path: 'src/foo.ts' } },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_progress',
    turn: 1,
    callId: 'read-1',
    name: 'read',
    text: 'progress body must not leak',
  });
  assertEquals(state.log.entries[0].text, 'read src/foo.ts …');
  assert(!state.log.entries[0].text.includes('progress body'));
});

Deno.test('Cycle 3 leaves other tools without preview', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'plan-1',
      name: 'delegate_to_planner',
      arguments: { task: 'summarize' },
    },
  });
  assertEquals(state.log.entries[0].text, 'delegate_to_planner …');
});

Deno.test('Cycle 3 shows write path and keeps preview on error', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'write-1', name: 'write', arguments: { path: 'notes/memo.txt' } },
  });
  assertEquals(state.log.entries[0].text, 'write notes/memo.txt …');
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'write-1',
      name: 'write',
      text: 'failure body must not leak',
      outcome: 'error',
    },
  });
  assertEquals(state.log.entries[0].text, 'write notes/memo.txt ✗');
  assert(!state.log.entries[0].text.includes('failure body'));
});

Deno.test('Cycle 3 truncates a long command head with ellipsis', () => {
  const longCommand = `curl ${'a'.repeat(200)}`;
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'bash-9', name: 'bash', arguments: { command: longCommand } },
  });
  const text = state.log.entries[0].text;
  assert(text.startsWith('bash curl '));
  assert(text.endsWith('…'));
  assert(!text.includes(longCommand));
  assert(new TextEncoder().encode(text).byteLength <= 64 + 1 + 96 + 1 + 3);
});

Deno.test('Slash commands parse exact built-ins only', () => {
  assertEquals(slashCommandOf('/help'), 'help');
  assertEquals(slashCommandOf('/sessions'), 'sessions');
  assertEquals(slashCommandOf('/exit'), 'exit');
  assertEquals(slashCommandOf('  /sessions  '), 'sessions');
  assertEquals(slashCommandOf('read foo.ts'), null);
  assertEquals(slashCommandOf('/unknown'), 'unknown');
  assertEquals(slashCommandOf('/history'), 'unknown');
  assertEquals(slashCommandOf('/context'), 'unknown');
  assertEquals(slashCommandOf('/sessions foo'), 'unknown');
  assertEquals(slashCommandOf('/HELP'), 'unknown');
});
