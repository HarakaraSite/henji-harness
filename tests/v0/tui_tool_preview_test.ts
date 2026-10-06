import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import {
  recallExecutionIdOf,
  renameTitleOf,
  slashCommandCandidates,
  slashCommandOf,
} from '../../v0/tui/slash_command.ts';
import { toolCallText } from '../../v0/tui/terminal_text.ts';
import {
  conversationFixtureRows,
  fixtureExecutionId,
} from './helpers/increment_170_conversation_fixture.ts';
import type { ToolCallContent, ToolResultContent } from '../../v0/agent/core/contracts.ts';

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

const spawnCall: ToolCallContent = {
  kind: 'tool_call',
  callId: 'spawn-1',
  name: 'spawn_subagent',
  arguments: { agent: 'reviewer', task: 'Review the implementation.' },
};

const spawnResult: ToolResultContent = {
  kind: 'tool_result',
  callId: spawnCall.callId,
  name: spawnCall.name,
  text: '{"ok":true,"runId":"13600000-0000-4000-8000-000000000001"}',
  outcome: 'success',
};

Deno.test('spawn_subagent preview keeps its agent name and task head from call to result', () => {
  let state = reduceUiEvent(createUiState(), { kind: 'tool_call', turn: 1, call: spawnCall });
  assertEquals(
    state.log.entries.map((entry) => [entry.label, entry.text]),
    [['tool>', 'spawn_subagent reviewer Review the implementation. …']],
  );
  state = reduceUiEvent(state, { kind: 'tool_result', turn: 1, result: spawnResult });
  assertEquals(
    state.log.entries.map((entry) => [entry.label, entry.text]),
    [['tool>', 'spawn_subagent reviewer Review the implementation. ✓']],
  );
});

Deno.test('spawn_subagent preview keeps its agent name and task head in saved entity rows', () => {
  const rows = conversationFixtureRows('review the implementation', [
    {
      kind: 'model_result',
      semanticOccurrenceId: 'fixture-model-result-1',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 2,
      request: { modelStep: 1 },
      declaredCalls: [{
        callId: spawnCall.callId,
        name: spawnCall.name,
        arguments: { agent: 'reviewer', task: 'Review the implementation.' },
      }],
    },
    {
      kind: 'tool_call',
      semanticOccurrenceId: 'fixture-tool-1',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 3,
      request: { modelStep: 1 },
      callIndex: 0,
      callId: spawnCall.callId,
      name: spawnCall.name,
      arguments: { agent: 'reviewer', task: 'Review the implementation.' },
    },
    {
      kind: 'tool_result',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 3,
      request: { modelStep: 1 },
      result: {
        callId: spawnCall.callId,
        name: spawnCall.name,
        text: spawnResult.text,
        outcome: 'success',
      },
    },
  ]);
  assertEquals(
    rows.filter((entry) => entry.kind === 'tool').map((entry) => [entry.label, entry.text]),
    [['tool>', 'spawn_subagent reviewer Review the implementation. ✓']],
  );
});

Deno.test('spawn_subagent preview abbreviates a long Japanese task and keeps only its first line', () => {
  assertEquals(
    toolCallText('spawn_subagent', {
      agent: 'reviewer',
      task: '認証処理を調べる。\n結果を報告する。',
    }),
    'spawn_subagent reviewer 認証処理を調べる。',
  );
  const task =
    '認証処理を調べて、トークン更新に失敗する原因を特定してください。\n結果を報告してください。';
  let state = reduceUiEvent(createUiState(), {
    kind: 'tool_call',
    turn: 1,
    call: { ...spawnCall, arguments: { agent: 'reviewer', task } },
  });
  assertEquals(
    state.log.entries[0].text,
    'spawn_subagent reviewer 認証処理を調べて、トークン更新に失敗する原因を特定してくだ… …',
  );
  state = reduceUiEvent(state, { kind: 'tool_result', turn: 1, result: spawnResult });
  assertEquals(
    state.log.entries[0].text,
    'spawn_subagent reviewer 認証処理を調べて、トークン更新に失敗する原因を特定してくだ… ✓',
  );
});

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

Deno.test('tool preview distinguishes multiline commands sharing a first line', () => {
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
  assert(state.log.entries[0].text.includes('echo one echo two echo three'));
  const first = state.log.entries[0].text;
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'bash-3',
      name: 'bash',
      arguments: { command: 'echo one\n echo changed\n echo three' },
    },
  });
  assert(state.log.entries[1].text !== first);
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

Deno.test('web_fetch preview shows the requested URL and persists through result', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'fetch-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com/page?q=1' },
    },
  });
  assertEquals(state.log.entries[0].text, 'web_fetch https://example.com/page?q=1 …');
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'fetch-1',
      name: 'web_fetch',
      text: 'URL: https://example.com/final\nStatus: 200',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries[0].text, 'web_fetch https://example.com/page?q=1 ✓');
  assert(!state.log.entries[0].text.includes('example.com/final'));
});

