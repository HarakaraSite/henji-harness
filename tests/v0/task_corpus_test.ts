import { assert, assertEquals } from './test_helpers.ts';
import {
  CORPUS_PATH,
  type CorpusObservation,
  CorpusValidationError,
  FIXTURE_PATH,
  loadTaskCorpus,
  type ResolvedFixture,
  scoreCorpusObservation,
  validateTaskCorpus,
} from '../../v0/corpus/task_corpus.ts';

const encoder = new TextEncoder();
const deno = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';

const fixtureMap = new Map<string, ResolvedFixture>([
  ['deno-v0-fmt', {
    id: 'deno-v0-fmt',
    path: FIXTURE_PATH,
    objectKey: 'fmt',
    expectedSortedKeys: ['lineWidth', 'semiColons', 'singleQuote'],
    actualSortedKeys: ['lineWidth', 'semiColons', 'singleQuote'],
  }],
  ['deno-v0-lint', {
    id: 'deno-v0-lint',
    path: FIXTURE_PATH,
    objectKey: 'lint',
    expectedSortedKeys: ['rules'],
    actualSortedKeys: ['rules'],
  }],
]);

const readCorpus = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(CORPUS_PATH)) as Record<string, unknown>;

const taskAt = (corpus: Record<string, unknown>, id: string): Record<string, unknown> => {
  const tasks = corpus.tasks as Record<string, unknown>[];
  return tasks.find((task) => task.id === id) as Record<string, unknown>;
};

const expectInvalid = async (mutate: (value: Record<string, unknown>) => void): Promise<void> => {
  const value = await readCorpus();
  mutate(value);
  assertThrows(() => validateTaskCorpus(value, fixtureMap), CorpusValidationError);
};

const event = (
  requestOrdinal: number,
  callName: string,
  outcome: 'success' | 'error' = 'success',
  callId = `${callName}-call`,
  resultCallId = callId,
  resultName = callName,
) => ({ requestOrdinal, callId, resultCallId, callName, resultName, outcome });

const observation = (
  finalText: string,
  requestCount: number,
  toolEvents: CorpusObservation['toolEvents'] = [],
  submission: CorpusObservation['submission'] = null,
): CorpusObservation => ({
  finalText,
  requestCount,
  toolEvents,
  submission,
});

Deno.test('loads the versioned 24-case corpus and validates literal fixtures', async () => {
  const corpus = await loadTaskCorpus(CORPUS_PATH, async (path) => {
    assertEquals(path, FIXTURE_PATH);
    return await Deno.readTextFile(path);
  });
  assertEquals(corpus.schemaVersion, 1);
  assertEquals(corpus.corpusId, 'henji-normal-cli-small-v1');
  assertEquals(corpus.fixtures.map((fixture) => fixture.id), ['deno-v0-fmt', 'deno-v0-lint']);
  assertEquals(corpus.tasks.length, 24);
  assertEquals(
    corpus.tasks.map((task) => task.id),
    [...corpus.tasks].map((task) => task.id).sort(),
  );
  assertEquals(corpus.tasks.filter((task) => task.category === 'final_only').length, 4);
  for (
    const category of [
      'uppercase_text',
      'character_count',
      'count_json_array_items',
      'list_json_object_keys',
      'multi_tool',
    ]
  ) {
    assertEquals(corpus.tasks.filter((task) => task.category === category).length, 4);
  }
  assertEquals(
    new Set(corpus.tasks.filter((task) => task.pairId !== null).map((task) => task.pairId)).size,
    10,
  );
  assertEquals(corpus.tasks.filter((task) => task.fixtureRefs.length > 0).length, 8);
});

Deno.test('loader rejects noncanonical corpus and fixture paths before reads', async () => {
  await assertThrowsAsync(
    () => loadTaskCorpus('other/task-corpus.json', () => Promise.resolve('{}')),
    CorpusValidationError,
  );
  const value = await readCorpus();
  (value.fixtures as Record<string, unknown>[])[0].path = 'subdir/deno.v0.json';
  assertThrows(() => validateTaskCorpus(value, fixtureMap), CorpusValidationError);
});

Deno.test('strict schema rejects malformed roots and unknown fields at every level', async () => {
  await expectInvalid((value) => {
    delete value.schemaVersion;
  });
  await expectInvalid((value) => {
    value.extra = true;
  });
  await expectInvalid((value) => {
    (value.fixtures as unknown[])[0] = {
      ...(value.fixtures as unknown[])[0] as object,
      extra: true,
    };
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.final-only.echo').oracle as Record<string, unknown>).extra = true;
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.final-only.echo').toolExpectation as Record<string, unknown>).extra = true;
  });
});

