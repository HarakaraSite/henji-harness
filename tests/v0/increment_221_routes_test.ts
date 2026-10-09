import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { type CoreService, createCoreService } from '../../v0/agent/host/core_service.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import type { ContextModelRequestRecord } from '../../v0/agent/history/context_attribution.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';
import type { ProviderDeclarationV1 } from '../../v0/agent/provider/provider_declaration.ts';
import { MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS } from '../../v0/resource_limits.ts';

const providerId = 'increment-221-route';
const credential = 'increment-221-local-only';

const models = {
  'parent-wide': {
    context: 1_000_000,
    input: 900_000,
    output: 300_000,
  },
  'parent-narrow': {
    context: 500_000,
    input: 450_000,
    output: 200_000,
  },
  'child-wide': {
    context: 800_000,
    input: 750_000,
    output: 400_000,
  },
} as const;

const selection = (modelId: keyof typeof models): ModelSelection => ({
  provider: providerId,
  api: 'openai-chat-completions',
  authProfile: 'openrouter-api-key',
  modelId,
  effort: 'auto',
});

const declaration = (endpoint: string): ProviderDeclarationV1 => ({
  schemaVersion: 1,
  providerId,
  protocol: 'openai-chat-completions',
  endpoint,
  authProfile: 'openrouter-api-key',
  modelCatalog: {
    kind: 'fixed',
    entries: Object.keys(models).map((modelId) => ({
      modelId,
      defaultEffort: 'auto' as const,
      efforts: ['auto'] as const,
    })),
  },
  defaults: { modelId: 'parent-wide', effort: 'auto' },
  modelListSource: 'catalog',
});

const completion = (text: string): Response =>
  new Response(
    `data: ${
      JSON.stringify({
        id: 'increment-221-local',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
      })
    }\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

const toolCall = (id: string, name: string, args: unknown): Response =>
  new Response(
    `data: ${
      JSON.stringify({
        id: 'increment-221-local',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })
    }\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

const waitForSettlement = async (
  core: CoreService,
  executionId: string,
): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await core.executionRead(executionId);
    if (result.execution.processSettlement === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`execution did not settle: ${executionId}`);
};

const submit = async (core: CoreService, sessionId: string, text: string) => {
  const receipt = await core.taskSubmit(sessionId, {
    commandId: crypto.randomUUID(),
    text,
  });
  ok(receipt.kind === 'accepted', JSON.stringify(receipt));
  await waitForSettlement(core, receipt.value.executionId);
  return receipt.value.executionId;
};

const assertSavedBudget = (
  request: ContextModelRequestRecord,
  body: Record<string, unknown>,
  expected: {
    readonly modelId: keyof typeof models;
    readonly contextTokens: number;
    readonly inputTokens: number;
  },
): void => {
  const limits = models[expected.modelId];
  const budget = request.budget;
  ok(budget, `missing saved budget for ${expected.modelId}`);
  strictEqual(request.modelSelection?.provider, providerId);
  strictEqual(request.modelSelection?.api, 'openai-chat-completions');
  strictEqual(request.modelSelection?.modelId, expected.modelId);
  strictEqual(request.modelSelection?.authProfile, 'openrouter-api-key');
  strictEqual(request.modelSelection?.effort, 'auto');
  strictEqual(body.model, expected.modelId);
  strictEqual(body.max_completion_tokens, MAX_PRODUCTION_OPENROUTER_COMPLETION_TOKENS);
  ok(Number(limits.output) !== Number(body.max_completion_tokens));
  strictEqual(budget.contextTokens, expected.contextTokens);
  strictEqual(budget.inputCapacityTokens, expected.inputTokens);
  strictEqual(budget.inputRatio, 0.8);
  strictEqual(budget.outputReserve, body.max_completion_tokens);
  deepStrictEqual(
    budget.capacitySources as Record<string, unknown>,
    {
      contextTokens: 'models.dev',
      inputTokens: 'models.dev',
      inputRatio: 'default',
      outputReserve: 'adapter-request',
    },
  );
  strictEqual(budget.modelsDevProviderId, providerId);
  strictEqual(
    budget.inputLimit,
    Math.min(
      Math.floor(limits.context * 0.8),
      limits.input,
      limits.context - Number(body.max_completion_tokens),
    ),
  );
  ok(
    typeof budget.inputTokens === 'number' && budget.inputTokens > 0 &&
      budget.inputTokens <= budget.inputLimit,
  );
};

