import { strictEqual } from 'node:assert';
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
        '--allow-read=.,/tmp,/var/tmp',
        '--allow-write=/tmp,/var/tmp',
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
