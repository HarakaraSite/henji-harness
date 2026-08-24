const encoder = new TextEncoder();
const decoder = new TextDecoder();
const write = async (value: unknown) => {
  await Deno.stdout.write(encoder.encode(JSON.stringify(value) + '\n'));
};
const buffer = new Uint8Array(65536);
let pending = '';
const readLine = async () => {
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      return line;
    }
    const count = await Deno.stdin.read(buffer);
    if (count === null) return pending;
    pending += decoder.decode(buffer.slice(0, count), { stream: true });
  }
};
const input = JSON.parse((await readLine()).trim());
const hostRequest = {
  v: 1,
  id: 'model-' + crypto.randomUUID(),
  kind: 'request',
  parentId: input.id,
  method: 'host.model.generate',
  payload: {
    messages: [{
      role: 'system',
      content: 'Return a concise JSON plan with title, summary, steps, and optional risks.',
    }, { role: 'user', content: JSON.stringify(input.payload) }],
  },
};
await write(hostRequest);
const reply = JSON.parse((await readLine()).trim());
if (!reply.ok) {
  await write({
    v: 1,
    id: 'result-' + crypto.randomUUID(),
    kind: 'response',
    replyTo: input.id,
    ok: false,
    error: reply.error,
  });
} else {await write({
    v: 1,
    id: 'result-' + crypto.randomUUID(),
    kind: 'response',
    replyTo: input.id,
    ok: true,
    payload: {
      type: 'plan',
      planText: reply.payload.text,
      profile: reply.payload.profile,
      revision: 'r1',
    },
  });}
