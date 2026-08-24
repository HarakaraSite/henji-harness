import { ADMISSION_LIMITS } from '../src/admission_profile.ts';
import { decodeFrame, encodeFrame, validateBuilderRequest } from '../src/builder_protocol.ts';
import { assertEquals, assertRejects, assertThrows } from './test_helpers.ts';
import { validateBuilderResponse } from '../src/builder_process.ts';
import type { BuilderRequestV1 } from '../src/builder_protocol.ts';

Deno.test('protocol roundtrips one exact big-endian frame', () => {
  const value = { b: 2, a: 1 };
  assertEquals(decodeFrame(encodeFrame(value, 128), 128), { a: 1, b: 2 });
});

Deno.test('protocol rejects zero, truncated, trailing, and duplicate-key frames', () => {
  assertThrows(() => decodeFrame(new Uint8Array([0, 0, 0, 0]), 128));
  assertThrows(() => decodeFrame(new Uint8Array([0, 0, 0, 2, 0x7b]), 128));
  const valid = encodeFrame({ a: 1 }, 128);
  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  assertThrows(() => decodeFrame(trailing, 128));
  const duplicate = new TextEncoder().encode('{"a":1,"a":2}');
  const framed = new Uint8Array(4 + duplicate.length);
  new DataView(framed.buffer).setUint32(0, duplicate.length, false);
  framed.set(duplicate, 4);
  assertThrows(() => decodeFrame(framed, 128));
});

Deno.test('protocol rejects invalid UTF-8 before JSON construction', () => {
  const framed = new Uint8Array([0, 0, 0, 1, 0xff]);
  assertThrows(() => decodeFrame(framed, 128));
});

Deno.test('protocol payload limit is inclusive and rejects one byte over', () => {
  const atLimit = 'x'.repeat(ADMISSION_LIMITS.builderRequestBytes - 2);
  assertEquals(
    decodeFrame(
      encodeFrame(atLimit, ADMISSION_LIMITS.builderRequestBytes),
      ADMISSION_LIMITS.builderRequestBytes,
    ),
    atLimit,
  );
  assertThrows(() => encodeFrame(`${atLimit}x`, ADMISSION_LIMITS.builderRequestBytes));
});

Deno.test('host rejects arbitrary Builder failure codes and forged details digest', async () => {
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const request: BuilderRequestV1 = {
    schemaVersion: 'builder-request/v1',
    requestId: hash('1'),
    sourceHash: hash('2'),
    sourceText: 'x',
    compilerOptionsDigest: hash('3'),
    admissionProfileDigest: hash('4'),
  };
  for (
    const response of [
      {
        schemaVersion: 'builder-response/v1',
        requestId: request.requestId,
        status: 'rejected',
        stage: 'builder',
        code: 'attacker_code',
        detailsDigest: hash('5'),
      },
      {
        schemaVersion: 'builder-response/v1',
        requestId: request.requestId,
        status: 'rejected',
        stage: 'builder',
        code: 'compiler_diagnostic',
        detailsDigest: hash('5'),
      },
    ]
  ) {
    let rejected = false;
    try {
      await validateBuilderResponse(response, request);
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});

const compiledResponse = (request: BuilderRequestV1, bytes: Uint8Array) => ({
  schemaVersion: 'builder-response/v1' as const,
  requestId: request.requestId,
  status: 'compiled' as const,
  sourceHash: request.sourceHash,
  compilerOptionsDigest: request.compilerOptionsDigest,
  emittedMediaType: 'application/javascript+module' as const,
  artifactBytesBase64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
  artifactByteCount: bytes.byteLength,
  diagnostics: [] as const,
  closure: { schemaVersion: 'module-closure/v1' as const, modules: [] as const },
});

Deno.test('Builder request source budget is inclusive and rejects one byte over', () => {
  const request: BuilderRequestV1 = {
    schemaVersion: 'builder-request/v1',
    requestId: `sha256:${'1'.repeat(64)}`,
    sourceHash: `sha256:${'2'.repeat(64)}`,
    sourceText: 'x'.repeat(ADMISSION_LIMITS.sourceUtf8Bytes),
    compilerOptionsDigest: `sha256:${'3'.repeat(64)}`,
    admissionProfileDigest: `sha256:${'4'.repeat(64)}`,
  };
  validateBuilderRequest(request);
  assertThrows(() =>
    validateBuilderRequest({
      ...request,
      sourceText: `${request.sourceText}x`,
    })
  );
});

Deno.test('Builder response artifact budget is inclusive and rejects one byte over', async () => {
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const request: BuilderRequestV1 = {
    schemaVersion: 'builder-request/v1',
    requestId: hash('1'),
    sourceHash: hash('2'),
    sourceText: 'x',
    compilerOptionsDigest: hash('3'),
    admissionProfileDigest: hash('4'),
  };
  const atLimit = compiledResponse(
    request,
    new Uint8Array(ADMISSION_LIMITS.emittedArtifactBytes),
  );
  await validateBuilderResponse(atLimit, request);
  const overLimit = compiledResponse(
    request,
    new Uint8Array(ADMISSION_LIMITS.emittedArtifactBytes + 1),
  );
  await assertRejects(() => validateBuilderResponse(overLimit, request));
});
