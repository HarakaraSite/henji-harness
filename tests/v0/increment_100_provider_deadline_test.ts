import { OpenRouterResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const SSE_FRAME =
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n';

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
  const encoder = new TextEncoder();
  const server = Deno.serve({ port: 0, onListen: () => {} }, () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setInterval(() => {
          let batch = '';
          for (let index = 0; index < 500; index += 1) batch += SSE_FRAME;
          try {
            controller.enqueue(encoder.encode(batch));
          } catch {
            clearInterval(timer);
          }
        }, 0);
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
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
