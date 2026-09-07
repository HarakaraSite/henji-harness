import type {
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../../v0/agent/contracts.ts';
import { ParentTurnExecutionContext, TurnRequestBudget } from '../../v0/agent/execution_context.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider_evidence.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider_profile.ts';
import {
  materializePreparedRuntimeComposition,
  prepareRuntimeComposition,
} from '../../v0/agent/runtime.ts';
import { emptySkillCatalog } from '../../v0/agent/skills.ts';
import { Registry } from '../../v0/agent/tools.ts';
import {
  createWebSearchTool,
  OPENROUTER_SONAR_SEARCH_MODEL,
  OpenRouterSonarWebSearchBackend,
} from '../../v0/agent/web_search.ts';
import { createDefaultAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../../v0/agent/worker_physical_io.ts';

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

const sonarResponse = {
  id: 'sonar-search',
  model: OPENROUTER_SONAR_SEARCH_MODEL,
  choices: [{
    finish_reason: 'stop',
    message: {
      role: 'assistant',
      content: 'Deno 2.9 added important changes.[2][1]',
      annotations: [
        {
          type: 'url_citation',
          url_citation: {
            url: 'https://example.com/secondary',
            title: 'Secondary source',
            start_index: 0,
            end_index: 0,
          },
        },
        {
          type: 'url_citation',
          url_citation: {
            url: 'https://deno.com/blog/v2.9',
            title: 'Deno 2.9',
            start_index: 0,
            end_index: 0,
          },
        },
      ],
    },
  }],
  usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13, cost: 0.005013 },
};

const contextFor = (
  evidence?: ProviderEvidenceRecorder,
  signal?: AbortSignal,
  requestCount?: () => number,
): ParentTurnExecutionContext =>
  new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget({ parent: 8, child: 8, aggregate: 16 }),
    signal,
    undefined,
    undefined,
    requestCount,
    requestCount,
    evidence,
  );

Deno.test('non-Worker runtime materializes the injected web_search backend', async () => {
  const prepared = await prepareRuntimeComposition({
    workspace: { root: '/provider-free-web-search' },
    instructionFileSystem: {
      lstat: () => Promise.reject(new Error('no instruction fixture')),
      open: () => Promise.reject(new Error('no instruction fixture')),
    },
    skillFileSystem: {
      lstat: () => Promise.reject(new Error('no skill fixture')),
      readDirectory: async function* () {},
      open: () => Promise.reject(new Error('no skill fixture')),
    },
    webSearchBackend: {
      search: (query) => ({
        answer: `runtime result for ${query}`,
        sources: [{ title: 'Runtime source', url: 'provider-free://runtime-search' }],
      }),
    },
  });
  const composition = materializePreparedRuntimeComposition(prepared);
  assert(composition.resourceSelection.resources.map(String).includes('tool:web_search'));
  assert(composition.registry.resolve('web_search') !== undefined);
  const result = await composition.registry.dispatch({
    callId: 'runtime-search',
    name: 'web_search',
    arguments: { query: 'runtime query' },
  }, { modelStep: 1 });
  assertEquals(result.content.outcome, 'success');
  assert(result.content.text.includes('runtime result for runtime query'));
  assert(result.content.text.includes('provider-free://runtime-search'));
});

