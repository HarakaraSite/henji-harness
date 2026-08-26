import { assert, assertEquals } from './test_helpers.ts';
import { CORPUS_PATH, type CorpusTask, loadTaskCorpus } from '../../v0/corpus/task_corpus.ts';
import { type LoopOutcome, type Model } from '../../v0/agent/contracts.ts';
import { OpenRouterAgentModel } from '../../v0/agent/openrouter_model.ts';
import { createRuntimeRegistry } from '../../v0/agent/runtime.ts';
import { Registry } from '../../v0/agent/tools.ts';
import {
  LiveCorpusEvalError,
  runLiveCorpusEval,
  serializeLiveCorpusEvalReport,
  validateLiveCorpusEvalReport,
} from '../../v0/eval/live_corpus_runner.ts';
import { main as liveCliMain, writeAllLiveCorpusBytes } from '../../v0/eval/live_corpus_cli.ts';
import { main as offlineCliMain } from '../../v0/eval/offline_corpus_cli.ts';
import { runOfflineCorpusEval } from '../../v0/eval/offline_corpus_runner.ts';

const DUMMY_CREDENTIAL = 'dummy-live-credential-marker';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const response = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const finalPayload = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});

const toolPayload = (callId: string, name: string, args: Record<string, unknown>) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  }],
});

const expectedFinal = (task: CorpusTask): string =>
  task.oracle.kind === 'exact_text' ? task.oracle.expected : JSON.stringify(task.oracle.expected);

const expectedTool = (
  task: CorpusTask,
  round: number,
): { name: string; args: Record<string, unknown> } => {
  const objectKey = task.id.includes('.lint.') ? 'lint' : 'fmt';
  if (task.category === 'character_count') {
    return {
      name: 'character_count',
      args: { text: task.id.includes('naive') ? 'naïve' : 'Henji 🐣' },
    };
  }
  if (task.category === 'count_json_array_items') {
    return {
      name: 'count_json_array_items',
      args: {
        json: task.id.includes('.simple.') ? '[1,2,3]' : '[["a","b"],{"x":1},false,null]',
      },
    };
  }
  if (
    task.category === 'list_json_object_keys' || (task.category === 'multi_tool' && round === 0)
  ) {
    return { name: 'list_json_object_keys', args: { path: 'deno.v0.json', objectKey } };
  }
  if (task.category === 'multi_tool') {
    return {
      name: 'count_json_array_items',
      args: {
        json: objectKey === 'fmt' ? '["lineWidth","semiColons","singleQuote"]' : '["rules"]',
      },
    };
  }
  return {
    name: 'uppercase_text',
    args: { text: task.id.includes('.unicode.') ? 'Straße café' : 'Henji harness' },
  };
};

const readCorpus = async () =>
  await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));

const fakeProvider = (
  tasks: readonly CorpusTask[],
  calls: FetchCall[],
  wrongTaskId?: string,
): typeof fetch => {
  const byPrompt = new Map(tasks.map((task) => [task.prompt, task]));
  return (input, init) => {
    calls.push({ input, init });
    assertEquals(input, ENDPOINT);
    assertEquals(init?.method, 'POST');
    assertEquals(init?.redirect, 'error');
    assertEquals(init?.headers, {
      'content-type': 'application/json',
      authorization: `Bearer ${DUMMY_CREDENTIAL}`,
    });
    assert(typeof init?.body === 'string');
    const body = JSON.parse(init.body) as {
      model: string;
      stream: boolean;
      max_completion_tokens: number;
      messages: { role: string; content: string | null }[];
      tools: { type: string; function: { name: string } }[];
    };
    assertEquals(body.model, 'google/gemini-3.7-flash');
    assertEquals(body.stream, false);
    assertEquals(body.max_completion_tokens, 1024);
    assertEquals(body.tools.map((tool) => tool.function.name), [
      'character_count',
      'count_json_array_items',
      'list_json_object_keys',
      'submit_json_result',
      'uppercase_text',
    ]);
    const task = byPrompt.get(body.messages[0]?.content ?? '');
    assert(task !== undefined, 'provider received an unknown canonical prompt');
    const assistantCount = body.messages.filter((message) => message.role === 'assistant').length;
    const requiredRounds = task.category === 'final_only'
      ? 0
      : task.category === 'multi_tool'
      ? 2
      : 1;
    if (assistantCount < requiredRounds) {
      const call = expectedTool(task, assistantCount);
      return Promise.resolve(
        response(toolPayload(`call-${assistantCount + 1}`, call.name, call.args)),
      );
    }
    if (task.oracle.kind === 'json_value') {
      return Promise.resolve(response(toolPayload(
        `call-${assistantCount + 1}`,
        'submit_json_result',
        { json: task.id === wrongTaskId ? 'wrong live answer' : expectedFinal(task) },
      )));
    }
    return Promise.resolve(
      response(finalPayload(task.id === wrongTaskId ? 'wrong live answer' : expectedFinal(task))),
    );
  };
};

