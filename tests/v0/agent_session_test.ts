import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { type AgentEvent, EventDeliveryError } from '../../v0/agent/events.ts';
import {
  type Message,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import {
  createFixtureTool,
  createJsonResultSubmissionTool,
  Registry,
  type Tool,
} from '../../v0/agent/tools.ts';

const call = (callId: string, name = 'uppercase_text', text = callId): ToolCall => ({
  callId,
  name,
  arguments: { text },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const names = (events: readonly AgentEvent[]): readonly string[] =>
  events.map((event) => event.kind);

Deno.test('session commits two plain turns and supplies the prior turn to the next request', async () => {
  const requests: ModelRequest[] = [];
  const model = {
    generate(request: ModelRequest) {
      requests.push(request);
      const last = request.transcript.at(-1);
      const isFirst = last?.role === 'user' && last.content.kind === 'text' &&
        last.content.text === 'first';
      return { kind: 'final' as const, text: isFirst ? 'one' : 'two' };
    },
  };
  const events: AgentEvent[] = [];
  const session = new AgentSession(model, new Registry([]), {
    eventSink: (event) => events.push(event),
  });

  const first = await session.submit('first');
  const second = await session.submit('second');
  assert(first.ok && second.ok);
  assertEquals(requests.map((request) => request.transcript), [
    [{ role: 'user', content: { kind: 'text', text: 'first' } }],
    [
      { role: 'user', content: { kind: 'text', text: 'first' } },
      { role: 'assistant', content: { kind: 'text', text: 'one' } },
      { role: 'user', content: { kind: 'text', text: 'second' } },
    ],
  ]);
  assertEquals(names(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'turn_end',
    'turn_start',
    'user_message',
    'assistant_message',
    'turn_end',
  ]);
  assertEquals(
    events.filter((event) => event.kind === 'turn_end').map((event) => event.committed),
    [
      true,
      true,
    ],
  );
  assertEquals(session.transcriptSnapshot().map((message) => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
});

Deno.test('turn_end observes the actual session commit while standalone turns have no owner', async () => {
  let observedAtEnd: readonly Message[] = [];
  const session = new AgentSession(
    { generate: () => ({ kind: 'final' as const, text: 'answer' }) },
    new Registry([]),
    {
      eventSink(event) {
        if (event.kind === 'turn_end') observedAtEnd = session.transcriptSnapshot();
      },
    },
  );
  await session.submit('session turn');
  assertEquals(observedAtEnd.map((message) => message.role), ['user', 'assistant']);

  let standaloneEnd: AgentEvent | undefined;
  await runAgentTurn(
    'standalone turn',
    [],
    { generate: () => ({ kind: 'final' as const, text: 'answer' }) },
    new Registry([]),
    {
      eventSink: (event) => {
        if (event.kind === 'turn_end') standaloneEnd = event;
      },
    },
  );
  assert(standaloneEnd?.kind === 'turn_end');
  assertEquals(standaloneEnd.committed, false);
});

Deno.test('tool turn commits correlated activity and terminal JSON ends only its own turn', async () => {
  const requests: ModelRequest[] = [];
  const model = {
    generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length === 1) {
        return { kind: 'tool_calls' as const, calls: [call('one', 'uppercase_text', 'hello')] };
      }
      if (requests.length === 2) return { kind: 'final' as const, text: 'done' };
      return {
        kind: 'tool_calls' as const,
        calls: [{ callId: 'json', name: 'submit_json_result', arguments: { json: '{"ok":true}' } }],
      };
    },
  };
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    model,
    new Registry([createFixtureTool(), createJsonResultSubmissionTool()]),
    { eventSink: (event) => events.push(event) },
  );

  const first = await session.submit('use a tool');
  assert(first.ok && first.stopReason === 'final');
  assertEquals(names(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'assistant_message',
    'turn_end',
  ]);
  const firstEnd = events.at(-1);
  assert(firstEnd?.kind === 'turn_end');
  assertEquals(firstEnd.turn, 1);
  assertEquals(firstEnd.committed, true);

  const terminal = await session.submit('submit JSON');
  assert(terminal.ok && terminal.stopReason === 'tool_terminal');
  assertEquals(names(events).slice(7), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'turn_end',
  ]);
  const terminalEnd = events.at(-1);
  assert(terminalEnd?.kind === 'turn_end');
  assertEquals(terminalEnd.turn, 2);
  assertEquals(terminalEnd.outcome, 'tool_terminal');
  assertEquals(terminalEnd.committed, true);
  assertEquals(requests[2].transcript.map((message) => message.role), [
    'user',
    'assistant',
    'tool',
    'assistant',
    'user',
  ]);
});

Deno.test('model failure, invalid result, and max steps emit one completed end and do not commit', async () => {
  for (
    const [label, generate, expectedOutcome] of [
      ['throw', () => {
        throw new Error('offline');
      }, 'contract_failure'],
      ['invalid', () => ({ kind: 'not-a-result' }), 'contract_failure'],
    ] as const
  ) {
    const events: AgentEvent[] = [];
    const session = new AgentSession(
      { generate: generate as (request: ModelRequest) => ModelResult },
      new Registry([]),
      { eventSink: (event) => events.push(event) },
    );
    const result = await session.submit(label);
    assert(!result.ok);
    assertEquals(result.outcome, expectedOutcome);
    assertEquals(names(events), ['turn_start', 'user_message', 'turn_end']);
    const end = events.at(-1);
    assert(end?.kind === 'turn_end');
    assertEquals(end.outcome, expectedOutcome);
    assertEquals(end.committed, false);
    assertEquals(session.transcriptSnapshot(), []);
  }

  const events: AgentEvent[] = [];
  const result = await new AgentSession(
    { generate: () => ({ kind: 'tool_calls' as const, calls: [call('loop')] }) },
    new Registry([createFixtureTool()]),
    { maxSteps: 1, eventSink: (event) => events.push(event) },
  ).submit('loop');
  assert(!result.ok);
  assertEquals(result.stopReason, 'max_steps');
  assertEquals(names(events), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'turn_end',
  ]);
  const end = events.at(-1);
  assert(end?.kind === 'turn_end');
  assertEquals(end.outcome, 'max_steps');
  assertEquals(end.committed, false);
});