Deno.test('web_search completes main-Sonar-main with ordered citations and shared evidence', async () => {
  const counter = createWorkerRequestCounter();
  const requestBodies: Array<Record<string, unknown>> = [];
  let mainRequests = 0;
  const fetcher: typeof fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (body.model === OPENROUTER_SONAR_SEARCH_MODEL) {
      return Promise.resolve(
        new Response(JSON.stringify(sonarResponse), {
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
    credentialSource: () => 'test-credential',
    fetcher,
  });
  const composition = createDefaultAgentComposition({
    workspace: { root: '/provider-free-web-search' },
    skillCatalog: emptySkillCatalog(),
    physicalIo,
  });
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
  assertEquals(execution.snapshot(), { parent: 3, child: 0, aggregate: 3 });
  assertEquals(requestBodies.map((body) => body.model), [
    PRODUCTION_PROFILE.model,
    OPENROUTER_SONAR_SEARCH_MODEL,
    PRODUCTION_PROFILE.model,
  ]);
  assertEquals(requestBodies[1], {
    model: OPENROUTER_SONAR_SEARCH_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Only answer using facts supported by the search results. If the results do not contain the answer, say so explicitly rather than guessing. If the results are related but do not match the question, state the mismatch before answering. Clearly distinguish verified facts from inference.',
      },
      { role: 'user', content: 'Deno 2.9 changes' },
    ],
    stream: false,
    web_search_options: { search_context_size: 'medium' },
  });

  const toolMessage = outcome.transcript.find((message) => message.role === 'tool');
  assert(toolMessage?.role === 'tool');
  const resultText = toolMessage.content[0].text;
  assert(resultText.includes('Answer:\nDeno 2.9 added important changes.[2][1]'));
  assert(resultText.indexOf('Secondary source') < resultText.indexOf('Deno 2.9\n'));
  assert(resultText.includes('https://example.com/secondary'));
  assert(resultText.includes('https://deno.com/blog/v2.9'));

  const snapshot = evidence.snapshot();
  assertEquals(snapshot.requests.map((record) => JSON.parse(record.request.requestBody).model), [
    PRODUCTION_PROFILE.model,
    OPENROUTER_SONAR_SEARCH_MODEL,
    PRODUCTION_PROFILE.model,
  ]);
  assertEquals(snapshot.requests.map((record) => record.request.modelStep), [1, 1, 2]);
  assertEquals(snapshot.requests.map((record) => record.request.requestMetadata.responseMode), [
    'sse',
    'json',
    'sse',
  ]);
  assertEquals(snapshot.requests[1].response?.rawBody, JSON.stringify(sonarResponse));
  assertEquals(
    snapshot.requests[1].parserTransitions.map((transition) => transition.reason),
    ['json_response', 'answer_with_url_citations', 'web_search_result'],
  );
  assertEquals(
    snapshot.runtimeEvents.map((event) =>
      `${event.kind}:${'modelStep' in event ? event.modelStep : 0}`
    ),
    ['model_result:1', 'tool_call:1', 'tool_result:1', 'model_result:2'],
  );
  assert(!JSON.stringify(snapshot).includes('test-credential'));
  assert(!JSON.stringify(snapshot).toLowerCase().includes('authorization'));
});

Deno.test('web_search exposes provider response errors while retaining raw evidence', async () => {
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
      raw: JSON.stringify({ choices: [{ message: { content: 'answer', annotations: [] } }] }),
      status: 200,
      message: 'no answer with URL citations',
      transitions: ['json_response', 'missing_answer_or_url_citations'],
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    let fetches = 0;
    const backend = new OpenRouterSonarWebSearchBackend({
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
    assertEquals(snapshot.requests[0].response?.rawBody, item.raw);
    assertEquals(
      snapshot.requests[0].parserTransitions.map((transition) => transition.reason),
      item.transitions,
    );
  }
});

Deno.test('web_search request admission stops before credential resolution and fetch', async () => {
  let credentials = 0;
  let fetches = 0;
  const backend = new OpenRouterSonarWebSearchBackend({
    credentialSource: () => {
      credentials += 1;
      return 'test-credential';
    },
    fetcher: () => {
      fetches += 1;
      return Promise.resolve(new Response(JSON.stringify(sonarResponse)));
    },
  });
  const execution = new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget({ parent: 1, child: 1, aggregate: 1 }),
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
  assertEquals(result.content.outcome, 'error');
  assert(result.content.text.includes('request budget exhausted'));
  assertEquals(credentials, 0);
  assertEquals(fetches, 0);
});

Deno.test('web_search cancellation aborts the nested fetch and settles the turn as cancelled', async () => {
  const controller = new AbortController();
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let fetches = 0;
  const backend = new OpenRouterSonarWebSearchBackend({
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
  assertEquals(execution.snapshot(), { parent: 2, child: 0, aggregate: 2 });
  assertEquals(evidence.snapshot().requests[0].request.modelStep, 1);
});
