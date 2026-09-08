import {
  CANONICAL_FIXTURE_PATH,
  CORPUS_ID,
  type CorpusCategory,
  type CorpusFixture,
  type CorpusOracle,
  type CorpusTask,
  type CorpusVariant,
  type JsonValue,
  MAX_PROMPT_BYTES,
  MAX_REQUESTS,
  type ResolvedFixture,
  type ResolvedFixtures,
  SCHEMA_VERSION,
  TOOL_NAMES,
  type ToolExpectation,
  type ValidatedTaskCorpus,
} from './task_corpus_contract.ts';
import {
  canonicalFixtureTuples,
  canonicalTaskIds,
  expectedCategory,
  expectedFixtureRefs,
  expectedMaxCalls,
  expectedMaxRequests,
  expectedOracle,
  expectedPrompts,
  expectedTools,
  resolvedFixture,
} from './task_corpus_canonical.ts';
import {
  deepEqualJson,
  exactKeys,
  fail,
  fixtureId,
  integer,
  isJsonValue,
  isRecord,
  sortedStrings,
  stringValue,
  toolNames,
  unique,
  validId,
} from './task_corpus_value.ts';

const validateOracle = (value: unknown, path: string): CorpusOracle => {
  if (!isRecord(value)) fail(path, 'must be an object');
  const object = value as Record<string, unknown>;
  exactKeys(object, ['kind', 'expected'], path);
  const kind = stringValue(object.kind, `${path}.kind`);
  if (kind === 'exact_text') {
    return {
      kind,
      expected: stringValue(object.expected, `${path}.expected`, false),
    };
  }
  if (kind === 'json_value') {
    if (!isJsonValue(object.expected)) {
      fail(`${path}.expected`, 'must be JSON with safe integer numbers');
    }
    return { kind, expected: object.expected as JsonValue };
  }
  return fail(`${path}.kind`, 'unknown oracle kind');
};

const validateToolExpectation = (
  value: unknown,
  category: CorpusCategory,
  path: string,
): ToolExpectation => {
  if (!isRecord(value)) fail(path, 'must be an object');
  const object = value as Record<string, unknown>;
  exactKeys(object, [
    'requiredSequence',
    'allowedTools',
    'forbiddenTools',
    'maxCalls',
    'requireSuccessfulResults',
    'requireSeparateRounds',
  ], path);
  const requiredSequence = toolNames(
    object.requiredSequence,
    `${path}.requiredSequence`,
  );
  const allowedTools = toolNames(object.allowedTools, `${path}.allowedTools`);
  const forbiddenTools = toolNames(
    object.forbiddenTools,
    `${path}.forbiddenTools`,
  );
  if (
    new Set([...allowedTools, ...forbiddenTools]).size !== TOOL_NAMES.length ||
    TOOL_NAMES.some((name) => !allowedTools.includes(name) && !forbiddenTools.includes(name)) ||
    allowedTools.some((name) => forbiddenTools.includes(name))
  ) {
    fail(path, 'allowedTools and forbiddenTools must partition all four tools');
  }
  const maxCalls = integer(
    object.maxCalls,
    `${path}.maxCalls`,
    0,
    TOOL_NAMES.length,
  );
  if (typeof object.requireSuccessfulResults !== 'boolean') {
    fail(`${path}.requireSuccessfulResults`, 'must be boolean');
  }
  if (typeof object.requireSeparateRounds !== 'boolean') {
    fail(`${path}.requireSeparateRounds`, 'must be boolean');
  }
  const expected = expectedTools(category);
  if (
    requiredSequence.length !== expected.length ||
    requiredSequence.some((name, index) => name !== expected[index])
  ) {
    fail(`${path}.requiredSequence`, 'does not match the category sequence');
  }
  if (
    allowedTools.length !== expected.length ||
    expected.some((name) => !allowedTools.includes(name))
  ) {
    fail(`${path}.allowedTools`, 'does not match the category tools');
  }
  if (maxCalls !== expectedMaxCalls(category)) {
    fail(`${path}.maxCalls`, 'does not match the category ceiling');
  }
  if (object.requireSuccessfulResults !== true) {
    fail(`${path}.requireSuccessfulResults`, 'must be true');
  }
  if (object.requireSeparateRounds !== (category === 'multi_tool')) {
    fail(`${path}.requireSeparateRounds`, 'does not match the category');
  }
  return {
    requiredSequence,
    allowedTools,
    forbiddenTools,
    maxCalls,
    requireSuccessfulResults: true,
    requireSeparateRounds: category === 'multi_tool',
  };
};

