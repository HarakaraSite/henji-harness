import { main } from '../../../v0/agent/runtime_cli.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';
const MODES = [
  'argv-success',
  'argv-json-success',
  'stdin-success',
  'runtime-failure',
  'tty',
] as const;
type FixtureMode = (typeof MODES)[number];

const response = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const jsonToolResponse = (json: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'submit-1',
            type: 'function',
            function: { name: 'submit_json_result', arguments: JSON.stringify({ json }) },
          }],
        },
      }],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );

const mode = Deno.args[0] as string | undefined;
if (!mode || !MODES.includes(mode as FixtureMode)) {
  throw new Error('invalid runtime process fixture mode');
}

const fixtureMode = mode as FixtureMode;
const applicationArgs = Deno.args.slice(1);
const expectedTask = fixtureMode === 'argv-success'
  ? 'argv task'
  : fixtureMode === 'argv-json-success'
  ? 'json argv task'
  : fixtureMode === 'stdin-success'
  ? 'piped task'
  : fixtureMode === 'runtime-failure'
  ? 'valid'
  : undefined;

const fakeFetch: typeof fetch = (_input, init) => {
  if (expectedTask === undefined) throw new Error('unexpected provider request');
  if (typeof init?.body !== 'string') throw new Error('provider request body missing');
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    throw new Error('provider request body invalid');
  }
  if (
    typeof body !== 'object' || body === null ||
    !Array.isArray((body as { messages?: unknown }).messages) ||
    (body as { messages: unknown[] }).messages.length === 0 ||
    typeof (body as { messages: [{ content?: unknown }] }).messages[0]?.content !== 'string' ||
    (body as { messages: [{ content: string }] }).messages[0].content !== expectedTask
  ) {
    throw new Error('provider request task mismatch');
  }
  if (fixtureMode === 'runtime-failure') {
    return Promise.reject(new Error('sensitive-marker-provider-body'));
  }
  if (fixtureMode === 'argv-json-success') {
    return Promise.resolve(jsonToolResponse('{"ok":true,"items":[1,2]}'));
  }
  const finalText = fixtureMode === 'argv-success' ? 'offline argv answer' : 'offline stdin answer';
  return Promise.resolve(response(finalText));
};

const stdinIsTerminal = fixtureMode !== 'stdin-success';
const exit = await main(applicationArgs, {
  stdinIsTerminal: () => stdinIsTerminal,
  runtimeSeam: {
    credential: DUMMY_CREDENTIAL,
    fetcher: fakeFetch,
  },
});
Deno.exit(exit);
