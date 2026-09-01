import { assert, assertEquals } from './test_helpers.ts';
import {
  createFailureDiagnostic,
  decodeFailureDiagnostic,
  encodeFailureDiagnostic,
  FailureDiagnosticOwner,
  formatFailureDiagnostic,
  validateFailureDiagnostic,
} from '../../v0/agent/failure_diagnostic.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import {
  MAX_RESPONSE_BYTES,
  MAX_SSE_DATA_EVENTS,
  OpenRouterAgentError,
  OpenRouterAgentModel,
} from '../../v0/agent/openrouter_model.ts';
import type { ParseReason } from '../../v0/agent/failure_diagnostic.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import type { Model, ModelRequest } from '../../v0/agent/contracts.ts';
import { Registry } from '../../v0/agent/tools.ts';

const UUID = '12345678-1234-4234-8234-123456789abc';
const TIME = '2026-09-02T00:00:00.000Z';

const assertThrows = (fn: () => unknown): void => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw');
};

const base = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  diagnosticId: UUID,
  stage: 'response_parse' as const,
  code: 'response_error' as const,
  lane: 'parent' as const,
  providerRequestCount: 1,
  httpStatus: 200,
  parseReason: 'invalid_sse_json' as const,
  occurredAt: TIME,
  turnNumber: 1,
  modelStep: 1,
  retryCount: 0 as const,
  ...extra,
});

Deno.test('failure diagnostic v1 accepts canonical records and round trips exact bytes', () => {
  const value = createFailureDiagnostic(base(), {
    uuid: () => UUID,
    now: () => TIME,
  });
  assert(validateFailureDiagnostic(value));
  const encoded = encodeFailureDiagnostic(value);
  assertEquals(encoded, JSON.stringify(base()));
  assertEquals(decodeFailureDiagnostic(`${encoded}\n`), value);
  assertEquals(
    formatFailureDiagnostic(value),
    'failure> id=12345678-1234-4234-8234-123456789abc · stage=response_parse · code=response_error · lane=parent · requests=1 · http=200 · reason=invalid_sse_json · turn=1 · step=1 · occurredAt=2026-09-02T00:00:00.000Z · retry=0 · durable=yes',
  );
  assert(Object.isFrozen(value));
});

Deno.test('failure diagnostic v1 rejects extra data, malformed values, and wrong stage invariants', () => {
  assert(!validateFailureDiagnostic({ ...base(), message: 'private marker' }));
  assert(!validateFailureDiagnostic(base({ providerRequestCount: 17 })));
  assert(!validateFailureDiagnostic(base({ modelStep: 9 })));
  assert(!validateFailureDiagnostic(base({ httpStatus: 99 })));
  assert(
    !validateFailureDiagnostic(
      base({ stage: 'http', code: 'http_error', parseReason: undefined }),
    ),
  );
  assertThrows(() => decodeFailureDiagnostic(JSON.stringify(base())));
  assertThrows(() =>
    createFailureDiagnostic(base({ diagnosticId: 'not-a-uuid' }), {
      uuid: () => 'not-a-uuid',
      now: () => TIME,
    })
  );
});