export const validateFixture = (value: unknown, path: string): CorpusFixture => {
  if (!isRecord(value)) fail(path, 'must be an object');
  const object = value as Record<string, unknown>;
  exactKeys(
    object,
    ['id', 'kind', 'path', 'objectKey', 'expectedSortedKeys'],
    path,
  );
  const id = fixtureId(object.id, `${path}.id`);
  if (object.kind !== 'local_json_object') {
    fail(`${path}.kind`, 'must be local_json_object');
  }
  if (object.path !== CANONICAL_FIXTURE_PATH) {
    fail(`${path}.path`, 'must be deno.v0.json');
  }
  const objectKey = stringValue(object.objectKey, `${path}.objectKey`);
  const expectedSortedKeys = sortedStrings(
    object.expectedSortedKeys,
    `${path}.expectedSortedKeys`,
  );
  const canonical = canonicalFixtureTuples[id];
  if (
    canonical.objectKey !== objectKey ||
    !deepEqualJson([...canonical.expectedSortedKeys], [...expectedSortedKeys])
  ) {
    fail(`${path}`, 'fixture tuple does not match the canonical v1 fixture');
  }
  return {
    id,
    kind: 'local_json_object',
    path: CANONICAL_FIXTURE_PATH,
    objectKey,
    expectedSortedKeys,
  };
};

const validateTask = (
  value: unknown,
  index: number,
  fixtures: ReadonlyMap<string, CorpusFixture>,
): CorpusTask => {
  const path = `tasks[${index}]`;
  if (!isRecord(value)) fail(path, 'must be an object');
  const object = value as Record<string, unknown>;
  exactKeys(object, [
    'id',
    'category',
    'variant',
    'pairId',
    'prompt',
    'fixtureRefs',
    'oracle',
    'toolExpectation',
    'maxRequests',
  ], path);
  const id = validId(object.id, `${path}.id`);
  const categoryValue = stringValue(object.category, `${path}.category`);
  const categories: readonly CorpusCategory[] = [
    'final_only',
    'uppercase_text',
    'character_count',
    'count_json_array_items',
    'list_json_object_keys',
    'multi_tool',
  ];
  if (!categories.includes(categoryValue as CorpusCategory)) {
    fail(`${path}.category`, 'unknown category');
  }
  const category = categoryValue as CorpusCategory;
  const variantValue = stringValue(object.variant, `${path}.variant`);
  if (!['explicit', 'implicit', 'none'].includes(variantValue)) {
    fail(`${path}.variant`, 'unknown variant');
  }
  const variant = variantValue as CorpusVariant;
  if (variant === 'none' && category !== 'final_only') {
    fail(`${path}.variant`, 'only final_only may use none');
  }
  if (variant !== 'none' && category === 'final_only') {
    fail(`${path}.variant`, 'final_only must use none');
  }
  const pairId = object.pairId === null ? null : validId(object.pairId, `${path}.pairId`);
  if (category === 'final_only' && pairId !== null) {
    fail(`${path}.pairId`, 'final_only cannot be paired');
  }
  if (category !== 'final_only' && pairId === null) {
    fail(`${path}.pairId`, 'tool tasks require a pairId');
  }
  const prompt = stringValue(object.prompt, `${path}.prompt`);
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) {
    fail(`${path}.prompt`, 'exceeds 64 KiB');
  }
  if (!Array.isArray(object.fixtureRefs)) {
    fail(`${path}.fixtureRefs`, 'must be an array');
  }
  const fixtureEntries = object.fixtureRefs as unknown[];
  const fixtureRefs = fixtureEntries.map((entry, refIndex) =>
    stringValue(entry, `${path}.fixtureRefs[${refIndex}]`)
  );
  unique(fixtureRefs, `${path}.fixtureRefs`);
  fixtureRefs.forEach((ref) => {
    if (!fixtures.has(ref)) {
      fail(`${path}.fixtureRefs`, `unknown fixture ${ref}`);
    }
  });
  const oracle = validateOracle(object.oracle, `${path}.oracle`);
  const toolExpectation = validateToolExpectation(
    object.toolExpectation,
    category,
    `${path}.toolExpectation`,
  );
  const maxRequests = integer(
    object.maxRequests,
    `${path}.maxRequests`,
    1,
    MAX_REQUESTS,
  );
  if (maxRequests !== expectedMaxRequests(category)) {
    fail(`${path}.maxRequests`, 'does not match the category ceiling');
  }
  return {
    id,
    category,
    variant,
    pairId,
    prompt,
    fixtureRefs,
    oracle,
    toolExpectation,
    maxRequests,
  };
};