Deno.test('event snapshots cannot mutate dispatch arguments, requests, or committed transcript', async () => {
  let executedArguments: unknown;
  const tool: Tool = {
    name: 'capture',
    description: 'capture',
    inputSchema: { type: 'object', properties: { nested: { type: 'object' } } },
    execute(argumentsValue) {
      executedArguments = argumentsValue;
      return JSON.stringify(argumentsValue);
    },
  };
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate(request) {
        requests.push(request);
        return request.transcript.at(-1)?.role === 'user'
          ? {
            kind: 'tool_calls' as const,
            calls: [{
              callId: 'capture',
              name: 'capture',
              arguments: { nested: { value: 'original' } },
            }],
          }
          : { kind: 'final' as const, text: 'finished' };
      },
    },
    new Registry([tool]),
    {
      eventSink(event) {
        events.push(event);
        if (event.kind === 'user_message') {
          (event.message.content as { text: string }).text = 'changed';
        }
        if (event.kind === 'tool_call') {
          (event.call.arguments as { nested: { value: string } }).nested.value = 'changed';
        }
      },
    },
  );

  await session.submit('original user');
  assertEquals(executedArguments, { nested: { value: 'original' } });
  assertEquals(requests[0].transcript[0], {
    role: 'user',
    content: { kind: 'text', text: 'original user' },
  });
  const exposed = session.transcriptSnapshot();
  (exposed[0].content as { text: string }).text = 'external mutation';
  assertEquals(session.transcriptSnapshot()[0], {
    role: 'user',
    content: { kind: 'text', text: 'original user' },
  });
});

Deno.test('defensive snapshots preserve nested -0 through requests, events, dispatch, and outcome', async () => {
  let dispatched: unknown;
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const tool: Tool = {
    name: 'negative_zero',
    description: 'preserve negative zero',
    inputSchema: { marker: -0 },
    execute(argumentsValue) {
      dispatched = argumentsValue;
      return 'preserved';
    },
  };
  const outcome = await runAgentTurn(
    'negative zero',
    [],
    {
      generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            kind: 'tool_calls' as const,
            calls: [{
              callId: 'negative-zero',
              name: 'negative_zero',
              arguments: { value: -0, nested: [-0, { value: -0 }] },
            }],
          };
        }
        const assistant = request.transcript[1];
        assert(assistant?.role === 'assistant' && Array.isArray(assistant.content));
        assert(Object.is(assistant.content[0].arguments.value, -0));
        assert(Object.is(assistant.content[0].arguments.nested[0], -0));
        return { kind: 'final' as const, text: 'finished' };
      },
    },
    new Registry([tool]),
    { eventSink: (event) => events.push(event) },
  );
  assert(Object.is((requests[0].tools[0].inputSchema as { marker: number }).marker, -0));
  assert(Object.is((dispatched as { value: number }).value, -0));
  const toolCall = events.find((event) => event.kind === 'tool_call');
  assert(toolCall?.kind === 'tool_call');
  assert(Object.is((toolCall.call.arguments as { value: number }).value, -0));
  assert(outcome.ok);
  const assistant = outcome.transcript[1];
  assert(assistant?.role === 'assistant' && Array.isArray(assistant.content));
  assert(Object.is(assistant.content[0].arguments.value, -0));
  assert(Object.is(assistant.content[0].arguments.nested[1].value, -0));
});

