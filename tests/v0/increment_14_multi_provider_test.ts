import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
import { AgentSession } from '../../v0/agent/session/session.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import {
  defaultModelSelectionFor,
  isModelSelection,
  modelCatalogEntryFor,
  providerIdsForSelection,
  searchModelsFor,
  selectModelFor,
} from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { OPENAI_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openai_model_catalog.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  parseProviderDeclaration,
  ProviderDeclarationError,
  resolveProviderRegistry,
  validateProviderDeclaration,
} from '../../v0/agent/provider/provider_declaration.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const request: ModelRequest = {
  systemInstruction: 'Answer briefly.',
  transcript: [{ role: 'user', content: { kind: 'text', text: 'Say hello.' } }],
  tools: [],
};

const openAICompletedStream = (text: string): string => {
  const response = {
    id: 'resp_increment_14',
    object: 'response',
    created_at: 1_788_800_000,
    status: 'completed',
    model: 'gpt-5.6-sol',
    output: [{
      id: 'msg_increment_14',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
  };
  return [
    `data: ${
      JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: text,
        item_id: 'msg_increment_14',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        logprobs: [],
      })
    }\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response, sequence_number: 2 })}\n\n`,
  ].join('');
};

const openAIToolStream = (): string => {
  const response = {
    id: 'resp_tool_increment_14',
    object: 'response',
    created_at: 1_788_800_001,
    status: 'completed',
    model: 'gpt-5.6-sol',
    output: [{
      id: 'fc_increment_14',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_increment_14',
      name: 'read',
      arguments: '{"path":"README.md"}',
    }],
  };
  return `data: ${
    JSON.stringify({ type: 'response.completed', response, sequence_number: 1 })
  }\n\n`;
};

const openRouterCompletedStream = (text: string): string =>
  `data: ${
    JSON.stringify({
      id: 'gen_increment_14',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      }],
    })
  }\n\ndata: ${
    JSON.stringify({
      id: 'gen_increment_14',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        cost: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\ndata: [DONE]\n\n`;

Deno.test('Increment 14 selects a fixed provider catalog at startup', () => {
  assertEquals(defaultModelSelectionFor('openrouter'), ROOT_DEFAULT_MODEL_SELECTION);
  assertEquals(defaultModelSelectionFor('openai'), OPENAI_DEFAULT_MODEL_SELECTION);
  assertEquals(defaultModelSelectionFor('openrouter-responses').provider, 'openrouter-responses');
  assert(isModelSelection(defaultModelSelectionFor('openrouter-responses')));
  assert(isModelSelection(OPENAI_DEFAULT_MODEL_SELECTION));
  assertEquals(parseTuiInvocation(['--root-provider', 'openai', '--no-session']), {
    rawAgentName: undefined,
    rootProvider: 'openai',
    persistence: 'none',
  });
  assertEquals(
    parseTuiInvocation(['--root-provider', 'openrouter-responses', '--no-session'])
      .rootProvider,
    'openrouter-responses',
  );
  for (
    const args of [
      ['--root-provider'],
      ['--root-provider', 'anthropic'],
      ['--root-provider', 'openai', '--root-provider', 'openrouter'],
    ]
  ) {
    let rejected = false;
    try {
      parseTuiInvocation(args);
    } catch {
      rejected = true;
    }
    assert(rejected, `expected rejection: ${args.join(' ')}`);
  }
});

Deno.test('Increment 14 OpenAI root uses the official Responses SDK and retains raw evidence', async () => {
  const seen: { url?: string; authorization?: string; body?: string } = {};
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.url = request.url;
    seen.authorization = request.headers.get('authorization') ?? undefined;
    seen.body = await request.clone().text();
    return new Response(openAICompletedStream('hello'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_increment_14' },
    });
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    openAICredentialSource: () => Promise.resolve('openai-secret'),
    fetcher,
  });
  const evidence = new ProviderEvidenceRecorder();
  const result = await physical.createModel('parent', OPENAI_DEFAULT_MODEL_SELECTION).generate(
    request,
    { providerEvidence: evidence, providerEvidenceLane: 'parent', modelStep: 1 },
  );
  assertEquals(result.kind, 'final');
  if (result.kind !== 'final') throw new Error('expected final');
  assertEquals(result.text, 'hello');
  assertEquals(result.providerState?.provider, 'openai');
  assertEquals(seen.url, 'https://api.openai.com/v1/responses');
  assertEquals(seen.authorization, 'Bearer openai-secret');
  const body = JSON.parse(seen.body ?? '{}');
  assertEquals(body.model, 'gpt-5.6-sol');
  assertEquals(body.store, false);
  assertEquals(body.stream, true);
  assertEquals(body.include, ['reasoning.encrypted_content']);

  const retained = evidence.snapshot().requests[0];
  assertEquals(retained.request.requestMetadata, {
    contentType: 'application/json',
    redirect: 'error',
    responseMode: 'sse',
    origin: 'root_model',
    provider: 'openai',
    api: 'openai-responses',
    modelId: 'gpt-5.6-sol',
    effort: 'medium',
    authProfile: 'openai-api-key',
    protocol: 'sse',
  });
  assert(retained.response?.rawBody?.includes('response.completed'));
  assert(retained.sseEvents.length === 3);
  assert(!JSON.stringify(retained).includes('openai-secret'));

  const session = new AgentSession(
    physical.createModel('parent', OPENAI_DEFAULT_MODEL_SELECTION),
    new Registry([]),
    { systemInstruction: 'Answer briefly.' },
  );
  const outcome = await session.submit('Say hello.');
  assert(outcome.ok, 'OpenAI final must pass through the Henji core loop');
  assertEquals(outcome.finalText, 'hello');
});

