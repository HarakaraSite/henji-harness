import { type Message } from '../../v0/agent/core/contracts.ts';
import { DenoHistoryExporter } from '../../v0/agent/session/history_export.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  resolveWorkspace,
} from '../../v0/agent/tools/work_tools.ts';

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
    const registry = new Registry([
      createWriteTool(workspace),
      createEditTool(workspace),
      createReadTool(workspace),
    ]);
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

Deno.test('read bounds large output while edit can replace text beyond the read result limit', async () => {
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
    await asText(
      edit.execute({
        path: 'large.txt',
        edits: [{ oldText: '0001:', newText: 'first:' }],
      }),
    );
    assertEquals(
      await Deno.readTextFile(`${workspaceRoot}/large.txt`),
      large.replace('0001:', 'first:'),
    );

    await Deno.writeTextFile(`${workspaceRoot}/one-line.txt`, 'z'.repeat(65_537));
    await expectReject(
      read.execute({ path: 'one-line.txt' }),
      /line 1 exceeds 64 KiB read result limit/u,
    );

    await Deno.writeTextFile(
      `${workspaceRoot}/no-progress.txt`,
      `${'x'.repeat(65_535)}\nlast\n`,
    );
    await expectReject(
      read.execute({ path: 'no-progress.txt' }),
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

Deno.test('edit inserts three UTF-8 lines up to 1 MiB and can edit the resulting file again', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    const encoder = new TextEncoder();
    const maxFileBytes = 1_048_576;
    const anchor = '挿入位置\n';
    const inserted = '追加1\n追加2\n追加3\n';
    const paddingBytes = maxFileBytes - encoder.encode(anchor + inserted).byteLength;
    const padding = '本文\n'.repeat(Math.floor(paddingBytes / 7)) +
      'x'.repeat(paddingBytes % 7);
    const original = padding + anchor;
    await Deno.writeTextFile(`${workspaceRoot}/note.md`, original);
    const registry = new Registry([createEditTool(await resolveWorkspace(workspaceRoot))]);
    const first = await registry.dispatch({
      callId: 'insert-three-lines',
      name: 'edit',
      arguments: {
        path: 'note.md',
        edits: [{ oldText: anchor, newText: anchor + inserted }],
      },
    });
    assertEquals(first.content.outcome, 'success');
    assertEquals(JSON.parse(first.content.text), {
      path: 'note.md',
      edits: 1,
      bytes: maxFileBytes,
    });
    assertEquals(await Deno.readTextFile(`${workspaceRoot}/note.md`), original + inserted);
    const second = await registry.dispatch({
      callId: 'edit-one-MiB-file',
      name: 'edit',
      arguments: {
        path: 'note.md',
        edits: [{ oldText: '追加2\n', newText: '変更2\n' }],
      },
    });
    assertEquals(second.content.outcome, 'success');
    assertEquals(
      await Deno.readTextFile(`${workspaceRoot}/note.md`),
      (original + inserted).replace('追加2\n', '変更2\n'),
    );
  });
});

Deno.test('edit applies the 1 MiB file limit before and after replacement without writing on failure', async () => {
  await withTempWorkspace(async (_stateRoot, workspaceRoot) => {
    const edit = createEditTool(await resolveWorkspace(workspaceRoot));
    const atLimit = 'x'.repeat(1_048_575) + 'A';
    await Deno.writeTextFile(`${workspaceRoot}/note.txt`, atLimit);
    await expectReject(
      edit.execute({ path: 'note.txt', edits: [{ oldText: 'A', newText: '追加' }] }),
      /file exceeds 1 MiB/u,
    );
    assertEquals(await Deno.readTextFile(`${workspaceRoot}/note.txt`), atLimit);
    const overLimit = atLimit + 'B';
    await Deno.writeTextFile(`${workspaceRoot}/note.txt`, overLimit);
    await expectReject(
      edit.execute({ path: 'note.txt', edits: [{ oldText: 'AB', newText: 'A' }] }),
      /file exceeds 1 MiB/u,
    );
    assertEquals(await Deno.readTextFile(`${workspaceRoot}/note.txt`), overLimit);
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
  text: 'I will read the current source.',
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
      position: {
        agent: 'default',
        committedTurn: 1,
        createdAt: '2026-09-11T00:00:00.000Z',
        title: 'First session',
      },
      session: { kind: 'durable', sessionId },
      runtime: {
        instructionSource: 'AGENTS.md',
        skillNames: ['handoff-read', 'handoff-write'],
        omittedSkills: 1,
        hardSandbox: false,
      },
    });
    const second = await exporter.write({
      transcript: [...turnOne(), ...turnTwo()],
      position: {
        agent: 'default',
        committedTurn: 2,
        createdAt: '2026-09-11T00:00:00.000Z',
        title: 'First session',
      },
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
    assert(secondText.includes('- Title: `First session`'));
    assert(secondText.includes('- Created: `2026-09-11T00:00:00.000Z`'));
    assert(firstText.includes('## Runtime at export'));
    assert(firstText.includes('- Context: `AGENTS.md`'));
    assert(firstText.includes('- Skills: `handoff-read, handoff-write (+1 more)`'));
    assert(firstText.includes('- Hard sandbox: no'));
    assert(secondText.includes('### tool> read'));
    assert(secondText.includes('### assistant>\n\n```\nI will read the current source.\n```'));
    assert(secondText.indexOf('### assistant>') < secondText.indexOf('### tool> read'));
    assert(secondText.includes('"offset": 2'));
    assert(secondText.includes('### tool< read · success'));
    assert(firstText.includes('````\nfirst answer with ``` fence\n````'));

    const none = await exporter.write({
      transcript: [],
      position: {
        agent: 'planner',
        committedTurn: 0,
        createdAt: '2026-09-11T01:00:00.000Z',
      },
      session: { kind: 'none' },
    });
    assert(none.path.includes('/no-session-through-turn-000000-'));
    const noneText = await Deno.readTextFile(none.path);
    assert(noneText.includes('- Session: `no-session`'));
    assert(!noneText.includes(sessionId));
  });
});