Deno.test('event sink failure stops before the next effect and rolls the turn back', async () => {
  const cases: readonly [
    'turn_start' | 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result' | 'turn_end',
    number,
    number,
  ][] = [
    ['turn_start', 0, 0],
    ['user_message', 0, 0],
    ['assistant_message', 1, 0],
    ['tool_call', 1, 0],
    ['tool_result', 1, 1],
  ];
  for (const [failingKind, expectedRequests, expectedExecutions] of cases) {
    let requests = 0;
    let executions = 0;
    const sink = (event: AgentEvent): void => {
      if (event.kind === failingKind) throw new Error('sink rejected');
    };
    const result = new AgentSession(
      {
        generate() {
          requests += 1;
          return {
            kind: 'tool_calls' as const,
            calls: [{ callId: 'call', name: 'count', arguments: { ok: true } }],
          };
        },
      },
      new Registry([{
        name: 'count',
        description: 'count',
        inputSchema: {},
        execute: () => {
          executions += 1;
          return 'done';
        },
      }]),
      { eventSink: sink },
    ).submit('fail');
    await assertRejects(() => result);
    assertEquals(requests, expectedRequests);
    assertEquals(executions, expectedExecutions);
  }

  const events: AgentEvent[] = [];
  let requests = 0;
  const session = new AgentSession(
    {
      generate: () => {
        requests += 1;
        return { kind: 'final' as const, text: 'done' };
      },
    },
    new Registry([]),
    {
      eventSink(event) {
        events.push(event);
        if (event.kind === 'turn_end') throw new Error('sink rejected');
      },
    },
  );
  const rejected = session.submit('turn end failure');
  await assertRejects(() => rejected);
  try {
    await rejected;
  } catch (error) {
    assert(error instanceof EventDeliveryError);
    assertEquals(error.message, 'agent event delivery failed');
  }
  assertEquals(requests, 1);
  assertEquals(session.transcriptSnapshot(), []);
  assertEquals(events.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'turn_end',
  ]);
});

Deno.test('sink failures stop every position in a multi-call batch before later effects', async () => {
  const cases: readonly [
    'tool_call' | 'tool_result',
    'first' | 'later',
    readonly string[],
  ][] = [
    ['tool_call', 'first', ['turn_start', 'user_message', 'assistant_message', 'tool_call']],
    ['tool_call', 'later', [
      'turn_start',
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'tool_call',
    ]],
    ['tool_result', 'first', [
      'turn_start',
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
    ]],
    ['tool_result', 'later', [
      'turn_start',
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
    ]],
  ];
  for (const [kind, position, expectedKinds] of cases) {
    const events: AgentEvent[] = [];
    const dispatches: string[] = [];
    let requests = 0;
    const session = new AgentSession(
      {
        generate() {
          requests += 1;
          return {
            kind: 'tool_calls' as const,
            calls: [call('first', 'ordered'), call('later', 'ordered')],
          };
        },
      },
      new Registry([{
        name: 'ordered',
        description: 'ordered',
        inputSchema: {},
        execute(argumentsValue) {
          dispatches.push((argumentsValue as { text: string }).text);
          return 'done';
        },
      }]),
      {
        eventSink(event) {
          events.push(event);
          const target = position === 'first' ? 'first' : 'later';
          const matches = kind === 'tool_call'
            ? event.kind === 'tool_call' && event.call.callId === target
            : event.kind === 'tool_result' && event.result.callId === target;
          if (matches) throw new Error('stop at requested multi-call position');
        },
      },
    );
    const rejected = session.submit('multi-call');
    await assertRejects(() => rejected);
    assertEquals(requests, 1);
    assertEquals(
      dispatches,
      kind === 'tool_call'
        ? position === 'first' ? [] : ['first']
        : position === 'first'
        ? ['first']
        : ['first', 'later'],
    );
    assertEquals(names(events), expectedKinds);
    assertEquals(session.transcriptSnapshot(), []);
  }
});