Deno.test('Increment 58 OpenRouter Responses root uses the shared Responses adapter statelessly', async () => {
  const seen: { url?: string; authorization?: string; body?: string } = {};
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.url = request.url;
    seen.authorization = request.headers.get('authorization') ?? undefined;
    seen.body = await request.clone().text();
    return new Response(openAICompletedStream('hello'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_increment_58' },
    });
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    fetcher,
  });
  const selection = defaultModelSelectionFor('openrouter-responses');
  const evidence = new ProviderEvidenceRecorder();
  const result = await physical.createModel('parent', selection).generate(request, {
    providerEvidence: evidence,
    providerEvidenceLane: 'parent',
    modelStep: 1,
  });
  assertEquals(result.kind, 'final');
  if (result.kind !== 'final') throw new Error('expected final');
  assertEquals(result.text, 'hello');
  assertEquals(result.providerState, undefined);
  assertEquals(seen.url, 'https://openrouter.ai/api/v1/responses');
  assertEquals(seen.authorization, 'Bearer router-secret');
  const body = JSON.parse(seen.body ?? '{}');
  assertEquals(body.model, 'deepseek/deepseek-v4.1-flash');
  assertEquals(body.store, undefined);
  assertEquals(body.stream, true);

  const retained = evidence.snapshot().requests[0];
  assertEquals(retained.request.requestMetadata.provider, 'openrouter-responses');
  assertEquals(retained.request.requestMetadata.api, 'openrouter-responses');
  assertEquals(retained.request.requestMetadata.authProfile, 'openrouter-api-key');
  assert(!JSON.stringify(retained).includes('router-secret'));
});

const declarationBody = (providerId: string): Record<string, unknown> => ({
  schemaVersion: 1,
  providerId,
  protocol: 'openai-responses',
  endpoint: 'https://openrouter.ai/api/v1/',
  authProfile: 'openrouter-api-key',
  modelCatalog: {
    kind: 'fixed',
    entries: [{
      modelId: 'deepseek/deepseek-v4.1-flash',
      defaultEffort: 'high',
      efforts: ['auto', 'high'],
    }],
  },
  defaults: { modelId: 'deepseek/deepseek-v4.1-flash', effort: 'high' },
});

const declarationCodeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ProviderDeclarationError) return error.code;
    throw error;
  }
  return 'no_error';
};

