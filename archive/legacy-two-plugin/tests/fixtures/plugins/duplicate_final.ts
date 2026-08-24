const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
const first = await reader.read();
if (first.done || first.value === undefined) throw new Error('missing request');
const request = JSON.parse(first.value.trim());
const response = {
  v: 1,
  kind: 'response',
  id: 'final',
  replyTo: request.id,
  ok: true,
  payload: {},
};
console.log(JSON.stringify(response));
console.log(JSON.stringify(response));
