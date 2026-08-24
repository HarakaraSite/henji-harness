import { canonicalize, contentHash } from '../src/canonical_content.ts';
import { normalizeDefinitionContent } from '../src/definition_content.ts';
import { assertEquals, assertNotEquals, assertThrows } from './assert.ts';

const goldenDefinition = (sourceText = 'export default (input: string) => input;\n') =>
  normalizeDefinitionContent({
    schemaVersion: 'definition-content/v1',
    identity: { pluginId: 'plugin-1', namespace: 'example', kind: 'text-transform' },
    source: { mediaType: 'application/typescript', text: sourceText },
    manifest: { displayName: 'Example', description: '' },
    publicContract: { input: 'text', output: 'text' },
    pluginOwnedTests: [],
    config: {},
    requestedCapabilities: [],
  });

const GOLDEN =
  '{"config":{},"identity":{"kind":"text-transform","namespace":"example","pluginId":"plugin-1"},"manifest":{"description":"","displayName":"Example"},"pluginOwnedTests":[],"publicContract":{"input":"text","output":"text"},"requestedCapabilities":[],"schemaVersion":"definition-content/v1","source":{"mediaType":"application/typescript","text":"export default (input: string) => input;\\n"}}';

Deno.test('JCS canonical content matches the independently derived golden', async () => {
  const content = goldenDefinition();
  assertEquals(canonicalize(content), GOLDEN);
  assertEquals(new TextEncoder().encode(GOLDEN).byteLength, 387);
  assertEquals(
    await contentHash(content),
    'sha256:7630b115e3beeb0f6fb81021a5e3988fc2c6a26fd8f62734d2c9ec91123bc247',
  );
});

Deno.test('JCS uses ECMAScript string and number serialization', () => {
  assertEquals(
    canonicalize({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    }),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
  assertEquals(
    canonicalize([0, -0, 5e-324, -5e-324, 1.7976931348623157e308, 9007199254740992]),
    '[0,0,5e-324,-5e-324,1.7976931348623157e+308,9007199254740992]',
  );
});

Deno.test('JCS sorts property names by raw UTF-16 code units', () => {
  const value = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  };
  assertEquals(
    canonicalize(value),
    '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

Deno.test('canonical content is stable for key order and approved normalization', async () => {
  assertEquals(
    canonicalize({ z: 1, a: { z: 2, a: 3 } }),
    canonicalize({ a: { a: 3, z: 2 }, z: 1 }),
  );
  const left = goldenDefinition('\uFEFFexport default (input: string) => input;\r\n');
  const right = goldenDefinition();
  assertEquals(await contentHash(left), await contentHash(right));
});

Deno.test('canonical content changes when meaning or array order changes', async () => {
  assertNotEquals(await contentHash({ value: 1 }), await contentHash({ value: 2 }));
  assertNotEquals(await contentHash({ value: [1, 2] }), await contentHash({ value: [2, 1] }));
});

Deno.test('JCS rejects lone surrogates, non-finite numbers, sparse arrays, and cycles', () => {
  assertThrows(() => canonicalize('\ud800'), 'lone surrogate');
  assertThrows(() => canonicalize(Number.NaN), 'finite');
  assertThrows(() => canonicalize(new Array(1)), 'sparse');
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assertThrows(() => canonicalize(cycle), 'cyclic');
});

Deno.test('JCS rejects accessors and non-enumerable properties without reading them', () => {
  for (const enumerable of [true, false]) {
    let reads = 0;
    const value = {};
    Object.defineProperty(value, 'field', { enumerable, get: () => ++reads });
    assertThrows(() => canonicalize(value), 'enumerable data properties');
    assertEquals(reads, 0);
  }
  const array: unknown[] = [];
  let arrayReads = 0;
  Object.defineProperty(array, '0', { enumerable: true, get: () => ++arrayReads });
  assertThrows(() => canonicalize(array), 'enumerable data properties');
  assertEquals(arrayReads, 0);

  for (const enumerable of [true, false]) {
    const withExtra: unknown[] = [];
    let reads = 0;
    Object.defineProperty(withExtra, 'extra', { enumerable, get: () => ++reads });
    assertThrows(() => canonicalize(withExtra), 'non-JSON property');
    assertEquals(reads, 0);
  }
  const withSymbol: unknown[] = [];
  Object.defineProperty(withSymbol, Symbol('extra'), { enumerable: true, value: 1 });
  assertThrows(() => canonicalize(withSymbol), 'non-JSON property');
});
