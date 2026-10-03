import { deepStrictEqual as equal } from 'node:assert';

Deno.test('Increment 138 Agent configuration rejection can terminate without crashing the Host', async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--check',
      '--no-prompt',
      '--cached-only',
      '--unstable-worker-options',
      '--allow-read=.,/tmp',
      '--allow-write=/tmp',
      '--config',
      'deno.v0.json',
      'tests/v0/fixtures/increment_138_startup_recovery.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  equal(output.code, 0, new TextDecoder().decode(output.stderr));
  equal(new TextDecoder().decode(output.stdout).trim().split('\n'), [
    'configuration_rejected',
    'next_operation_reached',
  ]);
});
