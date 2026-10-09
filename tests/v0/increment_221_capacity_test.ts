import { deepStrictEqual, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { LiveModelCatalog } from '../../v0/agent/provider/live_model_catalog.ts';
import { writeDefaultSelection } from '../../v0/agent/provider/default_selection.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';
import type { ProviderDeclarationV1 } from '../../v0/agent/provider/provider_declaration.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import { WorkerHostStartupError } from '../../v0/agent/worker/worker_host_session.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import {
  type ContextCapacityMetadata,
  resolveContextBudget,
} from '../../v0/agent/session/context_budget.ts';

const route = (
  providerId: string,
  endpoint: string,
  additions: Partial<ProviderDeclarationV1> = {},
): ProviderDeclarationV1 => ({
  schemaVersion: 1,
  providerId,
  protocol: 'openai-chat-completions',
  endpoint,
  authProfile: 'openrouter-api-key',
  modelCatalog: {
    kind: 'fixed',
    entries: [{ modelId: 'deepseek-v4.1-flash', defaultEffort: 'auto', efforts: ['auto'] }],
  },
  defaults: { modelId: 'deepseek-v4.1-flash', effort: 'auto' },
  ...additions,
});

const selection = (provider: ProviderDeclarationV1): ModelSelection => ({
  provider: provider.providerId,
  api: 'openai-chat-completions',
  authProfile: provider.authProfile,
  modelId: provider.defaults.modelId,
  effort: 'auto',
});

const startCoreWorker = async (
  physicalIoMode: 'production' | 'provider-free',
  metadata: unknown,
): Promise<{
  readonly startCommand?: Extract<WorkerHostCommand, { kind: 'start' }>;
  readonly metadataRequests: number;
  readonly catalogFacts: string;
}> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-221-capacity-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  const provider = route('opencode-go-chat', 'https://opencode.ai/zen/go/v1', {
    modelListSource: 'catalog',
  });
  let startCommand: Extract<WorkerHostCommand, { kind: 'start' }> | undefined;
  let metadataRequests = 0;
  let receive: ((message: WorkerToHostMessage) => void) | undefined;
  const capsule: WorkerHostCapsule = {
    send(command) {
      if (command.kind !== 'start') return;
      startCommand = command;
      queueMicrotask(() =>
        receive?.({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: 'test startup stop',
        })
      );
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
    terminate() {},
  };
  const core = await createCoreService({
    workspaceRoot,
    stateRoot: `${root}/state`,
    dataRoot: `${root}/data`,
    configRoot: `${root}/config`,
    credentialRoot: `${root}/credentials`,
    physicalIoMode,
    initialSession: { kind: 'new' },
    initialModelSelection: selection(provider),
    providerDeclarations: [provider],
    modelsMetadataUrl: 'https://metadata.example/api.json',
    catalogFetcher: (_input, init) => {
      metadataRequests += 1;
      strictEqual(new Headers(init?.headers).has('authorization'), false);
      return Promise.resolve(Response.json(metadata));
    },
    capsuleFactory: () => capsule,
  });
  try {
    await core.taskSubmit(core.coreRead().activeSessionId!, {
      commandId: crypto.randomUUID(),
      text: 'capacity startup probe',
    });
    const paths = await sessionPaths(`${root}/state`, workspaceRoot);
    const catalogFacts = await Deno.readTextFile(`${paths.root}/catalog-requests.jsonl`)
      .catch(() => '');
    return { startCommand, metadataRequests, catalogFacts };
  } finally {
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('Increment 221 derives L from known C/I/R and uses the selected adapter reserve', () => {
  const selected = selection(route('opencode-go-chat', 'https://opencode.ai/zen/go/v1'));
  const capacity: ContextCapacityMetadata = {
    contextTokens: 1_000_000,
    inputTokens: 600_000,
    source: 'models.dev',
    modelsDevProviderId: 'opencode-go',
  };
  const budget = resolveContextBudget({}, selected, 65_536, capacity);
  strictEqual(budget.inputLimit, 600_000);
  strictEqual(budget.outputReserve, 65_536);
  strictEqual(budget.inputRatio, 0.8);
  deepStrictEqual(budget.capacitySources, {
    contextTokens: 'models.dev',
    inputTokens: 'models.dev',
    inputRatio: 'default',
    outputReserve: 'adapter-request',
  });

  const withoutInputLimit = resolveContextBudget(
    {},
    selected,
    undefined,
    { contextTokens: 100_000, source: 'models.dev' },
  );
  strictEqual(withoutInputLimit.inputLimit, 80_000);
  strictEqual(withoutInputLimit.outputReserve, undefined);
});

Deno.test('Increment 221 applies explicit model/provider/default values per field over metadata', () => {
  const provider = route('opencode-go-chat', 'https://opencode.ai/zen/go/v1');
  const budget = resolveContextBudget(
    {
      defaults: {
        contextTokens: 300_000,
        inputRatio: 0.5,
        outputReserve: 90_000,
        historyTokens: 456,
      },
      providers: { 'opencode-go-chat': { inputTokens: 140_000 } },
      models: { 'opencode-go-chat/deepseek-v4.1-flash': { contextTokens: 250_000 } },
    },
    selection(provider),
    50_000,
    {
      contextTokens: 1_000_000,
      inputTokens: 600_000,
      source: 'models.dev',
      modelsDevProviderId: 'opencode-go',
    },
  );
  strictEqual(budget.contextTokens, 250_000);
  strictEqual(budget.inputTokens, 140_000);
  strictEqual(budget.inputRatio, 0.5);
  strictEqual(budget.inputLimit, 125_000);
  strictEqual(budget.historyTokens, 456);
  strictEqual(budget.outputReserve, 50_000);
  deepStrictEqual(budget.capacitySources, {
    contextTokens: 'explicit-configuration',
    inputTokens: 'explicit-configuration',
    inputRatio: 'explicit-configuration',
    outputReserve: 'adapter-request',
  });
});

Deno.test('Increment 221 leaves unknown capacity unbounded and does not reuse output maximum as a reserve', () => {
  const provider = route('unlisted-route', 'https://route.example/v1');
  const budget = resolveContextBudget({}, selection(provider), undefined, {
    source: 'unknown',
  });
  strictEqual(budget.inputLimit, undefined);
  strictEqual(budget.historyTokens, undefined);
  strictEqual(budget.outputReserve, undefined);
  deepStrictEqual(budget.capacitySources, {
    contextTokens: 'unknown',
    inputTokens: 'unknown',
    inputRatio: 'default',
    outputReserve: 'unknown',
  });
});

Deno.test('Increment 221 resolves capacity by explicit models.dev mapping or exact route and model', async () => {
  const go = route('opencode-go-chat', 'https://opencode.ai/zen/go/v1/');
  const mapped = route('mapped-route', 'https://other.example/v1', {
    modelsDevProviderId: 'mapped',
  });
  const unknown = route('unknown-route', 'https://unknown.example/v1');
  const payload = {
    'opencode-go': {
      api: 'https://opencode.ai/zen/go/v1',
      models: {
        'deepseek-v4.1-flash': { limit: { context: 1_000_000, output: 384_000 } },
      },
    },
    unrelated: {
      api: 'https://elsewhere.example/v1',
      models: {
        'deepseek-v4.1-flash': { limit: { context: 9_000_000, input: 8_000_000 } },
      },
    },
    mapped: {
      models: {
        'deepseek-v4.1-flash': { limit: { input: 40_000, output: 80_000 } },
      },
    },
  };
  const catalog = new LiveModelCatalog({
    configRoot: '/tmp/increment-221-config',
    credentialRoot: '/tmp/increment-221-credentials',
    declarations: [go, mapped, unknown],
    metadataUrl: 'https://metadata.example/api.json',
    fetcher: (_input, init) => {
      strictEqual(new Headers(init?.headers).has('authorization'), false);
      return Promise.resolve(Response.json(payload));
    },
  });

  deepStrictEqual(await catalog.capacity(selection(go)), {
    contextTokens: 1_000_000,
    source: 'models.dev',
    modelsDevProviderId: 'opencode-go',
  });
  deepStrictEqual(await catalog.capacity(selection(mapped)), {
    inputTokens: 40_000,
    source: 'models.dev',
    modelsDevProviderId: 'mapped',
  });
  deepStrictEqual(await catalog.capacity(selection(unknown)), { source: 'unknown' });
});

Deno.test('Increment 221 carries Core catalog capacity through createWorkerSession to Worker startup', async () => {
  const result = await startCoreWorker('production', {
    'opencode-go': {
      api: 'https://opencode.ai/zen/go/v1',
      models: { 'deepseek-v4.1-flash': { limit: { context: 1_000_000, output: 384_000 } } },
    },
  });
  strictEqual(result.metadataRequests, 1);
  strictEqual(result.startCommand?.kind, 'start');
  deepStrictEqual(result.startCommand?.modelCapacity, {
    contextTokens: 1_000_000,
    source: 'models.dev',
    modelsDevProviderId: 'opencode-go',
  });
  const [fact] = result.catalogFacts.trimEnd().split('\n').map((line) => JSON.parse(line));
  strictEqual(fact.api, 'models.dev');
  strictEqual(fact.httpStatus, 200);
});

Deno.test('Increment 221 provider-free Core startup does not fetch public model metadata', async () => {
  const result = await startCoreWorker('provider-free', {});
  strictEqual(result.metadataRequests, 0);
  strictEqual(result.startCommand?.kind, 'start');
  strictEqual(result.startCommand?.modelCapacity, undefined);
  strictEqual(result.catalogFacts, '');
});

Deno.test('Increment 221 standalone headless Host resolves and persists selected model capacity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-221-headless-capacity-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  const dataRoot = `${root}/data`;
  const configRoot = `${root}/config`;
  const provider = route('opencode-go-chat', 'https://opencode.ai/zen/go/v1', {
    modelListSource: 'catalog',
  });
  let metadataRequests = 0;
  let metadataHadAuthorization = false;
  let startCommand: Extract<WorkerHostCommand, { kind: 'start' }> | undefined;
  let receive: ((message: WorkerToHostMessage) => void) | undefined;
  const metadataServer = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      metadataRequests += 1;
      metadataHadAuthorization ||= request.headers.has('authorization');
      return Response.json({
        'opencode-go': {
          api: 'https://opencode.ai/zen/go/v1',
          models: {
            'deepseek-v4.1-flash': {
              limit: { context: 1_000_000, input: 900_000, output: 384_000 },
            },
          },
        },
      });
    },
  );
  const capsule: WorkerHostCapsule = {
    send(command) {
      if (command.kind !== 'start') return;
      startCommand = command;
      queueMicrotask(() =>
        receive?.({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'composition',
          message: 'headless capacity startup stop',
        })
      );
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
    terminate() {},
  };
  try {
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.mkdir(`${configRoot}/providers`, { recursive: true });
    await Deno.writeTextFile(
      `${configRoot}/providers/${provider.providerId}.json`,
      JSON.stringify(provider),
    );
    await Deno.writeTextFile(
      `${configRoot}/model-metadata.json`,
      JSON.stringify({ url: `http://127.0.0.1:${metadataServer.addr.port}/api.json` }),
    );
    await writeDefaultSelection(configRoot, selection(provider));

    let startupError: unknown;
    try {
      await runHeadlessWorker('headless capacity probe', {}, {
        workspaceRoot,
        stateRoot,
        dataRoot,
        configRoot,
        physicalIoMode: 'production',
        capsuleFactory: () => capsule,
      });
    } catch (error) {
      startupError = error;
    }

    strictEqual(startupError instanceof WorkerHostStartupError, true);
    strictEqual(metadataRequests, 1);
    strictEqual(metadataHadAuthorization, false);
    strictEqual(startCommand?.kind, 'start');
    deepStrictEqual(startCommand?.modelCapacity, {
      contextTokens: 1_000_000,
      inputTokens: 900_000,
      source: 'models.dev',
      modelsDevProviderId: 'opencode-go',
    });
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const facts = (await Deno.readTextFile(`${paths.root}/catalog-requests.jsonl`))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    strictEqual(facts.length, 1);
    strictEqual(facts[0].provider, provider.providerId);
    strictEqual(facts[0].api, 'models.dev');
    strictEqual(facts[0].httpStatus, 200);
  } finally {
    await metadataServer.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
