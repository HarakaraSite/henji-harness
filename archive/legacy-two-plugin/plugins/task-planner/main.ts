import { createPlanPrompt } from './prompt.ts';
import { parsePlannerOutput } from './plan_parser.ts';

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
const prompt = createPlanPrompt(initial.payload);
console.log(
  JSON.stringify({
    v: 1,
    kind: 'request',
    id: 'model-1',
    parentId: initial.id,
    method: 'host.model.generate',
    payload: { messages: [{ role: 'user', content: prompt }] },
  }),
);
const model = await read();
if (model.replyTo !== 'model-1' || model.ok !== true) {
  console.log(
    JSON.stringify({
      v: 1,
      kind: 'response',
      id: 'planner-final',
      replyTo: initial.id,
      ok: false,
      error: model.error ?? { code: 'model_failure', message: 'model host call failed' },
    }),
  );
  Deno.exit(0);
}
const plan = parsePlannerOutput(model.payload.text);
if ('code' in plan) {
  console.log(
    JSON.stringify({
      v: 1,
      kind: 'response',
      id: 'planner-final',
      replyTo: initial.id,
      ok: false,
      error: plan,
    }),
  );
  Deno.exit(0);
}
console.log(
  JSON.stringify({
    v: 1,
    kind: 'response',
    id: 'planner-final',
    replyTo: initial.id,
    ok: true,
    payload: plan,
  }),
);
