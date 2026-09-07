import { type Message } from '../../v0/agent/core/contracts.ts';
import {
  DenoHistoryExporter,
  type HistoryExporter,
  type HistoryExportReceipt,
  type HistoryExportRequest,
} from '../../v0/agent/session/history_export.ts';
import {
  createEditTool,
  createReadTool,
  resolveWorkspace,
} from '../../v0/agent/tools/work_tools.ts';
import { TuiPresentationAdapter } from '../../v0/presentation/adapter.ts';
import { createDeclaredRegistry } from '../../v0/agent/tools/registries.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';

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

const asText = async (value: unknown): Promise<string> => {
  const resolved = await value;
  if (typeof resolved !== 'string') throw new Error('expected text result');
  return resolved;
};

const expectReject = async (
  operation: PromiseLike<unknown> | unknown,
  pattern: RegExp,
): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof Error);
    assert(pattern.test(error.message), error.message);
    return;
  }
  throw new Error('expected rejection');
};

const withTempWorkspace = async (
  run: (stateRoot: string, workspaceRoot: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-4-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  try {
    await run(stateRoot, workspaceRoot);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('read keeps small calls exact and returns complete line windows with continuation', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    await Deno.writeTextFile(`${workspaceRoot}/sample.txt`, 'alpha\n日本語\nomega');
    const read = createReadTool(await resolveWorkspace(workspaceRoot));
    assertEquals(await asText(read.execute({ path: 'sample.txt' })), 'alpha\n日本語\nomega');
    assertEquals(
      await asText(read.execute({ path: 'sample.txt', offset: 2, limit: 1 })),
      '日本語\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]',
    );
    assertEquals(
      await asText(read.execute({ path: 'sample.txt', offset: 3, limit: 2 })),
      'omega',
    );
    assertEquals(
      await asText(read.execute({ path: 'sample.txt', offset: 9, limit: 1 })),
      '',
    );
    await expectReject(
      read.execute({ path: 'sample.txt', offset: 0 }),
      /invalid read arguments/u,
    );
  });
});

Deno.test('declared work components preserve write, edit, and read behavior', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    const workspace = await resolveWorkspace(workspaceRoot);
    const registry = createDeclaredRegistry({
      instructions: [],
      skills: [],
      tools: ['tool:write', 'tool:edit', 'tool:read'].map(createAgentResourceIdentity),
      subagents: [],
    }, {
      workspace,
      skillCatalog: emptySkillCatalog(),
    });
    const written = await registry.dispatch({
      callId: 'write-component',
      name: 'write',
      arguments: { path: 'component.txt', content: 'alpha\nbeta\n' },
    });
    assertEquals(written.content.outcome, 'success');
    const edited = await registry.dispatch({
      callId: 'edit-component',
      name: 'edit',
      arguments: {
        path: 'component.txt',
        edits: [{ oldText: 'beta', newText: '韓国語' }],
      },
    });
    assertEquals(edited.content.outcome, 'success');
    const read = await registry.dispatch({
      callId: 'read-component',
      name: 'read',
      arguments: { path: 'component.txt' },
    });
    assertEquals(read.content.text, 'alpha\n韓国語\n');
  });
});

Deno.test('read bounds large output without changing edit whole-file behavior', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    const large = Array.from(
      { length: 900 },
      (_, index) => `${String(index + 1).padStart(4, '0')}:${'x'.repeat(90)}\n`,
    ).join('');
    await Deno.writeTextFile(`${workspaceRoot}/large.txt`, large);
    const workspace = await resolveWorkspace(workspaceRoot);
    const read = createReadTool(workspace);
    const first = await asText(read.execute({ path: 'large.txt' }));
    assert(new TextEncoder().encode(first).byteLength <= 65_536);
    const match = first.match(/Use offset=(\d+) to continue\./u);
    assert(match !== null);
    const next = Number(match[1]);
    assert(next > 1 && next < 900);
    const tail = await asText(read.execute({ path: 'large.txt', offset: next }));
    assert(tail.includes(`${String(next).padStart(4, '0')}:`));

    const edit = createEditTool(workspace);
    await expectReject(
      edit.execute({
        path: 'large.txt',
        edits: [{ oldText: '0001:', newText: 'first:' }],
      }),
      /file exceeds 64 KiB/u,
    );

    await Deno.writeTextFile(`${workspaceRoot}/one-line.txt`, 'z'.repeat(65_537));
    await expectReject(
      read.execute({ path: 'one-line.txt' }),
      /line 1 exceeds 64 KiB read result limit/u,
    );
  });
});

