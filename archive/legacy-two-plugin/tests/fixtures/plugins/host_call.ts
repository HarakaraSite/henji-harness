const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
const firstLine = await reader.read();
if (firstLine.done || firstLine.value === undefined) throw new Error('missing root request');
const first = JSON.parse(firstLine.value.trim());
console.log(
  JSON.stringify({
    v: 1,
    kind: 'request',
    id: 'host-1',
    parentId: first.id,
    method: 'host.model.generate',
    payload: {},
  }),
);
const replyLine = await reader.read();
if (replyLine.done || replyLine.value === undefined) throw new Error('missing host response');
const reply = JSON.parse(replyLine.value.trim());
console.log(
  JSON.stringify({
    v: 1,
    kind: 'response',
    id: 'final-1',
    replyTo: first.id,
    ok: true,
    payload: reply.payload,
  }),
);
