import { decodeBoundedJson, frameSubmission, IntakeError } from '../src/intake_json.ts';
import { INTAKE_LIMITS, measureStructureBounded } from '../src/limits.ts';
import { EMPTY_LEDGER } from '../src/revision_outcome.ts';
import { frameForRevisionService } from '../src/submission_framing.ts';
import { assertEquals, assertThrows } from './assert.ts';

const bytes = (value: string) => new TextEncoder().encode(value);

Deno.test('bounded framing accepts the limit and rejects one byte over', () => {
  const small = { ...INTAKE_LIMITS, maxRawBytes: 4 };
  assertEquals(frameSubmission([bytes('1234')], small).bytes.byteLength, 4);
  assertThrows(() => frameSubmission([bytes('12345'), bytes('ignored')], small), 'raw input');
});

Deno.test('decoder rejects duplicate keys before JSON conversion', () => {
  const frame = frameSubmission([bytes('{"a":1,"a":2}')], INTAKE_LIMITS);
  assertThrows(() => decodeBoundedJson(frame, INTAKE_LIMITS), 'duplicate key');
});

Deno.test('duplicate key precedes property count on a composite failure', () => {
  const profile = { ...INTAKE_LIMITS, maxObjectProperties: 1 };
  assertThrows(
    () => decodeBoundedJson(frameSubmission([bytes('{"a":1,"a":2}')], profile), profile),
    'duplicate key',
  );
});

Deno.test('JSON syntax precedes duplicate and structural limit failures', () => {
  const profile = { ...INTAKE_LIMITS, maxObjectProperties: 1, maxDepth: 1 };
  try {
    decodeBoundedJson(frameSubmission([bytes('{"a":1,"a":{"b":2},}')], profile), profile);
  } catch (error) {
    assertEquals(error instanceof IntakeError ? error.code : null, 'json_syntax');
    return;
  }
  throw new Error('expected syntax rejection');
});

Deno.test('oversize framing returns a non-append service refusal', async () => {
  const result = await frameForRevisionService(
    [new Uint8Array(INTAKE_LIMITS.maxRawBytes + 1)],
    EMPTY_LEDGER,
  );
  assertEquals(result.status, 'refused');
  assertEquals(result.ledger, EMPTY_LEDGER);
});

Deno.test('decoder enforces depth, property, array, and decoded string limits', () => {
  for (
    const [json, profile] of [
      ['[[[]]]', { ...INTAKE_LIMITS, maxDepth: 2 }],
      ['{"a":1,"b":2}', { ...INTAKE_LIMITS, maxObjectProperties: 1 }],
      ['[1,2]', { ...INTAKE_LIMITS, maxArrayItems: 1 }],
      ['"é"', { ...INTAKE_LIMITS, maxDecodedStringBytesEach: 1 }],
    ] as const
  ) {
    assertThrows(() => decodeBoundedJson(frameSubmission([bytes(json)], profile), profile));
  }
});

Deno.test('decoder rejects malformed UTF-8 and trailing JSON', () => {
  assertThrows(() =>
    decodeBoundedJson(frameSubmission([new Uint8Array([0xff])], INTAKE_LIMITS), INTAKE_LIMITS)
  );
  assertThrows(() =>
    decodeBoundedJson(frameSubmission([bytes('{}{}')], INTAKE_LIMITS), INTAKE_LIMITS)
  );
  assertEquals((new IntakeError('x', 'y')).code, 'x');
});

Deno.test('bounded traversal rejects huge and extra-property arrays early', () => {
  const sparse: unknown[] = [];
  sparse.length = 1_000_000_000;
  assertThrows(() => measureStructureBounded(sparse, 8, 512), 'entries');
  const extra: unknown[] = [];
  Object.defineProperty(extra, 'extra', { value: 1 });
  assertThrows(() => measureStructureBounded(extra, 8, 512), 'non-JSON');
});
