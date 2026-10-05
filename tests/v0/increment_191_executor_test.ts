import { strictEqual } from 'node:assert';

Deno.test('Increment 191 run_typescript executes in a permissioned Worker and remains cancellable', async () => {
  const fixture = 'tests/v0/fixtures/increment_191_executor.ts';
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
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  strictEqual(result.code, 0, `${stdout}\n${stderr}`);
  strictEqual(stdout.trim(), 'increment-191 executor passed');
});
