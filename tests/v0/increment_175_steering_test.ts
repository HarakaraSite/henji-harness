import { deepStrictEqual, strictEqual } from 'node:assert';
import type { LoopOutcome, Message, Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { SteeringOwner } from '../../v0/agent/core/steering.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ApplicationTaskService } from '../../v0/agent/host/task_service.ts';
import type { HostActiveSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { indexSessionHistory } from '../../v0/agent/session/session_history.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => resolve = accept);
  return { promise, resolve };
};

Deno.test('Increment 175 applies steering after a final response and retains its replay state', async () => {
  const steering = new SteeringOwner();
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const state = { provider: 'openai', replayItems: [{ type: 'message', id: 'first-response' }] };
  const model: Model = {
    generate(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        strictEqual(steering.admit('Research the web before answering.'), 'accepted');
        return { kind: 'final', text: 'Original answer', providerState: state };
      }
      return { kind: 'final', text: 'Answer with the additional research' };
    },
  };
  let committed: readonly Message[] | undefined;
  const result = await runAgentTurn('Original task', [], model, new Registry([]), {
    maxSteps: 2,
    steering,
    eventSink: (event) => events.push(event),
    commit: (transcript) => committed = transcript,
  });
  strictEqual(result.stopReason, 'final');
  strictEqual(result.finalText, 'Answer with the additional research');
  strictEqual(requests.length, 2);
  deepStrictEqual(requests[1].transcript, [
    { role: 'user', content: { kind: 'text', text: 'Original task' } },
    { role: 'assistant', content: { kind: 'text', text: 'Original answer' }, providerState: state },
    {
      role: 'user',
      content: { kind: 'text', text: 'Research the web before answering.' },
      steering: true,
    },
  ]);
  deepStrictEqual(committed, result.transcript);
  strictEqual(indexSessionHistory(result.transcript)?.turnCount, 1);
  strictEqual(events.filter((event) => event.kind === 'steering_message').length, 1);
  strictEqual(events.filter((event) => event.kind === 'turn_end').length, 1);
});

Deno.test('Increment 175 records accepted steering at the step limit instead of succeeding with the old final', async () => {
  const steering = new SteeringOwner();
  const events: AgentEvent[] = [];
  const result = await runAgentTurn(
    'Original task',
    [],
    {
      generate: () => {
        steering.admit('Use the new instruction.');
        return { kind: 'final', text: 'Original answer' };
      },
    },
    new Registry([]),
    {
      maxSteps: 1,
      steering,
      eventSink: (event) => events.push(event),
    },
  );
  strictEqual(result.ok, false);
  strictEqual(result.stopReason, 'max_steps');
  strictEqual(result.steps, 1);
  strictEqual(events.filter((event) => event.kind === 'steering_message').length, 1);
  deepStrictEqual(result.transcript.at(-1), {
    role: 'user',
    content: { kind: 'text', text: 'Use the new instruction.' },
    steering: true,
  });
});

Deno.test('Increment 175 closes the empty steering lane before announcing normal settlement', async () => {
  const steering = new SteeringOwner();
  let lateResult: string | undefined;
  await runAgentTurn(
    'Original task',
    [],
    {
      generate: () => ({ kind: 'final', text: 'Done' }),
    },
    new Registry([]),
    {
      steering,
      eventSink: (event) => {
        if (event.kind === 'turn_end') lateResult = steering.admit('Too late');
      },
    },
  );
  strictEqual(lateResult, 'idle');
});

const controlledTasks = async () => {
  const completion = deferred<Omit<LoopOutcome, 'transcript'>>();
  const receipt = deferred<'accepted' | 'idle'>();
  const sent = deferred<void>();
  const host = {
    sessionId: 'increment-175-session',
    admit: (_task: string, executionId: string) =>
      Promise.resolve({ executionId, completion: completion.promise }),
    steerActiveTurn: () => {
      sent.resolve();
      return receipt.promise;
    },
  } as unknown as HostActiveSession;
  const tasks = new ApplicationTaskService(() => host, () => {});
  const admission = await tasks.admit('Original task', 'task-command');
  const finish = async () => {
    completion.resolve({
      ok: true,
      task: 'Original task',
      outcome: 'final',
      stopReason: 'final',
      finalText: 'Done',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
    });
    await admission.untilIdle;
  };
  return { tasks, admission, receipt, sent, finish };
};

Deno.test('Increment 175 waits for Worker admission and rejects a closed lane without an accepted notice', async () => {
  const control = await controlledTasks();
  const result = control.tasks.steer(
    control.admission.executionId,
    'Additional instruction',
    'steer',
  );
  await control.sent.promise;
  strictEqual(control.tasks.pendingView().steering, undefined);
  strictEqual(control.tasks.canSteer(), false);
  control.receipt.resolve('idle');
  deepStrictEqual(await result, { kind: 'rejected', reason: 'idle' });
  strictEqual(control.tasks.pendingView().steering, undefined);
  await control.finish();
});

Deno.test('Increment 175 does not restore pending steering when application precedes its receipt', async () => {
  const control = await controlledTasks();
  const result = control.tasks.steer(
    control.admission.executionId,
    'Additional instruction',
    'steer',
  );
  await control.sent.promise;
  control.tasks.observe({ kind: 'steering_applied', executionId: control.admission.executionId });
  control.receipt.resolve('accepted');
  deepStrictEqual(await result, { kind: 'accepted' });
  strictEqual(control.tasks.pendingView().steering, undefined);
  strictEqual(control.tasks.canSteer(), false);
  await control.finish();
});