Deno.test('invalid mixed and duplicate terminal batches remain non-dispatched and event-correlated', async () => {
  const terminal = (callId: string): ToolCall => ({
    callId,
    name: 'submit_json_result',
    arguments: { json: '1' },
  });
  const normal = call('normal', 'ordered');
  const batches: readonly [string, readonly ToolCall[]][] = [
    ['mixed', [terminal('terminal'), normal]],
    ['duplicate', [terminal('terminal-a'), terminal('terminal-b')]],
  ];
  for (const [label, calls] of batches) {
    const events: AgentEvent[] = [];
    let requests = 0;
    let dispatches = 0;
    const session = new AgentSession(
      {
        generate() {
          requests += 1;
          return { kind: 'tool_calls' as const, calls };
        },
      },
      new Registry([
        createJsonResultSubmissionTool(),
        {
          name: 'ordered',
          description: 'ordered',
          inputSchema: {},
          execute: () => {
            dispatches += 1;
            return 'unexpected dispatch';
          },
        },
      ]),
      { maxSteps: 1, eventSink: (event) => events.push(event) },
    );
    const result = await session.submit(label);
    assert(!result.ok);
    assertEquals(result.stopReason, 'max_steps');
    assertEquals(requests, 1);
    assertEquals(dispatches, 0);
    assertEquals(
      events.filter((event) => event.kind === 'tool_call').map((event) => event.call.callId),
      calls.map((call) => call.callId),
    );
    assertEquals(
      events.filter((event) => event.kind === 'tool_result').map((event) => event.result),
      calls.map((call) => ({
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: 'terminal tool must be the sole call in its batch',
        outcome: 'error',
      })),
    );
    const end = events.at(-1);
    assert(end?.kind === 'turn_end');
    assertEquals(end.outcome, 'max_steps');
    assertEquals(end.committed, false);
    assertEquals(session.transcriptSnapshot(), []);
  }

  const failureEvents: AgentEvent[] = [];
  const rejectedSession = new AgentSession(
    {
      generate: () => ({ kind: 'tool_calls' as const, calls: [terminal('one'), terminal('two')] }),
    },
    new Registry([createJsonResultSubmissionTool()]),
    {
      eventSink(event) {
        failureEvents.push(event);
        if (event.kind === 'tool_result' && event.result.callId === 'two') {
          throw new Error('stop at duplicate terminal result');
        }
      },
    },
  );
  await assertRejects(() => rejectedSession.submit('duplicate failure'));
  assertEquals(failureEvents.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
  ]);
  assertEquals(rejectedSession.transcriptSnapshot(), []);

  const earlyEvents: AgentEvent[] = [];
  let earlyRequests = 0;
  let earlyDispatches = 0;
  const earlyFailureSession = new AgentSession(
    {
      generate: () => {
        earlyRequests += 1;
        return {
          kind: 'tool_calls' as const,
          calls: [terminal('early-terminal'), call('suppressed-normal', 'ordered')],
        };
      },
    },
    new Registry([
      createJsonResultSubmissionTool(),
      {
        name: 'ordered',
        description: 'ordered',
        inputSchema: {},
        execute: () => {
          earlyDispatches += 1;
          return 'unexpected dispatch';
        },
      },
    ]),
    {
      eventSink(event) {
        earlyEvents.push(event);
        if (event.kind === 'tool_result' && event.result.callId === 'early-terminal') {
          throw new Error('stop at first invalid terminal result');
        }
      },
    },
  );
  await assertRejects(() => earlyFailureSession.submit('early mixed failure'));
  assertEquals(earlyRequests, 1);
  assertEquals(earlyDispatches, 0);
  assertEquals(earlyEvents.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
  ]);
  assertEquals(
    earlyEvents.filter((event) => event.kind === 'tool_call').map((event) => event.call.callId),
    ['early-terminal'],
  );
  assertEquals(
    earlyEvents.filter((event) => event.kind === 'tool_result').map((event) => event.result.callId),
    ['early-terminal'],
  );
  assertEquals(earlyFailureSession.transcriptSnapshot(), []);
});

