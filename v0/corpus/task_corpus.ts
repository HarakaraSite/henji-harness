const CANONICAL_CORPUS_PATH = 'v0/corpus/task-corpus.v1.json';
const CANONICAL_FIXTURE_PATH = 'deno.v0.json';
const SCHEMA_VERSION = 1;
const CORPUS_ID = 'henji-normal-cli-small-v1';
const MAX_REQUESTS = 8;
const MAX_PROMPT_BYTES = 64 * 1024;

export const CORPUS_PATH = CANONICAL_CORPUS_PATH;
export const FIXTURE_PATH = CANONICAL_FIXTURE_PATH;

export const TOOL_NAMES = [
  'character_count',
  'count_json_array_items',
  'list_json_object_keys',
  'uppercase_text',
] as const;
export type CorpusToolName = (typeof TOOL_NAMES)[number];
export type CorpusCategory =
  | 'final_only'
  | 'uppercase_text'
  | 'character_count'
  | 'count_json_array_items'
  | 'list_json_object_keys'
  | 'multi_tool';
export type CorpusVariant = 'explicit' | 'implicit' | 'none';

export interface ExactTextOracle {
  readonly kind: 'exact_text';
  readonly expected: string;
}

export interface JsonValueOracle {
  readonly kind: 'json_value';
  readonly expected: JsonValue;
}

export type CorpusOracle = ExactTextOracle | JsonValueOracle;
export type JsonValue = null | boolean | string | number | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export interface ToolExpectation {
  readonly requiredSequence: readonly CorpusToolName[];
  readonly allowedTools: readonly CorpusToolName[];
  readonly forbiddenTools: readonly CorpusToolName[];
  readonly maxCalls: number;
  readonly requireSuccessfulResults: boolean;
  readonly requireSeparateRounds: boolean;
}

export interface CorpusFixture {
  readonly id: string;
  readonly kind: 'local_json_object';
  readonly path: typeof CANONICAL_FIXTURE_PATH;
  readonly objectKey: string;
  readonly expectedSortedKeys: readonly string[];
}

export interface CorpusTask {
  readonly id: string;
  readonly category: CorpusCategory;
  readonly variant: CorpusVariant;
  readonly pairId: string | null;
  readonly prompt: string;
  readonly fixtureRefs: readonly string[];
  readonly oracle: CorpusOracle;
  readonly toolExpectation: ToolExpectation;
  readonly maxRequests: number;
}

export interface ValidatedTaskCorpus {
  readonly schemaVersion: 1;
  readonly corpusId: typeof CORPUS_ID;
  readonly fixtures: readonly CorpusFixture[];
  readonly tasks: readonly CorpusTask[];
}

export interface ResolvedFixture {
  readonly id: string;
  readonly path: string;
  readonly objectKey: string;
  readonly expectedSortedKeys: readonly string[];
  readonly actualSortedKeys: readonly string[];
}

export type ResolvedFixtures =
  | ReadonlyMap<string, ResolvedFixture>
  | Readonly<Record<string, ResolvedFixture>>;

export type FixtureReader = (
  path: typeof CANONICAL_FIXTURE_PATH,
) => Promise<string | Uint8Array>;

export interface CorpusObservation {
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: readonly {
    readonly requestOrdinal: number;
    readonly callId: string;
    readonly resultCallId: string;
    readonly callName: string;
    readonly resultName: string;
    readonly outcome: 'success' | 'error';
  }[];
}

export type CorpusFailureCode =
  | 'invalid_observation'
  | 'request_ceiling'
  | 'oracle_text_mismatch'
  | 'oracle_json_malformed'
  | 'oracle_json_mismatch'
  | 'tool_missing'
  | 'tool_extra'
  | 'tool_not_allowed'
  | 'tool_forbidden'
  | 'tool_error'
  | 'tool_missing_result'
  | 'tool_call_result_id_mismatch'
  | 'tool_call_result_name_mismatch'
  | 'tool_order'
  | 'tool_same_round';

export interface CorpusDimensionScore {
  readonly passed: boolean;
  readonly failureCodes: readonly CorpusFailureCode[];
}