const expectError = async (operation: () => Promise<unknown>, code: string): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof LiveCorpusEvalError);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const freshFactories = (models: Model[], registries: Registry[]) => ({
  createRegistry: () => {
    const registry = createRuntimeRegistry();
    registries.push(registry);
    return registry;
  },
  createModel: (options: ConstructorParameters<typeof OpenRouterAgentModel>[0]) => {
    const model = new OpenRouterAgentModel(options);
    models.push(model);
    return model;
  },
});

Deno.test('sentinel uses exact six cases, twelve external requests, and real composition', async () => {
  const corpus = await readCorpus();
  const calls: FetchCall[] = [];
  const models: Model[] = [];
  const registries: Registry[] = [];
  const report = await runLiveCorpusEval('sentinel', {
    fetcher: fakeProvider(corpus.tasks, calls),
    credential: DUMMY_CREDENTIAL,
    ...freshFactories(models, registries),
  });
  assertEquals(report.suite, 'sentinel_v1');
  assertEquals(report.requestCeiling, 12);
  assertEquals(report.externalRequests, 12);
  assertEquals(report.counts, {
    total: 6,
    completed: 6,
    passed: 6,
    failed: 0,
    errors: 0,
    notRun: 0,
  });
  assertEquals(report.results.map((result) => result.taskId), [
    'v1.character-count.henji-chick.explicit',
    'v1.count-json-array-items.complex.explicit',
    'v1.final-only.echo',
    'v1.list-json-object-keys.fmt.explicit',
    'v1.multi-tool.fmt.explicit',
    'v1.uppercase-text.ascii.explicit',
  ]);
  assertEquals(calls.length, 12);
  assertEquals(models.length, 6);
  assertEquals(registries.length, 6);
  assertEquals(new Set(models).size, 6);
  assertEquals(new Set(registries).size, 6);
  assertEquals(
    report.results.map((result) => result.status === 'passed' ? result.requestCount : -1),
    [2, 2, 1, 2, 3, 2],
  );
});

Deno.test('canonical is fixed at 24 cases and 48 requests with fresh per-case state', async () => {
  const corpus = await readCorpus();
  const calls: FetchCall[] = [];
  const models: Model[] = [];
  const registries: Registry[] = [];
  const report = await runLiveCorpusEval('canonical', {
    fetcher: fakeProvider(corpus.tasks, calls),
    credential: DUMMY_CREDENTIAL,
    ...freshFactories(models, registries),
  });
  assertEquals(report.requestCeiling, 48);
  assertEquals(report.externalRequests, 48);
  assertEquals(report.counts, {
    total: 24,
    completed: 24,
    passed: 24,
    failed: 0,
    errors: 0,
    notRun: 0,
  });
  assertEquals(calls.length, 48);
  assertEquals(models.length, 24);
  assertEquals(registries.length, 24);
  assertEquals(new Set(models).size, 24);
  assertEquals(new Set(registries).size, 24);
});

Deno.test('scored failure continues and provider failures abort with a canonical not-run suffix', async () => {
  const corpus = await readCorpus();
  const calls: FetchCall[] = [];
  const failed = await runLiveCorpusEval('sentinel', {
    fetcher: fakeProvider(corpus.tasks, calls, 'v1.final-only.echo'),
    credential: DUMMY_CREDENTIAL,
  });
  assertEquals(failed.completion.status, 'completed');
  assertEquals(failed.counts, {
    total: 6,
    completed: 6,
    passed: 5,
    failed: 1,
    errors: 0,
    notRun: 0,
  });
  assert(
    failed.results.some((result) =>
      result.taskId === 'v1.final-only.echo' && result.status === 'failed'
    ),
  );

  const providerCalls: FetchCall[] = [];
  const aborted = await runLiveCorpusEval('sentinel', {
    fetcher: () => Promise.resolve(response({ error: 'PROVIDER_BODY_MARKER' }, 429)),
    credential: DUMMY_CREDENTIAL,
  });
  assertEquals(aborted.completion, {
    status: 'aborted',
    abortCode: 'provider_http_error',
    abortTaskId: 'v1.character-count.henji-chick.explicit',
  });
  assertEquals(aborted.counts, {
    total: 6,
    completed: 0,
    passed: 0,
    failed: 0,
    errors: 1,
    notRun: 5,
  });
  assertEquals(aborted.results[0], {
    taskId: 'v1.character-count.henji-chick.explicit',
    status: 'error',
    errorCode: 'provider_http_error',
    externalRequests: 1,
  });
  assert(aborted.results.slice(1).every((result) => result.status === 'not_run'));
  assert(!JSON.stringify(aborted).includes('PROVIDER_BODY_MARKER'));
  assert(!JSON.stringify(aborted).includes(DUMMY_CREDENTIAL));
  assertEquals(providerCalls.length, 0);
});

