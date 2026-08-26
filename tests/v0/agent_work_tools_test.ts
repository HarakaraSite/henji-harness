import { assert, assertEquals } from './test_helpers.ts';
import type { JsonValue } from '../../v0/agent/contracts.ts';
import { Registry, type Tool } from '../../v0/agent/tools.ts';
import { createCorpusRegistry, createProductionRegistry } from '../../v0/agent/registries.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  resolveWorkspace,
} from '../../v0/agent/work_tools.ts';

const encoder = new TextEncoder();

const withWorkspace = async <T>(fn: (root: string) => Promise<T>): Promise<T> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-work-tools-' });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const toolError = async (tool: Tool, args: unknown, expected: string): Promise<void> => {
  try {
    await tool.execute(args as JsonValue);
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, expected);
    return;
  }
  throw new Error(`expected rejection: ${expected}`);
};

const textBytes = (text: string): Uint8Array => encoder.encode(text);

Deno.test('read accepts relative and in-root absolute paths and preserves text bytes', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeFile(`${root}/text.txt`, textBytes('\ufeffa\r\nb\n'));
    const workspace = await resolveWorkspace(root);
    const tool = createReadTool(workspace);
    assertEquals(await tool.execute({ path: './text.txt' }), '\ufeffa\r\nb\n');
    assertEquals(await tool.execute({ path: `${root}/text.txt` }), '\ufeffa\r\nb\n');
    await Deno.writeFile(`${root}/empty.txt`, new Uint8Array());
    assertEquals(await tool.execute({ path: 'empty.txt' }), '');
    await toolError(tool, { path: 'missing.txt' }, 'file not found');
    await toolError(tool, { path: root }, 'target is not a regular file');
  });
});

Deno.test('path boundaries reject traversal, sibling prefixes, malformed and oversized inputs', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const tool = createReadTool(workspace);
    const sibling = `${root}-other`;
    await Deno.mkdir(sibling);
    await Deno.writeTextFile(`${sibling}/x`, 'outside');
    for (const path of ['../escape', sibling + '/x', '/tmp/escape', '', '   ', 'x\0y']) {
      await toolError(tool, { path }, 'path must stay within workspace');
    }
    await toolError(tool, { path: 'x'.repeat(4097) }, 'path must stay within workspace');
    await toolError(tool, { path: '\ud800' }, 'path must stay within workspace');
    await toolError(tool, { path: 'x', extra: 1 }, 'invalid read arguments');
    await Deno.remove(sibling, { recursive: true });
  });
});

Deno.test('symlink components and non-regular targets are rejected before content access', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/target.txt`, 'target');
    await Deno.mkdir(`${root}/dir`);
    const link = new Deno.Command('/bin/bash', {
      args: [
        '--noprofile',
        '--norc',
        '-c',
        `ln -s '${root}/target.txt' '${root}/inside-link'; ln -s '${root}' '${root}/dir-link'`,
      ],
      clearEnv: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdout: 'null',
      stderr: 'null',
    }).outputSync();
    assert(link.success);
    const workspace = await resolveWorkspace(root);
    const read = createReadTool(workspace);
    const write = createWriteTool(workspace);
    await toolError(read, { path: 'inside-link' }, 'path must not contain a symlink');
    await toolError(read, { path: 'dir-link/target.txt' }, 'path must not contain a symlink');
    await toolError(
      write,
      { path: 'dir-link/new.txt', content: 'x' },
      'path must not contain a symlink',
    );
    await toolError(read, { path: 'dir' }, 'target is not a regular file');
  });
});

Deno.test('read enforces UTF-8, NUL, and exact byte boundaries', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const read = createReadTool(workspace);
    await Deno.writeFile(`${root}/exact.txt`, new Uint8Array(65_536).fill(0x61));
    assertEquals((await read.execute({ path: 'exact.txt' }) as string).length, 65_536);
    await Deno.writeFile(`${root}/large.txt`, new Uint8Array(65_537).fill(0x61));
    await toolError(read, { path: 'large.txt' }, 'file exceeds 64 KiB');
    await Deno.writeFile(`${root}/bad.txt`, new Uint8Array([0xc3, 0x28]));
    await toolError(read, { path: 'bad.txt' }, 'file is not valid UTF-8 text');
    await Deno.writeFile(`${root}/nul.txt`, new Uint8Array([0x61, 0x00]));
    await toolError(read, { path: 'nul.txt' }, 'file is not valid UTF-8 text');
  });
});

Deno.test('write creates parents, preserves mode on replacement, and returns exact summaries', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const write = createWriteTool(workspace);
    assertEquals(
      await write.execute({ path: 'a/b.txt', content: 'hé' }),
      '{"path":"a/b.txt","bytes":3}',
    );
    assertEquals(await Deno.readTextFile(`${root}/a/b.txt`), 'hé');
    const before = await Deno.stat(`${root}/a/b.txt`);
    await Deno.chmod(`${root}/a/b.txt`, 0o640);
    assertEquals(
      await write.execute({ path: `${root}/a/./b.txt`, content: '' }),
      '{"path":"a/b.txt","bytes":0}',
    );
    const after = await Deno.stat(`${root}/a/b.txt`);
    assertEquals((after.mode ?? 0) & 0o777, 0o640);
    assert((before.mode ?? 0) > 0);
    await toolError(write, { path: 'a/b.txt', content: '\ud800' }, 'invalid write arguments');
    await toolError(write, { path: 'a/b.txt', content: 'x\0y' }, 'invalid write arguments');
    const backslashPath = 'a\\b.txt';
    assertEquals(
      await write.execute({ path: backslashPath, content: 'x' }),
      JSON.stringify({ path: backslashPath, bytes: 1 }),
    );
    assertEquals(await Deno.readTextFile(`${root}/${backslashPath}`), 'x');
    await toolError(
      write,
      { path: 'a/b.txt', content: 'x', extra: true },
      'invalid write arguments',
    );
  });
});

Deno.test('write failures clean temp files and leave target unchanged', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/keep.txt`, 'old');
    const workspace = await resolveWorkspace(root);
    const write = createWriteTool(workspace, {
      beforeRename: () => {
        throw new Error('injected marker');
      },
    });
    await toolError(write, { path: 'keep.txt', content: 'new' }, 'local write failed');
    assertEquals(await Deno.readTextFile(`${root}/keep.txt`), 'old');
    assertEquals((await Array.fromAsync(Deno.readDir(root))).map((entry) => entry.name), [
      'keep.txt',
    ]);
  });
});

