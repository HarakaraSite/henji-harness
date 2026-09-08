import {
  CANONICAL_CORPUS_PATH,
  type CorpusFixture,
  CorpusValidationError,
  type FixtureReader,
  type ResolvedFixture,
  type ValidatedTaskCorpus,
} from './task_corpus_contract.ts';
import { fail, isRecord } from './task_corpus_value.ts';
import { validateFixture, validateTaskCorpus } from './task_corpus_validation.ts';

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
