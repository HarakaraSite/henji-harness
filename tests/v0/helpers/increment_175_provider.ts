export const originalAnswer = 'Original answer before the additional instruction';
export const steeredAnswer = 'Updated answer reflecting the additional instruction';

const encoder = new TextEncoder();
const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const completed = (text: string) => ({
  type: 'response.completed',
  response: {
    id: crypto.randomUUID(),
    output: [{
      type: 'message',
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
  },
});

/** Local Responses endpoint with explicit release, shared by the HTTP and production TUI checks. */
export const startFinalSteeringProvider = () => {
  const requests: Record<string, unknown>[] = [];
  let releaseFirst = () => {};
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => started = resolve);
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/probe/release' && request.method === 'POST') {
      releaseFirst();
      return Response.json({ released: true });
    }
    if (url.pathname === '/probe/status') {
      return Response.json({
        requestCount: requests.length,
        userInputs: requests.map((body) =>
          (Array.isArray(body.input) ? body.input : []).filter((item) => item.role === 'user')
            .map((item) => item.content)
        ),
      });
    }
    if (url.pathname !== '/v1/responses') return new Response('Not found', { status: 404 });
    requests.push(await request.json());
    const ordinal = requests.length;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const text = ordinal === 1 ? originalAnswer : steeredAnswer;
          controller.enqueue(frame({
            type: 'response.reasoning_summary_text.delta',
            delta: ordinal === 1
              ? 'Working on the original request.'
              : 'Applying the additional instruction.',
          }));
          controller.enqueue(frame({ type: 'response.output_text.delta', delta: text }));
          const finish = () => {
            controller.enqueue(frame(completed(text)));
            controller.close();
          };
          if (ordinal === 1) {
            releaseFirst = () => {
              releaseFirst = () => {};
              finish();
            };
            started();
          } else finish();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { server, origin, requests, firstStarted, releaseFirst: () => releaseFirst() };
};
