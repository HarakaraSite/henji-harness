import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import {
  assertRunTypescriptCodeAllowed,
  loadRunTypescriptSandbox,
  RunTypescriptSandboxConfigError,
  RunTypescriptSandboxDeniedError,
} from '../../v0/agent/tools/run_typescript_sandbox.ts';

const withConfigRoot = async (
  run: (configRoot: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-204-sandbox-' });
  try {
    await run(`${root}/config/henji-harness`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('Increment 204 sandbox config adds allow paths and expands ~ deny entries', async () => {
  await withConfigRoot(async (configRoot) => {
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(
      `${configRoot}/run-typescript.json`,
      JSON.stringify({
        schemaVersion: 1,
        allow: ['~/shared-notes', '/tmp/increment-204-extra'],
        deny: ['~/.local/state/henji-harness/v1/credentials', '/tmp/increment-204-denied.txt'],
      }),
    );
    const sandbox = await loadRunTypescriptSandbox(configRoot, { home: '/home/increment-204' });
    deepStrictEqual(sandbox.allowedPaths, [
      '/home/increment-204/shared-notes',
      '/tmp/increment-204-extra',
    ]);
    deepStrictEqual(sandbox.deniedPaths, [
      '~/.local/state/henji-harness/v1/credentials',
      '/home/increment-204/.local/state/henji-harness/v1/credentials',
      '/tmp/increment-204-denied.txt',
    ]);
    assertRunTypescriptCodeAllowed('return 1;', sandbox.deniedPaths);
    try {
      assertRunTypescriptCodeAllowed(
        'return await Deno.readTextFile("~/.local/state/henji-harness/v1/credentials");',
        sandbox.deniedPaths,
      );
      throw new Error('expected the deny audit to reject the entry');
    } catch (error) {
      ok(error instanceof RunTypescriptSandboxDeniedError);
      match(error.message, /references denied path/);
    }
    try {
      assertRunTypescriptCodeAllowed(
        'return await Deno.readTextFile("/home/increment-204/.local/state/henji-harness/v1/credentials/openai-api-key");',
        sandbox.deniedPaths,
      );
      throw new Error('expected the deny audit to reject the expanded entry');
    } catch (error) {
      ok(error instanceof RunTypescriptSandboxDeniedError);
    }
  });
});

Deno.test('Increment 204 sandbox config is optional and rejects unusable entries', async () => {
  await withConfigRoot(async (configRoot) => {
    await Deno.mkdir(configRoot, { recursive: true });
    deepStrictEqual(await loadRunTypescriptSandbox(configRoot, { home: '/home/increment-204' }), {
      allowedPaths: [],
      deniedPaths: [],
    });
    deepStrictEqual(await loadRunTypescriptSandbox(undefined, { home: '/home/increment-204' }), {
      allowedPaths: [],
      deniedPaths: [],
    });

    const rejected = async (config: unknown, home: string): Promise<void> => {
      await Deno.writeTextFile(
        `${configRoot}/run-typescript.json`,
        JSON.stringify(config),
      );
      try {
        await loadRunTypescriptSandbox(configRoot, { home });
        throw new Error('expected the sandbox config to be rejected');
      } catch (error) {
        ok(error instanceof RunTypescriptSandboxConfigError, String(error));
      }
    };
    await rejected({ schemaVersion: 2, allow: [] }, '/home/increment-204');
    await rejected({ schemaVersion: 1, allow: 'not-an-array' }, '/home/increment-204');
    await rejected({ schemaVersion: 1, allow: ['relative/path'] }, '/home/increment-204');
    // An empty home value stands for an environment where ~ cannot be expanded.
    await rejected({ schemaVersion: 1, deny: ['~/state'] }, '');
    await rejected({ schemaVersion: 1, deny: ['/tmp/has space '] }, '/home/increment-204');
  });
});

Deno.test('Increment 204 run_typescript keeps credential paths outside the code Worker', async () => {
  // The credential root must sit outside /tmp and the workspace, because /tmp stays readable.
  const credentialRoot = await Deno.makeTempDir({
    dir: '/var/tmp',
    prefix: 'henji-i204-credentials-',
  });
  await Deno.writeTextFile(`${credentialRoot}/openai-api-key`, 'i204-dummy-credential\n', {
    mode: 0o600,
  });
  await Deno.writeTextFile(`${credentialRoot}/chatgpt-account.json`, '{"accessToken":"x"}\n', {
    mode: 0o600,
  });
  const fixture = 'tests/v0/fixtures/increment_204_run_typescript_sandbox.ts';
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--no-prompt',
        '--cached-only',
        '--unstable-worker-options',
        '--allow-read=.,/tmp',
        '--allow-write=/tmp',
        '--allow-net',
        '--allow-run=/bin/bash',
        '--allow-env=HOME,NODE_V8_COVERAGE',
        '--config',
        'deno.v0.json',
        fixture,
        credentialRoot,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    strictEqual(result.code, 0, `${stdout}\n${stderr}`);
    strictEqual(stdout.trim(), 'increment-204 sandbox passed');
  } finally {
    await Deno.remove(credentialRoot, { recursive: true });
  }
});
