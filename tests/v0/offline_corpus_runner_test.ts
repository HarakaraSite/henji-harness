import { assert, assertEquals } from './test_helpers.ts';
import { CORPUS_PATH, type CorpusTask, loadTaskCorpus } from '../../v0/corpus/task_corpus.ts';
import {
  type LoopOutcome,
  type Model,
  type ModelRequest,
  type ToolCall,
} from '../../v0/agent/contracts.ts';
import { FixtureModelContractError } from '../../v0/agent/fixture_model.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { createRuntimeRegistry } from '../../v0/agent/runtime.ts';
import { Registry } from '../../v0/agent/tools.ts';
import {
  assertScriptedCorpusTaskSet,
  createScriptedCorpusModel,
} from '../../v0/eval/scripted_corpus_model.ts';
import {
  observationFromLoopOutcome,
  OfflineCorpusEvalError,
  type OfflineRunnerFailureCode,
  runOfflineCorpusEval,
  serializeOfflineCorpusEvalReport,
  validateOfflineCorpusEvalReport,
} from '../../v0/eval/offline_corpus_runner.ts';
import { main as offlineCliMain } from '../../v0/eval/offline_corpus_cli.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectSyncCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof OfflineCorpusEvalError, 'unexpected error type');
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const expectSyncThrow = (fn: () => unknown, errorType: new (...args: never[]) => Error): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof errorType, 'unexpected error type');
    return;
  }
  throw new Error('expected throw');
};

const expectAsyncCode = async (fn: () => Promise<unknown>, code: string): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof OfflineCorpusEvalError, 'unexpected error type');
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const finalModel = (text: string): Model => ({
  generate: () => ({ kind: 'final', text }),
});

const userMessage = (task: CorpusTask) => ({
  role: 'user' as const,
  content: { kind: 'text' as const, text: task.prompt },
});

const oneRoundOutcome = (
  task: CorpusTask,
  finalText: string,
  callId = 'call-1',
  callName = 'uppercase_text',
  resultText = 'HENJI HARNESS',
): LoopOutcome => ({
  ok: true,
  task: task.prompt,
  outcome: 'final',
  stopReason: 'final',
  finalText,
  steps: 2,
  toolCallCount: 1,
  toolResultCount: 1,
  transcript: [
    userMessage(task),
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId,
        name: callName,
        arguments: { text: 'Henji harness' },
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId,
        name: callName,
        text: resultText,
        outcome: 'success',
      }],
    },
    { role: 'assistant', content: { kind: 'text', text: finalText } },
  ],
});

const runWithRealLoop = async (
  task: string,
  model: Model,
  registry: Registry,
  options: Parameters<typeof runAgent>[3],
): Promise<LoopOutcome> => await runAgent(task, model, registry, options);

const readCorpus = async () =>
  await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));

Deno.test('offline runner executes all 24 scripted cases in canonical order', async () => {
  const report = await runOfflineCorpusEval();
  assertEquals(report.completion, {
    status: 'completed',
    abortCode: null,
    abortTaskId: null,
  });
  assertEquals(report.counts, { total: 24, completed: 24, passed: 24, failed: 0 });
  const corpus = await readCorpus();
  assertEquals(report.results.map((result) => result.taskId), corpus.tasks.map((task) => task.id));
  assert(report.results.every((result) => result.status === 'passed'));
});

