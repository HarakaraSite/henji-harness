const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
await reader.read();
console.error('x'.repeat(4096));
console.log(
  JSON.stringify({
    v: 1,
    kind: 'response',
    id: 'response-1',
    replyTo: 'request-1',
    ok: true,
    payload: {},
  }),
);
