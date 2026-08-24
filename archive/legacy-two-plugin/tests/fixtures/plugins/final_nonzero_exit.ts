const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
const input = await reader.read();
if (input.done || input.value === undefined) throw new Error('missing request');
const request = JSON.parse(input.value.trim());
console.log(JSON.stringify({
  v: 1,
  kind: 'response',
  id: 'response-1',
  replyTo: request.id,
  ok: true,
  payload: { status: 'planned', steps: [] },
}));
Deno.exit(1);