Deno.test('read validates the complete UTF-8 file even after the selected window', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    const bytes = new Uint8Array([...new TextEncoder().encode('visible\n'), 0xff]);
    await Deno.writeFile(`${workspaceRoot}/invalid.txt`, bytes);
    const read = createReadTool(await resolveWorkspace(workspaceRoot));
    await expectReject(
      read.execute({ path: 'invalid.txt', limit: 1 }),
      /file is not valid UTF-8 text/u,
    );
  });
});

const turnOne = (): Message[] => [{
  role: 'user',
  content: { kind: 'text', text: 'first request' },
}, {
  role: 'assistant',
  content: { kind: 'text', text: 'first answer with ``` fence' },
}];

const turnTwo = (): Message[] => [{
  role: 'user',
  content: { kind: 'text', text: 'second request' },
}, {
  role: 'assistant',
  content: [{
    kind: 'tool_call',
    callId: 'call-2',
    name: 'read',
    arguments: { path: 'README.md', offset: 2 },
  }],
}, {
  role: 'tool',
  content: [{
    kind: 'tool_result',
    callId: 'call-2',
    name: 'read',
    text: 'tool output',
    outcome: 'success',
  }],
}, {
  role: 'assistant',
  content: { kind: 'text', text: 'second answer' },
}];

Deno.test('history export writes distinct complete snapshots and explicit no-session identity', async () => {
  await withTempWorkspace(async (stateRoot, workspaceRoot) => {
    const uuids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const exporter = new DenoHistoryExporter(stateRoot, workspaceRoot, {
      uuid: () => uuids.shift()!,
    });
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first = await exporter.write({
      transcript: turnOne(),
      position: { agent: 'default', committedTurn: 1 },
      session: { kind: 'durable', sessionId },
    });
    const second = await exporter.write({
      transcript: [...turnOne(), ...turnTwo()],
      position: { agent: 'default', committedTurn: 2 },
      session: { kind: 'durable', sessionId },
    });
    assert(first.path.startsWith('/'));
    assert(first.path !== second.path);
    assertEquals([first.throughTurn, second.throughTurn], [1, 2]);
    const firstText = await Deno.readTextFile(first.path);
    const secondText = await Deno.readTextFile(second.path);
    assert(firstText.includes('## Turn 1'));
    assert(!firstText.includes('## Turn 2'));
    assert(secondText.includes('## Turn 1'));
    assert(secondText.includes('## Turn 2'));
    assert(secondText.includes('### tool> read'));
    assert(secondText.includes('"offset": 2'));
    assert(secondText.includes('### tool< read · success'));
    assert(firstText.includes('````\nfirst answer with ``` fence\n````'));

    const none = await exporter.write({
      transcript: [],
      position: { agent: 'planner', committedTurn: 0 },
      session: { kind: 'none' },
    });
    assert(none.path.includes('/no-session-through-turn-000000-'));
    const noneText = await Deno.readTextFile(none.path);
    assert(noneText.includes('- Session: `no-session`'));
    assert(!noneText.includes(sessionId));
  });
});

Deno.test('presentation adapter captures transcript and ignores no-session internal UUID', async () => {
  let captured: HistoryExportRequest | undefined;
  let resolveWrite!: (receipt: HistoryExportReceipt) => void;
  const exporter: HistoryExporter = {
    write: (request) => {
      captured = request;
      return new Promise((resolve) => {
        resolveWrite = resolve;
      });
    },
  };
  let transcript = turnOne();
  const internalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.reject(new Error('not used')),
      transcriptSnapshot: () => structuredClone(transcript),
      currentPosition: () => ({
        sessionId: internalId,
        agent: 'default',
        committedTurn: 1,
        messageCount: 2,
      }),
    },
    undefined,
    undefined,
    {
      historyExporter: exporter,
      historySessionMode: 'none',
    },
  );
  const operation = adapter.dispatch({ kind: 'history_export' });
  assert(operation instanceof Promise);
  assert(captured !== undefined);
  assertEquals(captured.session, { kind: 'none' });
  assertEquals(captured.transcript, turnOne());
  transcript = [...turnOne(), ...turnTwo()];
  resolveWrite({ path: '/tmp/export.md', throughTurn: 1 });
  assertEquals(await operation, {
    kind: 'history_export',
    path: '/tmp/export.md',
    throughTurn: 1,
  });
});