const validateCanonicalTask = (task: CorpusTask, index: number): void => {
  const expectedPrompt = expectedPrompts[task.id];
  if (expectedPrompt === undefined) {
    fail(`tasks[${index}].id`, `unknown v1 task ${task.id}`);
  }
  if (task.prompt !== expectedPrompt) {
    fail(`tasks[${index}].prompt`, 'does not match the canonical prompt');
  }
  const category = expectedCategory(task.id);
  if (task.category !== category) {
    fail(`tasks[${index}].category`, 'does not match the canonical task');
  }
  const expectedVariant: CorpusVariant = category === 'final_only'
    ? 'none'
    : task.id.endsWith('.explicit')
    ? 'explicit'
    : 'implicit';
  if (task.variant !== expectedVariant) {
    fail(`tasks[${index}].variant`, 'does not match the canonical task');
  }
  const expectedPair = category === 'final_only'
    ? null
    : task.id.slice(0, task.id.lastIndexOf('.'));
  if (task.pairId !== expectedPair) {
    fail(`tasks[${index}].pairId`, 'does not match the canonical pair');
  }
  if (
    task.fixtureRefs.length !== expectedFixtureRefs(task.id).length ||
    task.fixtureRefs.some((ref, refIndex) => ref !== expectedFixtureRefs(task.id)[refIndex])
  ) {
    fail(
      `tasks[${index}].fixtureRefs`,
      'does not match the canonical fixture reference',
    );
  }
  if (
    !deepEqualJson(task.oracle.expected, expectedOracle(task.id).expected) ||
    task.oracle.kind !== expectedOracle(task.id).kind
  ) {
    fail(`tasks[${index}].oracle`, 'does not match the canonical oracle');
  }
};

const validatePairsAndBalance = (tasks: readonly CorpusTask[]): void => {
  const counts = new Map<CorpusCategory, number>();
  const variants = new Map<string, CorpusTask[]>();
  for (const task of tasks) {
    counts.set(task.category, (counts.get(task.category) ?? 0) + 1);
    if (task.pairId !== null) {
      variants.set(task.pairId, [...(variants.get(task.pairId) ?? []), task]);
    }
  }
  const categories: readonly CorpusCategory[] = [
    'final_only',
    'uppercase_text',
    'character_count',
    'count_json_array_items',
    'list_json_object_keys',
    'multi_tool',
  ];
  categories.forEach((category) => {
    if (counts.get(category) !== 4) {
      fail('tasks', `category ${category} must contain four tasks`);
    }
  });
  if (variants.size !== 10) {
    fail('tasks', 'must contain exactly ten controlled pairs');
  }
  for (const [pairId, pair] of variants) {
    if (
      pair.length !== 2 || new Set(pair.map((task) => task.variant)).size !== 2
    ) fail('tasks', `pair ${pairId} must contain explicit and implicit tasks`);
    const [first, second] = pair;
    if (
      first.category !== second.category ||
      first.oracle.kind !== second.oracle.kind ||
      !deepEqualJson(first.oracle.expected, second.oracle.expected) ||
      first.prompt === second.prompt ||
      first.maxRequests !== second.maxRequests ||
      first.toolExpectation.maxCalls !== second.toolExpectation.maxCalls ||
      first.fixtureRefs.join('\u0000') !== second.fixtureRefs.join('\u0000')
    ) {
      fail('tasks', `pair ${pairId} fields do not match`);
    }
  }
};

