import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import {
  recallExecutionIdOf,
  renameTitleOf,
  slashCommandCandidates,
  slashCommandOf,
} from '../../v0/tui/controller.ts';
import { toolCallText } from '../../v0/tui/terminal_text.ts';

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

Deno.test('tool preview shows the bash head on one line', () => {
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

Deno.test('tool preview keeps only the head line for multiline commands', () => {
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

Deno.test('read range preview persists across progress and result updates', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'src/foo.ts', offset: 201, limit: 200 },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_progress',
    turn: 1,
    callId: 'read-1',
    name: 'read',
    text: 'progress body must not leak',
  });
  assertEquals(state.log.entries[0].text, 'read src/foo.ts lines 201–400 …');
  assert(!state.log.entries[0].text.includes('progress body'));
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'read-1',
      name: 'read',
      text: 'result body must not leak',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries[0].text, 'read src/foo.ts lines 201–400 ✓');
  assert(!state.log.entries[0].text.includes('result body'));
});

Deno.test('read preview distinguishes a bounded first window from an open continuation', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'README.md', limit: 200 },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'read-2',
      name: 'read',
      arguments: { path: 'README.md', offset: 201 },
    },
  });
  assertEquals(state.log.entries.map((entry) => entry.text), [
    'read README.md lines 1–200 …',
    'read README.md lines 201+ …',
  ]);
});

Deno.test('bash_output preview shows its stream and requested byte window', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'output-1',
      name: 'bash_output',
      arguments: {
        outputId: '12345678-1234-4123-8123-123456789abc',
        stream: 'stdout',
      },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'output-1',
      name: 'bash_output',
      text: 'saved output must not leak',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'output-2',
      name: 'bash_output',
      arguments: {
        outputId: '12345678-1234-4123-8123-123456789abc',
        stream: 'stderr',
        offset: 49_152,
        limit: 4_096,
      },
    },
  });
  assertEquals(state.log.entries.map((entry) => entry.text), [
    'bash_output stdout bytes 0–49151 ✓',
    'bash_output stderr bytes 49152–53247 …',
  ]);
  assert(!state.log.entries[0].text.includes('12345678'));
  assert(!state.log.entries[0].text.includes('saved output'));
});

Deno.test('web_search and skill previews show their semantic target', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-1',
      name: 'web_search',
      arguments: { query: 'Deno 3.0 release status' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'skill-1',
      name: 'skill',
      arguments: { name: 'handoff-read' },
    },
  });
  assertEquals(state.log.entries.map((entry) => entry.text), [
    'web_search Deno 3.0 release status …',
    'skill handoff-read …',
  ]);
});

Deno.test('direct renderer seam uses the same semantic preview', () => {
  assertEquals(
    toolCallText('skill', { name: 'handoff-read' }),
    'skill handoff-read',
  );
});

Deno.test('tool preview leaves other tools without arguments', () => {
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

Deno.test('tool preview shows write path and persists on error', () => {
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

Deno.test('tool preview truncates a long command head with ellipsis', () => {
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

Deno.test('Slash commands parse exact built-ins and rename title arguments', () => {
  assertEquals(slashCommandOf('/help'), 'help');
  assertEquals(slashCommandOf('/new'), 'new');
  assertEquals(slashCommandOf('/sessions'), 'sessions');
  assertEquals(slashCommandOf('/rename Project notes'), 'rename');
  assertEquals(slashCommandOf('/provider'), 'provider');
  assertEquals(slashCommandOf('/model'), 'model');
  assertEquals(slashCommandOf('/effort'), 'effort');
  assertEquals(slashCommandOf('/history export'), 'history_export');
  assertEquals(slashCommandOf('/recover'), 'recover');
  assertEquals(slashCommandOf('/recall'), 'recall');
  assertEquals(slashCommandOf('/recall aaaaaaaa'), 'recall');
  assertEquals(slashCommandOf('/exit'), 'exit');
  assertEquals(slashCommandOf('  /sessions  '), 'sessions');
  assertEquals(slashCommandOf('read foo.ts'), null);
  assertEquals(slashCommandOf('/unknown'), 'unknown');
  assertEquals(slashCommandOf('/history'), 'unknown');
  assertEquals(slashCommandOf('/history export now'), 'unknown');
  assertEquals(slashCommandOf('/context'), 'unknown');
  assertEquals(slashCommandOf('/sessions foo'), 'unknown');
  assertEquals(slashCommandOf('/new session'), 'unknown');
  assertEquals(slashCommandOf('/renamefoo'), 'unknown');
  assertEquals(slashCommandOf('/HELP'), 'unknown');
  assertEquals(renameTitleOf('/rename Project\nnotes'), 'Project notes');
  assertEquals(renameTitleOf('/rename'), '');
  assertEquals(renameTitleOf('/sessions'), null);
  assertEquals(recallExecutionIdOf('/recall'), undefined);
  assertEquals(
    recallExecutionIdOf('/recall AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  assertEquals(recallExecutionIdOf('/recall aaaaaaaa'), 'aaaaaaaa');
  assertEquals(recallExecutionIdOf('/recall short'), null);
  assertEquals(recallExecutionIdOf('/recall aaaaaaaa extra'), null);
});

Deno.test('Slash command candidates use case-sensitive raw-prefix matching', () => {
  assertEquals(slashCommandCandidates('/'), [
    '/help',
    '/new',
    '/sessions',
    '/rename',
    '/provider',
    '/model',
    '/effort',
    '/history export',
    '/recover',
    '/recall',
    '/exit',
  ]);
  assertEquals(slashCommandCandidates('/h'), ['/help', '/history export']);
  assertEquals(slashCommandCandidates('/n'), ['/new']);
  assertEquals(slashCommandCandidates('/r'), ['/rename', '/recover', '/recall']);
  assertEquals(slashCommandCandidates('/history'), ['/history export']);
  assertEquals(slashCommandCandidates('/history export'), ['/history export']);
  assertEquals(slashCommandCandidates('/unknown'), []);
  assertEquals(slashCommandCandidates('/H'), []);
  assertEquals(slashCommandCandidates(' /help'), []);
  assertEquals(slashCommandCandidates('ordinary task'), []);
});
