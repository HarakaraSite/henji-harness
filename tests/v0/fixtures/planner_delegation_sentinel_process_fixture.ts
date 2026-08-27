import {
  EXPECTED_CHILD_FINAL,
  EXPECTED_PARENT_FINAL,
  FIXED_DELEGATED_TASK,
  FIXED_PARENT_TASK,
  runSentinel,
} from '../../../v0/agent/planner_delegation_sentinel.ts';

const workspace = Deno.args[0];
const marker = 'dummy-planner-process-secret';
if (
  workspace === undefined || Deno.env.get('HENJI_OPENROUTER_API_KEY') !== marker ||
  Deno.args.join(' ').includes(marker)
) throw new Error('fixture boundary failed');

const callPayload = (id: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: {
              name: 'delegate_to_planner',
              arguments: JSON.stringify({ task: FIXED_DELEGATED_TASK }),
            },
          }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const finalPayload = (text: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

let requests = 0;
const fakeFetch: typeof fetch = (_input, init) => {
  requests += 1;
  if (typeof init?.body !== 'string') throw new Error('fixture request body missing');
  const body = JSON.parse(init.body) as { messages?: unknown[] };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('fixture messages missing');
  }
  if (
    requests === 1 && body.messages[0] &&
    (body.messages[0] as { content?: unknown }).content !== FIXED_PARENT_TASK
  ) {
    throw new Error('fixture parent task mismatch');
  }
  if (
    requests === 2 && body.messages[1] &&
    (body.messages[1] as { content?: unknown }).content !== FIXED_DELEGATED_TASK
  ) {
    throw new Error('fixture child task mismatch');
  }
  if (requests === 1) return Promise.resolve(callPayload('process-parent-call'));
  if (requests === 2) return Promise.resolve(finalPayload(EXPECTED_CHILD_FINAL));
  if (requests === 3) return Promise.resolve(finalPayload(EXPECTED_PARENT_FINAL));
  throw new Error('fixture unexpected request');
};

if (Deno.args[1] === 'provider-failure') {
  // This is a synthetic child report used only to exercise launcher sanitization.
  console.log(JSON.stringify({
    schemaVersion: 1,
    taskId: 'v1.planner-delegation.fixed',
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    ok: false,
    outcome: 'aborted',
    code: 'provider_failure',
    parentModelRequests: 1,
    childModelRequests: 0,
    aggregateModelRequests: 1,
    externalRequests: 1,
    delegationCalls: 1,
    delegationResults: 0,
    requestOrder: ['parent'],
    parentToolOrder: ['delegate_to_planner'],
    parentStopReason: 'contract_failure',
    plannerFinalValidated: false,
    childCompletedBeforeParentFinal: false,
    plannerNonMutating: true,
    plannerNonRecursive: true,
    transcriptValidated: false,
    workspaceValidated: true,
  }));
  Deno.exitCode = 1;
} else {
  const result = await runSentinel({
    workspaceRoot: workspace,
    credential: marker,
    fetcher: fakeFetch,
  });
  if (requests !== 3) throw new Error('fixture request count mismatch');
  console.log(JSON.stringify(result.report));
}
