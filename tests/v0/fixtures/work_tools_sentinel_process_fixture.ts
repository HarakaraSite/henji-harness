import { FIXED_TASK, runSentinel } from '../../../v0/agent/work_tools_sentinel.ts';

const workspace = Deno.args[0];
const marker = 'dummy-work-tools-sentinel-secret';
if (
  workspace === undefined || Deno.env.get('HENJI_OPENROUTER_API_KEY') !== marker ||
  Deno.args.join(' ').includes(marker)
) {
  throw new Error('fixture boundary failed');
}

const calls = [
  { name: 'write', arguments: { path: 'work/item.txt', content: 'alpha\n' } },
  { name: 'read', arguments: { path: 'work/item.txt' } },
  {
    name: 'edit',
    arguments: { path: 'work/item.txt', edits: [{ oldText: 'alpha\n', newText: 'beta\n' }] },
  },
  {
    name: 'bash',
    arguments: {
      command:
        'test "$(cat work/item.txt)" = beta && printf \'verified:%s\' "$(wc -c < work/item.txt)"',
      timeoutMs: 5000,
    },
  },
  {
    name: 'submit_json_result',
    arguments: {
      json: '{"path":"work/item.txt","content":"beta\\n","bytes":5,"bash":"verified:5"}',
    },
  },
] as const;

const providerResponse = (ordinal: number): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `process-call-${ordinal + 1}`,
            type: 'function',
            function: {
              name: calls[ordinal].name,
              arguments: JSON.stringify(calls[ordinal].arguments),
            },
          }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const expectedResults = [
  '{"path":"work/item.txt","bytes":6}',
  'alpha\n',
  '{"path":"work/item.txt","edits":1,"bytes":5}',
  '{"stdout":"verified:5","stderr":"","exitCode":0,"signal":null,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false}',
  'json result submitted',
] as const;

let requests = 0;
const fakeFetch: typeof fetch = (_input, init) => {
  requests += 1;
  if (typeof init?.body !== 'string') throw new Error('process provider request body missing');
  const body = JSON.parse(init.body) as { messages?: unknown };
  if (!Array.isArray(body.messages) || body.messages[0] === undefined) {
    throw new Error('process provider request messages missing');
  }
  const first = body.messages[0];
  if (
    typeof first !== 'object' || first === null ||
    (first as { content?: unknown }).content !== FIXED_TASK
  ) throw new Error('process provider task mismatch');
  const priorResults = body.messages.flatMap((message) => {
    if (
      typeof message === 'object' && message !== null &&
      (message as { role?: unknown }).role === 'tool' &&
      typeof (message as { content?: unknown }).content === 'string'
    ) return [(message as { content: string }).content];
    return [];
  });
  const expectedPrior = expectedResults.slice(0, requests - 1);
  if (
    priorResults.length !== expectedPrior.length ||
    priorResults.some((result, index) => result !== expectedPrior[index])
  ) throw new Error('process provider causal results mismatch');
  return Promise.resolve(providerResponse(requests - 1));
};

if (Deno.args[1] === 'provider-failure') {
  console.log(JSON.stringify({
    schemaVersion: 1,
    taskId: 'v1.work-tools.fixed',
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    ok: false,
    outcome: 'aborted',
    code: 'provider_failure',
    modelRequests: 1,
    externalRequests: 1,
    steps: 1,
    toolCalls: 0,
    toolResults: 0,
    toolOrder: [],
    stopReason: 'contract_failure',
    terminalKind: null,
    transcriptValidated: false,
    workspaceValidated: false,
  }));
  Deno.exitCode = 1;
} else {
  const result = await runSentinel({
    workspaceRoot: workspace,
    credential: marker,
    fetcher: fakeFetch,
  });
  if (requests !== 5) throw new Error('process provider request count mismatch');
  console.log(JSON.stringify(result.report));
}