Deno.test('failed drafts do not reach the next turn while completed tool side effects remain', async () => {
  let requests = 0;
  let sideEffects = 0;
  let rejectResults = true;
  const seen: ModelRequest[] = [];
  const session = new AgentSession(
    {
      generate(request) {
        requests += 1;
        seen.push(request);
        return requests === 1
          ? { kind: 'tool_calls' as const, calls: [call('side-effect', 'count')] }
          : { kind: 'final' as const, text: 'recovered' };
      },
    },
    new Registry([{
      name: 'count',
      description: 'count',
      inputSchema: {},
      execute: () => {
        sideEffects += 1;
        return 'done';
      },
    }]),
    {
      eventSink(event) {
        if (rejectResults && event.kind === 'tool_result') {
          throw new Error('stop after side effect');
        }
      },
    },
  );
  await assertRejects(() => session.submit('failed turn'));
  assertEquals(sideEffects, 1);
  rejectResults = false;
  const recovered = await session.submit('recovery turn');
  assert(recovered.ok);
  assertEquals(seen[1].transcript, [{
    role: 'user',
    content: { kind: 'text', text: 'recovery turn' },
  }]);
  assertEquals(session.transcriptSnapshot().map((message) => message.role), ['user', 'assistant']);
});

Deno.test('blank and concurrent submits consume no turn, event, request, or transcript', async () => {
  const gate = deferred<{ kind: 'final'; text: string }>();
  let requests = 0;
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate() {
        requests += 1;
        return gate.promise;
      },
    },
    new Registry([]),
    { eventSink: (event) => events.push(event) },
  );
  await assertRejects(() => session.submit('   '));
  const first = session.submit('active');
  await Promise.resolve();
  await assertRejects(() => session.submit('concurrent'));
  assertEquals(requests, 1);
  assertEquals(events.map((event) => event.kind), ['turn_start', 'user_message']);
  gate.resolve({ kind: 'final', text: 'done' });
  await first;
  assertEquals((events[0] as { turn: number }).turn, 1);
  assertEquals(session.transcriptSnapshot().map((message) => message.role), ['user', 'assistant']);
});

Deno.test('max-step request ceiling resets independently for every accepted turn', async () => {
  let requests = 0;
  const session = new AgentSession(
    {
      generate: () => {
        requests += 1;
        return { kind: 'tool_calls' as const, calls: [call(`c-${requests}`)] };
      },
    },
    new Registry([createFixtureTool()]),
    { maxSteps: 8 },
  );
  const first = await session.submit('first');
  const second = await session.submit('second');
  assertEquals(first.stopReason, 'max_steps');
  assertEquals(second.stopReason, 'max_steps');
  assertEquals(requests, 16);
});

Deno.test('system instruction and sorted tool definitions stay fixed across turns and requests', async () => {
  const requests: ModelRequest[] = [];
  const session = new AgentSession(
    {
      generate(request) {
        requests.push(request);
        return { kind: 'final' as const, text: 'ok' };
      },
    },
    new Registry([
      { name: 'z', description: 'z', inputSchema: { nested: ['z'] }, execute: () => 'z' },
      { name: 'a', description: 'a', inputSchema: { nested: ['a'] }, execute: () => 'a' },
    ]),
    { systemInstruction: 'fixed instructions' },
  );
  await session.submit('one');
  await session.submit('two');
  assertEquals(requests.map((request) => request.systemInstruction), [
    'fixed instructions',
    'fixed instructions',
  ]);
  assertEquals(requests.map((request) => request.tools.map((tool) => tool.name)), [['a', 'z'], [
    'a',
    'z',
  ]]);
  assertEquals(requests[0].tools, requests[1].tools);
});

Deno.test('one-turn primitive accepts committed messages without mutating the caller', async () => {
  const prior: Message[] = [{ role: 'user', content: { kind: 'text', text: 'prior' } }];
  const request: ModelRequest[] = [];
  const outcome = await runAgentTurn(
    'next',
    prior,
    {
      generate(value) {
        request.push(value);
        return { kind: 'final' as const, text: 'answer' };
      },
    },
    new Registry([]),
    { turn: 7 },
  );
  assert(outcome.ok);
  assertEquals(prior, [{ role: 'user', content: { kind: 'text', text: 'prior' } }]);
  assertEquals(request[0].transcript.map((message) => message.role), ['user', 'user']);
  assertEquals(request[0].transcript.at(-1), {
    role: 'user',
    content: { kind: 'text', text: 'next' },
  });
});