Deno.test('failure diagnostic owner is single-use and snapshots injected identity', () => {
  const owner = new FailureDiagnosticOwner(3, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const first = owner.record({
    stage: 'transport',
    code: 'transport_error',
    providerRequestCount: 2,
    modelStep: 2,
  });
  assertEquals(first.turnNumber, 3);
  assertEquals(owner.snapshot(), first);
  assertThrows(() =>
    owner.record({
      stage: 'http',
      code: 'http_error',
      providerRequestCount: 2,
      httpStatus: 500,
      modelStep: 2,
    })
  );
});

const emptyRegistry = new Registry([]);
const request: ModelRequest = {
  transcript: [{ role: 'user', content: { kind: 'text', text: 'task' } }],
  tools: [],
};

Deno.test('loop propagates typed provider facts and occurrence-bound aggregate count', async () => {
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const context = new ParentTurnExecutionContext(
    1,
    undefined,
    undefined,
    undefined,
    owner,
  );
  const events: unknown[] = [];
  const model: Model = {
    generate: () => {
      throw new OpenRouterAgentError(
        'response_error',
        'fixed internal response failure',
        1,
        200,
        {
          stage: 'response_parse',
          code: 'response_error',
          parseReason: 'invalid_sse_json',
          httpStatus: 200,
        },
      );
    },
  };
  const outcome = await runAgentTurn('task', [], model, emptyRegistry, {
    executionContext: context,
    diagnosticOwner: owner,
    eventSink: (event) => events.push(event),
  });
  assertEquals(outcome.stopReason, 'contract_failure');
  assertEquals(outcome.diagnostic?.diagnosticId, UUID);
  assertEquals(outcome.diagnostic?.providerRequestCount, 1);
  assertEquals(outcome.diagnostic?.parseReason, 'invalid_sse_json');
  const end = events.at(-1) as { diagnostic?: unknown };
  assertEquals(end.diagnostic, outcome.diagnostic);
});

Deno.test('loop emits request admission and invalid result as distinct typed records', async () => {
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const context = new ParentTurnExecutionContext(
    1,
    undefined,
    undefined,
    undefined,
    owner,
  );
  const invalidModel: Model = {
    generate: () => ({ kind: 'not-a-result' } as never),
  };
  const invalid = await runAgentTurn('task', [], invalidModel, emptyRegistry, {
    executionContext: context,
    diagnosticOwner: owner,
  });
  assertEquals(invalid.diagnostic?.stage, 'model_result_validation');
  assertEquals(invalid.diagnostic?.code, 'invalid_model_result');
  assertEquals(invalid.diagnostic?.modelStep, 1);

  const exhaustedOwner = new FailureDiagnosticOwner(1, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const exhaustedContext = new ParentTurnExecutionContext(
    1,
    undefined,
    undefined,
    undefined,
    exhaustedOwner,
  );
  for (let index = 0; index < 8; index += 1) {
    assert(exhaustedContext.claimModelRequest());
  }
  const exhausted = await runAgentTurn(
    'task',
    [],
    { generate: () => ({ kind: 'final', text: 'unused' }) },
    emptyRegistry,
    {
      executionContext: exhaustedContext,
      diagnosticOwner: exhaustedOwner,
    },
  );
  assertEquals(exhausted.diagnostic?.stage, 'request_admission');
  assertEquals(exhausted.diagnostic?.code, 'request_budget_exhausted');
  assertEquals(exhausted.diagnostic?.providerRequestCount, 8);
  assertEquals(exhausted.diagnostic?.modelStep, 0);
});

Deno.test('normal success does not allocate a failure diagnostic', async () => {
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const result = await runAgentTurn(
    'task',
    [],
    { generate: () => ({ kind: 'final', text: 'ok' }) },
    emptyRegistry,
    {
      executionContext: new ParentTurnExecutionContext(
        1,
        undefined,
        undefined,
        undefined,
        owner,
      ),
      diagnosticOwner: owner,
    },
  );
  assertEquals(result.diagnostic, undefined);
  assertEquals(owner.snapshot(), undefined);
});

Deno.test('OpenRouter transport and HTTP failures retain fixed typed facts without payload text', async () => {
  const transport = new OpenRouterAgentModel({
    credential: 'credential-marker',
    fetcher: () => Promise.reject(new Error('private payload marker')),
  });
  let transportError: unknown;
  try {
    await transport.generate(request);
  } catch (error) {
    transportError = error;
  }
  assert(transportError instanceof OpenRouterAgentError);
  assertEquals(transportError.failureFact.stage, 'transport');
  assertEquals(transportError.failureFact.code, 'transport_error');
  assertEquals(transportError.failureFact.requestCount, 1);

  const http = new OpenRouterAgentModel({
    credential: 'credential-marker',
    fetcher: () => Promise.resolve(new Response('private payload marker', { status: 429 })),
  });
  let httpError: unknown;
  try {
    await http.generate(request);
  } catch (error) {
    httpError = error;
  }
  assert(httpError instanceof OpenRouterAgentError);
  assertEquals(httpError.failureFact.stage, 'http');
  assertEquals(httpError.failureFact.code, 'http_error');
  assertEquals(httpError.failureFact.requestCount, 1);
  assertEquals(httpError.failureFact.httpStatus, 429);
});

Deno.test('credential resolution remains request-free even after loop admission', async () => {
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => UUID,
    now: () => TIME,
  });
  const model = new OpenRouterAgentModel({
    credential: undefined,
    credentialSource: () => undefined,
  });
  const result = await runAgentTurn('task', [], model, emptyRegistry, {
    executionContext: new ParentTurnExecutionContext(
      1,
      undefined,
      undefined,
      undefined,
      owner,
    ),
    diagnosticOwner: owner,
  });
  assertEquals(result.diagnostic?.stage, 'credential_resolution');
  assertEquals(result.diagnostic?.code, 'missing_credential');
  assertEquals(result.diagnostic?.providerRequestCount, 0);
});