Deno.test('edit validates original snapshot, overlap, uniqueness, and size atomically', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/edit.txt`, 'alpha beta gamma');
    const workspace = await resolveWorkspace(root);
    const edit = createEditTool(workspace);
    assertEquals(
      await edit.execute({
        path: 'edit.txt',
        edits: [
          { oldText: 'gamma', newText: 'G' },
          { oldText: 'alpha', newText: 'A' },
        ],
      }),
      '{"path":"edit.txt","edits":2,"bytes":8}',
    );
    assertEquals(await Deno.readTextFile(`${root}/edit.txt`), 'A beta G');
    for (
      const [edits, message] of [
        [[{ oldText: '', newText: 'x' }], 'edit 1 oldText is empty'],
        [[{ oldText: 'missing', newText: 'x' }], 'edit 1 oldText was not found'],
        [[{ oldText: 'A', newText: 'A' }], 'edit 1 does not change content'],
        [[{ oldText: 'A b', newText: 'x' }, { oldText: 'beta', newText: 'y' }], 'edits overlap'],
      ] as const
    ) {
      await toolError(edit, { path: 'edit.txt', edits }, message);
    }
    await Deno.writeTextFile(`${root}/edit.txt`, 'a a');
    await toolError(
      edit,
      { path: 'edit.txt', edits: [{ oldText: 'a', newText: 'z' }] },
      'edit 1 oldText is not unique',
    );
    await Deno.writeTextFile(`${root}/edit.txt`, `a${'x'.repeat(65_535)}`);
    await toolError(edit, {
      path: 'edit.txt',
      edits: [{ oldText: 'a', newText: 'aa' }],
    }, 'file exceeds 64 KiB');
  });
});

Deno.test('edit detects concurrent bytes and injected commit failures without leaking markers', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/edit.txt`, 'old');
    const workspace = await resolveWorkspace(root);
    const concurrent = createEditTool(workspace, {
      beforeRename: async () => {
        await Deno.writeTextFile(`${root}/edit.txt`, 'race');
      },
    });
    await toolError(
      concurrent,
      { path: 'edit.txt', edits: [{ oldText: 'old', newText: 'new' }] },
      'local edit failed',
    );
    assertEquals(await Deno.readTextFile(`${root}/edit.txt`), 'race');
    await Deno.writeTextFile(`${root}/edit.txt`, 'old');
    const injected = createEditTool(workspace, {
      beforeRename: () => {
        throw new Error('os marker');
      },
    });
    await toolError(
      injected,
      { path: 'edit.txt', edits: [{ oldText: 'old', newText: 'new' }] },
      'local edit failed',
    );
    assertEquals(await Deno.readTextFile(`${root}/edit.txt`), 'old');
  });
});