Deno.test('Increment 59 provider declarations validate, load, and merge over built-ins', async () => {
  const builtins = builtinProviderDeclarations();
  assertEquals(builtins.map((declaration) => declaration.providerId).sort(), [
    'openai',
    'openrouter',
    'openrouter-responses',
  ]);

  const parsed = validateProviderDeclaration(declarationBody('openrouter-responses'));
  assertEquals(parsed.endpoint, 'https://openrouter.ai/api/v1');
  const merged = resolveProviderRegistry(builtins, [parsed]);
  assertEquals(merged.get('openrouter-responses')?.endpoint, 'https://openrouter.ai/api/v1');
  assert(merged.get('openrouter') !== undefined);
  assert(merged.get('openai') !== undefined);

  const added = resolveProviderRegistry(builtins, [
    validateProviderDeclaration(declarationBody('internal-vllm')),
  ]);
  assert(added.get('internal-vllm') !== undefined);

  for (const reserved of ['openrouter', 'openai']) {
    assertEquals(
      declarationCodeOf(() => validateProviderDeclaration(declarationBody(reserved))),
      'provider_declaration_reserved',
    );
  }
  assertEquals(
    declarationCodeOf(() =>
      validateProviderDeclaration({ ...declarationBody('bad'), protocol: 'anthropic-messages' })
    ),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() =>
      validateProviderDeclaration({ ...declarationBody('bad'), authProfile: 'unknown-profile' })
    ),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() =>
      validateProviderDeclaration({
        ...declarationBody('bad'),
        defaults: { modelId: 'missing/model', effort: 'high' },
      })
    ),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => parseProviderDeclaration('{ not json')),
    'provider_declaration_invalid',
  );

  const conflictBuiltin = validateProviderDeclaration(declarationBody('team-provider'));
  assertEquals(
    declarationCodeOf(() =>
      resolveProviderRegistry(
        [conflictBuiltin],
        [validateProviderDeclaration(declarationBody('team-provider'))],
      )
    ),
    'provider_declaration_duplicate',
  );

  const root = '/cfg/providers';
  const files = new Map<string, string>([
    [`${root}/a.json`, JSON.stringify(declarationBody('dup'))],
    [`${root}/b.json`, JSON.stringify(declarationBody('dup'))],
  ]);
  const duplicateFileSystem = {
    readDirectory: () => Promise.resolve(['a.json', 'b.json']),
    readTextFile: (path: string) => Promise.resolve(files.get(path) ?? ''),
  };
  let duplicateCode = 'no_error';
  try {
    await loadProviderDeclarations({ configRoot: '/cfg', fileSystem: duplicateFileSystem });
  } catch (error) {
    duplicateCode = error instanceof ProviderDeclarationError ? error.code : 'other';
  }
  assertEquals(duplicateCode, 'provider_declaration_duplicate');

  const missingFileSystem = {
    readDirectory: () => Promise.reject(new Deno.errors.NotFound()),
    readTextFile: () => Promise.resolve(''),
  };
  assertEquals(
    (await loadProviderDeclarations({ configRoot: '/cfg', fileSystem: missingFileSystem })).length,
    0,
  );
});

Deno.test('Increment 60 declaration overrides the OpenRouter Responses catalog and defaults', () => {
  const override = validateProviderDeclaration({
    ...declarationBody('openrouter-responses'),
    modelCatalog: {
      kind: 'fixed',
      entries: [{ modelId: 'acme/override-model', defaultEffort: 'low', efforts: ['low', 'high'] }],
    },
    defaults: { modelId: 'acme/override-model', effort: 'high' },
  });
  setActiveProviderDeclarations([override]);
  try {
    const selection = defaultModelSelectionFor('openrouter-responses');
    assertEquals(selection.modelId, 'acme/override-model');
    assertEquals(selection.effort, 'high');
    assert(isModelSelection(selection));
    assertEquals(searchModelsFor('openrouter-responses', '').length, 1);
    assertEquals(
      modelCatalogEntryFor('openrouter-responses', 'acme/override-model')?.defaultEffort,
      'low',
    );
    assertEquals(selectModelFor('openrouter-responses', 'acme/override-model').effort, 'low');
    assert(
      searchModelsFor('openrouter-responses', 'deepseek').length === 0,
      'the static catalog must not leak past a declaration override',
    );
  } finally {
    setActiveProviderDeclarations([]);
  }
  assertEquals(
    defaultModelSelectionFor('openrouter-responses').modelId,
    'deepseek/deepseek-v4.1-flash',
  );
});