Deno.test('later request-build failures retain prior aggregate count while first stays zero', async () => {
  let aggregate = 0;
  let calls = 0;
  const owner = new FailureDiagnosticOwner(1, { uuid: () => UUID, now: () => TIME });
  const result = await runAgentTurn(
    'task',
    [],
    {
      generate: () => {
        calls += 1;
        if (calls === 1) {
          aggregate = 1;
          return {
            kind: 'tool_calls' as const,
            calls: [{ callId: 'unknown', name: 'missing', arguments: {} }],
          };
        }
        throw new OpenRouterAgentError(
          'limit_exceeded',
          'request build limit',
          0,
          undefined,
          { stage: 'request_build', code: 'limit_exceeded' },
        );
      },
    },
    emptyRegistry,
    {
      executionContext: new ParentTurnExecutionContext(
        1,
        undefined,
        undefined,
        undefined,
        owner,
        () => aggregate,
      ),
      diagnosticOwner: owner,
    },
  );
  assertEquals(result.diagnostic?.stage, 'request_build');
  assertEquals(result.diagnostic?.providerRequestCount, 1);
});

Deno.test('parent step two transport, HTTP, parser, and credential facts retain exact occurrence bounds', async () => {
  const cases = [
    {
      stage: 'transport' as const,
      code: 'transport_error' as const,
      fetchCount: 2 as const,
    },
    {
      stage: 'http' as const,
      code: 'http_error' as const,
      fetchCount: 2 as const,
    },
    {
      stage: 'response_parse' as const,
      code: 'response_error' as const,
      fetchCount: 2 as const,
    },
    {
      stage: 'credential_resolution' as const,
      code: 'missing_credential' as const,
      fetchCount: 1 as const,
    },
  ] as const;
  for (const current of cases) {
    let fetchCalls = 0;
    let credentialCalls = 0;
    const firstToolResponse = JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'missing', arguments: '{}' },
          }],
        },
      }],
    });
    const model = new OpenRouterAgentModel({
      responseMode: 'json',
      credentialSource: () => {
        credentialCalls += 1;
        if (current.stage === 'credential_resolution' && credentialCalls > 1) {
          return undefined;
        }
        return 'credential-value-marker';
      },
      fetcher: () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return Promise.resolve(
            new Response(firstToolResponse, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (current.stage === 'transport') {
          return Promise.reject(
            new Error('Authorization: Bearer authorization-shaped-marker private-payload-marker'),
          );
        }
        if (current.stage === 'http') {
          return Promise.resolve(
            new Response('private-payload-marker', {
              status: 429,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (current.stage === 'response_parse') {
          return Promise.resolve(
            new Response('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        throw new Error('credential resolution should not start a second fetch');
      },
    });
    const events: unknown[] = [];
    const owner = new FailureDiagnosticOwner(1, { uuid: () => UUID, now: () => TIME });
    const outcome = await runAgentTurn(
      'task',
      [],
      model,
      emptyRegistry,
      {
        eventSink: (event) => events.push(event),
        executionContext: new ParentTurnExecutionContext(
          1,
          undefined,
          undefined,
          undefined,
          owner,
          () => fetchCalls,
        ),
        diagnosticOwner: owner,
      },
    );
    assertEquals(outcome.diagnostic?.stage, current.stage);
    assertEquals(outcome.diagnostic?.code, current.code);
    assertEquals(outcome.diagnostic?.providerRequestCount, current.fetchCount);
    assertEquals(outcome.diagnostic?.modelStep, 2);
    if (current.stage === 'http') assertEquals(outcome.diagnostic?.httpStatus, 429);
    if (current.stage === 'response_parse') {
      assertEquals(outcome.diagnostic?.httpStatus, 200);
      assertEquals(outcome.diagnostic?.parseReason, 'invalid_sse_json');
    }
    assertEquals(fetchCalls, current.fetchCount);
    assertEquals(credentialCalls, 2);
    const terminal = events.at(-1) as { readonly diagnostic?: unknown };
    assertEquals(terminal.diagnostic, outcome.diagnostic);
    assert(!JSON.stringify(outcome).includes('credential-value-marker'));
    assert(!JSON.stringify(outcome).includes('authorization-shaped-marker'));
    assert(!JSON.stringify(outcome).includes('private-payload-marker'));
  }
});

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const sseModel = (
  body: BodyInit | null,
  contentType = 'text/event-stream',
  status = 200,
) =>
  new OpenRouterAgentModel({
    credential: 'credential-marker',
    responseMode: 'sse',
    fetcher: () =>
      Promise.resolve(
        new Response(body, {
          status,
          headers: { 'content-type': contentType },
        }),
      ),
  });

const sseFailure = async (
  body: BodyInit | null,
  contentType = 'text/event-stream',
  status = 200,
): Promise<OpenRouterAgentError> => {
  try {
    await sseModel(body, contentType, status).generate(request);
  } catch (error) {
    assert(error instanceof OpenRouterAgentError);
    return error;
  }
  throw new Error('expected an SSE failure');
};

const assertResponseParseFact = (
  error: OpenRouterAgentError,
  parseReason: ParseReason,
  code: 'response_error' | 'limit_exceeded' = 'response_error',
  status = 200,
): void => {
  assertEquals(error.failureFact, {
    stage: 'response_parse',
    code,
    requestCount: 1,
    httpStatus: status,
    parseReason,
  });
};

Deno.test('every response refusal maps to one bounded parse reason with the HTTP status', async () => {
  const validDelta = {
    id: 'completion-1',
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  const finalDelta = {
    id: 'completion-1',
    choices: [{
      index: 0,
      delta: { content: 'answer' },
      finish_reason: 'stop',
    }],
  };
  const toolFragment = {
    index: 0,
    id: 'call-1',
    type: 'function',
    function: { name: 'tool', arguments: '{}' },
  };
  const cases: readonly [
    string,
    BodyInit | null,
    string,
    'response_error' | 'limit_exceeded',
  ][] = [
    [
      'unsupported media type',
      sseFrame(finalDelta),
      'application/json',
      'response_error',
    ],
    ['response body missing', null, 'text/event-stream', 'response_error'],
    [
      'response body too large',
      new Uint8Array(MAX_RESPONSE_BYTES + 1),
      'text/event-stream',
      'limit_exceeded',
    ],
    [
      'response stream failed',
      Array.from(
        { length: MAX_SSE_DATA_EVENTS + 1 },
        () => sseFrame(validDelta),
      ).join(''),
      'text/event-stream',
      'limit_exceeded',
    ],
    [
      'invalid UTF-8',
      new Uint8Array([0xff]),
      'text/event-stream',
      'response_error',
    ],
    [
      'invalid SSE framing',
      'data: {}\n',
      'text/event-stream',
      'response_error',
    ],
    ['invalid SSE JSON', 'data: {\n\n', 'text/event-stream', 'response_error'],
    [
      'provider reported error',
      sseFrame({ id: 'completion-1', error: { code: 'provider-private' } }),
      'text/event-stream',
      'response_error',
    ],
    [
      'invalid completion identity',
      sseFrame({
        id: '',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'unsupported choice shape',
      sseFrame({ id: 'completion-1', choices: [] }),
      'text/event-stream',
      'response_error',
    ],
    [
      'unsupported finish reason',
      sseFrame({
        id: 'completion-1',
        choices: [{
          index: 0,
          delta: { content: 'answer' },
          finish_reason: 'other',
        }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'unsupported delta shape',
      sseFrame({
        id: 'completion-1',
        choices: [{ index: 0, delta: [], finish_reason: null }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'mixed text and tool calls',
      sseFrame({
        ...validDelta,
        choices: [{
          index: 0,
          delta: { tool_calls: [toolFragment] },
          finish_reason: null,
        }],
      }) + sseFrame({
        ...validDelta,
        choices: [{
          index: 0,
          delta: { content: 'answer' },
          finish_reason: null,
        }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'invalid tool arguments',
      sseFrame({
        id: 'completion-1',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              ...toolFragment,
              function: { ...toolFragment.function, arguments: '{' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'incomplete tool call',
      sseFrame({
        id: 'completion-1',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ ...toolFragment, index: 1 }] },
          finish_reason: 'tool_calls',
        }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'invalid usage frame',
      sseFrame({ ...validDelta, usage: {} }),
      'text/event-stream',
      'response_error',
    ],
    [
      'data after terminal',
      sseFrame(finalDelta) +
      sseFrame({
        ...validDelta,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'empty terminal result',
      sseFrame({
        ...validDelta,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'text/event-stream',
      'response_error',
    ],
    [
      'stream ended before done',
      sseFrame(finalDelta),
      'text/event-stream',
      'response_error',
    ],
    [
      'unsupported response shape',
      sseFrame([]),
      'text/event-stream',
      'response_error',
    ],
  ];
  const reasons = [
    'unsupported_media_type',
    'response_body_missing',
    'response_body_too_large',
    'response_stream_failed',
    'invalid_utf8',
    'invalid_sse_framing',
    'invalid_sse_json',
    'provider_reported_error',
    'invalid_completion_identity',
    'unsupported_choice_shape',
    'unsupported_finish_reason',
    'unsupported_delta_shape',
    'mixed_text_and_tool_calls',
    'invalid_tool_arguments',
    'incomplete_tool_call',
    'invalid_usage_frame',
    'data_after_terminal',
    'empty_terminal_result',
    'stream_ended_before_done',
    'unsupported_response_shape',
  ] as const;
  assertEquals(cases.length, reasons.length);
  for (const [index, [, body, contentType, code]] of cases.entries()) {
    const error = await sseFailure(body, contentType);
    assertResponseParseFact(error, reasons[index], code);
  }
});

Deno.test('JSON response parse failures retain status and fixed reason', async () => {
  const missing = await (async () => {
    try {
      await new OpenRouterAgentModel({
        credential: 'credential-marker',
        fetcher: () =>
          Promise.resolve(
            new Response(null, {
              status: 206,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      }).generate(request);
    } catch (error) {
      assert(error instanceof OpenRouterAgentError);
      return error;
    }
    throw new Error('expected missing body');
  })();
  assertResponseParseFact(
    missing,
    'response_body_missing',
    'response_error',
    206,
  );

  const invalid = await (async () => {
    try {
      await new OpenRouterAgentModel({
        credential: 'credential-marker',
        fetcher: () =>
          Promise.resolve(
            new Response('{', {
              status: 207,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      }).generate(request);
    } catch (error) {
      assert(error instanceof OpenRouterAgentError);
      return error;
    }
    throw new Error('expected invalid JSON');
  })();
  assertResponseParseFact(invalid, 'invalid_sse_json', 'response_error', 207);
});

Deno.test('post-HTTP body and SSE reader failures retain response parse status', async () => {
  const failingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      controller.error(new Error('private body marker'));
    },
    cancel() {
      // The reader is settled even though the source reported a read error.
    },
  });
  let bodyError: unknown;
  try {
    await new OpenRouterAgentModel({
      credential: 'credential-marker',
      fetcher: () =>
        Promise.resolve(
          new Response(failingBody, {
            status: 208,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    }).generate(request);
  } catch (error) {
    bodyError = error;
  }
  assert(bodyError instanceof OpenRouterAgentError);
  assertResponseParseFact(bodyError, 'response_stream_failed', 'response_error', 208);

  const failingSseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('private stream marker'));
    },
    cancel() {
      // The reader is settled even though the source reported a read error.
    },
  });
  let sseError: unknown;
  try {
    await new OpenRouterAgentModel({
      credential: 'credential-marker',
      responseMode: 'sse',
      fetcher: () =>
        Promise.resolve(
          new Response(failingSseBody, {
            status: 209,
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    }).generate(request);
  } catch (error) {
    sseError = error;
  }
  assert(sseError instanceof OpenRouterAgentError);
  assertResponseParseFact(sseError, 'response_stream_failed', 'response_error', 209);
});