Deno.test('provider failure taxonomy aborts at the first case without a second request', async () => {
  const invalidInput = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    createRegistry: () =>
      new Registry([{
        name: 'broken',
        description: 'broken tool definition',
        inputSchema: undefined as never,
        execute: () => 'unused',
      }]),
    fetcher: () => {
      throw new Error('invalid input must not fetch');
    },
  });
  assertEquals(invalidInput.completion.abortCode, 'provider_invalid_input');
  assertEquals(invalidInput.externalRequests, 0);

  const missingCredential = await runLiveCorpusEval('sentinel', {
    credentialSource: () => undefined,
    fetcher: () => {
      throw new Error('missing credential must not fetch');
    },
  });
  assertEquals(missingCredential.completion.abortCode, 'provider_missing_credential');
  assertEquals(missingCredential.externalRequests, 0);

  const transport = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    fetcher: () => Promise.reject(new Error('transport marker')),
  });
  assertEquals(transport.completion.abortCode, 'provider_transport_error');
  assertEquals(transport.externalRequests, 1);

  const responseFailure = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    fetcher: () => Promise.resolve(response({ choices: [] })),
  });
  assertEquals(responseFailure.completion.abortCode, 'provider_response_error');
  assertEquals(responseFailure.externalRequests, 1);

  const limitFailure = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    createRegistry: () =>
      new Registry([{
        name: 'oversized',
        description: 'x'.repeat(300 * 1024),
        inputSchema: {},
        execute: () => 'unused',
      }]),
    fetcher: () => {
      throw new Error('limit must not fetch');
    },
  });
  assertEquals(limitFailure.completion.abortCode, 'provider_limit_exceeded');
  assertEquals(limitFailure.externalRequests, 0);
  for (
    const report of [invalidInput, missingCredential, transport, responseFailure, limitFailure]
  ) {
    assertEquals(report.counts.errors, 1);
    assert(report.results.slice(1).every((result) => result.status === 'not_run'));
  }
});

Deno.test('aggregate ceiling blocks the next delegate fetch at the exact sentinel boundary', async () => {
  const corpus = await readCorpus();
  let delegateCalls = 0;
  const finalOutcome = (taskPrompt: string, steps: number): LoopOutcome => {
    const transcript: LoopOutcome['transcript'][number][] = [
      { role: 'user', content: { kind: 'text', text: taskPrompt } },
    ];
    for (let index = 0; index < steps - 1; index += 1) {
      const callId = `call-${index + 1}`;
      transcript.push({
        role: 'assistant',
        content: [{ kind: 'tool_call', callId, name: 'uppercase_text', arguments: { text: 'x' } }],
      });
      transcript.push({
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId,
          name: 'uppercase_text',
          text: 'X',
          outcome: 'success',
        }],
      });
    }
    transcript.push({ role: 'assistant', content: { kind: 'text', text: 'unused' } });
    return {
      ok: true,
      task: taskPrompt,
      outcome: 'final',
      stopReason: 'final',
      finalText: 'unused',
      steps,
      toolCallCount: steps - 1,
      toolResultCount: steps - 1,
      transcript,
    };
  };
  const report = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    fetcher: () => {
      delegateCalls += 1;
      return Promise.resolve(response(finalPayload('unused')));
    },
    runLoop: async (task, model, registry) => {
      const taskEntry = corpus.tasks.find((entry) => entry.prompt === task)!;
      const attempts = taskEntry.id === 'v1.uppercase-text.ascii.explicit'
        ? taskEntry.maxRequests + 1
        : taskEntry.maxRequests;
      for (let index = 0; index < attempts; index += 1) {
        await model.generate({
          transcript: [{ role: 'user', content: { kind: 'text', text: task } }],
          tools: registry.definitions(),
        });
      }
      return finalOutcome(task, taskEntry.maxRequests);
    },
  });
  assertEquals(delegateCalls, 12);
  assertEquals(report.externalRequests, 12);
  assertEquals(report.completion, {
    status: 'aborted',
    abortCode: 'external_request_ceiling',
    abortTaskId: 'v1.uppercase-text.ascii.explicit',
  });
  assertEquals(report.results[5], {
    taskId: 'v1.uppercase-text.ascii.explicit',
    status: 'error',
    errorCode: 'external_request_ceiling',
    externalRequests: 2,
  });
});

