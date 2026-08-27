import { assertEquals } from './test_helpers.ts';
import { main } from '../../v0/agent/session_cli.ts';
import { createSessionPersistence, DenoSessionStore } from '../../v0/agent/session_store.ts';

const transcript = [
  { role: 'user' as const, content: { kind: 'text' as const, text: 'task' } },
  { role: 'assistant' as const, content: { kind: 'text' as const, text: 'answer' } },
];

const capture = () => {
  let stdout = '';
  let stderr = '';
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    writeStdout: (value: string) => {
      stdout += value;
    },
    writeStderr: (value: string) => {
      stderr += value;
    },
  };
};

Deno.test('management list emits stable metadata and exact empty projection', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-cli-' });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const output = capture();
  assertEquals(
    await main(['list'], {
      workspaceRoot: workspace,
      stateRoot: `${root}/state`,
      writeStdout: output.writeStdout,
      writeStderr: output.writeStderr,
    }),
    0,
  );
  assertEquals(output.stdout, '{"schemaVersion":1,"sessions":[]}\n');
  assertEquals(output.stderr, '');
  await Deno.remove(root, { recursive: true });
});

Deno.test('management delete requires confirmation and reports stable success/error wires', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-cli-delete-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(transcript, 2, '2026-08-27T00:00:01.000Z');
  await persistence.close();
  const output = capture();
  assertEquals(
    await main(['delete', '--session', handle.id, '--yes'], {
      workspaceRoot: workspace,
      stateRoot: state,
      writeStdout: output.writeStdout,
      writeStderr: output.writeStderr,
    }),
    0,
  );
  assertEquals(output.stdout, `{"ok":true,"deleted":"${handle.id}"}\n`);
  const bad = capture();
  assertEquals(
    await main(['delete', '--session', handle.id], {
      workspaceRoot: workspace,
      stateRoot: state,
      writeStdout: bad.writeStdout,
      writeStderr: bad.writeStderr,
    }),
    1,
  );
  assertEquals(bad.stdout, '');
  assertEquals(
    bad.stderr,
    '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}\n',
  );
  await Deno.remove(root, { recursive: true });
});
