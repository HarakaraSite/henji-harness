import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import type { ChatGPTModelSelection } from '../../v0/agent/provider/model_selection.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

const sse = (output: unknown[], text = '') => {
  const events = text ? [{ type: 'response.output_text.delta', delta: text }] : [];
  const completed = {
    type: 'response.completed',
    response: { id: crypto.randomUUID(), status: 'completed', output },
  };
  return new Response(
    [...events, completed].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const call = (id: string, name: string, args: unknown) =>
  sse([{
    type: 'function_call',
    id: `function-${id}`,
    status: 'completed',
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  }]);
const final = (text: string) =>
  sse([{
    type: 'message',
    id: crypto.randomUUID(),
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }], text);
const toolResult = (input: Record<string, unknown>[], callId: string) => {
  const item = input.find((item) =>
    item.type === 'function_call_output' && item.call_id === callId
  );
  ok(item, `missing tool result ${callId}`);
  return JSON.parse(item.output as string);
};

Deno.test('Increment 182 real ChatGPT parent and model-omitted children share the execution account', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i182-inheritance-' });
  const configRoot = `${root}/config`;
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(`${configRoot}/chatgpt/accounts`, { recursive: true });
  await Deno.mkdir(workspaceRoot);
  await Deno.writeTextFile(`${workspaceRoot}/marker.txt`, 'child read actual workspace');
  const selectAccount = async (registrationId: string) =>
    await Deno.writeTextFile(
      `${configRoot}/chatgpt/selection.json`,
      JSON.stringify({ schemaVersion: 1, registrationId }),
    );
  for (const registrationId of ['account-a', 'account-b']) {
    await Deno.writeTextFile(
      `${configRoot}/chatgpt/accounts/${registrationId}.json`,
      JSON.stringify({
        schemaVersion: 1,
        registrationId,
        clientId: 'increment-182-local',
        subject: registrationId,
        accessToken: `local-${registrationId}`,
        refreshToken: 'unused-local-refresh',
        idToken: 'unused-local-id',
        expiresAt: Date.now() + 3600_000,
        scopes: ['chatgpt.tokens.use.direct'],
      }),
    );
  }
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'local-openrouter-key', {
    mode: 0o600,
  });
  await selectAccount('account-a');
  const parentSteps = new Map<number, number>();
  const childSteps = new Map<number, number>();
  const requests: { lane: string; turn: number; account: string; provider: string }[] = [];
  let scenario = 'inherit';
  let crossDirection: 'chatgpt-to-openrouter' | 'openrouter-to-chatgpt' | undefined;
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const body = await request.json();
    const input = body.input as Record<string, unknown>[];
    const users = input.filter((item) => item.role === 'user');
    const task = JSON.stringify(users.at(-1)?.content);
    const child = task.includes('B10-CHILD') || task.includes('B10-CROSS-CHILD');
    const cross = task.includes('B10-CROSS');
    const turn = task.includes('-2') ? 2 : 1;
    const chatgpt = new URL(request.url).pathname === '/v1/responses';
    const account = chatgpt
      ? cross ? 'account-b' : turn === 1 ? 'account-a' : 'account-b'
      : 'openrouter-key';
    if (cross) strictEqual(chatgpt, crossDirection === 'chatgpt-to-openrouter' ? !child : child);
    // Only synthetic local tokens are used. No real credential is loaded by this test.
    strictEqual(request.headers.get('authorization'), `Bearer local-${account}`);
    requests.push({
      lane: child ? 'child' : 'parent',
      turn,
      account,
      provider: chatgpt ? 'openai-chatgpt' : 'openrouter-responses',
    });
    if (child) {
      const step = (childSteps.get(turn) ?? 0) + 1;
      childSteps.set(turn, step);
      if (step === 1) return call(`read-${scenario}-${turn}`, 'read', { path: 'marker.txt' });
      const read = input.find((item) =>
        item.type === 'function_call_output' && item.call_id === `read-${scenario}-${turn}`
      );
      ok(String(read?.output).includes('child read actual workspace'));
      return final(`child ${turn} read actual workspace`);
    }
    const step = (parentSteps.get(turn) ?? 0) + 1;
    parentSteps.set(turn, step);
    if (step === 1) {
      // Selection changes after the parent request; its child and continuation must stay bound.
      if (turn === 1 && !cross) await selectAccount('account-b');
      return call(`spawn-${scenario}-${turn}`, 'spawn_subagent', {
        agent: 'generic',
        task: `B10-${cross ? 'CROSS-' : ''}CHILD-${turn}: read marker.txt`,
        ...(cross
          ? {
            model: crossDirection === 'chatgpt-to-openrouter'
              ? {
                provider: 'openrouter-responses',
                modelId: 'anthropic/claude-sonnet',
                effort: 'auto',
              }
              : { provider: 'openai-chatgpt', modelId: 'gpt-6.1-sol', effort: 'medium' },
          }
          : {}),
      });
    }
    if (step === 2) {
      const spawned = toolResult(input, `spawn-${scenario}-${turn}`);
      ok(spawned.ok && typeof spawned.runId === 'string', JSON.stringify(spawned));
      return call(`collect-${scenario}-${turn}`, 'collect_subagent', { runId: spawned.runId });
    }
    const collected = toolResult(input, `collect-${scenario}-${turn}`);
    ok(collected.ok, JSON.stringify(collected));
    strictEqual(
      collected.finalText,
      `child ${turn} read actual workspace`,
      JSON.stringify(collected),
    );
    return final(`parent ${turn} collected child`);
  });
  let session: Awaited<ReturnType<typeof createWorkerSession>>['session'] | undefined;
  try {
    const workerUrl = new URL('./fixtures/increment_182_chatgpt_worker.ts', import.meta.url);
    workerUrl.searchParams.set('endpoint', `http://127.0.0.1:${server.addr.port}`);
    session = (await createWorkerSession({
      workspaceRoot,
      stateRoot,
      dataRoot: `${root}/data`,
      configRoot,
      persistence: 'new',
      initialModelSelection: selectModelFor('openai-chatgpt', 'gpt-6.1-sol', 'medium'),
      physicalIoMode: 'production',
      capsuleFactory: () => new WorkerCapsule(workerUrl),
    })).session;
    for (const turn of [1, 2]) {
      const outcome = await session.submit(`B10-PARENT-${turn}: delegate reading marker.txt`);
      ok(outcome.ok, JSON.stringify(outcome));
      strictEqual(outcome.finalText, `parent ${turn} collected child`);
    }
    deepStrictEqual([...parentSteps], [[1, 3], [2, 3]]);
    deepStrictEqual([...childSteps], [[1, 2], [2, 2]]);
    strictEqual(requests.length, 10);

    // An explicit model binding remains authoritative even if the host now selects account-b.
    strictEqual(
      await session.selectModel({
        ...selectModelFor('openai-chatgpt', 'gpt-6.1-sol', 'medium'),
        registrationId: 'account-a',
      } as ChatGPTModelSelection),
      'selected',
    );
    scenario = 'explicit';
    parentSteps.clear();
    childSteps.clear();
    const explicit = await session.submit('B10-PARENT-1: use explicitly bound account-a');
    ok(explicit.ok, JSON.stringify(explicit));
    strictEqual(explicit.finalText, 'parent 1 collected child');

    // Explicit null does not silently use the host's selected account.
    strictEqual(
      await session.selectModel({
        ...selectModelFor('openai-chatgpt', 'gpt-6.1-sol', 'medium'),
        registrationId: null,
      } as ChatGPTModelSelection),
      'selected',
    );
    const count = requests.length;
    const missing = await session.submit('B10-EXPLICIT-NO-ACCOUNT');
    strictEqual(missing.ok, false);
    strictEqual(requests.length, count);
    strictEqual(missing.toolCallCount, 0);

    for (const direction of ['chatgpt-to-openrouter', 'openrouter-to-chatgpt'] as const) {
      crossDirection = direction;
      scenario = direction;
      parentSteps.clear();
      childSteps.clear();
      const parentModel = direction === 'chatgpt-to-openrouter'
        ? selectModelFor('openai-chatgpt', 'gpt-6.1-sol', 'medium')
        : selectModelFor('openrouter-responses', 'anthropic/claude-sonnet');
      strictEqual(await session.selectModel(parentModel), 'selected');
      const before = requests.length;
      const outcome = await session.submit('B10-CROSS-PARENT-1: delegate to another provider');
      ok(outcome.ok, JSON.stringify(outcome));
      strictEqual(outcome.finalText, 'parent 1 collected child');
      const actual = requests.slice(before);
      deepStrictEqual(
        [...new Set(actual.filter((fact) => fact.lane === 'parent').map((fact) => fact.provider))],
        [parentModel.provider],
      );
      deepStrictEqual(
        [...new Set(actual.filter((fact) => fact.lane === 'child').map((fact) => fact.provider))],
        [direction === 'chatgpt-to-openrouter' ? 'openrouter-responses' : 'openai-chatgpt'],
      );
      strictEqual(actual.length, 5);
    }

    const beforeLookupFailure = requests.length;
    // A selection read failure after Data admission must settle both receipt and execution.
    strictEqual(
      await session.selectModel(selectModelFor('openai-chatgpt', 'gpt-6.1-sol', 'medium')),
      'selected',
    );
    await Deno.writeTextFile(`${configRoot}/chatgpt/selection.json`, '{}');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const admission = await Promise.race([
        session.admit('B10-INVALID-SAVED-SELECTION'),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('auth lookup left receipt pending')), 3_000);
        }),
      ]);
      const failed = await admission.completion;
      strictEqual(failed.ok, false);
      ok(failed.error?.includes('chatgpt_saved_state_invalid'));
      strictEqual(requests.length, beforeLookupFailure);
    } finally {
      clearTimeout(timeout);
      await selectAccount('account-b');
    }

    await session.close();
    session = undefined;
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
    try {
      await store.initialize();
      const artifacts = await store.executionArtifacts.list();
      const children = artifacts.filter((artifact) => artifact.agent === 'generic');
      strictEqual(children.length, 5);
      for (const artifact of children) {
        strictEqual(artifact.normalizedOutcome, 'completed');
        ok(artifact.outcome?.ok);
        strictEqual(artifact.outcome?.toolCallCount, 1);
      }
    } finally {
      store.close();
    }
  } finally {
    await session?.close();
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