Deno.test('observation mapping uses zero-based rounds and strict report serialization', async () => {
  const corpus = await readCorpus();
  const report = await runOfflineCorpusEval();
  const multiTask = corpus.tasks.find((task) => task.id === 'v1.multi-tool.fmt.explicit')!;
  const multiResult = report.results.find((result) => result.taskId === multiTask.id)!;
  assert(multiResult.status === 'passed');
  assertEquals(multiResult.toolEvents.map((event) => event.requestOrdinal), [0, 1]);

  const roundTrip = JSON.parse(serializeOfflineCorpusEvalReport(report, corpus));
  assertEquals(roundTrip, report);
  assertEquals(validateOfflineCorpusEvalReport(roundTrip, corpus), report);
  const serialized = serializeOfflineCorpusEvalReport(report, corpus);
  assert(serialized.endsWith('\n'));
  assert(!serialized.slice(0, -1).includes('\n'));
  for (const forbidden of ['timestamp', 'duration', 'tokens', 'cost', 'rate', 'ranking']) {
    assert(!serialized.includes(forbidden), `report contains forbidden field ${forbidden}`);
  }

  const singleTask = corpus.tasks.find((task) => task.id === 'v1.uppercase-text.ascii.explicit')!;
  const singleResult = report.results.find((result) => result.taskId === singleTask.id)!;
  assert(singleResult.status === 'passed');
  const mapped = observationFromLoopOutcome(singleTask, {
    ok: true,
    task: singleTask.prompt,
    outcome: 'final',
    stopReason: 'final',
    finalText: singleResult.finalText,
    steps: singleResult.requestCount,
    toolCallCount: singleResult.toolEvents.length,
    toolResultCount: singleResult.toolEvents.length,
    transcript: [
      { role: 'user', content: { kind: 'text', text: singleTask.prompt } },
      {
        role: 'assistant',
        content: [{
          kind: 'tool_call',
          callId: 'call-1',
          name: 'uppercase_text',
          arguments: { text: 'Henji harness' },
        }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'call-1',
          name: 'uppercase_text',
          text: 'HENJI HARNESS',
          outcome: 'success',
        }],
      },
      { role: 'assistant', content: { kind: 'text', text: 'HENJI HARNESS' } },
    ],
  });
  assertEquals(mapped.requestCount, 2);
  assertEquals(mapped.toolEvents[0].requestOrdinal, 0);
});

Deno.test('script table has the exact corpus ID set and enforces prompt/tools/exhaustion', async () => {
  const corpus = await readCorpus();
  const taskIds = corpus.tasks.map((task) => task.id);
  assertScriptedCorpusTaskSet(taskIds);
  expectSyncThrow(() => assertScriptedCorpusTaskSet(taskIds.slice(1)), FixtureModelContractError);
  expectSyncThrow(
    () => assertScriptedCorpusTaskSet([...taskIds, 'v1.extra.task']),
    FixtureModelContractError,
  );
  const duplicate = [...taskIds];
  duplicate[1] = duplicate[0];
  expectSyncThrow(() => assertScriptedCorpusTaskSet(duplicate), FixtureModelContractError);

  const task = corpus.tasks.find((entry) => entry.id === 'v1.uppercase-text.ascii.explicit')!;
  expectSyncThrow(
    () => createScriptedCorpusModel({ ...task, id: 'v1.unknown.task' }),
    FixtureModelContractError,
  );
  expectSyncThrow(
    () => createScriptedCorpusModel({ ...task, prompt: 'changed prompt' }),
    FixtureModelContractError,
  );
  const model = createScriptedCorpusModel(task);
  const registry = createRuntimeRegistry();
  const firstRequest: ModelRequest = {
    transcript: [userMessage(task)],
    tools: registry.definitions(),
  };
  model.generate(firstRequest);
  expectSyncThrow(
    () =>
      model.generate({
        ...firstRequest,
        tools: [...firstRequest.tools, { name: 'unknown_tool', description: 'x', inputSchema: {} }],
      }),
    FixtureModelContractError,
  );
  const finalModelInstance = createScriptedCorpusModel(
    corpus.tasks.find((entry) => entry.id === 'v1.final-only.echo')!,
  );
  const finalTask = corpus.tasks.find((entry) => entry.id === 'v1.final-only.echo')!;
  const finalRequest: ModelRequest = {
    transcript: [userMessage(finalTask)],
    tools: registry.definitions(),
  };
  finalModelInstance.generate(finalRequest);
  expectSyncThrow(() => finalModelInstance.generate(finalRequest), FixtureModelContractError);
});