Deno.test('strict schema rejects IDs, references, prompt bounds, and fixture drift', async () => {
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').id = 'bad';
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').fixtureRefs = ['unknown'];
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').fixtureRefs = ['', ''];
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').prompt = ' ';
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').prompt = 'x'.repeat(64 * 1024 + 1);
  });
  await expectInvalid((value) => {
    (value.fixtures as Record<string, unknown>[])[0].expectedSortedKeys = [
      'semiColons',
      'lineWidth',
      'singleQuote',
    ];
  });
  await expectInvalid((value) => {
    const fixture = (value.fixtures as Record<string, unknown>[])[0];
    fixture.objectKey = 'lint';
    fixture.expectedSortedKeys = ['rules'];
  });
  await expectInvalid((value) => {
    (value.fixtures as Record<string, unknown>[])[0].expectedSortedKeys = ['rules'];
  });
  const drift = new Map(fixtureMap);
  drift.set('deno-v0-fmt', {
    ...fixtureMap.get('deno-v0-fmt')!,
    actualSortedKeys: ['lineWidth', 'semiColons'],
  });
  const driftCorpus = await readCorpus();
  assertThrows(() => validateTaskCorpus(driftCorpus, drift), CorpusValidationError);
});

Deno.test('strict schema rejects oracle and tool expectation type/range/partition errors', async () => {
  await expectInvalid((value) => {
    (taskAt(value, 'v1.final-only.echo').oracle as Record<string, unknown>).kind = 'semantic';
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.final-only.echo').oracle as Record<string, unknown>).expected = '';
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.final-only.json').oracle as Record<string, unknown>).expected = 1e400;
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.uppercase-text.ascii.explicit').toolExpectation as Record<string, unknown>)
      .forbiddenTools = [];
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.uppercase-text.ascii.explicit').toolExpectation as Record<string, unknown>)
      .allowedTools = ['uppercase_text', 'uppercase_text'];
  });
  await expectInvalid((value) => {
    (taskAt(value, 'v1.multi-tool.fmt.explicit').toolExpectation as Record<string, unknown>)
      .requireSeparateRounds = false;
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').maxRequests = 0;
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').maxRequests = 9;
  });
});

Deno.test('strict schema rejects matrix, order, pair, fixture, and balance mutations', async () => {
  await expectInvalid((value) => {
    (value.tasks as unknown[]).reverse();
  });
  await expectInvalid((value) => {
    (value.tasks as unknown[]).pop();
  });
  await expectInvalid((value) => {
    (value.tasks as unknown[]).push(JSON.parse(JSON.stringify((value.tasks as unknown[])[0])));
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').category = 'uppercase_text';
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').variant = 'explicit';
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.uppercase-text.ascii.explicit').pairId = 'v1.uppercase-text.other';
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.list-json-object-keys.fmt.explicit').fixtureRefs = [];
  });
  await expectInvalid((value) => {
    taskAt(value, 'v1.final-only.echo').pairId = 'v1.final-only.echo';
  });
});

Deno.test('exact text and JSON oracles are mechanical and strict', async () => {
  const corpus = await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));
  const textTask = corpus.tasks.find((task) => task.id === 'v1.final-only.echo')!;
  assert(scoreCorpusObservation(textTask, observation('MiXeD 123 !', 1)).passed);
  assert(!scoreCorpusObservation(textTask, observation(' mixed 123 ! ', 1)).passed);
  const jsonTask = corpus.tasks.find((task) => task.id === 'v1.final-only.json')!;
  assert(
    scoreCorpusObservation(
      jsonTask,
      observation('{"version":1,"status":"ready"}', 1, [], {
        kind: 'json_result',
        requestOrdinal: 0,
        callId: 'submit-1',
        resultCallId: 'submit-1',
        outcome: 'success',
      }),
    ).passed,
  );
  assert(
    !scoreCorpusObservation(jsonTask, observation('{"status":"ready","version":1} trailing', 1))
      .passed,
  );
  assert(
    !scoreCorpusObservation(jsonTask, observation('{"status":"ready","version":"1"}', 1)).passed,
  );
  const multiline = corpus.tasks.find((task) => task.id === 'v1.final-only.multiline')!;
  assert(scoreCorpusObservation(multiline, observation('alpha\nbeta', 1)).passed);
  assert(!scoreCorpusObservation(multiline, observation('alpha\nbeta\n', 1)).passed);
});

