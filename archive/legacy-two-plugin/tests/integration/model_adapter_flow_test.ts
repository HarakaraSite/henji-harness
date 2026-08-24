import { assertEquals } from '@std/assert';
import { runPluginSession } from '../../src/runner/plugin_session.ts';

Deno.test('model-adapter plugin calls only the broker host method', async () => {
  const result = await runPluginSession({
    v: 1,
    kind: 'request',
    id: 'adapter-root',
    method: 'plugin.execute',
    payload: { messages: [{ role: 'user', content: 'plan' }] },
  }, {
    denoCommand: Deno.execPath(),
    entrypoint: new URL('../../plugins/model-adapter/main.ts', import.meta.url).pathname,
    cwd: Deno.cwd(),
    timeoutMs: 500,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    maxTotalOutputBytes: 8192,
  }, (request) => {
    assertEquals(request.method, 'host.broker.call');
    assertEquals(request.payload, {
      endpointId: 'openrouter-api',
      operationId: 'chat-completions',
      body: {
        model: 'google/gemini-3.7-flash',
        messages: [{ role: 'user', content: 'plan' }],
        stream: false,
      },
    });
    return Promise.resolve({
      v: 1,
      kind: 'response',
      id: 'broker-response',
      replyTo: request.id,
      ok: true,
      payload: { choices: [{ message: { content: 'result' } }] },
    });
  });
  assertEquals(result.failure, undefined);
  assertEquals(result.response?.payload, { text: 'result' });
});
