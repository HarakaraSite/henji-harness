import { OpenRouterResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_transport.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const encoder = new TextEncoder();

/** A ReadableStream that keeps producing on demand so the reader never awaits a macrotask. */
const continuousStream = (frame: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      let batch = '';
      for (let index = 0; index < 500; index += 1) batch += frame;
      controller.enqueue(encoder.encode(batch));
    },
  });

const modelFor = (baseURL: string, timeoutMs: number): OpenRouterResponsesModel =>
  new OpenRouterResponsesModel({
    selection: {
      provider: 'openrouter-responses',
      api: 'openrouter-responses',
      authProfile: 'test',
      modelId: 'test',
      effort: 'high',
    } as never,
    credentialSource: () => Promise.resolve('test-key'),
    timeoutMs,
    baseURL,
  });

const generate = (model: OpenRouterResponsesModel): Promise<unknown> =>
  model.generate(
    { transcript: [{ role: 'user', content: { kind: 'text', text: 'hi' } }], tools: [] } as never,
    {} as never,
  );

const streamErrorCode = async (model: OpenRouterResponsesModel): Promise<string | undefined> => {
  try {
    await generate(model);
    return undefined;
  } catch (error) {
    return (error as { readonly code?: string }).code;
  }
};

Deno.test('Increment 100 provider deadline fires during a continuous stream', async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, () =>
    new Response(
      continuousStream(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
      ),
      { headers: { 'content-type': 'text/event-stream' } },
    ));
  const port = (server.addr as Deno.NetAddr).port;
  try {
    const started = performance.now();
    const code = await streamErrorCode(modelFor(`http://localhost:${port}/v1`, 500));
    const elapsed = performance.now() - started;
    assert(code === 'provider_timeout', `expected provider_timeout, got ${code}`);
    assert(elapsed < 5_000, `deadline fired late: ${Math.round(elapsed)}ms`);
  } finally {
    await server.shutdown();
  }
});

Deno.test('Increment 100 chat provider deadline fires during a continuous stream', async () => {
  const model = new OpenRouterAgentModel({
    profile: {
      id: 'test-profile',
      model: 'test/model',
      origin: 'https://openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      secretEnv: 'HENJI_TEST_KEY',
      maxCompletionTokens: 128,
      stream: false,
    } as never,
    responseMode: 'sse',
    credential: 'dummy-credential-value',
    timeoutMs: 500,
    fetcher: () =>
      Promise.resolve(
        new Response(
          continuousStream(
            'data: {"id":"gen","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
      ),
  } as never);
  const started = performance.now();
  let code: string | undefined;
  try {
    await model.generate(
      { transcript: [{ role: 'user', content: { kind: 'text', text: 'hi' } }], tools: [] } as never,
      {} as never,
    );
  } catch (error) {
    code = (error as { readonly code?: string }).code;
  }
  assert(code === 'provider_timeout', `expected provider_timeout, got ${code}`);
  assert(performance.now() - started < 5_000, 'chat deadline did not fire promptly');
});

Deno.test('Increment 100 provider deadline fires when the stream stalls', async () => {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    const started = performance.now();
    const code = await streamErrorCode(modelFor(`http://localhost:${port}/v1`, 500));
    const elapsed = performance.now() - started;
    assert(code === 'provider_timeout', `expected provider_timeout, got ${code}`);
    assert(elapsed < 5_000, `deadline fired late: ${Math.round(elapsed)}ms`);
  } finally {
    await server.shutdown();
  }
});
