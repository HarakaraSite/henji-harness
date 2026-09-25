import { createUiState, reduceUiAction, reduceUiEvent } from '../../v0/tui/state.ts';
import { restoredPresentationMessages } from '../../v0/presentation/adapter_projection.ts';
import { renderSessionTimeline } from '../../v0/agent/history/history_view.ts';
import type { Message } from '../../v0/agent/core/contracts.ts';
import type {
  StoredExecutionRow,
  StoredSessionHistoryExecution,
} from '../../v0/agent/history/history_store_contract.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';

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

const transcript: readonly Message[] = [
  { role: 'user', content: { kind: 'text', text: 'inspect the repo' } },
  {
    role: 'assistant',
    content: [{
      kind: 'tool_call',
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'README.md' },
    }],
    text: 'I will read the README first.',
  },
  {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'read-1',
      name: 'read',
      text: 'body',
      outcome: 'success',
    }],
  },
  {
    role: 'assistant',
    content: [{
      kind: 'tool_call',
      callId: 'bash-1',
      name: 'bash',
      arguments: { command: 'git status --short' },
    }],
    text: 'Now I will check the working tree.',
  },
  {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'bash-1',
      name: 'bash',
      text: '',
      outcome: 'success',
    }],
  },
  {
    role: 'assistant',
    content: { kind: 'text', text: 'The README and working tree are consistent.' },
  },
];

/** One label/text row per settled assistant text, in turn order. */
const expectedRows: readonly (readonly [string, string])[] = [
  ['user>', 'inspect the repo'],
  ['assistant note>', 'I will read the README first.'],
  ['tool>', 'read README.md ✓'],
  ['assistant note>', 'Now I will check the working tree.'],
  ['tool>', 'bash git status --short ✓'],
  ['assistant>', 'The README and working tree are consistent.'],
];

const execution: StoredExecutionRow = {
  executionId: '12900000-0000-4000-8000-000000000001',
  taskId: '12900000-0000-4000-8000-000000000002',
  task: 'inspect the repo',
  sessionCorrelation: '12900000-0000-4000-8000-000000000003',
  turn: 1,
  createdAt: '2026-09-25T00:00:00.000Z',
  settledAt: '2026-09-25T00:00:01.000Z',
  lifecycle: 'settled',
  outcome: 'completed',
  adoption: 'canonical',
  baseRevision: 0,
  committedRevision: 1,
  agent: 'default',
  model: ROOT_DEFAULT_MODEL_SELECTION,
  build: buildManifest(),
  definition: {
    schemaVersion: 1,
    resourceKind: 'agent-definition',
    resourceId: 'builtin/default',
    revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
  },
  acknowledgement: 'recorded',
  generationAvailability: 'recorded',
  diagnosticCapture: 'recorded',
  artifactCapture: 'recorded',
  contextCapture: 'complete',
};

Deno.test('Increment 129 keeps every assistant note before its tool calls in all history views', () => {
  let state = createUiState();
  state = reduceUiEvent(state, { kind: 'turn_start', turn: 1 });
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: transcript[0] as Extract<Message, { role: 'user' }>,
  });
  state = reduceUiEvent(state, { kind: 'assistant_progress', turn: 1, text: 'I will read' });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: transcript[1] as Extract<Message, { role: 'assistant' }>,
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      kind: 'tool_call',
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'README.md' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'read-1',
      name: 'read',
      text: 'body',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, { kind: 'assistant_progress', turn: 1, text: 'Now I will' });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: transcript[3] as Extract<Message, { role: 'assistant' }>,
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      kind: 'tool_call',
      callId: 'bash-1',
      name: 'bash',
      arguments: { command: 'git status --short' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'bash-1',
      name: 'bash',
      text: '',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, { kind: 'assistant_progress', turn: 1, text: 'The README' });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: transcript[5] as Extract<Message, { role: 'assistant' }>,
  });

  const liveRows = state.log.entries.map((entry) => [entry.label, entry.text]);
  assertEquals(liveRows, expectedRows);
  assert(
    state.log.entries.every((entry) => !entry.live),
    'progress fragments must not survive as live entries',
  );

  const restored = reduceUiEvent(createUiState(), {
    kind: 'restored_log',
    messages: restoredPresentationMessages(transcript),
    omitted: 0,
  });
  const restoredRows = restored.log.entries.map((entry) => [entry.label, entry.text]);
  assertEquals(restoredRows, expectedRows);

  const timeline: StoredSessionHistoryExecution[] = [{
    execution,
    messages: transcript,
    thinking: [],
  }];
  const rendered = renderSessionTimeline(timeline);
  const sessionLines = rendered.split('\n').slice(1).filter((line) => line.length > 0);
  assertEquals(sessionLines, expectedRows.map(([label, text]) => `${label} ${text}`));
  assert(
    rendered.indexOf('assistant note> I will read the README first.') <
      rendered.indexOf('tool> read README.md ✓'),
    'the note must stay before its tool calls',
  );
});

Deno.test('Increment 129 keeps assistant notes when the tool terminal final settles', () => {
  let state = createUiState();
  state = reduceUiEvent(state, { kind: 'turn_start', turn: 1 });
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'submit the result' } },
  });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: {
      role: 'assistant',
      text: 'I will prepare the result.',
      content: [{
        kind: 'tool_call',
        callId: 'json-1',
        name: 'submit_json_result',
        arguments: { value: 42 },
      }],
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      kind: 'tool_call',
      callId: 'json-1',
      name: 'submit_json_result',
      arguments: { value: 42 },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'json-1',
      name: 'submit_json_result',
      text: '{"ok":true}',
      outcome: 'success',
    },
  });
  state = reduceUiAction(state, {
    kind: 'assistant_final',
    turn: 1,
    text: 'Submitted {"ok":true}.',
  });

  assertEquals(state.log.entries.map((entry) => [entry.label, entry.text]), [
    ['user>', 'submit the result'],
    ['assistant note>', 'I will prepare the result.'],
    ['tool>', 'submit_json_result ✓'],
    ['assistant>', 'Submitted {"ok":true}.'],
  ]);
  assert(
    state.log.entries.at(-1)?.label === 'assistant>',
    'the final answer must follow every tool entry',
  );
});