Deno.test('scripted model checks every preceding result in a sequential multi-tool task', async () => {
  const corpus = await readCorpus();
  const task = corpus.tasks.find((entry) => entry.id === 'v1.multi-tool.fmt.explicit')!;
  const registry = createRuntimeRegistry();
  const firstRequest: ModelRequest = {
    transcript: [userMessage(task)],
    tools: registry.definitions(),
  };
  const firstModel = createScriptedCorpusModel(task);
  const firstResult = firstModel.generate(firstRequest) as {
    kind: 'tool_calls';
    calls: readonly ToolCall[];
  };
  assert(firstResult.kind === 'tool_calls');
  const firstCall = firstResult.calls[0];
  const firstAssistant = {
    role: 'assistant' as const,
    content: [{ kind: 'tool_call' as const, ...firstCall }],
  };
  const validToolResult = {
    role: 'tool' as const,
    content: [{
      kind: 'tool_result' as const,
      callId: firstCall.callId,
      name: firstCall.name,
      text: '["lineWidth","semiColons","singleQuote"]',
      outcome: 'success' as const,
    }],
  };
  const validSecond = firstModel.generate({
    ...firstRequest,
    transcript: [userMessage(task), firstAssistant, validToolResult],
  }) as { kind: 'tool_calls'; calls: readonly ToolCall[] };
  assert(validSecond.kind === 'tool_calls');

  for (
    const [field, value] of [
      ['callId', 'other-call'],
      ['name', 'uppercase_text'],
      ['text', 'wrong result'],
      ['outcome', 'error'],
    ] as const
  ) {
    const model = createScriptedCorpusModel(task);
    const first = model.generate(firstRequest) as {
      kind: 'tool_calls';
      calls: readonly ToolCall[];
    };
    assert(first.kind === 'tool_calls');
    const call = first.calls[0];
    const assistant = {
      role: 'assistant' as const,
      content: [{ kind: 'tool_call' as const, ...call }],
    };
    const result = clone(validToolResult);
    (result.content[0] as Record<string, unknown>)[field] = value;
    expectSyncThrow(
      () =>
        model.generate({
          ...firstRequest,
          transcript: [userMessage(task), assistant, result],
        }),
      FixtureModelContractError,
    );
  }
});

