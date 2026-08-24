import {
  DEFINITION_CONTENT_V1_OWNERSHIP_PATHS,
  FIELD_OWNERSHIP,
  type FieldOwnership,
  validateFieldOwnership,
} from '../src/field_ownership.ts';
import { assertEquals, assertThrows } from './assert.ts';

Deno.test('field ownership covers the schema exactly once', () => {
  validateFieldOwnership(FIELD_OWNERSHIP);
  assertEquals(new Set(FIELD_OWNERSHIP.map(({ path }) => path)).size, FIELD_OWNERSHIP.length);
  assertEquals(
    FIELD_OWNERSHIP.map(({ path }) => path).sort(),
    [...DEFINITION_CONTENT_V1_OWNERSHIP_PATHS].sort(),
  );
});

Deno.test('field ownership rejects duplicate, conflicting, missing, and unknown paths', () => {
  assertThrows(() => validateFieldOwnership([...FIELD_OWNERSHIP, FIELD_OWNERSHIP[0]]), 'duplicate');
  assertThrows(
    () =>
      validateFieldOwnership([
        ...FIELD_OWNERSHIP,
        { path: 'source.text', owner: 'definition-author', visibility: 'visible' },
      ]),
    'parent/child ownership conflict',
  );
  assertThrows(
    () =>
      validateFieldOwnership([...FIELD_OWNERSHIP, {
        path: 'unknown',
        owner: 'host',
        visibility: 'hidden',
      }]),
    'not in DefinitionContent',
  );
  assertThrows(() => validateFieldOwnership(FIELD_OWNERSHIP.slice(1)), 'missing');
  const invalid = FIELD_OWNERSHIP.map((entry) => ({ ...entry })) as FieldOwnership[];
  invalid[4] = { ...invalid[4], visibility: 'hidden' };
  assertThrows(() => validateFieldOwnership(invalid), 'owner and visibility');
});
