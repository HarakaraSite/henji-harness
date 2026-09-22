import {
  type AsyncAgentRequest,
  type AsyncAgentResponse,
  createAsyncAgentTools,
} from '../../v0/agent/tools/async_agents.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

Deno.test('Increment 109 async agent tools expose a fixed four-operation surface', async () => {
  const requests: AsyncAgentRequest[] = [];
  const callIds: (string | undefined)[] = [];
  const rpc = (
    request: AsyncAgentRequest,
    callId?: string,
  ): Promise<AsyncAgentResponse> => {
    requests.push(request);
    callIds.push(callId);
    switch (request.kind) {
      case 'spawn':
        return Promise.resolve({ ok: true, kind: 'spawn', runId: 'run-1' });
      case 'status':
        return Promise.resolve({
          ok: true,
          kind: 'status',
          runId: request.runId,
          state: 'running',
        });
      case 'collect':
        return Promise.resolve({
          ok: true,
          kind: 'collect',
          result: {
            runId: request.runId,
            state: 'completed',
            finalText: 'child answer',
          },
        });
      case 'cancel':
        return Promise.resolve({
          ok: true,
          kind: 'cancel',
          runId: request.runId,
          state: 'cancelled',
        });
    }
  };
  const registry = new Registry([
    ...createAsyncAgentTools(['planner', 'researcher'], rpc),
  ]);
  assertEquals(
    registry.definitions().map((tool) => tool.name),
    ['cancel_subagent', 'collect_subagent', 'spawn_subagent', 'subagent_status'],
  );

  const spawned = await registry.dispatch(
    {
      callId: 'spawn-call-1',
      name: 'spawn_subagent',
      arguments: { agent: 'researcher', task: 'investigate X' },
    },
    { callId: 'spawn-call-1', signal: undefined },
  );
  assertEquals(JSON.parse(spawned.content.text), { ok: true, runId: 'run-1' });
  assertEquals(requests[0], { kind: 'spawn', agent: 'researcher', task: 'investigate X' });
  assertEquals(callIds[0], 'spawn-call-1');

  const status = await registry.dispatch({
    callId: 'status-1',
    name: 'subagent_status',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(status.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'running',
  });

  const collected = await registry.dispatch({
    callId: 'collect-1',
    name: 'collect_subagent',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(collected.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'completed',
    finalText: 'child answer',
  });

  const cancelled = await registry.dispatch({
    callId: 'cancel-1',
    name: 'cancel_subagent',
    arguments: { runId: 'run-1' },
  });
  assertEquals(JSON.parse(cancelled.content.text), {
    ok: true,
    runId: 'run-1',
    state: 'cancelled',
  });
});

Deno.test('Increment 109 spawn rejects an undeclared agent name', async () => {
  const registry = new Registry([
    ...createAsyncAgentTools(
      ['planner'],
      () => Promise.resolve({ ok: true, kind: 'spawn', runId: 'never' }),
    ),
  ]);
  const rejected = await registry.dispatch({
    callId: 'spawn-bad',
    name: 'spawn_subagent',
    arguments: { agent: 'researcher', task: 'x' },
  });
  assertEquals(rejected.content.outcome, 'error');
  assert(
    rejected.content.text.includes('agent must be one of'),
    'expected an undeclared-agent error result',
  );
});

Deno.test('Increment 109 child failure is reported without throwing', async () => {
  const registry = new Registry([
    ...createAsyncAgentTools(['planner'], (request) => {
      if (request.kind === 'collect') {
        return Promise.resolve({
          ok: true,
          kind: 'collect',
          result: {
            runId: request.runId,
            state: 'failed',
            error: 'child task failed',
          },
        });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    }),
  ]);
  const collected = await registry.dispatch({
    callId: 'collect-failed',
    name: 'collect_subagent',
    arguments: { runId: 'run-2' },
  });
  assertEquals(collected.content.outcome, 'success');
  assertEquals(JSON.parse(collected.content.text), {
    ok: true,
    runId: 'run-2',
    state: 'failed',
    error: 'child task failed',
  });
});
