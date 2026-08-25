import { assert, assertEquals } from './test_helpers.ts';
import { type Model, type ModelResult, type ToolCall } from '../../v0/agent/contracts.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { ExactJsonKeysModel, JSON_KEYS_TASK } from '../../v0/agent/real_json_keys_task.ts';
import { MULTI_TOOL_TASK, OrderedMultiToolModel } from '../../v0/agent/real_multi_tool_task.ts';
import {
  createJsonArrayCountTool,
  createJsonObjectKeysTool,
  Registry,
} from '../../v0/agent/tools.ts';

const encoder = new TextEncoder();
const allowedPath = 'deno.v0.json';
const call = (path: string, objectKey: string) => ({
  callId: 'json-keys',
  name: 'list_json_object_keys',
  arguments: { path, objectKey },
});

const listToolCall = (callId = 'list-call'): ToolCall => ({
  callId,
  name: 'list_json_object_keys',
  arguments: { path: allowedPath, objectKey: 'tasks' },
});

const countToolCall = (json: string, callId = 'count-call'): ToolCall => ({
  callId,
  name: 'count_json_array_items',
  arguments: { json },
});

const scriptedModel = (results: readonly ModelResult[]): {
  readonly model: Model;
  readonly callCount: number;
} => {
  let callCount = 0;
  return {
    model: {
      generate: () => {
        const result = results[callCount];
        callCount += 1;
        if (!result) throw new Error('unexpected extra model request');
        return result;
      },
    },
    get callCount() {
      return callCount;
    },
  };
};

Deno.test('lists sorted keys from the allowed JSON object', async () => {
  const registry = new Registry([createJsonObjectKeysTool({
    allowedPath,
    readFile: () => Promise.resolve(encoder.encode('{"tasks":{"z":"last","a":"first"}}')),
  })]);
  const result = await registry.dispatch(call(allowedPath, 'tasks'));
  assertEquals(result.outcome, 'success');
  assertEquals(result.text, '["a","z"]');
});

Deno.test('rejects other paths, malformed input, invalid JSON, non-object values, and oversized files', async () => {
  const cases = [
    { path: 'other.json', objectKey: 'tasks', text: '{"tasks":{}}', maxBytes: 1024 },
    { path: allowedPath, objectKey: '', text: '{"tasks":{}}', maxBytes: 1024 },
    { path: allowedPath, objectKey: 'tasks', text: '{', maxBytes: 1024 },
    { path: allowedPath, objectKey: 'tasks', text: '[]', maxBytes: 1024 },
    { path: allowedPath, objectKey: 'tasks', text: '{"tasks":[]}', maxBytes: 1024 },
    { path: allowedPath, objectKey: 'tasks', text: '{"tasks":{}}', maxBytes: 1 },
  ] as const;
  for (const testCase of cases) {
    let reads = 0;
    const registry = new Registry([createJsonObjectKeysTool({
      allowedPath,
      maxBytes: testCase.maxBytes,
      readFile: () => {
        reads += 1;
        return Promise.resolve(encoder.encode(testCase.text));
      },
    })]);
    const result = await registry.dispatch(call(testCase.path, testCase.objectKey));
    assertEquals(result.outcome, 'error');
    if (testCase.path !== allowedPath || testCase.objectKey === '') {
      assertEquals(reads, 0);
      assert(result.text.startsWith('invalid arguments:'));
    } else {
      assertEquals(reads, 1);
      assert(result.text.startsWith('tool execution error:'));
    }
  }
});

Deno.test('reads the real non-secret task configuration within the explicit permission boundary', async () => {
  const registry = new Registry([createJsonObjectKeysTool({ allowedPath })]);
  const result = await registry.dispatch(call(allowedPath, 'tasks'));
  assertEquals(result.outcome, 'success');
  const keys = JSON.parse(result.text) as string[];
  assert(keys.includes('agent:selection:test'));
  assert(keys.includes('v0:gate'));
  assertEquals(keys, [...keys].sort());
});

