import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { runPlugin } from '../../src/runner/plugin_process.ts';

const fixture = (name: string) =>
  new URL(`../fixtures/plugins/${name}.ts`, import.meta.url).pathname;
const request = {
  v: 1 as const,
  kind: 'request' as const,
  id: 'request-1',
  method: 'plugin.execute',
  payload: {},
};
const base = {
  denoCommand: Deno.execPath(),
  cwd: Deno.cwd(),
  timeoutMs: 500,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  maxTotalOutputBytes: 2048,
};

Deno.test('runPlugin transports one JSONL request and response', async () => {
  const result = await runPlugin(request, { ...base, entrypoint: fixture('respond') });
  assertEquals(result.failure, undefined);
  assertEquals(result.response?.replyTo, 'request-1');
  assertEquals(result.response?.payload, { status: 'planned', steps: [] });
});

Deno.test('runPlugin rejects non-protocol stdout', async () => {
  const result = await runPlugin(request, { ...base, entrypoint: fixture('malformed_stdout') });
  assertEquals(result.failure?.code, 'protocol_violation');
});

Deno.test('runPlugin enforces a process timeout', async () => {
  const result = await runPlugin(request, { ...base, timeoutMs: 25, entrypoint: fixture('hang') });
  assertEquals(result.failure?.code, 'process_timeout');
});

Deno.test('runPlugin limits stderr while continuing to drain stdout', async () => {
  const result = await runPlugin(request, {
    ...base,
    maxStderrBytes: 64,
    entrypoint: fixture('stderr_flood'),
  });
  assertEquals(result.failure?.code, 'process_output_limit');
  assert(result.stderrBytes > 64);
});

Deno.test('plugin cannot access the Runner environment', async () => {
  const result = await runPlugin(request, { ...base, entrypoint: fixture('permission_probe') });
  assertEquals(result.failure?.code, 'plugin_exit');
  assertStringIncludes(result.stderr, 'Requires env access');
});

for (
  const [name, expected] of [
    ['network_probe', 'Requires net access'],
    [
      'run_probe',
      'Requires run access',
    ],
    ['write_probe', 'Requires write access'],
    ['ffi_probe', 'Requires ffi access'],
  ] as const
) {
  Deno.test(`plugin cannot gain ${name} permission`, async () => {
    const result = await runPlugin(request, {
      ...base,
      maxStderrBytes: 8_192,
      maxTotalOutputBytes: 9_216,
      entrypoint: fixture(name),
    });
    assertEquals(result.failure?.code, 'plugin_exit');
    assertStringIncludes(result.stderr, expected);
  });
}
