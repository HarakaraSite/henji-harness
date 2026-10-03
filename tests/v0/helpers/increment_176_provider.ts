const encoder = new TextEncoder();
export const frame176 = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
export const completed176 = (output: unknown[]) => ({
  type: 'response.completed',
  response: { id: 'i176-response', status: 'completed', output },
});
export const answer176 = {
  type: 'message',
  id: 'i176-message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Completed normally.', annotations: [] }],
};
export const apiErrorStream176 = (credential: string): string =>
  [
    { type: 'response.created', response: { id: 'i176-response', output: [] } },
    { type: 'response.reasoning_summary_text.delta', delta: 'Checking the request.' },
    {
      error: {
        message: `Request rejected for ${credential}. Authorization: Bearer ${credential}`,
        code: 'invalid_request',
        type: 'invalid_request_error',
        param: 'input',
      },
    },
  ].map(frame176).join('');

/** Loopback-only provider for production Worker and TUI diagnostics readback. */
export const startFailureProvider176 = (credential: string) => {
  let requests = 0;
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    if (new URL(request.url).pathname === '/probe/status') return Response.json({ requests });
    const body = await request.json();
    requests += 1;
    const input = Array.isArray(body.input) ? body.input as Record<string, unknown>[] : [];
    const task = input.filter((item) => item.role === 'user').at(-1)?.content;
    const output = task === 'tool error' && !input.some((item) =>
        item.type === 'function_call_output'
      )
      ? [{
        type: 'function_call',
        id: 'i176-read',
        call_id: 'i176-read',
        status: 'completed',
        name: 'read',
        arguments: '{"path":"i176-missing-file.txt"}',
      }]
      : [answer176];
    const stream = task === 'provider error'
      ? apiErrorStream176(credential)
      : frame176(completed176(output));
    return new Response(encoder.encode(stream), {
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'i176-request',
      },
    });
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { server, origin, requestCount: () => requests };
};
