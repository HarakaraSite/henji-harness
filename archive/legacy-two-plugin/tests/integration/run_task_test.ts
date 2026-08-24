import { assertEquals } from '@std/assert';
import { runTask } from '../../src/runner/run.ts';

Deno.test('runTask composes planner, adapter, and broker', async () => {
  const result = await runTask(
    { task: 'Draft notes' },
    'dummy-secret',
    Deno.execPath(),
    () =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: '{"status":"planned","steps":[]}' } }] }),
      ),
  );
  assertEquals(result, { status: 'planned', steps: [] });
});

Deno.test('runTask preserves a planner failure as a structured error', async () => {
  const result = await runTask(
    { task: 'Draft notes' },
    'dummy-secret',
    Deno.execPath(),
    () =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: 'not a plan' } }] }),
      ),
  );
  assertEquals(result, {
    code: 'plugin_response_failed',
    message: 'model output is not valid Plan JSON',
    cause: { code: 'planner_output_invalid', message: 'model output is not valid Plan JSON' },
  });
});

Deno.test('runTask traces a structured plugin failure code', async () => {
  const events: unknown[] = [];
  await runTask(
    { task: 'Draft notes' },
    'dummy-secret',
    Deno.execPath(),
    () => Promise.resolve(Response.json({ choices: [{ message: { content: 'not a plan' } }] })),
    (event) => {
      events.push(event);
    },
  );
  assertEquals(
    (events[1] as { failureCode?: string }).failureCode,
    'planner_output_invalid',
  );
});

Deno.test('runTask records redacted plugin identities and process measurements when tracing', async () => {
  const events: unknown[] = [];
  await runTask(
    { task: 'Draft notes' },
    'dummy-secret',
    Deno.execPath(),
    () =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: '{"status":"planned","steps":[]}' } }] }),
      ),
    (event) => {
      events.push(event);
    },
  );
  assertEquals(events.length, 2);
  assertEquals(
    (events[0] as { plugin: { id: string; sourceHash: string } }).plugin.id,
    'model-adapter',
  );
  assertEquals(
    (events[1] as { plugin: { id: string; sourceHash: string } }).plugin.sourceHash.length,
    64,
  );
});
