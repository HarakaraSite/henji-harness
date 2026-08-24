const decoder = new TextDecoder();
const input = await new Response(Deno.stdin.readable).text();
const request = JSON.parse(decoder.decode(new TextEncoder().encode(input.trim())));
console.log(JSON.stringify({
  v: 1,
  kind: 'response',
  id: 'response-1',
  replyTo: request.id,
  ok: true,
  payload: { status: 'planned', steps: [] },
}));
