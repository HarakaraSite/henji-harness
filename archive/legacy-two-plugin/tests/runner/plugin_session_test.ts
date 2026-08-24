import { assert, assertEquals } from '@std/assert';
import { runPluginSession } from '../../src/runner/plugin_session.ts';

const fixture = (name: string) =>
  new URL(`../fixtures/plugins/${name}.ts`, import.meta.url).pathname;
const base = {
  denoCommand: Deno.execPath(),
  cwd: Deno.cwd(),
  timeoutMs: 500,
  maxStdoutBytes: 4096,
  maxStderrBytes: 4096,
  maxTotalOutputBytes: 8192,
};

Deno.test('plugin session serves a nested host request before its final response', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-1', method: 'plugin.execute', payload: {} },
    {
      denoCommand: Deno.execPath(),
      entrypoint: new URL('../fixtures/plugins/host_call.ts', import.meta.url).pathname,
      cwd: Deno.cwd(),
      timeoutMs: 500,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxTotalOutputBytes: 8192,
    },
    (request) =>
      Promise.resolve({
        v: 1,
        kind: 'response',
        id: 'host-response',
        replyTo: request.id,
        ok: true,
        payload: { text: 'planned' },
      }),
  );
  assertEquals(result.failure, undefined);
  assertEquals(result.response?.payload, { text: 'planned' });
});

Deno.test('plugin session rejects duplicate final responses', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-2', method: 'plugin.execute', payload: {} },
    { ...base, entrypoint: fixture('duplicate_final') },
    () => Promise.reject(new Error('not expected')),
  );
  assertEquals(result.failure?.code, 'protocol_violation');
  assertEquals(result.response, undefined);
});

Deno.test('plugin session converts a rejected host handler into a structured failure', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-handler', method: 'plugin.execute', payload: {} },
    { ...base, entrypoint: fixture('host_call') },
    () => Promise.reject(new Error('broker unavailable')),
  );
  assertEquals(result.failure?.code, 'host_handler_failed');
  assertEquals(result.failure?.cause, {
    code: 'host_handler_error',
    message: 'Error: broker unavailable',
  });
  assertEquals(result.response, undefined);
});

Deno.test('plugin session classifies timeout', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-timeout', method: 'plugin.execute', payload: {} },
    { ...base, timeoutMs: 25, entrypoint: fixture('hang') },
    () => Promise.reject(new Error('not expected')),
  );
  assertEquals(result.failure?.code, 'process_timeout');
});

Deno.test('plugin session applies its deadline while a host handler is pending', async () => {
  const timeoutMs = 100;
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-host-timeout', method: 'plugin.execute', payload: {} },
    { ...base, timeoutMs, entrypoint: fixture('host_call') },
    () => new Promise<never>(() => {}),
  );
  assertEquals(result.failure?.code, 'process_timeout');
  assert(result.durationMs < timeoutMs + 75, `duration was ${result.durationMs}ms`);
});

Deno.test('plugin session rejects a final response followed by nonzero exit', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'root-nonzero', method: 'plugin.execute', payload: {} },
    { ...base, entrypoint: fixture('final_nonzero_exit') },
    () => Promise.reject(new Error('not expected')),
  );
  assertEquals(result.failure?.code, 'plugin_exit');
  assertEquals(result.response, undefined);
});

Deno.test('plugin session enforces stderr output limit', async () => {
  const result = await runPluginSession(
    { v: 1, kind: 'request', id: 'request-1', method: 'plugin.execute', payload: {} },
    { ...base, maxStderrBytes: 64, entrypoint: fixture('stderr_flood') },
    () => Promise.reject(new Error('not expected')),
  );
  assertEquals(result.failure?.code, 'process_output_limit');
  assertEquals(result.response, undefined);
});

Deno.test('plugin session returns a structured failure when plugin stdin closes', async () => {
  const result = await runPluginSession(
    {
      v: 1,
      kind: 'request',
      id: 'closed-stdin',
      method: 'plugin.execute',
      payload: { content: 'x'.repeat(128 * 1024) },
    },
    { ...base, timeoutMs: 1_000, entrypoint: fixture('close_stdin') },
    () => Promise.reject(new Error('not expected')),
  );
  assertEquals(result.failure?.code, 'plugin_exit');
  assertEquals(result.response, undefined);
});