Deno.test('web_fetch preview keeps the requested URL when the fetch fails', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'fetch-2',
      name: 'web_fetch',
      arguments: { url: 'https://example.com/missing' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'fetch-2',
      name: 'web_fetch',
      text: 'web_fetch request failed (404) for https://example.com/missing',
      outcome: 'error',
    },
  });
  assertEquals(state.log.entries[0].text, 'web_fetch https://example.com/missing ✗');
  assert(!state.log.entries[0].text.includes('404'));
});

Deno.test('web_fetch preview truncates a long URL with ellipsis', () => {
  const longUrl = `https://example.com/${'a'.repeat(200)}`;
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'fetch-9', name: 'web_fetch', arguments: { url: longUrl } },
  });
  const text = state.log.entries[0].text;
  assert(text.startsWith('web_fetch https://example.com/'));
  assert(text.endsWith('…'));
  assert(!text.includes(longUrl));
  assert(new TextEncoder().encode(text).byteLength <= 64 + 1 + 96 + 1 + 3);
});

Deno.test('search preview shows mode, pattern, glob and path from call to result', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-1',
      name: 'search',
      arguments: { mode: 'content', pattern: 'toolActivityPreview', path: 'v0/' },
    },
  });
  assertEquals(state.log.entries[0].text, 'search content "toolActivityPreview" v0/ …');
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'search-1',
      name: 'search',
      text: 'result body must not leak',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries[0].text, 'search content "toolActivityPreview" v0/ ✓');
  assert(!state.log.entries[0].text.includes('result body'));
});

Deno.test('search preview shows glob and path for path listings and entries', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-1',
      name: 'search',
      arguments: { mode: 'paths', glob: '*.ts', path: 'tests/v0' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-2',
      name: 'search',
      arguments: { mode: 'entries', path: 'v0/tui', depth: 2 },
    },
  });
  assertEquals(state.log.entries.map((entry) => entry.text), [
    'search paths glob="*.ts" tests/v0 …',
    'search entries v0/tui …',
  ]);
});

Deno.test('search preview bounds each element and keeps the later elements visible', () => {
  const pattern = 'a'.repeat(200);
  const path = 'b'.repeat(200);
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'search-1', name: 'search', arguments: { mode: 'content', pattern, path } },
  });
  const text = state.log.entries[0].text;
  assertEquals(
    text,
    `search content "${'a'.repeat(33)}…" ${'b'.repeat(19)}… …`,
  );
  assert(new TextEncoder().encode(text).byteLength <= 64 + 1 + 96 + 1 + 3);
});

Deno.test('search preview keeps one line and skips empty elements', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-1',
      name: 'search',
      arguments: { mode: 'content', pattern: 'first line\nsecond line' },
    },
  });
  assertEquals(state.log.entries[0].text, 'search content "first line" …');
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-2',
      name: 'search',
      arguments: { mode: 'content', pattern: '  ', path: 'v0/' },
    },
  });
  assertEquals(state.log.entries[1].text, 'search content v0/ …');
});

Deno.test('search preview bounds an unexpected mode value', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'search-1',
      name: 'search',
      arguments: { mode: 'unexpected-very-long-mode' },
    },
  });
  assertEquals(state.log.entries[0].text, 'search unexp… …');
});

Deno.test('run_typescript preview shows its leading purpose comment and hides the body', () => {
  const code = '// TUI関連7ファイルの配色を変更する\n' +
    'const text = await Deno.readTextFile(workspace + "/x");\nreturn text;';
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'ts-1', name: 'run_typescript', arguments: { code } },
  });
  assertEquals(state.log.entries[0].text, 'run_typescript TUI関連7ファイルの配色を変更する …');
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'ts-1',
      name: 'run_typescript',
      text: '{"ok":true}',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries[0].text, 'run_typescript TUI関連7ファイルの配色を変更する ✓');
  assert(!state.log.entries[0].text.includes('readTextFile'));
});

Deno.test('run_typescript preview requires the first content line to be a comment', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['\n\n   // 目的を記す\nconst a = 1;', '目的を記す'],
    ['const a = 1;\n// 後方のコメント', ''],
    ['//\nconst a = 1;', ''],
    ['return 1;', ''],
  ];
  for (const [code, comment] of cases) {
    let state = createUiState();
    state = reduceUiEvent(state, {
      kind: 'tool_call',
      turn: 1,
      call: { callId: 'ts-1', name: 'run_typescript', arguments: { code } },
    });
    assertEquals(
      state.log.entries[0].text,
      comment.length === 0 ? 'run_typescript …' : `run_typescript ${comment} …`,
    );
  }
});

