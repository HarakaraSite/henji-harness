import { fromOpenRouterResponse, toOpenRouterRequest } from './provider_codec.ts';
import { parseModelRequest } from '../../src/domain/model.ts';

const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buffered = '';
const read = async () => {
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      return JSON.parse(line);
    }
    const value = await reader.read();
    if (value.done) throw new Error('missing protocol message');
    buffered += value.value;
  }
};
const initial = await read();
const model = parseModelRequest(initial.payload);
if ('code' in model) {
  console.log(
    JSON.stringify({
      v: 1,
      kind: 'response',
      id: 'adapter-final',
      replyTo: initial.id,
      ok: false,
      error: model,
    }),
  );
  Deno.exit(0);
}
console.log(
  JSON.stringify({
    v: 1,
    kind: 'request',
    id: 'broker-1',
    parentId: initial.id,
    method: 'host.broker.call',
    payload: {
      endpointId: 'openrouter-api',
      operationId: 'chat-completions',
      body: toOpenRouterRequest(model),
    },
  }),
);
const broker = await read();
if (broker.replyTo !== 'broker-1' || broker.ok !== true) {
  console.log(
    JSON.stringify({
      v: 1,
      kind: 'response',
      id: 'adapter-final',
      replyTo: initial.id,
      ok: false,
      error: broker.error ?? { code: 'broker_failure', message: 'broker host call failed' },
    }),
  );
  Deno.exit(0);
}
const response = fromOpenRouterResponse(broker.payload);
if ('code' in response) {
  console.log(
    JSON.stringify({
      v: 1,
      kind: 'response',
      id: 'adapter-final',
      replyTo: initial.id,
      ok: false,
      error: response,
    }),
  );
  Deno.exit(0);
}
console.log(
  JSON.stringify({
    v: 1,
    kind: 'response',
    id: 'adapter-final',
    replyTo: initial.id,
    ok: true,
    payload: response,
  }),
);