export interface CorpusCaseScore {
  readonly taskId: string;
  readonly passed: boolean;
  readonly oracle: CorpusDimensionScore;
  readonly tools: CorpusDimensionScore;
  readonly requests: CorpusDimensionScore;
  readonly failureCodes: readonly CorpusFailureCode[];
}

export class CorpusValidationError extends Error {
  constructor(message: string) {
    super(`invalid task corpus: ${message}`);
    this.name = 'CorpusValidationError';
  }
}

const fail = (path: string, message: string): never => {
  throw new CorpusValidationError(`${path}: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `fields must be exactly ${expected.join(', ')}`);
  }
};

const stringValue = (value: unknown, path: string, nonblank = true): string => {
  if (typeof value !== 'string' || (nonblank && value.trim().length === 0)) {
    fail(path, nonblank ? 'must be a nonblank string' : 'must be a string');
  }
  return value as string;
};

const integer = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== 'number' || !Number.isInteger(value) || value < minimum ||
    value > maximum
  ) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
};

const unique = <T>(values: readonly T[], path: string): void => {
  if (new Set(values).size !== values.length) {
    fail(path, 'must not contain duplicates');
  }
};

const sortedStrings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const entries = value as unknown[];
  const values = entries.map((entry, index) => stringValue(entry, `${path}[${index}]`));
  unique(values, path);
  const sorted = [...values].sort();
  if (values.some((entry, index) => entry !== sorted[index])) {
    fail(path, 'must be sorted');
  }
  return values;
};

const toolName = (value: unknown, path: string): CorpusToolName => {
  if (
    typeof value !== 'string' || !TOOL_NAMES.includes(value as CorpusToolName)
  ) {
    fail(path, 'unknown tool');
  }
  return value as CorpusToolName;
};

const toolNames = (value: unknown, path: string): readonly CorpusToolName[] => {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const entries = value as unknown[];
  const values = entries.map((entry, index) => toolName(entry, `${path}[${index}]`));
  unique(values, path);
  return values;
};

const validId = (value: unknown, path: string): string => {
  const id = stringValue(value, path);
  if (
    !/^v1\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(id)
  ) {
    fail(path, 'does not match the versioned ID format');
  }
  return id;
};

const fixtureId = (value: unknown, path: string): string => {
  const id = stringValue(value, path);
  if (!/^deno-v0-(?:fmt|lint)$/.test(id)) fail(path, 'unknown fixture ID');
  return id;
};

const canonicalFixtureTuples: Readonly<
  Record<string, {
    readonly objectKey: string;
    readonly expectedSortedKeys: readonly string[];
  }>
> = {
  'deno-v0-fmt': {
    objectKey: 'fmt',
    expectedSortedKeys: ['lineWidth', 'semiColons', 'singleQuote'],
  },
  'deno-v0-lint': {
    objectKey: 'lint',
    expectedSortedKeys: ['rules'],
  },
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'boolean' || typeof value === 'string'
  ) return true;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isSafeInteger(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
};

const deepEqualJson = (left: JsonValue, right: JsonValue): boolean => {
  if (typeof left !== typeof right || left === null || right === null) {
    return left === right;
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqualJson(left[key], right[key])
    );
};

const expectedPrompts: Readonly<Record<string, string>> = {
  'v1.character-count.henji-chick.explicit':
    'Use the character_count tool on exactly this text and return only its JSON result: Henji 🐣',
  'v1.character-count.henji-chick.implicit':
    'Count the Unicode code points in this text and return only a JSON object with the count: Henji 🐣',
  'v1.character-count.naive.explicit':
    'Use the character_count tool on exactly this text and return only its JSON result: naïve',
  'v1.character-count.naive.implicit':
    'Count the Unicode code points in this text and return only a JSON object with the count: naïve',
  'v1.count-json-array-items.complex.explicit':
    'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [["a","b"],{"x":1},false,null]',
  'v1.count-json-array-items.complex.implicit':
    'Count the top-level items in this JSON array and return only a JSON object with the count: [["a","b"],{"x":1},false,null]',
  'v1.count-json-array-items.simple.explicit':
    'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [1,2,3]',
  'v1.count-json-array-items.simple.implicit':
    'Count the top-level items in this JSON array and return only a JSON object with the count: [1,2,3]',
  'v1.final-only.echo':
    'Echo exactly the text between the brackets, without the brackets: [MiXeD 123 !]',
  'v1.final-only.json':
    'Return only this JSON object, with no code fence: {"status":"ready","version":1}',
  'v1.final-only.multiline': 'Return exactly these two lines and nothing else:\nalpha\nbeta',
  'v1.final-only.token': 'Reply with exactly: HENJI CORPUS READY',
  'v1.list-json-object-keys.fmt.explicit':
    'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "fmt". Return only the resulting JSON array.',
  'v1.list-json-object-keys.fmt.implicit':
    'Read the literal local file "deno.v0.json", list the sorted keys of its "fmt" object, and return only the JSON array.',
  'v1.list-json-object-keys.lint.explicit':
    'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "lint". Return only the resulting JSON array.',
  'v1.list-json-object-keys.lint.implicit':
    'Read the literal local file "deno.v0.json", list the sorted keys of its "lint" object, and return only the JSON array.',
  'v1.multi-tool.fmt.explicit':
    'Use list_json_object_keys to list the keys of object "fmt" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.fmt.implicit':
    'In the literal local file "deno.v0.json", obtain the sorted key list for object "fmt", then count the items in that returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.lint.explicit':
    'Use list_json_object_keys to list the keys of object "lint" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.lint.implicit':
    'In the literal local file "deno.v0.json", obtain the sorted key list for object "lint", then count the items in that returned JSON array. Return only a JSON object with the count.',
  'v1.uppercase-text.ascii.explicit':
    'Use the uppercase_text tool on exactly this text and return only its result: Henji harness',
  'v1.uppercase-text.ascii.implicit':
    'Convert this text to uppercase and return only the converted text: Henji harness',
  'v1.uppercase-text.unicode.explicit':
    'Use the uppercase_text tool on exactly this text and return only its result: Straße café',
  'v1.uppercase-text.unicode.implicit':
    'Convert this text to uppercase and return only the converted text: Straße café',
};

const expectedOracle = (id: string): CorpusOracle => {
  if (id.includes('character-count.henji-chick')) {
    return { kind: 'json_value', expected: { count: 7 } };
  }
  if (id.includes('character-count.naive')) {
    return { kind: 'json_value', expected: { count: 5 } };
  }
  if (id.includes('count-json-array-items.complex')) {
    return { kind: 'json_value', expected: { count: 4 } };
  }
  if (id.includes('count-json-array-items.simple')) {
    return { kind: 'json_value', expected: { count: 3 } };
  }
  if (id === 'v1.final-only.echo') {
    return { kind: 'exact_text', expected: 'MiXeD 123 !' };
  }
  if (id === 'v1.final-only.json') {
    return { kind: 'json_value', expected: { status: 'ready', version: 1 } };
  }
  if (id === 'v1.final-only.multiline') {
    return { kind: 'exact_text', expected: 'alpha\nbeta' };
  }
  if (id === 'v1.final-only.token') {
    return { kind: 'exact_text', expected: 'HENJI CORPUS READY' };
  }
  if (id.includes('list-json-object-keys.fmt')) {
    return {
      kind: 'json_value',
      expected: ['lineWidth', 'semiColons', 'singleQuote'],
    };
  }
  if (id.includes('list-json-object-keys.lint')) {
    return { kind: 'json_value', expected: ['rules'] };
  }
  if (id.includes('multi-tool.fmt')) {
    return { kind: 'json_value', expected: { count: 3 } };
  }
  if (id.includes('multi-tool.lint')) {
    return { kind: 'json_value', expected: { count: 1 } };
  }
  if (id.includes('uppercase-text')) {
    return {
      kind: 'exact_text',
      expected: id.includes('unicode') ? 'STRASSE CAFÉ' : 'HENJI HARNESS',
    };
  }
  return fail('task', `no canonical oracle for ${id}`);
};

const expectedCategory = (id: string): CorpusCategory => {
  if (id.includes('.character-count.')) return 'character_count';
  if (id.includes('.count-json-array-items.')) return 'count_json_array_items';
  if (id.includes('.list-json-object-keys.')) return 'list_json_object_keys';
  if (id.includes('.multi-tool.')) return 'multi_tool';
  if (id.includes('.uppercase-text.')) return 'uppercase_text';
  if (id.includes('.final-only.')) return 'final_only';
  return fail('task', `no canonical category for ${id}`);
};

const expectedFixtureRefs = (id: string): readonly string[] => {
  if (id.includes('.fmt.')) return ['deno-v0-fmt'];
  if (id.includes('.lint.')) return ['deno-v0-lint'];
  return [];
};

const expectedTools = (category: CorpusCategory): readonly CorpusToolName[] => {
  if (category === 'final_only') return [];
  if (category === 'multi_tool') {
    return ['list_json_object_keys', 'count_json_array_items'];
  }
  return [category];
};

const expectedMaxRequests = (category: CorpusCategory): number =>
  category === 'final_only' ? 1 : category === 'multi_tool' ? 3 : 2;

const expectedMaxCalls = (category: CorpusCategory): number =>
  category === 'final_only' ? 0 : category === 'multi_tool' ? 2 : 1;

const canonicalTaskIds = Object.keys(expectedPrompts).sort();

const resolvedFixture = (
  fixtures: ResolvedFixtures,
  id: string,
): ResolvedFixture | undefined =>
  fixtures instanceof Map
    ? fixtures.get(id)
    : (fixtures as Readonly<Record<string, ResolvedFixture>>)[id];

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

const validateFixture = (value: unknown, path: string): CorpusFixture => {
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

const readFixture = async (
  reader: FixtureReader,
  fixture: CorpusFixture,
): Promise<ResolvedFixture> => {
  const raw = await reader(fixture.path);
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`fixtures.${fixture.id}`, 'fixture JSON is malformed');
  }
  if (!isRecord(parsed)) {
    fail(`fixtures.${fixture.id}`, 'fixture root is not an object');
  }
  const fixtureObject = parsed as Record<string, unknown>;
  const target = fixtureObject[fixture.objectKey];
  if (!isRecord(target)) {
    fail(
      `fixtures.${fixture.id}`,
      'fixture object is missing or not an object',
    );
  }
  const targetObject = target as Record<string, unknown>;
  const actualSortedKeys = Object.keys(targetObject).sort();
  if (
    actualSortedKeys.some((key, index) => key !== fixture.expectedSortedKeys[index]) ||
    actualSortedKeys.length !== fixture.expectedSortedKeys.length
  ) {
    fail(
      `fixtures.${fixture.id}`,
      'fixture keys drifted from expectedSortedKeys',
    );
  }
  return {
    id: fixture.id,
    path: fixture.path,
    objectKey: fixture.objectKey,
    expectedSortedKeys: fixture.expectedSortedKeys,
    actualSortedKeys,
  };
};

export const loadTaskCorpus = async (
  corpusPath: string,
  fixtureReader: FixtureReader,
): Promise<ValidatedTaskCorpus> => {
  if (corpusPath !== CANONICAL_CORPUS_PATH) {
    fail('corpusPath', 'only v0/corpus/task-corpus.v1.json is permitted');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(corpusPath));
  } catch (error) {
    if (error instanceof CorpusValidationError) throw error;
    fail('corpus', 'corpus JSON is malformed or unreadable');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.fixtures)) {
    return validateTaskCorpus(parsed, new Map());
  }
  const rawFixtures = parsed.fixtures.map((fixture, index) =>
    validateFixture(fixture, `fixtures[${index}]`)
  );
  const resolved = new Map<string, ResolvedFixture>();
  for (const fixture of rawFixtures) {
    resolved.set(fixture.id, await readFixture(fixtureReader, fixture));
  }
  return validateTaskCorpus(parsed, resolved);
};

const dimension = (
  failureCodes: readonly CorpusFailureCode[],
): CorpusDimensionScore => ({
  passed: failureCodes.length === 0,
  failureCodes,
});

export const scoreCorpusObservation = (
  task: CorpusTask,
  observation: CorpusObservation,
): CorpusCaseScore => {
  const requestFailures: CorpusFailureCode[] = [];
  const oracleFailures: CorpusFailureCode[] = [];
  const toolFailures: CorpusFailureCode[] = [];
  if (
    typeof observation.finalText !== 'string' ||
    !Number.isInteger(observation.requestCount) ||
    !Array.isArray(observation.toolEvents)
  ) {
    return {
      taskId: task.id,
      passed: false,
      oracle: dimension(['invalid_observation']),
      tools: dimension(['invalid_observation']),
      requests: dimension(['invalid_observation']),
      failureCodes: ['invalid_observation'],
    };
  }
  if (
    observation.requestCount < 0 ||
    observation.requestCount > task.maxRequests ||
    observation.requestCount > MAX_REQUESTS
  ) {
    requestFailures.push('request_ceiling');
  }
  if (task.oracle.kind === 'exact_text') {
    if (observation.finalText !== task.oracle.expected) {
      oracleFailures.push('oracle_text_mismatch');
    }
  } else {
    let actual: unknown;
    try {
      actual = JSON.parse(observation.finalText);
    } catch {
      oracleFailures.push('oracle_json_malformed');
      actual = undefined;
    }
    if (
      actual !== undefined &&
      (!isJsonValue(actual) || !deepEqualJson(actual, task.oracle.expected))
    ) {
      oracleFailures.push('oracle_json_mismatch');
    }
  }
  const successfulNames: CorpusToolName[] = [];
  let previousOrdinal = -1;
  for (const event of observation.toolEvents) {
    if (
      !isRecord(event) || typeof event.requestOrdinal !== 'number' ||
      !Number.isInteger(event.requestOrdinal)
    ) {
      toolFailures.push('invalid_observation');
      continue;
    }
    if (
      event.requestOrdinal < 0 ||
      event.requestOrdinal >= observation.requestCount
    ) toolFailures.push('invalid_observation');
    if (
      typeof event.callId !== 'string' || event.callId.length === 0 ||
      typeof event.resultCallId !== 'string' || event.resultCallId.length === 0
    ) {
      toolFailures.push('tool_missing_result');
    } else if (event.callId !== event.resultCallId) {
      toolFailures.push('tool_call_result_id_mismatch');
    }
    if (
      typeof event.callName !== 'string' ||
      typeof event.resultName !== 'string' ||
      event.callName !== event.resultName
    ) {
      toolFailures.push('tool_call_result_name_mismatch');
    }
    if (!TOOL_NAMES.includes(event.callName as CorpusToolName)) {
      toolFailures.push('tool_not_allowed');
    } else {
      const name = event.callName as CorpusToolName;
      if (task.toolExpectation.forbiddenTools.includes(name)) {
        toolFailures.push('tool_forbidden');
      } else if (!task.toolExpectation.allowedTools.includes(name)) {
        toolFailures.push('tool_not_allowed');
      }
      if (event.outcome === 'error') toolFailures.push('tool_error');
      else if (event.outcome === 'success') successfulNames.push(name);
      else toolFailures.push('invalid_observation');
      if (
        task.toolExpectation.requireSeparateRounds &&
        previousOrdinal >= event.requestOrdinal
      ) {
        toolFailures.push('tool_same_round');
      }
      previousOrdinal = event.requestOrdinal;
    }
  }
  const required = task.toolExpectation.requiredSequence;
  if (successfulNames.length < required.length) {
    toolFailures.push('tool_missing');
  }
  if (
    successfulNames.length > required.length ||
    observation.toolEvents.length > task.toolExpectation.maxCalls
  ) {
    toolFailures.push('tool_extra');
  }
  if (
    successfulNames.length === required.length &&
    successfulNames.some((name, index) => name !== required[index])
  ) {
    toolFailures.push('tool_order');
  }
  const dedupe = (
    codes: readonly CorpusFailureCode[],
  ): readonly CorpusFailureCode[] => [...new Set(codes)];
  const oracle = dimension(dedupe(oracleFailures));
  const tools = dimension(dedupe(toolFailures));
  const requests = dimension(dedupe(requestFailures));
  const failureCodes = dedupe([
    ...oracle.failureCodes,
    ...tools.failureCodes,
    ...requests.failureCodes,
  ]);
  return {
    taskId: task.id,
    passed: failureCodes.length === 0,
    oracle,
    tools,
    requests,
    failureCodes,
  };
};
