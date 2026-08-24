import { DefinitionContentError, normalizeDefinitionContent } from '../src/definition_content.ts';
import { assertEquals, assertThrows } from './assert.ts';

const definition = (): Record<string, unknown> => ({
  schemaVersion: 'definition-content/v1',
  identity: { pluginId: '', namespace: '', kind: 'text-transform' },
  source: { mediaType: 'application/typescript', text: '\uFEFFline 1\r\nline 2\r' },
  manifest: { displayName: 'Cafe\u0301' },
  publicContract: { input: 'text', output: 'text' },
  pluginOwnedTests: [
    { name: '', input: 'Cafe\u0301', expectedOutput: 'Café' },
    { name: '', input: 'same', expectedOutput: 'same' },
  ],
  config: { negativeZero: -0, nested: [null, true, { value: 'raw' }] },
});

Deno.test('DefinitionContent applies approved defaults and normalization', () => {
  const normalized = normalizeDefinitionContent(definition());
  assertEquals(normalized.source.text, 'line 1\nline 2\n');
  assertEquals(normalized.manifest, { displayName: 'Café', description: '' });
  assertEquals(normalized.pluginOwnedTests[0], {
    name: '',
    input: 'Café',
    expectedOutput: 'Café',
  });
  assertEquals(normalized.config.negativeZero, 0);
  assertEquals(normalized.requestedCapabilities, []);
});

Deno.test('DefinitionContent accepts empty and duplicate author-owned values', () => {
  const normalized = normalizeDefinitionContent(definition());
  assertEquals(normalized.identity.pluginId, '');
  assertEquals(normalized.pluginOwnedTests.map(({ name }) => name), ['', '']);
});

Deno.test('DefinitionContent rejects unknown fields at every schema object level', () => {
  for (
    const mutate of [
      (value: Record<string, unknown>) => Object.assign(value, { extra: true }),
      (value: Record<string, unknown>) => Object.assign(value.identity as object, { extra: true }),
      (value: Record<string, unknown>) => Object.assign(value.source as object, { extra: true }),
      (value: Record<string, unknown>) => Object.assign(value.manifest as object, { extra: true }),
      (value: Record<string, unknown>) =>
        Object.assign(value.publicContract as object, { extra: true }),
      (value: Record<string, unknown>) =>
        Object.assign((value.pluginOwnedTests as Record<string, unknown>[])[0], { extra: true }),
    ]
  ) {
    const value = definition();
    mutate(value);
    assertThrows(() => normalizeDefinitionContent(value), 'unknown field');
  }
});

Deno.test('DefinitionContent rejects invalid JSON and I-JSON values', () => {
  for (
    const config of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: 1n },
      { value: () => undefined },
      { value: '\ud800' },
      { value: new Date(0) },
    ]
  ) {
    const value = definition();
    value.config = config;
    assertThrows(() => normalizeDefinitionContent(value));
  }
  const sparse = definition();
  const array = new Array(1);
  sparse.config = { array };
  assertThrows(() => normalizeDefinitionContent(sparse), 'sparse arrays');

  for (const enumerable of [true, false]) {
    let reads = 0;
    const accessor = definition();
    Object.defineProperty(accessor.config as object, 'value', {
      enumerable,
      get: () => ++reads,
    });
    assertThrows(() => normalizeDefinitionContent(accessor), 'enumerable data property');
    assertEquals(reads, 0);
  }

  for (const key of ['extra', Symbol('extra')]) {
    const withExtraArrayProperty = definition();
    const arrayWithExtra: unknown[] = [];
    Object.defineProperty(arrayWithExtra, key, { value: 1, enumerable: true });
    withExtraArrayProperty.config = { arrayWithExtra };
    assertThrows(() => normalizeDefinitionContent(withExtraArrayProperty), 'non-JSON property');
  }
});

Deno.test('DefinitionContent rejects missing fields, wrong types, and wrong literals', () => {
  const cases: Array<(value: Record<string, unknown>) => void> = [
    (value) => delete value.schemaVersion,
    (value) => delete (value.identity as Record<string, unknown>).pluginId,
    (value) => delete (value.identity as Record<string, unknown>).namespace,
    (value) => delete (value.identity as Record<string, unknown>).kind,
    (value) => delete (value.source as Record<string, unknown>).mediaType,
    (value) => delete (value.source as Record<string, unknown>).text,
    (value) => delete (value.manifest as Record<string, unknown>).displayName,
    (value) => delete (value.publicContract as Record<string, unknown>).input,
    (value) => delete (value.publicContract as Record<string, unknown>).output,
    (value) => value.schemaVersion = 'wrong',
    (value) => (value.identity as Record<string, unknown>).kind = 'wrong',
    (value) => (value.source as Record<string, unknown>).mediaType = 'text/plain',
    (value) => (value.publicContract as Record<string, unknown>).input = 'bytes',
    (value) => (value.publicContract as Record<string, unknown>).output = 'bytes',
    (value) => value.identity = [],
    (value) => (value.source as Record<string, unknown>).text = 1,
    (value) => value.manifest = null,
    (value) => value.publicContract = 'text',
    (value) => value.pluginOwnedTests = {},
    (value) => value.config = [],
    (value) => value.requestedCapabilities = ['read'],
  ];
  for (const mutate of cases) {
    const value = definition();
    mutate(value);
    assertThrows(() => normalizeDefinitionContent(value));
  }
});

Deno.test('DefinitionContent does not mutate frozen input', () => {
  const value = definition();
  const before = structuredClone(value);
  Object.freeze(value);
  normalizeDefinitionContent(value);
  assertEquals(value, before);
});

Deno.test('DefinitionContent exposes a typed validation error', () => {
  assertThrows(
    () => normalizeDefinitionContent({}),
    DefinitionContentError.name,
  );
});