Deno.test('all preflight work completes before model, registry, credential, or fetch activity', async () => {
  let models = 0;
  let registries = 0;
  let credentials = 0;
  let fetches = 0;
  await expectError(() =>
    runLiveCorpusEval('canonical', {
      fixtureReader: () => Promise.resolve('{}'),
      credentialSource: () => {
        credentials += 1;
        return DUMMY_CREDENTIAL;
      },
      fetcher: () => {
        fetches += 1;
        return Promise.reject(new Error('fetch must not start'));
      },
      createRegistry: () => {
        registries += 1;
        return createRuntimeRegistry();
      },
      createModel: () => {
        models += 1;
        return { generate: () => ({ kind: 'final', text: 'unused' }) };
      },
    }), 'corpus_preflight_failed');
  assertEquals({ models, registries, credentials, fetches }, {
    models: 0,
    registries: 0,
    credentials: 0,
    fetches: 0,
  });
});

Deno.test('loop, transcript, and score infrastructure failures abort without guessing provider errors', async () => {
  const corpus = await readCorpus();
  const invalidReport = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    runLoop: () => Promise.resolve({ invalid: true } as unknown as LoopOutcome),
  });
  assertEquals(invalidReport.completion.abortCode, 'loop_outcome_invalid');
  assertEquals(invalidReport.results[0].status, 'error');

  const malformed: LoopOutcome = {
    ok: true,
    task: corpus.tasks[0].prompt,
    outcome: 'final',
    stopReason: 'final',
    finalText: '{}',
    steps: 1,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [{ role: 'user', content: { kind: 'text', text: 'wrong prompt' } }, {
      role: 'assistant',
      content: { kind: 'text', text: '{}' },
    }],
  };
  const report = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    runLoop: () => Promise.resolve(malformed),
  });
  assertEquals(report.completion.abortCode, 'transcript_malformed');
  assertEquals(report.results[0].status, 'error');

  const mapperContractFailure = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    runLoop: () =>
      Promise.resolve({
        ...malformed,
        transcript: [
          { role: 'user', content: { kind: 'text', text: corpus.tasks[0].prompt } },
          malformed.transcript[1],
        ],
        steps: 2,
      }),
  });
  assertEquals(mapperContractFailure.completion.abortCode, 'loop_outcome_invalid');

  const loopContractFailure = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    runLoop: (task) =>
      Promise.resolve({
        ok: false,
        task,
        outcome: 'contract_failure',
        stopReason: 'contract_failure',
        error: 'generic loop contract failure',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [{ role: 'user', content: { kind: 'text', text: task } }],
      }),
  });
  assertEquals(loopContractFailure.completion.abortCode, 'loop_contract_failure');

  const loopMaxSteps = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    runLoop: (task, _model, _registry, options) =>
      Promise.resolve({
        ok: false,
        task,
        outcome: 'max_steps',
        stopReason: 'max_steps',
        steps: options?.maxSteps ?? 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [{ role: 'user', content: { kind: 'text', text: task } }],
      }),
  });
  assertEquals(loopMaxSteps.completion.abortCode, 'loop_max_steps');

  const scoreContractFailure = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    scoreObservation: () => {
      throw new Error('score contract marker');
    },
    runLoop: (task) =>
      Promise.resolve({
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'unused',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [
          { role: 'user', content: { kind: 'text', text: task } },
          { role: 'assistant', content: { kind: 'text', text: 'unused' } },
        ],
      }),
  });
  assertEquals(scoreContractFailure.completion.abortCode, 'score_contract_invalid');
});