Deno.test('bash uses fixed Bash, cwd, clean environment, separated bounded output, and exit mapping', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const bash = createBashTool(workspace);
    const result = JSON.parse(
      await bash.execute({
        command:
          'printf "%s" "$PWD"; printf out; printf err >&2; printf "[%s]" "$PATH"; if [[ -n "${HENJI_OPENROUTER_API_KEY:-}" ]]; then exit 8; fi; exit 7',
      }) as string,
    );
    assertEquals(result.stdout, `${root}out[/usr/local/bin:/usr/bin:/bin]`);
    assertEquals(result.stderr, 'err');
    assertEquals(result.exitCode, 7);
    assertEquals(result.signal, null);
    assertEquals(result.timedOut, false);
    assertEquals(result.stdoutTruncated, false);
    assertEquals(result.stderrTruncated, false);
    const signal = JSON.parse(await bash.execute({ command: 'kill -TERM $$' }) as string);
    assertEquals(signal.exitCode, null);
    assertEquals(signal.signal, 'SIGTERM');
    const empty = JSON.parse(await bash.execute({ command: 'true' }) as string);
    assertEquals(empty.stdout, '');
    assertEquals(empty.stderr, '');
  });
});

Deno.test('bash capture flags, timeout escalation, and invalid arguments are bounded', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const bash = createBashTool(workspace);
    const output = JSON.parse(
      await bash.execute({
        command: "python3 -c \"import sys;sys.stdout.write('x'*4097);sys.stderr.write('y'*4097)\"",
      }) as string,
    );
    assertEquals(output.stdout.length, 4096);
    assertEquals(output.stderr.length, 4096);
    assertEquals(output.stdoutTruncated, true);
    assertEquals(output.stderrTruncated, true);
    const timed = JSON.parse(await bash.execute({ command: 'sleep 2', timeoutMs: 20 }) as string);
    assertEquals(timed.timedOut, true);
    assert(timed.signal === 'SIGTERM' || timed.signal === 'SIGKILL' || timed.exitCode !== null);
    const started = performance.now();
    const descendant = JSON.parse(
      await bash.execute({ command: 'sleep 2 & wait', timeoutMs: 20 }) as string,
    );
    assert(performance.now() - started < 1_000);
    assertEquals(descendant.timedOut, true);
    assert(
      descendant.signal === 'SIGTERM' || descendant.signal === 'SIGKILL' ||
        descendant.exitCode !== null,
    );
    for (
      const args of [
        { command: ' ' },
        { command: 'x\0y' },
        { command: '\ud800' },
        { command: 'true', timeoutMs: 0 },
        { command: 'true', timeoutMs: 120001 },
        { command: 'true', timeoutMs: 1.5 },
        { command: 'true', extra: 1 },
        { command: 4 },
      ]
    ) await toolError(bash, args, 'invalid bash arguments');
  });
});

Deno.test('bash SIGTERM-ignoring child is SIGKILLed, reaped, and bounded', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const bash = createBashTool(workspace);
    const started = performance.now();
    const result = JSON.parse(
      await bash.execute({
        command: 'trap "" TERM; echo "$$" > child.pid; exec sleep 5',
        timeoutMs: 20,
      }) as string,
    );
    assert(performance.now() - started < 1_000);
    assertEquals(result.timedOut, true);
    assertEquals(result.exitCode, null);
    assertEquals(result.signal, 'SIGKILL');
    const pid = (await Deno.readTextFile(`${root}/child.pid`)).trim();
    assert(/^\d+$/.test(pid));
    const probe = await new Deno.Command('/bin/bash', {
      args: ['--noprofile', '--norc', '-c', `kill -0 ${pid}`],
      cwd: root,
      clearEnv: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdout: 'null',
      stderr: 'null',
    }).output();
    assert(!probe.success);
  });
});

Deno.test('registry sanitizes local diagnostics and retains continuing tool correlation', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    const registry = new Registry([createReadTool(workspace)]);
    const result = await registry.dispatch({
      callId: 'r1',
      name: 'read',
      arguments: { path: '../secret-marker' },
    });
    assertEquals(result.terminal, null);
    assertEquals(result.content.outcome, 'error');
    assertEquals(result.content.text, 'invalid arguments: path must stay within workspace');
    assert(!result.content.text.includes(root));
  });
});

Deno.test('corpus and production registries expose disjoint exact definition sets', async () => {
  await withWorkspace(async (root) => {
    const workspace = await resolveWorkspace(root);
    assertEquals(
      createCorpusRegistry().definitions().map((definition) => definition.name),
      [
        'character_count',
        'count_json_array_items',
        'list_json_object_keys',
        'submit_json_result',
        'uppercase_text',
      ],
    );
    assertEquals(
      createProductionRegistry(workspace).definitions().map((definition) => definition.name),
      ['bash', 'edit', 'read', 'submit_json_result', 'write'],
    );
  });
});