Deno.test('tool scorer enforces sequence, event correlation, results, rounds, and ceilings', async () => {
  const corpus = await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));
  const single = corpus.tasks.find((task) => task.id === 'v1.uppercase-text.ascii.explicit')!;
  assert(
    scoreCorpusObservation(single, observation('HENJI HARNESS', 2, [event(0, 'uppercase_text')]))
      .passed,
  );
  assert(
    scoreCorpusObservation(single, observation('HENJI HARNESS', 2, [event(0, 'character_count')]))
      .failureCodes.includes('tool_forbidden'),
  );
  assert(
    scoreCorpusObservation(single, observation('HENJI HARNESS', 2, [])).failureCodes.includes(
      'tool_missing',
    ),
  );
  assert(
    scoreCorpusObservation(
      single,
      observation('HENJI HARNESS', 2, [event(0, 'uppercase_text', 'success', 'a', 'b')]),
    ).failureCodes.includes('tool_call_result_id_mismatch'),
  );
  assert(
    scoreCorpusObservation(
      single,
      observation('HENJI HARNESS', 2, [
        event(0, 'uppercase_text', 'success', 'a', 'a', 'character_count'),
      ]),
    ).failureCodes.includes('tool_call_result_name_mismatch'),
  );
  assert(
    scoreCorpusObservation(
      single,
      observation('HENJI HARNESS', 3, [event(0, 'uppercase_text'), event(1, 'uppercase_text')]),
    ).failureCodes.includes('tool_extra'),
  );
  assert(
    scoreCorpusObservation(single, observation('HENJI HARNESS', 9, [event(0, 'uppercase_text')]))
      .failureCodes.includes('request_ceiling'),
  );
  const multi = corpus.tasks.find((task) => task.id === 'v1.multi-tool.fmt.explicit')!;
  assert(
    scoreCorpusObservation(
      multi,
      observation('{"count":3}', 3, [
        event(0, 'list_json_object_keys'),
        event(1, 'count_json_array_items'),
      ], {
        kind: 'json_result',
        requestOrdinal: 2,
        callId: 'submit-1',
        resultCallId: 'submit-1',
        outcome: 'success',
      }),
    ).passed,
  );
  assert(
    scoreCorpusObservation(
      multi,
      observation('{"count":3}', 3, [
        event(0, 'count_json_array_items'),
        event(1, 'list_json_object_keys'),
      ]),
    ).failureCodes.includes('tool_order'),
  );
  assert(
    scoreCorpusObservation(
      multi,
      observation('{"count":3}', 3, [
        event(0, 'list_json_object_keys'),
        event(0, 'count_json_array_items'),
      ]),
    ).failureCodes.includes('tool_same_round'),
  );
  assert(
    scoreCorpusObservation(
      multi,
      observation('{"count":3}', 3, [
        event(0, 'list_json_object_keys', 'error'),
        event(1, 'count_json_array_items'),
      ]),
    ).failureCodes.includes('tool_error'),
  );
});

Deno.test('focused corpus task has exact read permissions and gate excludes provider tasks', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    tasks: Record<string, string>;
  };
  const focused = config.tasks['agent:corpus:test'];
  assertEquals(
    focused,
    `${deno} test --no-prompt --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json tests/v0/task_corpus_test.ts`,
  );
  assert(config.tasks['v0:check'].includes('v0/corpus/task_corpus.ts'));
  assert(config.tasks['v0:check'].includes('tests/v0/task_corpus_test.ts'));
  assert(config.tasks['v0:gate'].includes('agent:corpus:test'));
  assert(!/\bagent:run(?:\s|$)/.test(config.tasks['v0:gate']));
  assert(!/\bagent:acceptance(?:\s|$)/.test(config.tasks['v0:gate']));
  assertEquals(
    config.tasks['agent:run'],
    `${deno} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=deno.v0.json v0/agent/runtime_cli.ts`,
  );
  assertEquals(
    config.tasks['agent:acceptance'],
    `${deno} run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai v0/agent/real_provider_acceptance.ts`,
  );
  assertEquals(encoder.encode(CORPUS_PATH).byteLength > 0, true);
});

async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof errorClass);
    return;
  }
  throw new Error('expected promise to reject');
}

function assertThrows(fn: () => unknown, errorClass: new (...args: never[]) => Error): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof errorClass);
    return;
  }
  throw new Error('expected throw');
}
