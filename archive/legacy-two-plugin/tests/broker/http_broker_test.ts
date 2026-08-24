import { assertEquals } from '@std/assert';
import { callBroker } from '../../src/broker/http_broker.ts';

const options = {
  apiKey: 'dummy-secret',
  timeoutMs: 100,
  maxRequestBytes: 1024,
  maxResponseBytes: 1024,
};
const codeOf = (value: Awaited<ReturnType<typeof callBroker>>) =>
  'code' in value ? value.code : undefined;

Deno.test('broker resolves exactly the OpenRouter chat-completions operation', async () => {
  let request: Request | undefined;
  const result = await callBroker({
    endpointId: 'openrouter-api',
    operationId: 'chat-completions',
    body: { model: 'google/gemini-3.7-flash' },
  }, {
    ...options,
    fetchFn: (input, init) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({ choices: [] }));
    },
  });
  assertEquals(result, { status: 200, body: { choices: [] } });
  assertEquals(request?.url, 'https://openrouter.ai/api/v1/chat/completions');
  assertEquals(request?.headers.get('authorization'), 'Bearer dummy-secret');
});

Deno.test('broker rejects unallowlisted operations and oversized bodies', async () => {
  assertEquals(
    codeOf(
      await callBroker({ endpointId: 'other', operationId: 'chat-completions', body: {} }, options),
    ),
    'protocol_violation',
  );
  assertEquals(
    codeOf(
      await callBroker({
        endpointId: 'openrouter-api',
        operationId: 'chat-completions',
        body: { x: 'x'.repeat(1024) },
      }, options),
    ),
    'message_limit_exceeded',
  );
});

Deno.test('broker rejects oversized and malformed provider responses', async () => {
  const oversized = await callBroker({
    endpointId: 'openrouter-api',
    operationId: 'chat-completions',
    body: {},
  }, {
    ...options,
    maxResponseBytes: 2,
    fetchFn: () => Promise.resolve(Response.json({ choices: [] })),
  });
  assertEquals(codeOf(oversized), 'message_limit_exceeded');
  const malformed = await callBroker({
    endpointId: 'openrouter-api',
    operationId: 'chat-completions',
    body: {},
  }, { ...options, fetchFn: () => Promise.resolve(new Response('not json')) });
  assertEquals(codeOf(malformed), 'invalid_model_response');
});

Deno.test('broker stops reading a chunked response after its byte limit', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"x":"'));
      controller.enqueue(new Uint8Array(64));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await callBroker({
    endpointId: 'openrouter-api',
    operationId: 'chat-completions',
    body: {},
  }, { ...options, maxResponseBytes: 8, fetchFn: () => Promise.resolve(new Response(stream)) });
  assertEquals(codeOf(result), 'message_limit_exceeded');
  assertEquals(cancelled, true);
});
