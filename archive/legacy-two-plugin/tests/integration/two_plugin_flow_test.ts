import { assertEquals } from '@std/assert';
import { runPluginSession } from '../../src/runner/plugin_session.ts';

const sessionOptions = (entrypoint: string) => ({
  denoCommand: Deno.execPath(),
  entrypoint,
  cwd: Deno.cwd(),
  timeoutMs: 500,
  maxStdoutBytes: 4096,
  maxStderrBytes: 4096,
  maxTotalOutputBytes: 8192,
});

Deno.test('planner reaches adapter and broker in one model call', async () => {
  let modelCalls = 0;
  let brokerCalls = 0;
  const planner = await runPluginSession(
    {
      v: 1,
      kind: 'request',
      id: 'planner-root',
      method: 'plugin.execute',
      payload: { task: 'Prepare release notes' },
    },
    sessionOptions(new URL('../../plugins/task-planner/main.ts', import.meta.url).pathname),
    async (modelRequest) => {
      modelCalls += 1;
      const adapter = await runPluginSession(
        {
          v: 1,
          kind: 'request',
          id: 'adapter-root',
          method: 'plugin.execute',
          payload: modelRequest.payload,
        },
        sessionOptions(new URL('../../plugins/model-adapter/main.ts', import.meta.url).pathname),
        (brokerRequest) => {
          brokerCalls += 1;
          assertEquals(brokerRequest.method, 'host.broker.call');
          return Promise.resolve({
            v: 1,
            kind: 'response',
            id: 'broker-response',
            replyTo: brokerRequest.id,
            ok: true,
            payload: {
              choices: [{
                message: {
                  content:
                    '{"status":"planned","steps":[{"id":"one","description":"Draft notes"}]}',
                },
              }],
            },
          });
        },
      );
      assertEquals(adapter.failure, undefined);
      return {
        v: 1,
        kind: 'response',
        id: 'model-response',
        replyTo: modelRequest.id,
        ok: true,
        payload: adapter.response?.payload,
      };
    },
  );
  assertEquals(modelCalls, 1);
  assertEquals(brokerCalls, 1);
  assertEquals(planner.failure, undefined);
  assertEquals(planner.response?.payload, {
    status: 'planned',
    steps: [{ id: 'one', description: 'Draft notes' }],
  });
});
