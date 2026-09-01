import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const decoder = new TextDecoder();
const FAILURE = '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}\n';
const INVALID =
  '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}\n';

interface LauncherResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

const runLauncher = async (
  launcher: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<LauncherResult> => {
  const result = await new Deno.Command('/bin/sh', {
    args: [launcher, ...args],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', ...env },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};

const withRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-ui-acceptance-launcher-' });
  try {
    return await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const writeLauncher = async (
  root: string,
  launcherSource: string,
  denoPath: string,
): Promise<string> => {
  const directory = `${root}/v0/agent`;
  await Deno.mkdir(directory, { recursive: true });
  const launcher = `${directory}/ui_retained_acceptance_launcher.sh`;
  await Deno.writeTextFile(launcher, launcherSource.replaceAll(DENO, denoPath));
  await Deno.chmod(launcher, 0o755);
  return launcher;
};

const writeFakeDeno = async (
  root: string,
  executable = true,
): Promise<string> => {
  const fake = `${root}/fake-deno`;
  await Deno.writeTextFile(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "$FAKE_DENO_VERSION"
  exit 0
fi
{
  printf 'cwd=%s\\n' "$(pwd)"
  for arg
  do printf 'arg=%s\\n' "$arg"
  done
} > "$FAKE_DENO_CAPTURE"
`,
  );
  await Deno.chmod(fake, executable ? 0o755 : 0o600);
  return fake;
};

const launcherSource = await Deno.readTextFile('v0/agent/ui_retained_acceptance_launcher.sh');

Deno.test('acceptance launcher resolves repository root and fixed child argv from arbitrary cwd', async () => {
  await withRoot(async (root) => {
    const capture = `${root}/capture.txt`;
    const fake = await writeFakeDeno(root);
    const launcher = await writeLauncher(root, launcherSource, fake);
    const result = await runLauncher(launcher, [], {
      FAKE_DENO_VERSION: 'deno 2.9.4 (fake)',
      FAKE_DENO_CAPTURE: capture,
    });
    assert(result.success);
    assertEquals(result.stdout, '');
    assertEquals(result.stderr, '');
    const argv = (await Deno.readTextFile(capture)).trimEnd().split('\n');
    assertEquals(argv, [
      `cwd=${root}`,
      'arg=run',
      'arg=--no-prompt',
      'arg=--no-remote',
      `arg=${root}/tests/v0/fixtures/detached_ui_interactive_acceptance.ts`,
    ]);
    const mode = (await Deno.stat(launcher)).mode;
    assert(mode !== null && (mode & 0o111) !== 0);
  });
});

Deno.test('acceptance launcher rejects arguments before any Deno startup access', async () => {
  await withRoot(async (root) => {
    const launcher = await writeLauncher(root, launcherSource, `${root}/missing-deno`);
    const result = await runLauncher(launcher, ['unexpected'], {});
    assert(!result.success);
    assertEquals(result.stdout, '');
    assertEquals(result.stderr, INVALID);
  });
});

Deno.test('acceptance launcher sanitizes missing and wrong fixed Deno failures', async () => {
  await withRoot(async (root) => {
    const missing = await writeLauncher(root, launcherSource, `${root}/missing-deno`);
    const missingResult = await runLauncher(missing, [], {});
    assert(!missingResult.success);
    assertEquals(missingResult.stdout, '');
    assertEquals(missingResult.stderr, FAILURE);

    const capture = `${root}/wrong-capture.txt`;
    const wrongDeno = await writeFakeDeno(root);
    const wrong = await writeLauncher(root, launcherSource, wrongDeno);
    const wrongResult = await runLauncher(wrong, [], {
      FAKE_DENO_VERSION: 'deno 2.9.3 (wrong)',
      FAKE_DENO_CAPTURE: capture,
    });
    assert(!wrongResult.success);
    assertEquals(wrongResult.stdout, '');
    assertEquals(wrongResult.stderr, FAILURE);
  });
});

Deno.test('acceptance launcher sanitizes a non-executable fixed Deno path', async () => {
  await withRoot(async (root) => {
    const capture = `${root}/non-executable-capture.txt`;
    const nonExecutable = await writeFakeDeno(root, false);
    const launcher = await writeLauncher(root, launcherSource, nonExecutable);
    const result = await runLauncher(launcher, [], {
      FAKE_DENO_VERSION: 'deno 2.9.4',
      FAKE_DENO_CAPTURE: capture,
    });
    assert(!result.success);
    assertEquals(result.stdout, '');
    assertEquals(result.stderr, FAILURE);
  });
});
