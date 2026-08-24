import { assertEquals, assertStringIncludes } from '@std/assert';
import { runPluginSession } from '../../src/runner/plugin_session.ts';

Deno.test('task-planner plugin requests one provider-independent model call', async () => {
  let calls = 0;
  const result = await runPluginSession({
    v: 1,
    kind: 'request',
    id: 'planner-root',
    method: 'plugin.execute',
    payload: { task: 'Prepare release notes', constraints: ['No tools'] },
  }, {
    denoCommand: Deno.execPath(),
    entrypoint: new URL('../../plugins/task-planner/main.ts', import.meta.url).pathname,
    cwd: Deno.cwd(),
    timeoutMs: 500,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    maxTotalOutputBytes: 8192,
  }, (request) => {
    calls += 1;
    assertEquals(request.method, 'host.model.generate');
    const payload = request.payload as { messages: { content: string }[] };
    assertStringIncludes(payload.messages[0].content, 'Prepare release notes');
    return Promise.resolve({
      v: 1,
      kind: 'response',
      id: 'model-response',
      replyTo: request.id,
      ok: true,
      payload: { text: '{"status":"planned","steps":[{"id":"one","description":"Draft notes"}]}' },
    });
  });
  assertEquals(calls, 1);
  assertEquals(result.failure, undefined);
  assertEquals(result.response?.payload, {
    status: 'planned',
    steps: [{ id: 'one', description: 'Draft notes' }],
  });
});