Deno.test('counts items in a JSON array string', async () => {
  const registry = new Registry([createJsonArrayCountTool()]);
  const result = await registry.dispatch({
    callId: 'count-array',
    name: 'count_json_array_items',
    arguments: { json: '["a", "b", "c"]' },
  });
  assertEquals(result.outcome, 'success');
  assertEquals(result.text, '{"count":3}');
});

Deno.test('JSON task preserves two requests and rejects a failed first result after one request', async () => {
  const successScript = scriptedModel([
    { kind: 'tool_calls', calls: [listToolCall()] },
    { kind: 'final', text: '["a","z"]' },
  ]);
  const success = await runAgent(
    JSON_KEYS_TASK,
    new ExactJsonKeysModel(successScript.model),
    new Registry([createJsonObjectKeysTool({
      allowedPath,
      readFile: () => Promise.resolve(encoder.encode('{"tasks":{"z":"last","a":"first"}}')),
    })]),
    { maxSteps: 2 },
  );
  assert(success.ok);
  assertEquals(success.steps, 2);
  assertEquals(success.toolCallCount, 1);
  assertEquals(success.toolResultCount, 1);
  assertEquals(successScript.callCount, 2);

  const failureScript = scriptedModel([
    { kind: 'tool_calls', calls: [listToolCall()] },
  ]);
  const failure = await runAgent(
    JSON_KEYS_TASK,
    new ExactJsonKeysModel(failureScript.model),
    new Registry([createJsonObjectKeysTool({
      allowedPath,
      readFile: () => Promise.reject(new Error('fixture read failed')),
    })]),
    { maxSteps: 2 },
  );
  assertEquals(failure.stopReason, 'contract_failure');
  assertEquals(failure.steps, 2);
  assertEquals(failure.toolCallCount, 1);
  assertEquals(failure.toolResultCount, 1);
  assertEquals(failureScript.callCount, 1);
});

Deno.test('multi-tool task preserves three requests and rejects a failed second result after two requests', async () => {
  const successScript = scriptedModel([
    { kind: 'tool_calls', calls: [listToolCall()] },
    { kind: 'tool_calls', calls: [countToolCall('["a","b"]')] },
    { kind: 'final', text: '{"count":2}' },
  ]);
  const success = await runAgent(
    MULTI_TOOL_TASK,
    new OrderedMultiToolModel(successScript.model),
    new Registry([
      createJsonObjectKeysTool({
        allowedPath,
        readFile: () => Promise.resolve(encoder.encode('{"tasks":{"b":"second","a":"first"}}')),
      }),
      createJsonArrayCountTool(),
    ]),
    { maxSteps: 3 },
  );
  assert(success.ok);
  assertEquals(success.steps, 3);
  assertEquals(success.toolCallCount, 2);
  assertEquals(success.toolResultCount, 2);
  assertEquals(successScript.callCount, 3);

  const failureScript = scriptedModel([
    { kind: 'tool_calls', calls: [listToolCall()] },
    { kind: 'tool_calls', calls: [countToolCall('["a","b"]')] },
  ]);
  const failure = await runAgent(
    MULTI_TOOL_TASK,
    new OrderedMultiToolModel(failureScript.model),
    new Registry([
      createJsonObjectKeysTool({
        allowedPath,
        readFile: () => Promise.resolve(encoder.encode('{"tasks":{"b":"second","a":"first"}}')),
      }),
      {
        name: 'count_json_array_items',
        description: 'fixture failure',
        inputSchema: {},
        execute: () => {
          throw new Error('fixture count failed');
        },
      },
    ]),
    { maxSteps: 3 },
  );
  assertEquals(failure.stopReason, 'contract_failure');
  assertEquals(failure.steps, 3);
  assertEquals(failure.toolCallCount, 2);
  assertEquals(failure.toolResultCount, 2);
  assertEquals(failureScript.callCount, 2);
});
