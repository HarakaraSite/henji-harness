import { assert, assertEquals } from './test_helpers.ts';

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const testBase = `${repositoryRoot}/.tools/spike2-test-tmp`;

const fixture = async (prefix: string): Promise<string> => {
  const root = await Deno.makeTempDir({ dir: testBase, prefix });
  await Deno.mkdir(`${root}/scripts`, { mode: 0o700 });
  await Deno.copyFile(
    `${repositoryRoot}/scripts/bootstrap-deno-spike2.sh`,
    `${root}/scripts/bootstrap-deno-spike2.sh`,
  );
  await Deno.chmod(`${root}/scripts/bootstrap-deno-spike2.sh`, 0o700);
  await Deno.writeTextFile(`${root}/AGENTS.md`, '# bootstrap fixture\n', { mode: 0o600 });
  return root;
};

const runBootstrap = (root: string) =>
  new Deno.Command('/usr/bin/bash', {
    args: [`${root}/scripts/bootstrap-deno-spike2.sh`],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();

Deno.test('fresh concurrent bootstrap is idempotent without overwrite', async () => {
  const root = await fixture('bootstrap-race-');
  try {
    const [left, right] = await Promise.all([runBootstrap(root), runBootstrap(root)]);
    assert(left.success, new TextDecoder().decode(left.stderr));
    assert(right.success, new TextDecoder().decode(right.stderr));
    const executable = `${root}/.tools/deno/2.9.4/deno`;
    const info = await Deno.lstat(executable);
    assert(info.isFile && !info.isSymlink);
    assertEquals(
      (await new Deno.Command(executable, { args: ['--version'] }).output()).success,
      true,
    );
    const versionEntries = Array.fromAsync(Deno.readDir(`${root}/.tools/deno/2.9.4`));
    assertEquals((await versionEntries).map((entry) => entry.name), ['deno']);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('bootstrap rejects a symlinked tool ancestor without changing outside sentinel', async () => {
  const root = await fixture('bootstrap-symlink-');
  const outside = await Deno.makeTempDir({ dir: testBase, prefix: 'bootstrap-outside-' });
  const sentinel = `${outside}/sentinel`;
  await Deno.writeTextFile(sentinel, 'unchanged');
  const link = await new Deno.Command('/usr/bin/ln', {
    args: ['-s', outside, `${root}/.tools`],
    clearEnv: true,
  }).output();
  assert(link.success, new TextDecoder().decode(link.stderr));
  try {
    const result = await runBootstrap(root);
    assertEquals(result.success, false);
    assertEquals(await Deno.readTextFile(sentinel), 'unchanged');
    assertEquals((await Array.fromAsync(Deno.readDir(outside))).map((entry) => entry.name), [
      'sentinel',
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