Deno.test('Increment 61 declaration adds an external OpenAI provider beside the built-in', async () => {
  const declaration = validateProviderDeclaration({
    schemaVersion: 1,
    providerId: 'openai-alt',
    protocol: 'openai-responses',
    endpoint: 'https://api.openai.com/v1',
    authProfile: 'openai-api-key',
    modelCatalog: {
      kind: 'fixed',
      entries: [{
        modelId: 'gpt-5.6-terra',
        defaultEffort: 'medium',
        efforts: ['low', 'medium'],
      }],
    },
    defaults: { modelId: 'gpt-5.6-terra', effort: 'medium' },
  });
  setActiveProviderDeclarations([declaration]);
  try {
    assert(providerIdsForSelection().includes('openai-alt'));
    const selection = defaultModelSelectionFor('openai-alt');
    assertEquals(selection.provider, 'openai-alt');
    assertEquals(selection.api, 'openai-responses');
    assertEquals(selection.modelId, 'gpt-5.6-terra');
    assert(isModelSelection(selection));
    assertEquals(searchModelsFor('openai-alt', '').length, 1);
    assertEquals(selectModelFor('openai-alt', 'gpt-5.6-terra').effort, 'medium');

    const seen: { url?: string; authorization?: string } = {};
    const fetcher: typeof fetch = (input, init) => {
      const requested = input instanceof Request ? input : new Request(input, init);
      seen.url = requested.url;
      seen.authorization = requested.headers.get('authorization') ?? undefined;
      return Promise.resolve(
        new Response(openAICompletedStream('hello'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const physical = createProductionPhysicalIo(undefined, {
      openAICredentialSource: () => Promise.resolve('alt-secret'),
      fetcher,
      providerDeclarations: [declaration],
    });
    const evidence = new ProviderEvidenceRecorder();
    const result = await physical.createModel('parent', selection).generate(request, {
      providerEvidence: evidence,
      providerEvidenceLane: 'parent',
      modelStep: 1,
    });
    assertEquals(result.kind, 'final');
    assertEquals(seen.url, 'https://api.openai.com/v1/responses');
    assertEquals(seen.authorization, 'Bearer alt-secret');
    assertEquals(
      evidence.snapshot().requests[0].request.requestMetadata.provider,
      'openai-alt',
    );
    assert(!JSON.stringify(evidence.snapshot()).includes('alt-secret'));
  } finally {
    setActiveProviderDeclarations([]);
  }
});

Deno.test('Increment 59 provider declaration overrides the OpenRouter Responses endpoint', async () => {
  const seen: { url?: string } = {};
  const fetcher: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.url = request.url;
    return Promise.resolve(
      new Response(openAICompletedStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const declaration = validateProviderDeclaration({
    ...declarationBody('openrouter-responses'),
    endpoint: 'https://gateway.example/v1',
  });
  const physical = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    fetcher,
    providerDeclarations: [declaration],
  });
  const result = await physical.createModel(
    'parent',
    defaultModelSelectionFor('openrouter-responses'),
  ).generate(request);
  assertEquals(result.kind, 'final');
  assertEquals(seen.url, 'https://gateway.example/v1/responses');
});

Deno.test('Increment 14 keeps resolved OpenAI auth authoritative over ambient SDK headers', async () => {
  const previous = Deno.env.get('OPENAI_CUSTOM_HEADERS');
  Deno.env.set('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer ambient-secret');
  let authorization: string | undefined;
  try {
    const fetcher: typeof fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      authorization = request.headers.get('authorization') ?? undefined;
      return Promise.resolve(
        new Response(openAICompletedStream('fixed auth'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const model = createProductionPhysicalIo(undefined, {
      credentialSource: () => Promise.resolve('router-secret'),
      openAICredentialSource: () => Promise.resolve('openai-secret'),
      fetcher,
    }).createModel('parent', OPENAI_DEFAULT_MODEL_SELECTION);
    const result = await model.generate(request);
    assertEquals(result.kind, 'final');
    assertEquals(authorization, 'Bearer openai-secret');
  } finally {
    if (previous === undefined) Deno.env.delete('OPENAI_CUSTOM_HEADERS');
    else Deno.env.set('OPENAI_CUSTOM_HEADERS', previous);
  }
});

Deno.test('Increment 14 keeps planner OpenRouter auth separate from an OpenAI root', async () => {
  const seen: { authorization?: string; host?: string } = {};
  const fetcher: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.authorization = request.headers.get('authorization') ?? undefined;
    seen.host = new URL(request.url).host;
    return Promise.resolve(
      new Response(openRouterCompletedStream('planned'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    openAICredentialSource: () => Promise.resolve('openai-secret'),
    fetcher,
  });
  const result = await physical.createModel('planner').generate(request);
  assertEquals(result, { kind: 'final', text: 'planned' });
  assertEquals(seen.host, 'openrouter.ai');
  assertEquals(seen.authorization, 'Bearer router-secret');
});

Deno.test('Increment 14 replays OpenAI function calls for Henji-owned tool continuation', async () => {
  const bodies: unknown[] = [];
  let requestNumber = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(JSON.parse(await request.clone().text()));
    requestNumber += 1;
    return new Response(
      requestNumber === 1 ? openAIToolStream() : openAICompletedStream('README received'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const model = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    openAICredentialSource: () => Promise.resolve('openai-secret'),
    fetcher,
  }).createModel('parent', OPENAI_DEFAULT_MODEL_SELECTION);
  const session = new AgentSession(
    model,
    new Registry([{
      name: 'read',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: () => '# Henji',
    }]),
    {
      systemInstruction: request.systemInstruction,
    },
  );
  const outcome = await session.submit('Say hello.');
  assert(outcome.ok, 'OpenAI tool continuation must pass through the Henji core loop');
  assertEquals(outcome.finalText, 'README received');
  const assistant = outcome.transcript.find((message) => message.role === 'assistant');
  assertEquals(assistant?.content, [{
    kind: 'tool_call',
    callId: 'call_increment_14',
    name: 'read',
    arguments: { path: 'README.md' },
  }]);
  assertEquals(assistant?.providerState?.provider, 'openai');
  const secondInput = (bodies[1] as { readonly input: readonly unknown[] }).input;
  assertEquals(secondInput.slice(-2), [
    {
      id: 'fc_increment_14',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_increment_14',
      name: 'read',
      arguments: '{"path":"README.md"}',
    },
    { type: 'function_call_output', call_id: 'call_increment_14', output: '# Henji' },
  ]);
});

Deno.test('Increment 14 keeps OpenRouter web search usable beside an OpenAI root', async () => {
  const seen: { authorization?: string; model?: string } = {};
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.authorization = request.headers.get('authorization') ?? undefined;
    const body = JSON.parse(await request.clone().text());
    seen.model = body.model;
    return new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: 'Deno is a runtime.',
            annotations: [{
              type: 'url_citation',
              url_citation: { title: 'Deno Docs', url: 'https://docs.deno.com/' },
            }],
          },
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSource: () => Promise.resolve('router-secret'),
    openAICredentialSource: () => Promise.resolve('openai-secret'),
    fetcher,
  });
  assert(physical.webSearchBackend !== undefined);
  const result = await physical.webSearchBackend.search('What is Deno?');
  assertEquals(result.answer, 'Deno is a runtime.');
  assertEquals(seen.model, 'perplexity/sonar');
  assertEquals(seen.authorization, 'Bearer router-secret');
});

Deno.test('Increment 14 carries an OpenAI root through Host Worker persistence and resume', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-increment-14-' });
  const workspaceRoot = Deno.cwd();
  let first: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    first = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      initialModelSelection: OPENAI_DEFAULT_MODEL_SELECTION,
    });
    await store.initialize();
    assertEquals(first.session.modelSelectionSnapshot(), OPENAI_DEFAULT_MODEL_SELECTION);
    assertEquals(first.displayState.model.provider, 'openai');
    assert((await first.session.submit('persist direct provider selection')).ok);
    const artifact = (await store.executionArtifacts.list()).at(-1);
    assert(artifact !== undefined);
    assertEquals(artifact.manifest.rootModel, OPENAI_DEFAULT_MODEL_SELECTION);
    assert(artifact.manifest.resources.some((resource) => resource.startsWith('model:openai:')));
    const sessionId = first.session.currentPosition().sessionId;
    await first.close();
    first = undefined;
    const stored = await store.readWorker(sessionId);
    assert(stored.schemaVersion === 6);
    assertEquals(stored.activeModel, OPENAI_DEFAULT_MODEL_SELECTION);

    resumed = await createWorkerSession({
      stateRoot,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    assertEquals(resumed.session.modelSelectionSnapshot(), OPENAI_DEFAULT_MODEL_SELECTION);
    assertEquals(resumed.displayState.model.provider, 'openai');
  } finally {
    await first?.close();
    await resumed?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 32 compile entry grants both provider hosts and XDG credential discovery', async () => {
  const build = await Deno.readTextFile('scripts/build_henji.ts');
  assert(build.includes('--allow-net=openrouter.ai,api.openai.com'));
  assert(build.includes('XDG_CONFIG_HOME'));
  assert(build.includes('HOME'));
  assert(build.includes('--cached-only'));
});
