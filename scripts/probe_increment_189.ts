import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { HenjiApiClient } from '../v0/api/client.ts';

const functionCall = (id: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `function-${id}`,
  status: 'completed',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const response = (output: unknown[], text = '') => {
  const events: unknown[] = text ? [{ type: 'response.output_text.delta', delta: text }] : [];
  events.push({ type: 'response.completed', response: { id: crypto.randomUUID(), output } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
};
const finalResponse = (text: string) =>
  response([{
    type: 'message',
    id: 'final',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }], text);

/** A separate localhost probe of the installed binary, not a live model or compaction-quality test. */
export const probeHooksPackage = async (packageFolder: string, evidenceDirectory: string) => {
  const root = await Deno.makeTempDir({ dir: evidenceDirectory, prefix: 'hooks-package-' });
  const workspace = join(root, 'workspace');
  const config = join(root, 'config', 'henji-harness');
  const binDirectory = join(root, 'bin');
  const binary = join(binDirectory, 'henji');
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    PATH: binDirectory,
  };
  await Deno.mkdir(workspace);
  const command = async (executable: string, args: string[], input?: string) => {
    const child = new Deno.Command(executable, {
      args,
      env,
      cwd: workspace,
      stdin: input === undefined ? 'null' : 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const output = await child.output();
    if (!output.success) {
      throw new Error(
        new TextDecoder().decode(output.stderr) || new TextDecoder().decode(output.stdout),
      );
    }
    return new TextDecoder().decode(output.stdout);
  };
  // Install scripts need ordinary host utilities; the runtime itself runs without Deno on PATH.
  const install = await new Deno.Command('/bin/bash', {
    args: [join(packageFolder, 'install.sh'), '--bin-dir', binDirectory, '--config-root', config],
    env: { ...env, PATH: '/usr/local/bin:/usr/bin:/bin' },
    cwd: workspace,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!install.success) throw new Error(new TextDecoder().decode(install.stderr));
  const catalog = JSON.parse(await Deno.readTextFile(join(config, 'hooks.json')));
  strictEqual(catalog.default[0], 'runtime-start-time');
  ok(
    (await Deno.readTextFile(join(config, catalog.hooks['runtime-start-time']))).includes(
      'runtime_start',
    ),
  );
  const probeFolder = join(config, 'hooks', 'probe');
  await Deno.mkdir(probeFolder);
  await Deno.writeTextFile(join(probeFolder, 'label.ts'), "export const label = 'VERSION_ONE';\n");
  await Deno.writeTextFile(
    join(probeFolder, 'index.ts'),
    `
import { HOOK_API_CONTRACT, type HookFactory } from '@henji/hooks';
import { label } from './label.ts';
if (HOOK_API_CONTRACT !== 'henji-hooks/v2') throw new Error('wrong hook contract');
const factory: HookFactory = ({ workspace, requestProvider }) => {
  if (!requestProvider) throw new Error('requestProvider seam missing');
  let probeSettlementRequests = false;
  const auxiliary = async (path: string) => {
    await requestProvider({
      authProfile: 'increment-189-local-key',
      endpoint: (await Deno.readTextFile(workspace.root + '/aux-endpoint.txt')) + path,
      method: 'POST', body: new TextEncoder().encode('PRIVATE_AUXILIARY_PROBE_BODY'),
      evidenceMetadata: { provider: 'increment-189-local-aux', api: 'hook-http',
        modelId: 'aux-local', protocol: 'json', responseMode: 'json' },
    });
  };
  const write = async (phase: string, input: any) => {
    await Deno.writeTextFile(workspace.root + '/hook-events.ndjson', JSON.stringify({
      phase, label, runtime: input.runtime, task: input.task, outcome: input.outcome?.stopReason,
      settlement: input.settlement, checkpoint: input.context.checkpoint,
      turns: input.context.transcript.turns.map((turn: any) => ({turn: turn.turn, messages: turn.messages})),
      projectedTurns: input.context.projectedContext.retainedTurns.map((turn: any) => turn.turn),
      arguments: input.arguments, result: input.result,
    }) + '\\n', { append: true });
  };
  return {
    runtime_start: async (input) => {
      await write('runtime_start', input);
      return { context: ['HOOK_START ' + label + ' ' + input.runtime.role] };
    },
    runtime_stop: async (input) => {
      await write('runtime_stop', input);
      if (probeSettlementRequests) await auxiliary('/runtime-stop');
    },
    before_turn: async (input) => {
      await write('before_turn', input);
      return { context: ['HOOK_TURN ' + label + ' ' + input.task] };
    },
    before_tool: async (input) => {
      await write('before_tool', input);
      if (input.toolName === 'read') return { arguments: { path: 'actual.txt' } };
    },
    after_tool: async (input) => {
      await write('after_tool', input);
      if (input.toolName === 'read') return { text: 'HOOK_TEXT ' + input.result.text };
    },
    after_turn: async (input) => {
      await write('after_turn', input);
      probeSettlementRequests = input.outcome.task === 'TURN_THREE';
      if (probeSettlementRequests) await auxiliary('/after-turn');
      if (input.runtime.role === 'root' && input.runtime.turnNumber === 2) {
        return { checkpoint: { summary: 'HOOK_SUMMARY_TURN_ONE', coveredThroughTurn: 1 } };
      }
    },
  };
};
export default factory;
`,
  );
  catalog.default.push('probe');
  catalog.hooks.probe = 'hooks/probe/index.ts';
  await Deno.writeTextFile(join(config, 'hooks.json'), JSON.stringify(catalog));
  await Deno.mkdir(join(config, 'agents'), { recursive: true });
  await Deno.writeTextFile(
    join(config, 'agents', 'named-probe.json'),
    JSON.stringify({
      name: 'named-probe',
      instruction: 'Complete the child task.',
      tools: [],
      agents: [],
    }),
  );
  await Deno.writeTextFile(
    join(config, 'agents.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: { 'named-probe': 'agents/named-probe.json' },
    }),
  );
  await Deno.writeTextFile(join(workspace, 'actual.txt'), 'EFFECTIVE_READ_CONTENT');
  await Deno.writeTextFile(join(workspace, 'original.txt'), 'ORIGINAL_READ_CONTENT');
  const requests: Array<Record<string, unknown>> = [];
  const auxiliaryRequests: string[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/after-turn' || path === '/runtime-stop') {
      auxiliaryRequests.push(path);
      await request.arrayBuffer();
      return new Response('auxiliary accepted', { status: 202 });
    }
    const body = await request.json();
    requests.push(body);
    const input = body.input as Array<Record<string, unknown>>;
    const user = input.findLast((item) => item.role === 'user');
    const task = JSON.stringify(user?.content);
    const outputFor = (id: string): string | undefined =>
      input.find((item) => item.type === 'function_call_output' && item.call_id === id)?.output as
        | string
        | undefined;
    if (task.includes('TURN_ONE')) {
      if (!outputFor('read-probe')) {
        return response([functionCall('read-probe', 'read', { path: 'original.txt' })]);
      }
      ok(outputFor('read-probe')?.includes('HOOK_TEXT'));
      ok(outputFor('read-probe')?.includes('EFFECTIVE_READ_CONTENT'));
      return finalResponse('FINAL_TURN_ONE');
    }
    if (task.includes('PARENT_CHILDREN')) {
      if (!outputFor('spawn-generic')) {
        return response([functionCall('spawn-generic', 'spawn_subagent', {
          agent: 'generic',
          task: 'CHILD_GENERIC',
        })]);
      }
      const generic = JSON.parse(outputFor('spawn-generic')!).runId;
      if (!outputFor('collect-generic')) {
        return response([functionCall('collect-generic', 'collect_subagent', { runId: generic })]);
      }
      ok(outputFor('collect-generic')?.includes('FINAL_CHILD_GENERIC'));
      if (!outputFor('spawn-named')) {
        return response([functionCall('spawn-named', 'spawn_subagent', {
          agent: 'named-probe',
          task: 'CHILD_NAMED',
        })]);
      }
      const named = JSON.parse(outputFor('spawn-named')!).runId;
      if (!outputFor('collect-named')) {
        return response([functionCall('collect-named', 'collect_subagent', { runId: named })]);
      }
      ok(outputFor('collect-named')?.includes('FINAL_CHILD_NAMED'));
      return finalResponse('FINAL_PARENT_CHILDREN');
    }
    if (task.includes('CHILD_GENERIC')) return finalResponse('FINAL_CHILD_GENERIC');
    if (task.includes('CHILD_NAMED')) return finalResponse('FINAL_CHILD_NAMED');
    if (task.includes('TURN_TWO')) return finalResponse('FINAL_TURN_TWO');
    if (task.includes('TURN_THREE')) return finalResponse('FINAL_TURN_THREE');
    return finalResponse('FINAL_RUN_PROBE');
  });
  let core: Deno.ChildProcess | undefined;
  let client: HenjiApiClient | undefined;
  try {
    await Deno.writeTextFile(
      join(workspace, 'aux-endpoint.txt'),
      `http://127.0.0.1:${server.addr.port}`,
    );
    await Deno.mkdir(join(config, 'providers'), { recursive: true });
    await Deno.writeTextFile(
      join(config, 'providers', 'local.json'),
      JSON.stringify({
        schemaVersion: 1,
        providerId: 'increment-189-local',
        protocol: 'openai-responses',
        endpoint: `http://127.0.0.1:${server.addr.port}/v1`,
        authProfile: 'increment-189-local-key',
        modelCatalog: {
          kind: 'fixed',
          entries: [{ modelId: 'local', defaultEffort: 'auto', efforts: ['auto'] }],
        },
        defaults: { modelId: 'local', effort: 'auto' },
        modelListSource: 'catalog',
      }),
    );
    await Deno.writeTextFile(join(config, 'increment-189-local-key'), 'synthetic-hook-probe-key', {
      mode: 0o600,
    });
    await Deno.writeTextFile(
      join(config, 'default-selection.json'),
      JSON.stringify({
        provider: 'increment-189-local',
        api: 'openai-responses',
        authProfile: 'increment-189-local-key',
        modelId: 'local',
        effort: 'auto',
      }),
    );
    core = new Deno.Command(binary, {
      args: ['serve', '--json', '--new', '--root-provider', 'increment-189-local'],
      env,
      cwd: workspace,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const stderr = new Response(core.stderr).text();
    const reader = core.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let readyText = '';
    try {
      while (!readyText.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Core exited before ready: ${await stderr}`);
        readyText += chunk.value;
      }
    } finally {
      reader.releaseLock();
    }
    client = new HenjiApiClient(JSON.parse(readyText.split('\n')[0]).url);
    const sessionId = (await client.coreRead()).activeSessionId!;
    const submit = async (session: string, text: string) => {
      const receipt = await client!.taskSubmit(session, { commandId: crypto.randomUUID(), text });
      if (receipt.kind !== 'accepted') throw new Error(JSON.stringify(receipt));
      const deadline = Date.now() + 30_000;
      for (;;) {
        const execution = (await client!.executionRead(receipt.value.executionId)).execution;
        if (execution.processSettlement === 'complete') {
          strictEqual(execution.outcome, 'completed');
          return receipt.value.executionId;
        }
        if (Date.now() > deadline) throw new Error(`Execution did not settle: ${text}`);
        await new Promise((accept) => setTimeout(accept, 25));
      }
    };
    const executionIds = [await submit(sessionId, 'TURN_ONE')];
    await Deno.writeTextFile(
      join(probeFolder, 'label.ts'),
      "export const label = 'VERSION_TWO';\n",
    );
    executionIds.push(await submit(sessionId, 'TURN_TWO'));
    executionIds.push(await submit(sessionId, 'TURN_THREE'));
    const thirdRequest = requests.find((body) =>
      JSON.stringify(body.input).includes('TURN_THREE')
    )!;
    ok(JSON.stringify(thirdRequest.input).includes('HOOK_SUMMARY_TURN_ONE'));
    ok(!JSON.stringify(thirdRequest.input).includes('FINAL_TURN_ONE'));
    ok(!JSON.stringify(thirdRequest.input).includes('ORIGINAL_READ_CONTENT'));
    const instructions = String(thirdRequest.instructions);
    ok(instructions.includes('HOOK_START VERSION_ONE root'));
    ok(instructions.includes('HOOK_TURN VERSION_ONE TURN_THREE'));
    ok(!instructions.includes('HOOK_TURN VERSION_ONE TURN_TWO'));
    ok(/Worker started at .* UTC[+-]\d{2}:\d{2} \(.+\)/.test(instructions));
    const history = await command(binary, ['history', '--session', sessionId, '--view', 'detail']);
    for (
      const value of [
        'FINAL_TURN_ONE',
        'FINAL_TURN_TWO',
        'FINAL_TURN_THREE',
        'HOOK_TEXT',
        'original.txt',
        'actual.txt',
      ]
    ) ok(history.includes(value));
    ok(!history.includes('synthetic-hook-probe-key'));
    const occurrences = history.trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => record.kind === 'semantic_occurrence')
      .map((record) => record.value);
    const semanticEvents = occurrences.map((record) => record.payload.event?.payload)
      .filter(Boolean).map((payload) =>
        payload.kind === 'provider_observation'
          ? payload.observation.event
          : payload.kind === 'runtime_event'
          ? payload.event.event
          : payload
      ).filter(Boolean);
    const callEffect = semanticEvents.find((event) =>
      event.kind === 'tool_call' && event.call?.callId === 'read-probe'
    )?.hookEffect;
    strictEqual(callEffect?.originalArguments.path, 'original.txt');
    strictEqual(callEffect?.effectiveArguments.path, 'actual.txt');
    strictEqual(callEffect?.argumentHooks[0].name, 'probe');
    const resultEffect = semanticEvents.find((event) =>
      event.kind === 'tool_result' && event.result?.callId === 'read-probe'
    )?.hookEffect;
    ok(resultEffect?.originalText.includes('EFFECTIVE_READ_CONTENT'));
    strictEqual(resultEffect?.textHooks[0].name, 'probe');
    await Deno.writeTextFile(join(root, 'history.ndjson'), history);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    if (opened.kind !== 'accepted') throw new Error(JSON.stringify(opened));
    executionIds.push(await submit(opened.value.sessionId, 'PARENT_CHILDREN'));
    await client.coreShutdown({ commandId: crypto.randomUUID() });
    await core.status;
    core = undefined;
    client = undefined;
    const settledHistory = await command(binary, [
      'history',
      '--session',
      sessionId,
      '--view',
      'detail',
    ]);
    const observations = settledHistory.trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) =>
        record.kind === 'semantic_occurrence' && record.value.executionId === executionIds[2]
      )
      .map((record) => record.value.payload.event?.payload)
      .filter((payload) => payload?.kind === 'provider_observation')
      .map((payload) => payload.observation);
    const starts = observations.filter((observation) => observation.kind === 'request_start');
    deepStrictEqual(starts.map((observation) => observation.request.ordinal), [1, 2, 3]);
    deepStrictEqual(starts.map((observation) => observation.request.phase), [
      'user_turn',
      'hook',
      'hook',
    ]);
    ok(starts[1].request.endpoint.endsWith('/after-turn'));
    ok(starts[2].request.endpoint.endsWith('/runtime-stop'));
    deepStrictEqual(
      observations.filter((observation) => observation.kind === 'response_start')
        .map((observation) => [observation.requestOrdinal, observation.response.status]),
      [[1, 200], [2, 202], [3, 202]],
    );
    deepStrictEqual(auxiliaryRequests, ['/after-turn', '/runtime-stop']);
    ok(!settledHistory.includes('PRIVATE_AUXILIARY_PROBE_BODY'));
    ok(!settledHistory.includes('synthetic-hook-probe-key'));
    await Deno.writeTextFile(join(root, 'post-settlement-history.ndjson'), settledHistory);
    // Reopen the original durable Session in a fresh Core/Worker.
    core = new Deno.Command(binary, {
      args: ['serve', '--json', '--session', sessionId],
      env,
      cwd: workspace,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const reopenedStderr = new Response(core.stderr).text();
    const reopenedReader = core.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let reopenedReady = '';
    try {
      while (!reopenedReady.includes('\n')) {
        const chunk = await reopenedReader.read();
        if (chunk.done) throw new Error(`Reopened Core exited: ${await reopenedStderr}`);
        reopenedReady += chunk.value;
      }
    } finally {
      reopenedReader.releaseLock();
    }
    client = new HenjiApiClient(JSON.parse(reopenedReady.split('\n')[0]).url);
    executionIds.push(await submit(sessionId, 'TURN_THREE_REOPEN'));
    const reopenedRequest = requests.at(-1)!;
    ok(JSON.stringify(reopenedRequest.input).includes('HOOK_SUMMARY_TURN_ONE'));
    ok(!JSON.stringify(reopenedRequest.input).includes('FINAL_TURN_ONE'));
    ok(String(reopenedRequest.instructions).includes('HOOK_START VERSION_TWO root'));
    await client.coreShutdown({ commandId: crypto.randomUUID() });
    await core.status;
    core = undefined;
    client = undefined;
    const run = await command(binary, ['run', '--json'], 'RUN_PROBE\n');
    ok(run.includes('FINAL_RUN_PROBE'));
    const events = (await Deno.readTextFile(join(workspace, 'hook-events.ndjson'))).trim().split(
      '\n',
    ).map((line) => JSON.parse(line));
    for (
      const phase of [
        'runtime_start',
        'runtime_stop',
        'before_turn',
        'after_turn',
        'before_tool',
        'after_tool',
      ]
    ) ok(events.some((event) => event.phase === phase));
    const initial = events.filter((event) =>
      event.runtime.sessionId === sessionId && event.phase === 'before_turn' &&
      event.label === 'VERSION_ONE'
    );
    strictEqual(initial.length, 3);
    ok(initial.every((event) => event.label === 'VERSION_ONE'));
    const firstAfter = events.find((event) =>
      event.phase === 'after_turn' && event.runtime.sessionId === sessionId &&
      event.runtime.turnNumber === 1 && event.label === 'VERSION_ONE'
    );
    ok(JSON.stringify(firstAfter.turns).includes('FINAL_TURN_ONE'));
    ok(JSON.stringify(firstAfter.turns).includes('HOOK_TEXT'));
    ok(JSON.stringify(firstAfter.turns).includes('EFFECTIVE_READ_CONTENT'));
    strictEqual(firstAfter.settlement.adopted, true);
    for (const agentName of ['generic', 'named-probe']) {
      const child = events.filter((event) =>
        event.runtime.role === 'child' && event.runtime.agentName === agentName
      );
      for (const phase of ['runtime_start', 'after_turn', 'runtime_stop']) {
        ok(child.some((event) => event.phase === phase));
      }
      ok(child.every((event) => event.label === 'VERSION_TWO'));
      ok(child.every((event) => typeof event.runtime.parentExecutionId === 'string'));
      ok(
        child.find((event) => event.phase === 'after_turn').turns.every((turn: { turn: number }) =>
          turn.turn === 1
        ),
      );
      ok(
        !JSON.stringify(child.find((event) => event.phase === 'after_turn').turns)
          .includes('PARENT_CHILDREN'),
      );
    }
    const evidence = {
      root,
      packageFolder,
      sessionId,
      executionIds,
      localhostRequests: requests.length,
      localhostAuxiliaryRequests: auxiliaryRequests.length,
      liveProviderRequests: 0,
      checks: [
        'six hook phases',
        'compiled external/local import without Deno on PATH',
        'time zone and UTC offset',
        'turn scoped context',
        'tool arguments/text and history',
        'checkpoint projection, original history and durable reopen',
        'same Worker closure retained',
        'new Worker reload',
        'root/named/generic identities and child isolation',
        'normal stop',
        'main/after_turn/runtime_stop physical request order and semantic readback',
        'public API and run',
      ],
    };
    await Deno.writeTextFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
  } finally {
    if (client) await client.coreShutdown({ commandId: crypto.randomUUID() }).catch(() => {});
    else if (core) core.kill('SIGTERM');
    if (core) await core.status;
    await server.shutdown();
  }
};

if (import.meta.main) {
  const [packageFolder, evidenceDirectory] = Deno.args;
  if (!packageFolder || !evidenceDirectory) {
    throw new Error('usage: probe_increment_189.ts PACKAGE_FOLDER EVIDENCE_DIR');
  }
  await Deno.mkdir(resolve(evidenceDirectory), { recursive: true });
  console.log(
    JSON.stringify(await probeHooksPackage(resolve(packageFolder), resolve(evidenceDirectory))),
  );
}