Deno.test('strict report round-trip and fixed CLI channels expose no forbidden fields', async () => {
  const corpus = await readCorpus();
  const report = await runLiveCorpusEval('sentinel', {
    fetcher: fakeProvider(corpus.tasks, []),
    credential: DUMMY_CREDENTIAL,
  });
  const serialized = serializeLiveCorpusEvalReport(report, corpus);
  assert(serialized.endsWith('\n'));
  assertEquals(validateLiveCorpusEvalReport(JSON.parse(serialized), corpus), report);
  for (
    const forbidden of [
      'timestamp',
      'duration',
      'usage',
      'tokens',
      'cost',
      'rate',
      'ranking',
      'transcript',
    ]
  ) {
    assert(!serialized.includes(`"${forbidden}"`), `forbidden report field ${forbidden}`);
  }
  const invalid = JSON.parse(serialized) as Record<string, unknown>;
  invalid.extra = true;
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(invalid, corpus)),
    'report_contract_invalid',
  );
  const externalCountDrift = clone(report) as unknown as Record<string, unknown>;
  externalCountDrift.externalRequests = 0;
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(externalCountDrift, corpus)),
    'report_contract_invalid',
  );
  const submissionOrdinalDrift = clone(report) as unknown as Record<string, unknown>;
  const multiResult = (submissionOrdinalDrift.results as Record<string, unknown>[]).find((result) =>
    result.taskId === 'v1.multi-tool.fmt.explicit'
  )!;
  (multiResult.submission as Record<string, unknown>).requestOrdinal = 1;
  await expectError(
    () =>
      Promise.resolve().then(() => validateLiveCorpusEvalReport(submissionOrdinalDrift, corpus)),
    'report_contract_invalid',
  );

  const failedReport = await runLiveCorpusEval('sentinel', {
    fetcher: fakeProvider(corpus.tasks, [], 'v1.final-only.echo'),
    credential: DUMMY_CREDENTIAL,
  });
  const abortedReport = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    fetcher: () => Promise.resolve(response({ choices: [] })),
  });
  const countDrift = clone(failedReport) as unknown as Record<string, unknown>;
  (countDrift.counts as Record<string, unknown>).failed = 0;
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(countDrift, corpus)),
    'report_contract_invalid',
  );
  const suffixDrift = clone(abortedReport) as unknown as Record<string, unknown>;
  (suffixDrift.completion as Record<string, unknown>).abortTaskId = 'v1.final-only.echo';
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(suffixDrift, corpus)),
    'report_contract_invalid',
  );
  const duplicateError = clone(abortedReport) as unknown as Record<string, unknown>;
  (duplicateError.results as Record<string, unknown>[])[1] = {
    taskId: 'v1.count-json-array-items.complex.explicit',
    status: 'error',
    errorCode: 'provider_response_error',
    externalRequests: 0,
  };
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(duplicateError, corpus)),
    'report_contract_invalid',
  );
  const prefixNotRun = clone(abortedReport) as unknown as Record<string, unknown>;
  (prefixNotRun.results as Record<string, unknown>[])[0] = {
    taskId: 'v1.character-count.henji-chick.explicit',
    status: 'not_run',
    errorCode: 'run_aborted',
  };
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(prefixNotRun, corpus)),
    'report_contract_invalid',
  );

  const delayedAbortTask = corpus.tasks.find((task) =>
    task.id === 'v1.count-json-array-items.complex.explicit'
  )!;
  const delayedCalls: FetchCall[] = [];
  const baseFetcher = fakeProvider(corpus.tasks, delayedCalls);
  const delayedAbort = await runLiveCorpusEval('sentinel', {
    credential: DUMMY_CREDENTIAL,
    fetcher: (input, init) => {
      assert(typeof init?.body === 'string');
      const body = JSON.parse(init.body) as { messages: { content: string | null }[] };
      if (body.messages[0]?.content === delayedAbortTask.prompt) {
        throw new Error('delayed provider failure');
      }
      return baseFetcher(input, init);
    },
  });
  assertEquals(delayedAbort.completion, {
    status: 'aborted',
    abortCode: 'provider_transport_error',
    abortTaskId: delayedAbortTask.id,
  });
  assertEquals(delayedAbort.results[0].status, 'passed');
  const delayedPrefixDrift = clone(delayedAbort) as unknown as Record<string, unknown>;
  const delayedResults = delayedPrefixDrift.results as Record<string, unknown>[];
  const firstPassed = delayedResults[0];
  assert(firstPassed.status === 'passed');
  delayedResults[0] = {
    taskId: firstPassed.taskId,
    status: 'not_run',
    errorCode: 'run_aborted',
  };
  const delayedCounts = delayedPrefixDrift.counts as Record<string, unknown>;
  delayedCounts.completed = (delayedCounts.completed as number) - 1;
  delayedCounts.passed = (delayedCounts.passed as number) - 1;
  delayedCounts.notRun = (delayedCounts.notRun as number) + 1;
  delayedPrefixDrift.externalRequests = (delayedPrefixDrift.externalRequests as number) -
    (firstPassed.requestCount as number);
  await expectError(
    () => Promise.resolve().then(() => validateLiveCorpusEvalReport(delayedPrefixDrift, corpus)),
    'report_contract_invalid',
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await liveCliMain(['sentinel'], {
    run: () => Promise.resolve(report),
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 0);
  assertEquals(stderr, []);
  assertEquals(JSON.parse(stdout[0]), report);

  const failedStdout: string[] = [];
  const failedStderr: string[] = [];
  assertEquals(
    await liveCliMain(['sentinel'], {
      run: () => Promise.resolve(failedReport),
      writeStdout: (text) => {
        failedStdout.push(text);
      },
      writeStderr: (text) => {
        failedStderr.push(text);
      },
    }),
    1,
  );
  assertEquals(JSON.parse(failedStdout[0]), failedReport);
  assertEquals(failedStderr, []);

  const abortedStdout: string[] = [];
  const abortedStderr: string[] = [];
  assertEquals(
    await liveCliMain(['sentinel'], {
      run: () => Promise.resolve(abortedReport),
      writeStdout: (text) => {
        abortedStdout.push(text);
      },
      writeStderr: (text) => {
        abortedStderr.push(text);
      },
    }),
    1,
  );
  assertEquals(JSON.parse(abortedStdout[0]), abortedReport);
  assertEquals(abortedStderr, []);
  const invalidStdout: string[] = [];
  const invalidStderr: string[] = [];
  assertEquals(
    await liveCliMain(['other'], {
      writeStdout: (text) => {
        invalidStdout.push(text);
      },
      writeStderr: (text) => {
        invalidStderr.push(text);
      },
    }),
    1,
  );
  assertEquals(invalidStdout, []);
  assertEquals(JSON.parse(invalidStderr[0]), {
    schemaVersion: 1,
    errorCode: 'report_contract_invalid',
  });
});