const validateResolvedFixtures = (
  fixtures: readonly CorpusFixture[],
  resolved: ResolvedFixtures,
): void => {
  for (const fixture of fixtures) {
    const found = resolvedFixture(resolved, fixture.id);
    if (found === undefined) {
      fail(`fixtures.${fixture.id}`, 'fixture was not resolved');
    }
    const resolvedValue = found as ResolvedFixture;
    if (
      resolvedValue.path !== CANONICAL_FIXTURE_PATH ||
      resolvedValue.objectKey !== fixture.objectKey ||
      !deepEqualJson([...resolvedValue.expectedSortedKeys], [
        ...fixture.expectedSortedKeys,
      ]) ||
      !deepEqualJson([...resolvedValue.actualSortedKeys], [
        ...fixture.expectedSortedKeys,
      ])
    ) {
      fail(`fixtures.${fixture.id}`, 'fixture keys drifted from the corpus');
    }
  }
};

export const validateTaskCorpus = (
  value: unknown,
  resolvedFixtures: ResolvedFixtures,
): ValidatedTaskCorpus => {
  if (!isRecord(value)) fail('root', 'must be an object');
  const object = value as Record<string, unknown>;
  exactKeys(object, ['schemaVersion', 'corpusId', 'fixtures', 'tasks'], 'root');
  if (object.schemaVersion !== SCHEMA_VERSION) {
    fail('schemaVersion', 'unsupported schema version');
  }
  if (object.corpusId !== CORPUS_ID) fail('corpusId', 'unknown corpus ID');
  if (!Array.isArray(object.fixtures)) fail('fixtures', 'must be an array');
  const fixtureArray = object.fixtures as unknown[];
  if (fixtureArray.length !== 2) {
    fail('fixtures', 'must contain exactly two fixtures');
  }
  const fixtureEntries = fixtureArray;
  const fixtures = fixtureEntries.map((fixture, index) =>
    validateFixture(fixture, `fixtures[${index}]`)
  );
  unique(fixtures.map((fixture) => fixture.id), 'fixtures');
  if (fixtures[0].id !== 'deno-v0-fmt' || fixtures[1].id !== 'deno-v0-lint') {
    fail('fixtures', 'fixture order is not canonical');
  }
  if (!Array.isArray(object.tasks)) fail('tasks', 'must be an array');
  const taskArray = object.tasks as unknown[];
  if (taskArray.length !== 24) fail('tasks', 'must contain exactly 24 tasks');
  const fixtureMap = new Map<string, CorpusFixture>(
    fixtures.map((fixture): [string, CorpusFixture] => [fixture.id, fixture]),
  );
  const taskEntries = taskArray;
  const tasks = taskEntries.map((task, index) => validateTask(task, index, fixtureMap));
  unique(tasks.map((task) => task.id), 'tasks');
  if (tasks.some((task, index) => task.id !== canonicalTaskIds[index])) {
    fail('tasks', 'task IDs must be in canonical sorted order');
  }
  tasks.forEach(validateCanonicalTask);
  validatePairsAndBalance(tasks);
  validateResolvedFixtures(fixtures, resolvedFixtures);
  return { schemaVersion: 1, corpusId: CORPUS_ID, fixtures, tasks };
};
