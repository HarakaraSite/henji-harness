import { assertEquals, assertNotEquals } from '@std/assert';
import {
  pluginIdentity,
  pluginIdentityFromFiles,
  pluginSourcePaths,
} from '../../src/runner/plugin_identity.ts';
import { hashPayload } from '../../src/runner/trace.ts';

Deno.test('trace records a payload hash without retaining payload text', async () => {
  const hash = await hashPayload({ secret: 'do-not-log' });
  assertEquals(hash.length, 64);
  assertNotEquals(hash, 'do-not-log');
});

Deno.test('plugin identity is stable for the same source', async () => {
  assertEquals(
    await pluginIdentity('task-planner', '0.0.1', { 'main.ts': 'source' }),
    await pluginIdentity('task-planner', '0.0.1', { 'main.ts': 'source' }),
  );
});

Deno.test('plugin identity changes when a behavior-defining source changes', async () => {
  const before = await pluginIdentity('task-planner', '0.0.1', {
    'main.ts': 'entrypoint',
    'prompt.ts': 'original prompt',
  });
  const after = await pluginIdentity('task-planner', '0.0.1', {
    'main.ts': 'entrypoint',
    'prompt.ts': 'changed prompt',
  });
  assertNotEquals(before.sourceHash, after.sourceHash);
});

Deno.test('plugin identity from files is independent of checkout path', async () => {
  const readPaths: string[] = [];
  const readSource = (path: string) => {
    readPaths.push(path);
    return Promise.resolve(`contents of ${path.split('/').pop()}`);
  };
  assertEquals(
    await pluginIdentityFromFiles(
      'task-planner',
      '0.0.1',
      pluginSourcePaths('task-planner', '/checkout-a'),
      readSource,
    ),
    await pluginIdentityFromFiles(
      'task-planner',
      '0.0.1',
      pluginSourcePaths('task-planner', '/checkout-b'),
      readSource,
    ),
  );
  assertEquals(readPaths, [
    '/checkout-a/plugins/task-planner/main.ts',
    '/checkout-a/plugins/task-planner/prompt.ts',
    '/checkout-a/plugins/task-planner/plan_parser.ts',
    '/checkout-b/plugins/task-planner/main.ts',
    '/checkout-b/plugins/task-planner/prompt.ts',
    '/checkout-b/plugins/task-planner/plan_parser.ts',
  ]);
  assertEquals(Object.keys(pluginSourcePaths('task-planner', '/checkout-a')), [
    'main.ts',
    'prompt.ts',
    'plan_parser.ts',
  ]);
});

Deno.test('plugin source maps retain logical hash keys while resolving absolute read paths', () => {
  assertEquals(pluginSourcePaths('model-adapter', '/checkout'), {
    'main.ts': '/checkout/plugins/model-adapter/main.ts',
    'provider_codec.ts': '/checkout/plugins/model-adapter/provider_codec.ts',
    '../../src/domain/model.ts': '/checkout/src/domain/model.ts',
    '../../src/domain/errors.ts': '/checkout/src/domain/errors.ts',
  });
});
