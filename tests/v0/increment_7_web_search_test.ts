import type {
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../../v0/agent/core/contracts.ts';
import {
  ParentTurnExecutionContext,
  TurnRequestBudget,
} from '../../v0/agent/core/execution_context.ts';
import { runAgent } from '../../v0/agent/core/loop.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider/provider_profile.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';
import { bundledAgentConfiguration } from '../../v0/agent/configuration/agent_configuration.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { createWebSearchTool, ExaWebSearchBackend } from '../../v0/agent/tools/web_search.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import {
  createWorkerComposition,
  type PhysicalIoBindings,
  type ToolComponent,
} from '../../v0/agent/worker_agent_api.ts';
import { createWebFetchTool } from '../../v0/agent/tools/web_fetch.ts';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '../../v0/agent/tools/work_tools.ts';
import { createBashOutputTool } from '../../v0/agent/tools/bash_output.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../../v0/agent/worker/worker_physical_io.ts';

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

const bundledToolComponents = (
  physicalIo: PhysicalIoBindings,
): readonly ToolComponent[] => [
  {
    identity: createAgentResourceIdentity('tool:bash'),
    materialize: (bindings) =>
      createBashTool(
        bindings.workspace,
        bindings.processExecutor!,
        bindings.bashOutputStore,
        bindings.workTools.bash ?? {},
      ),
  },
  {
    identity: createAgentResourceIdentity('tool:bash_output'),
    materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
  },
  {
    identity: createAgentResourceIdentity('tool:edit'),
    materialize: (bindings) => createEditTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:read'),
    materialize: (bindings) => createReadTool(bindings.workspace),
  },
  {
    identity: createAgentResourceIdentity('tool:write'),
    materialize: (bindings) => createWriteTool(bindings.workspace, bindings.workTools),
  },
  {
    identity: createAgentResourceIdentity('tool:web_search'),
    materialize: () =>
      createWebSearchTool(
        new ExaWebSearchBackend({
          requestProvider: physicalIo.requestProvider!,
        }),
      ),
  },
  {
    identity: createAgentResourceIdentity('tool:web_fetch'),
    materialize: () => createWebFetchTool(),
  },
];

const usage = (id: string, finishReason: 'stop' | 'tool_calls'): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { content: '', role: 'assistant' },
        finish_reason: finishReason,
        native_finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cost: 0.001,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\n`;

const toolStream = (): string =>
  `data: ${
    JSON.stringify({
      id: 'main-tool',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'search-1',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'Deno 2.9 changes' }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
  }\n\n${usage('main-tool', 'tool_calls')}data: [DONE]\n\n`;

const textStream = (): string =>
  `data: ${
    JSON.stringify({
      id: 'main-final',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'grounded final answer' },
        finish_reason: 'stop',
      }],
    })
  }\n\n${usage('main-final', 'stop')}data: [DONE]\n\n`;

const exaResponse = {
  requestId: 'exa-search',
  resolvedSearchType: 'auto',
  results: [
    {
      title: 'Deno 2.9',
      url: 'https://deno.com/blog/v2.9',
      text: 'Deno 2.9 added important changes.',
      highlights: ['Deno 2.9 added important changes.'],
    },
    {
      title: 'Secondary source',
      url: 'https://example.com/secondary',
      text: 'Additional Deno 2.9 details.',
      highlights: ['Additional Deno 2.9 details.'],
    },
  ],
};

const contextFor = (
  evidence?: ProviderEvidenceRecorder,
  signal?: AbortSignal,
  requestCount?: () => number,
): ParentTurnExecutionContext =>
  new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget({ parent: 8, aggregate: 8 }),
    signal,
    undefined,
    undefined,
    requestCount,
    requestCount,
    evidence,
  );

Deno.test('web_search completes main-Exa-main with full results and shared evidence', async () => {
  const counter = createWorkerRequestCounter();
  const requestBodies: Array<Record<string, unknown>> = [];
  const physicalRequests: Array<{
    readonly url: string;
    readonly authorization?: string;
  }> = [];
  let mainRequests = 0;
  const fetcher: typeof fetch = (input, init) => {
    const bodyText = init?.body instanceof Uint8Array
      ? new TextDecoder().decode(init.body)
      : String(init?.body);
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    requestBodies.push(body);
    physicalRequests.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get('authorization') ??
        undefined,
    });
    if (body.model === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify(exaResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    mainRequests += 1;
    return Promise.resolve(
      new Response(mainRequests === 1 ? toolStream() : textStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
    );
  };
  const physicalIo = createProductionPhysicalIo(counter, {
    credentialSources: {
      'openrouter-api-key': () => 'test-credential',
      'exa-api-key': () => 'test-exa-credential',
    },
    fetcher,
  });
  const composition = createWorkerComposition({
    workspace: { root: '/provider-free-web-search' },
    skillCatalog: emptySkillCatalog(),
    physicalIo,
    toolComponents: bundledToolComponents(physicalIo),
    asyncAgentNames: [],
  }, { roleInstruction: bundledAgentConfiguration().configuration.instruction });
  const evidence = new ProviderEvidenceRecorder(
    '77777777-7777-4777-8777-777777777777',
    1,
    '2026-09-07T00:00:00.000Z',
  );
  const execution = contextFor(evidence, undefined, counter.count);
  const outcome = await runAgent(
    'Find Deno 2.9 changes',
    composition.model,
    composition.registry,
    {
      maxSteps: 4,
      systemInstruction: composition.systemInstruction,
      executionContext: execution,
    },
  );

  assert(outcome.ok);
  assertEquals(outcome.finalText, 'grounded final answer');
  assertEquals(outcome.steps, 2);
  assertEquals(outcome.turnProviderRequestCount, 3);
  assertEquals(outcome.runtimeProviderRequestCount, 3);
  assertEquals(counter.count(), 3);
  assertEquals(execution.snapshot(), { parent: 2, aggregate: 2 });
  assertEquals(requestBodies[0].model, PRODUCTION_PROFILE.model);
  assertEquals(requestBodies[1], {
    type: 'auto',
    contents: { highlights: true },
    query: 'Deno 2.9 changes',
    stream: false,
  });
  assertEquals(requestBodies[2].model, PRODUCTION_PROFILE.model);
  assertEquals(physicalRequests[1], {
    url: 'https://api.exa.ai/search',
    authorization: 'Bearer test-exa-credential',
  });

  const toolMessage = outcome.transcript.find((message) => message.role === 'tool');
  assert(toolMessage?.role === 'tool');
  const resultText = toolMessage.content[0].text;
  assertEquals(resultText, JSON.stringify(exaResponse));
  assert(resultText.includes('https://example.com/secondary'));
  assert(resultText.includes('https://deno.com/blog/v2.9'));

  const snapshot = evidence.snapshot();
  assertEquals(
    snapshot.requests[0].request.requestMetadata.modelId,
    PRODUCTION_PROFILE.model,
  );
  assertEquals(snapshot.requests[1].request.requestMetadata.provider, 'exa');
  assertEquals(snapshot.requests[1].request.requestMetadata.api, 'exa-search');
  assert(!('modelId' in snapshot.requests[1].request.requestMetadata));
  assert(!('effort' in snapshot.requests[1].request.requestMetadata));
  assertEquals(
    snapshot.requests[2].request.requestMetadata.modelId,
    PRODUCTION_PROFILE.model,
  );
  assertEquals(
    snapshot.requests.map((record) => record.request.requestMetadata.origin),
    ['root_model', 'web_search', 'root_model'],
  );
  assertEquals(snapshot.requests.map((record) => record.request.modelStep), [
    1,
    1,
    2,
  ]);
  assertEquals(
    snapshot.requests.map((record) => record.request.requestMetadata.responseMode),
    [
      'sse',
      'json',
      'sse',
    ],
  );
  assertEquals(Object.keys(snapshot.requests[1].response ?? {}), ['status']);
  assertEquals(
    snapshot.requests[1].parserTransitions.map((transition) => transition.reason),
    [],
  );
  assertEquals(
    snapshot.runtimeEvents.map((event) =>
      `${event.kind}:${'modelStep' in event ? event.modelStep : 0}`
    ),
    ['model_result:1', 'tool_call:1', 'tool_result:1', 'model_result:2'],
  );
  assert(!JSON.stringify(snapshot).includes('test-credential'));
});

Deno.test('web_search forwards Exa search options and preserves an empty result response', async () => {
  const response = { results: [], output: { answer: 'No matching pages.' } };
  const evidence = new ProviderEvidenceRecorder(
    '77777777-7777-4777-8777-777777777778',
    1,
    '2026-09-07T00:00:00.000Z',
  );
  const execution = contextFor(evidence);
  evidence.setContextRequestOrdinal(17);
  let seenUrl: string | undefined;
  let seenAuthorization: string | undefined;
  let seenExaBeta: string | undefined;
  let seenBody: Record<string, unknown> | undefined;
  const backend = new ExaWebSearchBackend({
    credential: 'test-credential',
    fetcher: (input, init) => {
      seenUrl = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get('authorization') ?? undefined;
      seenExaBeta = headers.get('Exa-Beta') ?? undefined;
      const bodyText = init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : String(init?.body);
      seenBody = JSON.parse(bodyText) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  const request = {
    query: 'Deno runtime research',
    type: 'deep',
    includeDomains: ['deno.com/docs'],
    startPublishedDate: '2026-01-01T00:00:00.000Z',
    category: 'research paper',
    additionalQueries: ['Deno runtime architecture'],
    contents: {
      text: { maxCharacters: 1200 },
      highlights: { dynamic: true, verbosity: 'low' },
    },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
    },
  };
  const result = await new Registry([createWebSearchTool(backend)]).dispatch({
    callId: 'exa-search-options',
    name: 'web_search',
    arguments: request,
  }, { modelExecution: execution, modelStep: 1 });

  assertEquals(result.content.outcome, 'success');
  assertEquals(result.content.text, JSON.stringify(response));
  assertEquals(seenUrl, 'https://api.exa.ai/search');
  assertEquals(seenAuthorization, 'Bearer test-credential');
  assertEquals(seenExaBeta, 'dynamic-highlights-2026-08-28');
  assertEquals(seenBody, {
    type: 'deep',
    contents: {
      text: { maxCharacters: 1200 },
      highlights: { dynamic: true, verbosity: 'low' },
    },
    query: 'Deno runtime research',
    includeDomains: ['deno.com/docs'],
    startPublishedDate: '2026-01-01T00:00:00.000Z',
    category: 'research paper',
    additionalQueries: ['Deno runtime architecture'],
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
    },
    stream: false,
  });
  assertEquals(
    evidence.snapshot().requests[0].request.contextRequestOrdinal,
    undefined,
  );
});

Deno.test('web_search exposes provider response errors with short facts', async () => {
  const cases = [
    {
      raw: JSON.stringify({ error: 'rate limited' }),
      status: 429,
      message: 'failed (429)',
      transitions: ['http_error'],
    },
    {
      raw: 'not JSON',
      status: 200,
      message: 'not valid JSON',
      transitions: ['invalid_json'],
    },
    {
      raw: JSON.stringify({ output: { answer: 'No source results.' } }),
      status: 200,
      message: 'no results array',
      transitions: ['missing_results'],
    },
    {
      raw: new Uint8Array([0xc3, 0x28]),
      status: 200,
      message: 'not valid UTF-8',
      transitions: ['invalid_utf8'],
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    let fetches = 0;
    const backend = new ExaWebSearchBackend({
      credential: 'test-credential',
      fetcher: () => {
        fetches += 1;
        return Promise.resolve(new Response(item.raw, { status: item.status }));
      },
    });
    const evidence = new ProviderEvidenceRecorder(
      `88888888-8888-4888-8888-88888888888${index}`,
      1,
      '2026-09-07T00:00:00.000Z',
    );
    const execution = contextFor(evidence);
    const result = await new Registry([createWebSearchTool(backend)]).dispatch({
      callId: `search-invalid-${index}`,
      name: 'web_search',
      arguments: { query: 'current information' },
    }, {
      modelExecution: execution,
      modelStep: 4,
    });

    assertEquals(result.content.outcome, 'error');
    assert(result.content.text.includes(item.message));
    assertEquals(fetches, 1);
    const snapshot = evidence.snapshot();
    assertEquals(snapshot.requests[0].request.modelStep, 4);
    assertEquals(Object.keys(snapshot.requests[0].response ?? {}), ['status']);
    assertEquals(
      snapshot.requests[0].parserTransitions.map((transition) => transition.reason),
      item.transitions,
    );
  }
});

Deno.test('web_search retains response status when the body is interrupted', async () => {
  let pulls = 0;
  const backend = new ExaWebSearchBackend({
    credential: 'test-credential',
    fetcher: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode('first-'));
              } else controller.error(new Error('body interrupted'));
            },
          }, { highWaterMark: 0 }),
          {
            status: 200,
            headers: { 'x-provider-response': 'received' },
          },
        ),
      ),
  });
  const evidence = new ProviderEvidenceRecorder(
    '88888888-8888-4888-8888-888888888890',
    1,
    '2026-09-07T00:00:00.000Z',
  );
  let error: unknown;
  try {
    await backend.search({ query: 'interrupted response' }, {
      modelExecution: contextFor(evidence),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error && error.message.includes('body interrupted'));
  const response = evidence.snapshot().requests[0].response;
  assertEquals(response?.status, 200);
  assertEquals(Object.keys(response ?? {}), ['status']);
});

Deno.test('web_search Exa request does not consume a model request budget', async () => {
  let credentials = 0;
  let fetches = 0;
  const backend = new ExaWebSearchBackend({
    credentialSource: () => {
      credentials += 1;
      return 'test-credential';
    },
    fetcher: () => {
      fetches += 1;
      return Promise.resolve(new Response(JSON.stringify({ results: [] })));
    },
  });
  const execution = new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget({ parent: 1, aggregate: 1 }),
  );
  assert(execution.claimModelRequest());
  const result = await new Registry([createWebSearchTool(backend)]).dispatch({
    callId: 'search-budget-exhausted',
    name: 'web_search',
    arguments: { query: 'current information' },
  }, {
    modelExecution: execution,
    modelStep: 1,
  });
  assertEquals(result.content.outcome, 'success');
  assertEquals(execution.snapshot(), { parent: 1, aggregate: 1 });
  assertEquals(credentials, 1);
  assertEquals(fetches, 1);
});

Deno.test('web_search cancellation aborts the nested fetch and settles the turn as cancelled', async () => {
  const controller = new AbortController();
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let fetches = 0;
  const backend = new ExaWebSearchBackend({
    credential: 'test-credential',
    fetcher: (_input, init) => {
      fetches += 1;
      resolveStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  });
  let modelRequests = 0;
  const model: Model = {
    generate(
      _request: ModelRequest,
      _options: ModelGenerateOptions = {},
    ): ModelResult {
      modelRequests += 1;
      return {
        kind: 'tool_calls',
        calls: [{
          callId: 'search-cancel',
          name: 'web_search',
          arguments: { query: 'wait for search' },
        }],
      };
    },
  };
  const evidence = new ProviderEvidenceRecorder(
    '99999999-9999-4999-8999-999999999999',
    1,
    '2026-09-07T00:00:00.000Z',
  );
  const execution = contextFor(evidence, controller.signal, () => fetches);
  const pending = runAgent(
    'cancel web search',
    model,
    new Registry([createWebSearchTool(backend)]),
    {
      maxSteps: 4,
      executionContext: execution,
      signal: controller.signal,
    },
  );
  await started;
  controller.abort('user cancelled');
  const outcome = await pending;

  assertEquals(outcome.stopReason, 'cancelled');
  assertEquals(outcome.ok, false);
  assertEquals(modelRequests, 1);
  assertEquals(fetches, 1);
  assertEquals(outcome.toolCallCount, 1);
  assertEquals(outcome.toolResultCount, 0);
  assertEquals(execution.snapshot(), { parent: 1, aggregate: 1 });
  assertEquals(evidence.snapshot().requests[0].request.modelStep, 1);
});
