import { renderCanonicalView, renderSessionView } from '../../v0/agent/history/history_view.ts';
import { parseHistoryArgs } from '../../v0/agent/cli/history_cli.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { restoredPresentationMessages } from '../../v0/presentation/adapter_projection.ts';
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

const sessionId = '99000000-0000-4000-8000-000000000001';
const definition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: 'a'.repeat(64) },
};
const build = buildManifest();

const record: StoredSessionRecord = {
  schemaVersion: 6,
  sessionId,
  workspaceRoot: '/tmp/ws',
  agent: 'default',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:01.000Z',
  title: null,
  stateRevision: 2,
  nextTurn: 2,
  transcript: [
    { role: 'user', content: { kind: 'text', text: 'do it' } },
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'c1',
        name: 'bash',
        arguments: { command: 'echo hi' },
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'c1',
        name: 'bash',
        text: 'hi',
        outcome: 'success',
      }],
    },
    { role: 'assistant', content: { kind: 'text', text: 'done' } },
  ],
  definition,
  activeModel: ROOT_DEFAULT_MODEL_SELECTION,
  modelChanges: [],
  turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
  turnExecutions: [{ turn: 1, build, definition }],
};

Deno.test('Increment 99 session view matches the conversation log shape', () => {
  const text = renderSessionView(record);
  assertEquals(text, 'user> do it\ntool> bash echo hi ✓\nassistant> done\n');
  assert(!text.includes('tool<'), 'session view must not emit tool<');
});

Deno.test('Increment 99 session view places mixed assistant final as resume does', () => {
  const mixed: StoredSessionRecord = {
    ...record,
    transcript: record.transcript.map((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? { ...message, text: 'checking the file' }
        : message
    ),
  };
  const restored = reduceUiEvent(createUiState(), {
    kind: 'restored_log',
    messages: restoredPresentationMessages(mixed.transcript),
    omitted: 0,
  });
  const expected = `${
    restored.log.entries.map((entry) => `${entry.label} ${entry.text}`).join('\n')
  }\n`;
  assertEquals(renderSessionView(mixed), expected);
  assertEquals(
    expected,
    'user> do it\nassistant note> checking the file\ntool> bash echo hi ✓\nassistant> done\n',
  );
});

Deno.test('Increment 99 canonical view keeps the structured Markdown export', () => {
  const markdown = renderCanonicalView(record, '/tmp/ws');
  assert(markdown.startsWith('# Henji Session History'));
  assert(markdown.includes('## Turn 1'));
  assert(markdown.includes('### user>'));
  assert(markdown.includes('### assistant>'));
  assert(markdown.includes('### tool> bash'));
  assert(markdown.includes('### tool< bash · success'));
});

Deno.test('Increment 99 history args default to session/latest-free and reject bad input', () => {
  assertEquals(parseHistoryArgs([]), { latest: false, view: 'session' });
  assertEquals(parseHistoryArgs(['--latest', '--view', 'detail']), {
    latest: true,
    view: 'detail',
  });
  assertEquals(parseHistoryArgs(['--session', sessionId]), {
    sessionRef: sessionId,
    latest: false,
    view: 'session',
  });
  assertEquals(parseHistoryArgs(['--session', 'e8e99332']), {
    sessionRef: 'e8e99332',
    latest: false,
    view: 'session',
  });
  for (
    const args of [
      ['--view', 'bogus'],
      ['--session', 'short'],
      ['--latest', '--session', sessionId],
      ['--unknown'],
    ]
  ) {
    let threw = false;
    try {
      parseHistoryArgs(args);
    } catch {
      threw = true;
    }
    assert(threw, `expected invalid invocation for ${JSON.stringify(args)}`);
  }
});

Deno.test('Increment 99 read-only store does not create history on an empty workspace', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i99-readonly-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  try {
    const store = new SqliteHistoryV7ProductionStore(`${root}/state`, workspaceRoot, {
      readOnly: true,
    });
    let threw = false;
    try {
      await store.initialize();
    } catch {
      threw = true;
    }
    assert(threw, 'read-only open must fail when no history database exists');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