Deno.test('Increment 221 Core idle model changes resolve each root request from its selected route', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-221-root-route-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  const configRoot = `${root}/config`;
  const dataRoot = `${root}/data`;
  const credentialRoot = `${root}/credentials`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.mkdir(credentialRoot, { recursive: true, mode: 0o700 });

  const requests: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.json() as Record<string, unknown>;
      requests.push({ body, authorization: request.headers.get('authorization') });
      return completion('route verified');
    },
  );
  const endpoint = `http://127.0.0.1:${provider.addr.port}/v1`;
  await Deno.writeTextFile(`${credentialRoot}/openrouter-api-key`, credential, { mode: 0o600 });
  const providerDeclaration = declaration(endpoint);
  const metadata = {
    [providerId]: {
      api: endpoint,
      models: Object.fromEntries(
        Object.entries(models).map(([modelId, limit]) => [
          modelId,
          { limit },
        ]),
      ),
    },
  };
  let metadataRequests = 0;
  let metadataAuthSeen = false;
  const core = await createCoreService({
    workspaceRoot,
    stateRoot,
    configRoot,
    dataRoot,
    credentialRoot,
    physicalIoMode: 'production',
    agent: 'generic',
    agentChoice: { name: 'generic' },
    initialSession: { kind: 'new' },
    initialModelSelection: selection('parent-wide'),
    providerDeclarations: [providerDeclaration],
    modelsMetadataUrl: 'https://metadata.example/api.json',
    catalogFetcher: (input, init) => {
      metadataRequests += 1;
      strictEqual(String(input), 'https://metadata.example/api.json');
      metadataAuthSeen ||= new Headers(init?.headers).has('authorization');
      return Promise.resolve(Response.json(metadata));
    },
    rootMaxSteps: 4,
  });
  let reader: SqliteHistoryStore | undefined;
  try {
    const sessionId = core.coreRead().activeSessionId;
    ok(sessionId);
    const firstExecution = await submit(core, sessionId, 'Root wide route before idle change');
    strictEqual((await core.executionRead(firstExecution)).execution.outcome, 'completed');
    strictEqual(requests.length, 1);
    reader = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
    await reader.initialize();
    const firstRequest = reader.listExecutionContext(firstExecution).requests[0];
    ok(firstRequest);
    strictEqual(requests[0].authorization, `Bearer ${credential}`);
    assertSavedBudget(firstRequest, requests[0].body, {
      modelId: 'parent-wide',
      contextTokens: models['parent-wide'].context,
      inputTokens: models['parent-wide'].input,
    });

    const changed = await core.selectionChange(sessionId, {
      commandId: crypto.randomUUID(),
      selection: { provider: providerId, modelId: 'parent-narrow', effort: 'auto' },
    });
    ok(changed.kind === 'accepted', JSON.stringify(changed));
    strictEqual(changed.value.result, 'selected');

    const secondExecution = await submit(core, sessionId, 'Root narrow route after idle change');
    const secondRequest = reader.listExecutionContext(secondExecution).requests[0];
    ok(secondRequest);
    strictEqual(requests[1].authorization, `Bearer ${credential}`);
    assertSavedBudget(secondRequest, requests[1].body, {
      modelId: 'parent-narrow',
      contextTokens: models['parent-narrow'].context,
      inputTokens: models['parent-narrow'].input,
    });
    const firstGeneration = reader.readExecution(firstExecution).workerGeneration;
    const secondGeneration = reader.readExecution(secondExecution).workerGeneration;
    ok(firstGeneration && secondGeneration, 'missing persisted Worker generation');
    strictEqual(secondGeneration, firstGeneration);
    strictEqual(metadataRequests, 1);
    strictEqual(metadataAuthSeen, false);
  } finally {
    reader?.close();
    await core.close();
    await provider.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 221 different-model child uses its own Core-resolved capacity in saved request facts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-221-child-route-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  const configRoot = `${root}/config`;
  const dataRoot = `${root}/data`;
  const credentialRoot = `${root}/credentials`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.mkdir(credentialRoot, { recursive: true, mode: 0o700 });

  let childRunId: string | undefined;
  let parentChildStep = 0;
  const requests: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.json() as Record<string, unknown>;
      requests.push({ body, authorization: request.headers.get('authorization') });
      const modelId = String(body.model);
      if (modelId === 'child-wide') return completion('child route verified');

      const messages = Array.isArray(body.messages)
        ? body.messages as Record<string, unknown>[]
        : [];
      const task = [...messages].reverse().find((message) => message.role === 'user')?.content;
      if (String(task).includes('delegate-to-child-route')) {
        parentChildStep += 1;
        if (parentChildStep === 1) {
          return toolCall('spawn-route-child', 'spawn_subagent', {
            agent: 'generic',
            task: 'child route capacity task',
            model: {
              provider: providerId,
              modelId: 'child-wide',
              effort: 'auto',
            },
          });
        }
        if (parentChildStep === 2) {
          const spawnResult = [...messages].reverse().find((message) => {
            if (message.role !== 'tool' || typeof message.content !== 'string') return false;
            try {
              const parsed = JSON.parse(message.content) as Record<string, unknown>;
              return parsed.ok === true && typeof parsed.runId === 'string';
            } catch {
              return false;
            }
          });
          ok(spawnResult && typeof spawnResult.content === 'string');
          const parsed = JSON.parse(spawnResult.content) as { runId: string };
          childRunId = parsed.runId;
          return toolCall('collect-route-child', 'collect_subagent', {
            runId: childRunId,
          });
        }
        return completion('parent collected child route');
      }
      return completion('parent route verified');
    },
  );
  const endpoint = `http://127.0.0.1:${provider.addr.port}/v1`;
  await Deno.writeTextFile(`${credentialRoot}/openrouter-api-key`, credential, { mode: 0o600 });
  const providerDeclaration = declaration(endpoint);
  const metadata = {
    [providerId]: {
      api: endpoint,
      models: Object.fromEntries(
        Object.entries(models).map(([modelId, limit]) => [
          modelId,
          { limit },
        ]),
      ),
    },
  };
  let metadataRequests = 0;
  const core = await createCoreService({
    workspaceRoot,
    stateRoot,
    configRoot,
    dataRoot,
    credentialRoot,
    physicalIoMode: 'production',
    agent: 'generic',
    agentChoice: { name: 'generic' },
    initialSession: { kind: 'new' },
    initialModelSelection: selection('parent-narrow'),
    providerDeclarations: [providerDeclaration],
    modelsMetadataUrl: 'https://metadata.example/api.json',
    catalogFetcher: (_input, init) => {
      metadataRequests += 1;
      strictEqual(new Headers(init?.headers).has('authorization'), false);
      return Promise.resolve(Response.json(metadata));
    },
    rootMaxSteps: 4,
  });
  let reader: SqliteHistoryStore | undefined;
  try {
    const sessionId = core.coreRead().activeSessionId;
    ok(sessionId);
    const executionId = await submit(core, sessionId, 'delegate-to-child-route');
    strictEqual((await core.executionRead(executionId)).execution.outcome, 'completed');
    ok(childRunId, 'parent did not start the child run');
    reader = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
    await reader.initialize();
    const parentRequests = reader.listExecutionContext(executionId).requests;
    const parentChildRequests = parentRequests.filter((request) =>
      request.modelSelection?.modelId === 'parent-narrow'
    );
    strictEqual(parentChildRequests.length, 3);
    const parentBodies = requests.filter((record) => record.body.model === 'parent-narrow');
    strictEqual(parentBodies.length, 3);
    parentChildRequests.forEach((request, index) => {
      assertSavedBudget(request, parentBodies[index].body, {
        modelId: 'parent-narrow',
        contextTokens: models['parent-narrow'].context,
        inputTokens: models['parent-narrow'].input,
      });
    });

    const childRequests = reader.listExecutionContext(childRunId).requests;
    strictEqual(childRequests.length, 1);
    const childRequest = childRequests[0];
    const childBody = requests.find((record) => record.body.model === 'child-wide')?.body;
    ok(childBody);
    assertSavedBudget(childRequest, childBody, {
      modelId: 'child-wide',
      contextTokens: models['child-wide'].context,
      inputTokens: models['child-wide'].input,
    });
    strictEqual(requests.filter((record) => record.body.model === 'parent-narrow').length, 3);
    strictEqual(requests.filter((record) => record.body.model === 'child-wide').length, 1);
    strictEqual(metadataRequests, 1);
    ok(requests.every((record) => record.authorization === `Bearer ${credential}`));
  } finally {
    reader?.close();
    await core.close();
    await provider.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