Deno.test('runner constructs fresh model and registry state for every canonical case', async () => {
  const models: Model[] = [];
  const registries: Registry[] = [];
  const outcomes: LoopOutcome[] = [];
  const report = await runOfflineCorpusEval({
    createCaseDependencies: (task) => {
      const model = createScriptedCorpusModel(task);
      const registry = createRuntimeRegistry();
      models.push(model);
      registries.push(registry);
      return { model, registry };
    },
    runLoop: async (task, model, registry, options) => {
      const outcome = await runWithRealLoop(task, model, registry, options);
      outcomes.push(outcome);
      return outcome;
    },
  });
  assertEquals(report.counts, { total: 24, completed: 24, passed: 24, failed: 0 });
  assertEquals(models.length, 24);
  assertEquals(registries.length, 24);
  assertEquals(new Set(models).size, 24);
  assertEquals(new Set(registries).size, 24);
  assertEquals(outcomes.length, 24);
  for (const outcome of outcomes) {
    const firstToolCall = outcome.transcript.find((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
    );
    if (firstToolCall?.role === 'assistant' && Array.isArray(firstToolCall.content)) {
      assertEquals(firstToolCall.content[0].callId, 'call-1');
    }
  }
});

Deno.test('ordinary score failures are case-local while later cases continue', async () => {
  const corpus = await readCorpus();
  const wrongTaskId = 'v1.final-only.echo';
  const forbiddenTaskId = 'v1.final-only.json';
  const report = await runOfflineCorpusEval({
    createCaseDependencies: (task) => ({
      model: createScriptedCorpusModel(task),
      registry: createRuntimeRegistry(),
    }),
    runLoop: async (task, model, registry, options) => {
      if (task === corpus.tasks.find((entry) => entry.id === wrongTaskId)?.prompt) {
        return await runAgent(task, finalModel('wrong answer'), registry, options);
      }
      if (task === corpus.tasks.find((entry) => entry.id === forbiddenTaskId)?.prompt) {
        const target = corpus.tasks.find((entry) => entry.id === forbiddenTaskId)!;
        return oneRoundOutcome(
          target,
          target.oracle.kind === 'exact_text'
            ? target.oracle.expected
            : '{"status":"ready","version":1}',
        );
      }
      return await runAgent(task, model, registry, options);
    },
  });
  assertEquals(report.completion.status, 'completed');
  assertEquals(report.counts, { total: 24, completed: 24, passed: 22, failed: 2 });
  const wrong = report.results.find((result) => result.taskId === wrongTaskId)!;
  const forbidden = report.results.find((result) => result.taskId === forbiddenTaskId)!;
  assert(wrong.status === 'failed');
  assert(forbidden.status === 'failed');
  assert(forbidden.score.failureCodes.includes('tool_forbidden'));
  const later = report.results.slice(
    report.results.findIndex((result) => result.taskId === forbiddenTaskId) + 1,
  );
  assert(later.every((result) => result.status === 'passed'));
});

Deno.test('dependency, loop, contract, max-step, and transcript failures abort with not-run suffix', async () => {
  const corpus = await readCorpus();
  const firstTask = corpus.tasks[0];
  const validFinal = (task: CorpusTask): LoopOutcome => ({
    ok: true,
    task: task.prompt,
    outcome: 'final',
    stopReason: 'final',
    finalText: 'unused',
    steps: 1,
    toolCallCount: 0,
    toolResultCount: 0,
    transcript: [userMessage(task), {
      role: 'assistant',
      content: { kind: 'text', text: 'unused' },
    }],
  });
  const withoutFinalText = (task: CorpusTask): LoopOutcome => {
    const value = clone(validFinal(task)) as unknown as Record<string, unknown>;
    delete value.finalText;
    return value as unknown as LoopOutcome;
  };
  const cases: readonly [
    OfflineRunnerFailureCode,
    (task: CorpusTask) => { readonly model: Model; readonly registry: Registry },
    (
      task: string,
      model: Model,
      registry: Registry,
      options: Parameters<typeof runAgent>[3],
    ) => Promise<LoopOutcome>,
  ][] = [
    ['dependency_construction_failed', () => {
      throw new Error('dependency');
    }, runWithRealLoop],
    [
      'case_execution_failed',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      () => Promise.reject(new Error('loop')),
    ],
    [
      'loop_contract_failure',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      (task) =>
        Promise.resolve({
          ...withoutFinalText(corpus.tasks.find((entry) => entry.prompt === task)!),
          ok: false,
          outcome: 'contract_failure',
          stopReason: 'contract_failure',
          error: 'contract',
        }),
    ],
    [
      'loop_max_steps',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      (task) =>
        Promise.resolve({
          ...withoutFinalText(corpus.tasks.find((entry) => entry.prompt === task)!),
          ok: false,
          outcome: 'max_steps',
          stopReason: 'max_steps',
        }),
    ],
    [
      'loop_outcome_invalid',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      (task) =>
        Promise.resolve({
          ...validFinal(corpus.tasks.find((entry) => entry.prompt === task)!),
          steps: 0,
        }),
    ],
    [
      'loop_outcome_invalid',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      (task) =>
        Promise.resolve({
          ...validFinal(corpus.tasks.find((entry) => entry.prompt === task)!),
          steps: 2,
        }),
    ],
    [
      'transcript_malformed',
      () => ({ model: finalModel('unused'), registry: new Registry([]) }),
      (task) =>
        Promise.resolve({
          ...validFinal(corpus.tasks.find((entry) => entry.prompt === task)!),
          transcript: [
            { role: 'user', content: { kind: 'text', text: 'wrong' } },
            ...validFinal(corpus.tasks.find((entry) => entry.prompt === task)!).transcript.slice(1),
          ],
        }),
    ],
  ];
  for (const [expectedCode, factory, loop] of cases) {
    const report = await runOfflineCorpusEval({
      createCaseDependencies: factory,
      runLoop: loop,
    });
    assertEquals(report.completion, {
      status: 'aborted',
      abortCode: expectedCode,
      abortTaskId: firstTask.id,
    });
    assertEquals(report.results[0], {
      taskId: firstTask.id,
      status: 'error',
      errorCode: expectedCode,
    });
    assertEquals(report.results.slice(1).length, 23);
    assert(report.results.slice(1).every((result) => result.status === 'not_run'));
    assertEquals(report.counts, { total: 24, completed: 0, passed: 0, failed: 0 });
  }
});

Deno.test('runner records scorer contract exceptions as score_contract_invalid', async () => {
  const corpus = await readCorpus();
  const firstTask = corpus.tasks[0];
  const report = await runOfflineCorpusEval({
    createCaseDependencies: (task) => {
      if (task.id === firstTask.id) {
        (task as unknown as Record<string, unknown>).oracle = null;
      }
      return { model: finalModel('unused'), registry: new Registry([]) };
    },
  });
  assertEquals(report.completion, {
    status: 'aborted',
    abortCode: 'score_contract_invalid',
    abortTaskId: firstTask.id,
  });
  assertEquals(report.results[0], {
    taskId: firstTask.id,
    status: 'error',
    errorCode: 'score_contract_invalid',
  });
  assert(report.results.slice(1).every((result) => result.status === 'not_run'));
});

Deno.test('corpus and fixture preflight happen before any case dependency construction', async () => {
  let constructions = 0;
  let fixtureReads = 0;
  await expectAsyncCode(
    () =>
      runOfflineCorpusEval({
        fixtureReader: () => {
          fixtureReads += 1;
          return Promise.resolve('{}');
        },
        createCaseDependencies: () => {
          constructions += 1;
          return { model: finalModel('unused'), registry: new Registry([]) };
        },
      }),
    'corpus_preflight_failed',
  );
  assertEquals(fixtureReads, 1);
  assertEquals(constructions, 0);

  constructions = 0;
  fixtureReads = 0;
  await expectAsyncCode(
    () =>
      runOfflineCorpusEval({
        fixtureReader: () => {
          fixtureReads += 1;
          return Promise.resolve(JSON.stringify({
            fmt: { lineWidth: 100, semiColons: true },
            lint: { rules: {} },
          }));
        },
        createCaseDependencies: () => {
          constructions += 1;
          return { model: finalModel('unused'), registry: new Registry([]) };
        },
      }),
    'corpus_preflight_failed',
  );
  assertEquals(fixtureReads, 1);
  assertEquals(constructions, 0);
});

Deno.test('mapper rejects malformed transcript roles, batches, correlation, terminal text, and counters', async () => {
  const corpus = await readCorpus();
  const task = corpus.tasks.find((entry) => entry.id === 'v1.uppercase-text.ascii.explicit')!;
  const outcome = await runAgent(
    task.prompt,
    createScriptedCorpusModel(task),
    createRuntimeRegistry(),
  );
  assert(outcome.ok);
  type MutableOutcome = Record<string, unknown> & { transcript: Record<string, unknown>[] };
  const mutations: readonly [string, string, (value: MutableOutcome) => void][] = [
    ['user prompt', 'transcript_malformed', (value) => {
      ((value.transcript[0].content as Record<string, unknown>).text as string) = 'wrong';
    }],
    ['user role', 'transcript_malformed', (value) => {
      value.transcript[0].role = 'assistant';
    }],
    ['message role order', 'transcript_malformed', (value) => {
      value.transcript[1].role = 'tool';
    }],
    ['empty call batch', 'transcript_malformed', (value) => {
      value.transcript[1].content = [];
    }],
    ['missing tool message', 'transcript_malformed', (value) => {
      value.transcript.splice(2, 1);
    }],
    ['result call ID mismatch', 'transcript_malformed', (value) => {
      (((value.transcript[2].content as unknown[])[0] as Record<string, unknown>).callId) = 'other';
    }],
    ['result name mismatch', 'transcript_malformed', (value) => {
      (((value.transcript[2].content as unknown[])[0] as Record<string, unknown>).name) = 'other';
    }],
    ['invalid result outcome', 'transcript_malformed', (value) => {
      (((value.transcript[2].content as unknown[])[0] as Record<string, unknown>).outcome) =
        'other';
    }],
    ['terminal text mismatch', 'transcript_malformed', (value) => {
      ((value.transcript[3].content as Record<string, unknown>).text) = 'wrong';
    }],
    ['steps counter mismatch', 'loop_outcome_invalid', (value) => {
      value.steps = 3;
    }],
    ['tool call counter mismatch', 'loop_outcome_invalid', (value) => {
      value.toolCallCount = 0;
    }],
    ['tool result counter mismatch', 'loop_outcome_invalid', (value) => {
      value.toolResultCount = 0;
    }],
  ];
  for (const [name, code, mutate] of mutations) {
    const changed = clone(outcome) as unknown as MutableOutcome;
    mutate(changed);
    try {
      observationFromLoopOutcome(task, changed as unknown as LoopOutcome);
    } catch (error) {
      assert(error instanceof OfflineCorpusEvalError, `${name}: unexpected error type`);
      assertEquals(error.code, code, name);
      continue;
    }
    throw new Error(`${name}: expected ${code}`);
  }

  const duplicate = oneRoundOutcome(task, 'HENJI HARNESS');
  const duplicateValue = clone(duplicate) as unknown as MutableOutcome;
  const firstCall = (duplicateValue.transcript[1].content as Record<string, unknown>[])[0];
  const secondCall = { ...firstCall };
  duplicateValue.transcript[1].content = [firstCall, secondCall];
  duplicateValue.transcript[2].content = [
    ...(duplicateValue.transcript[2].content as unknown[]),
    { ...((duplicateValue.transcript[2].content as unknown[])[0] as Record<string, unknown>) },
  ];
  duplicateValue.toolCallCount = 2;
  duplicateValue.toolResultCount = 2;
  expectSyncCode(
    () => observationFromLoopOutcome(task, duplicateValue as unknown as LoopOutcome),
    'transcript_malformed',
  );
});

Deno.test('round ordinals distinguish sequential rounds from same-round batches', async () => {
  const corpus = await readCorpus();
  const singleTask = corpus.tasks.find((entry) => entry.id === 'v1.uppercase-text.ascii.explicit')!;
  const singleOutcome = await runAgent(
    singleTask.prompt,
    createScriptedCorpusModel(singleTask),
    createRuntimeRegistry(),
  );
  assert(singleOutcome.ok);
  assertEquals(
    observationFromLoopOutcome(singleTask, singleOutcome).toolEvents.map((event) =>
      event.requestOrdinal
    ),
    [0],
  );

  const multiTask = corpus.tasks.find((entry) => entry.id === 'v1.multi-tool.fmt.explicit')!;
  const multiOutcome = await runAgent(
    multiTask.prompt,
    createScriptedCorpusModel(multiTask),
    createRuntimeRegistry(),
  );
  assert(multiOutcome.ok);
  assertEquals(
    observationFromLoopOutcome(multiTask, multiOutcome).toolEvents.map((event) =>
      event.requestOrdinal
    ),
    [0, 1],
  );

  const sameRound: LoopOutcome = {
    ok: true,
    task: multiTask.prompt,
    outcome: 'final',
    stopReason: 'final',
    finalText: '{"count":3}',
    steps: 2,
    toolCallCount: 2,
    toolResultCount: 2,
    transcript: [
      userMessage(multiTask),
      {
        role: 'assistant',
        content: [
          {
            kind: 'tool_call',
            callId: 'call-1',
            name: 'list_json_object_keys',
            arguments: { path: 'deno.v0.json', objectKey: 'fmt' },
          },
          {
            kind: 'tool_call',
            callId: 'call-2',
            name: 'count_json_array_items',
            arguments: { json: '[]' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            kind: 'tool_result',
            callId: 'call-1',
            name: 'list_json_object_keys',
            text: '["lineWidth","semiColons","singleQuote"]',
            outcome: 'success',
          },
          {
            kind: 'tool_result',
            callId: 'call-2',
            name: 'count_json_array_items',
            text: '{"count":3}',
            outcome: 'success',
          },
        ],
      },
      { role: 'assistant', content: { kind: 'text', text: '{"count":3}' } },
    ],
  };
  const sameObservation = observationFromLoopOutcome(multiTask, sameRound);
  assertEquals(sameObservation.toolEvents.map((event) => event.requestOrdinal), [0, 0]);
});

Deno.test('strict report validation rejects drifted fields, counts, order, partition, and scores', async () => {
  const corpus = await readCorpus();
  const report = await runOfflineCorpusEval();
  const invalid = (mutate: (value: Record<string, unknown>) => void): void => {
    const value = clone(report) as unknown as Record<string, unknown>;
    mutate(value);
    expectSyncCode(() => validateOfflineCorpusEvalReport(value, corpus), 'report_contract_invalid');
  };
  invalid((value) => {
    value.extra = true;
  });
  invalid((value) => {
    value.schemaVersion = 2;
  });
  invalid((value) => {
    value.mode = 'live';
  });
  invalid((value) => {
    (value.counts as Record<string, unknown>).total = 23;
  });
  invalid((value) => {
    (value.results as unknown[]).reverse();
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    first.status = 'error';
    first.errorCode = 'loop_contract_failure';
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    (first.score as Record<string, unknown>).taskId = 'v1.other.task';
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    first.finalText = 'retained score no longer matches';
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    first.requestCount = 3;
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    const event = (first.toolEvents as Record<string, unknown>[])[0];
    event.callName = 'uppercase_text';
    event.resultName = 'uppercase_text';
  });
  invalid((value) => {
    delete (value.results as Record<string, unknown>[])[0].finalText;
  });
  invalid((value) => {
    const first = (value.results as Record<string, unknown>[])[0];
    (first.toolEvents as Record<string, unknown>[])[0].requestOrdinal = 8;
  });
  invalid((value) => {
    (value.results as unknown[]).pop();
  });
  invalid((value) => {
    const completion = value.completion as Record<string, unknown>;
    completion.abortCode = 'run_aborted';
  });

  const aborted = await runOfflineCorpusEval({
    createCaseDependencies: () => {
      throw new Error('stop');
    },
  });
  assertEquals(validateOfflineCorpusEvalReport(aborted, corpus), aborted);
  const invalidAbort = clone(aborted) as unknown as Record<string, unknown>;
  const abortResults = invalidAbort.results as Record<string, unknown>[];
  abortResults[1].status = 'passed';
  delete abortResults[1].errorCode;
  expectSyncCode(
    () => validateOfflineCorpusEvalReport(invalidAbort, corpus),
    'report_contract_invalid',
  );
});

Deno.test('offline CLI emits one report line, returns failure for scored failures, and sanitizes fatals', async () => {
  const report = await runOfflineCorpusEval();
  let stdout = '';
  let stderr = '';
  const successExit = await offlineCliMain([], {
    run: () => Promise.resolve(report),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(successExit, 0);
  assertEquals(JSON.parse(stdout), report);
  assertEquals(stderr, '');
  assertEquals(stdout.split('\n').length, 2);

  const corpus = await readCorpus();
  const firstTask = corpus.tasks[0];
  const scoredFailure = await runOfflineCorpusEval({
    createCaseDependencies: (task) => ({
      model: createScriptedCorpusModel(task),
      registry: createRuntimeRegistry(),
    }),
    runLoop: async (task, model, registry, options) =>
      task === firstTask.prompt
        ? await runAgent(task, finalModel('wrong'), registry, options)
        : await runAgent(task, model, registry, options),
  });
  stdout = '';
  stderr = '';
  const failureExit = await offlineCliMain([], {
    run: () => Promise.resolve(scoredFailure),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(failureExit, 1);
  assertEquals(JSON.parse(stdout), scoredFailure);
  assertEquals(stderr, '');

  const abortedReport = await runOfflineCorpusEval({
    createCaseDependencies: () => {
      throw new Error('abort for CLI');
    },
  });
  stdout = '';
  stderr = '';
  const abortedExit = await offlineCliMain([], {
    run: () => Promise.resolve(abortedReport),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(abortedExit, 1);
  assertEquals(JSON.parse(stdout), abortedReport);
  assertEquals(stderr, '');

  stdout = '';
  stderr = '';
  const argsExit = await offlineCliMain(['unexpected'], {
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(argsExit, 1);
  assertEquals(stdout, '');
  assertEquals(JSON.parse(stderr), { schemaVersion: 1, errorCode: 'report_contract_invalid' });

  stdout = '';
  stderr = '';
  const thrownExit = await offlineCliMain([], {
    run: () => Promise.reject(new Error('raw details must not escape')),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(thrownExit, 1);
  assertEquals(stdout, '');
  assertEquals(JSON.parse(stderr), { schemaVersion: 1, errorCode: 'report_contract_invalid' });
  assert(!stderr.includes('raw details'));
});

Deno.test('offline tasks use exact read-only permissions and preserve production task literals', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    tasks: Record<string, string>;
  };
  const evalTest = config.tasks['agent:corpus:eval:test'];
  const evalOffline = config.tasks['agent:corpus:eval:offline'];
  assert(evalTest.includes('--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json'));
  assert(evalOffline.includes('--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json'));
  for (const task of [evalTest, evalOffline]) {
    for (const denied of ['--allow-net', '--allow-env', '--allow-write', '--allow-run']) {
      assert(!task.includes(denied), `${denied} unexpectedly granted`);
    }
  }
  assertEquals(
    config.tasks['agent:run'],
    '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=deno.v0.json v0/agent/runtime_cli.ts',
  );
  assertEquals(
    config.tasks['agent:acceptance'],
    '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai v0/agent/real_provider_acceptance.ts',
  );
});