Deno.test('run_typescript preview bounds a long comment and keeps the code hidden', () => {
  const comment = 'あ'.repeat(100);
  const code = `// ${comment}\nreturn 1;`;
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'ts-1', name: 'run_typescript', arguments: { code } },
  });
  const text = state.log.entries[0].text;
  assert(text.startsWith('run_typescript あ'));
  assert(text.endsWith('…'));
  assert(!text.includes('return 1'));
  assert(new TextEncoder().encode(text).byteLength <= 64 + 1 + 99 + 1 + 3);
});

Deno.test('search and run_typescript previews persist in saved entity rows', () => {
  const searchArguments = { mode: 'content', pattern: 'needle', path: 'v0/' };
  const codeArguments = { code: '// 目的を記す\nreturn 1;' };
  const rows = conversationFixtureRows('search and run a script', [
    {
      kind: 'model_result',
      semanticOccurrenceId: 'fixture-model-result-1',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 2,
      request: { modelStep: 1 },
      declaredCalls: [
        { callId: 'search-1', name: 'search', arguments: searchArguments },
        { callId: 'ts-1', name: 'run_typescript', arguments: codeArguments },
      ],
    },
    {
      kind: 'tool_call',
      semanticOccurrenceId: 'fixture-tool-1',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 3,
      request: { modelStep: 1 },
      callIndex: 0,
      callId: 'search-1',
      name: 'search',
      arguments: searchArguments,
    },
    {
      kind: 'tool_call',
      semanticOccurrenceId: 'fixture-tool-2',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 4,
      request: { modelStep: 1 },
      callIndex: 1,
      callId: 'ts-1',
      name: 'run_typescript',
      arguments: codeArguments,
    },
    {
      kind: 'tool_result',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 4,
      request: { modelStep: 1 },
      result: { callId: 'search-1', name: 'search', text: '{}', outcome: 'success' },
    },
    {
      kind: 'tool_result',
      executionId: fixtureExecutionId,
      turn: 1,
      eventOrdinal: 5,
      request: { modelStep: 1 },
      result: { callId: 'ts-1', name: 'run_typescript', text: '{}', outcome: 'success' },
    },
  ]);
  assertEquals(rows.filter((entry) => entry.kind === 'tool').map((entry) => entry.text), [
    'search content "needle" v0/ ✓',
    'run_typescript 目的を記す ✓',
  ]);
});

Deno.test('direct renderer seam uses the same semantic preview', () => {
  assertEquals(
    toolCallText('skill', { name: 'handoff-read' }),
    'skill handoff-read',
  );
  assertEquals(
    toolCallText('search', { mode: 'count', pattern: 'TODO', path: 'scripts/' }),
    'search count "TODO" scripts/',
  );
  assertEquals(
    toolCallText('run_typescript', { code: '// 目的を記す\nreturn 1;' }),
    'run_typescript 目的を記す',
  );
});

Deno.test('tool preview leaves other tools without arguments', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      callId: 'plan-1',
      name: 'submit_json_result',
      arguments: { json: '{"ok":true}' },
    },
  });
  assertEquals(state.log.entries[0].text, 'submit_json_result …');
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
  assert(/… #[0-9a-f]{8} …$/u.test(text));
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
  assertEquals(slashCommandOf('/recall'), 'recall');
  assertEquals(slashCommandOf('/recall aaaaaaaa'), 'recall');
  assertEquals(slashCommandOf('/detach'), 'detach');
  assertEquals(slashCommandOf('/quit'), 'quit');
  assertEquals(slashCommandOf('/shutdown'), 'unknown');
  assertEquals(slashCommandOf('/exit'), 'unknown');
  assertEquals(slashCommandOf('  /sessions  '), 'sessions');
  assertEquals(slashCommandOf('read foo.ts'), null);
  assertEquals(slashCommandOf('/unknown'), 'unknown');
  assertEquals(slashCommandOf('/context'), 'context');
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
  assertEquals(slashCommandCandidates('/'), []);
  assertEquals(slashCommandCandidates('/s'), ['/sessions']);
  assertEquals(slashCommandCandidates('/q'), ['/quit']);
  assertEquals(slashCommandCandidates('/d'), ['/detach']);
  assertEquals(slashCommandCandidates('/v'), ['/view']);
  assertEquals(slashCommandCandidates('/c'), ['/context']);
  assertEquals(slashCommandCandidates('/h'), [
    '/help',
  ]);
  assertEquals(slashCommandCandidates('/n'), ['/new']);
  assertEquals(slashCommandCandidates('/r'), ['/resume', '/rename', '/recall']);
  assertEquals(slashCommandCandidates('/unknown'), []);
  assertEquals(slashCommandCandidates('/H'), []);
  assertEquals(slashCommandCandidates(' /help'), []);
  assertEquals(slashCommandCandidates('ordinary task'), []);
});