Deno.test('CLI byte writers retry partial writes until the complete line is emitted', async () => {
  const expected = new TextEncoder().encode('partial-write-marker\n');
  const actual: number[] = [];
  let calls = 0;
  await writeAllLiveCorpusBytes((chunk) => {
    calls += 1;
    const amount = Math.min(2, chunk.byteLength);
    actual.push(...chunk.subarray(0, amount));
    return amount;
  }, expected);
  assertEquals(actual, [...expected]);
  assert(calls > 1);
});

Deno.test('focused task has no host env/network/write/run permission and offline v2 contract is strict', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    tasks: Record<string, string>;
  };
  const focusedCommand = config.tasks['agent:corpus:eval:live:test'];
  assert(focusedCommand.includes('--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json'));
  for (const forbidden of ['--allow-env', '--allow-net', '--allow-write', '--allow-run']) {
    assert(!focusedCommand.includes(forbidden), `focused task grants ${forbidden}`);
  }
  const gateCommand = config.tasks['v0:gate'];
  for (
    const forbidden of [
      'agent:run',
      'agent:acceptance',
      'agent:corpus:eval:live:sentinel',
      'agent:corpus:eval:live:canonical',
    ]
  ) {
    const taskBoundary = new RegExp(`(?:^|[\\s;&])${forbidden}(?:\\s|$)`);
    assert(!taskBoundary.test(gateCommand), `v0:gate reaches ${forbidden}`);
  }
  const offline = await runOfflineCorpusEval();
  assertEquals(offline.reportId, 'henji-offline-corpus-eval-v2');
  assertEquals(offline.mode, 'offline_scripted');
  assertEquals(offline.counts, { total: 24, completed: 24, passed: 24, failed: 0 });
  const stdout: string[] = [];
  assertEquals(
    await offlineCliMain([], {
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: () => undefined,
    }),
    0,
  );
  assertEquals(JSON.parse(stdout[0]).reportId, 'henji-offline-corpus-eval-v2');
});
