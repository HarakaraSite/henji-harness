import { canonicalBytes } from '../../spike0/src/canonical_content.ts';
import { decodeBoundedJson, frameSubmission, IntakeError } from '../../spike1/src/intake_json.ts';
import type { IntakeLimitProfileV1 } from '../../spike1/src/limits.ts';
import { ADMISSION_LIMITS } from './admission_profile.ts';
import { digestValue, exactObject, stringValue } from './runtime_schema.ts';

const jsonProfile = (maxRawBytes: number): IntakeLimitProfileV1 => ({
  schemaVersion: 'intake-limits/v1',
  maxRawBytes,
  maxDecodedStringBytesEach: maxRawBytes,
  maxDecodedStringBytesTotal: maxRawBytes,
  maxObjectProperties: 64,
  maxArrayItems: 64,
  maxDepth: 16,
  maxBaseCanonicalBytes: 1,
  maxBaseEntries: 1,
  maxBaseDepth: 1,
  maxTicketEvidenceScopeEntries: 1,
  maxTicketEvidenceScopeBytesTotal: 1,
  maxTicketCanonicalBytes: 1,
  maxLedgerEntries: 1,
  maxOutcomeCanonicalBytes: 1,
  maxLedgerOutcomeBytes: 1,
  maxLedgerCanonicalBytes: 1,
  maxTrustedIdBytesEach: maxRawBytes,
  maxTrustedMetadataBytesEach: maxRawBytes,
  maxOriginEvidenceCanonicalBytes: 1,
});

export interface BuilderRequestV1 {
  readonly schemaVersion: 'builder-request/v1';
  readonly requestId: string;
  readonly sourceHash: string;
  readonly sourceText: string;
  readonly compilerOptionsDigest: string;
  readonly admissionProfileDigest: string;
}

export interface BuilderCompiledResponseV1 {
  readonly schemaVersion: 'builder-response/v1';
  readonly requestId: string;
  readonly status: 'compiled';
  readonly sourceHash: string;
  readonly compilerOptionsDigest: string;
  readonly emittedMediaType: 'application/javascript+module';
  readonly artifactBytesBase64: string;
  readonly artifactByteCount: number;
  readonly diagnostics: readonly [];
  readonly closure: { readonly schemaVersion: 'module-closure/v1'; readonly modules: readonly [] };
}

export interface BuilderRejectedResponseV1 {
  readonly schemaVersion: 'builder-response/v1';
  readonly requestId: string;
  readonly status: 'rejected';
  readonly stage: string;
  readonly code: string;
  readonly detailsDigest: string;
}

export type BuilderResponseV1 = BuilderCompiledResponseV1 | BuilderRejectedResponseV1;

export const encodeFrame = (value: unknown, maxPayloadBytes: number): Uint8Array => {
  const payload = canonicalBytes(value);
  if (payload.byteLength === 0 || payload.byteLength > maxPayloadBytes) {
    throw new Error('frame payload limit');
  }
  const result = new Uint8Array(4 + payload.byteLength);
  new DataView(result.buffer).setUint32(0, payload.byteLength, false);
  result.set(payload, 4);
  return result;
};

export const decodeFrame = (bytes: Uint8Array, maxPayloadBytes: number): unknown => {
  if (bytes.byteLength < 4) throw new Error('frame truncated');
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > maxPayloadBytes || bytes.byteLength !== 4 + length) {
    throw new Error('frame length');
  }
  try {
    return decodeBoundedJson(
      frameSubmission([bytes.subarray(4)], jsonProfile(maxPayloadBytes)),
      jsonProfile(maxPayloadBytes),
    );
  } catch (error) {
    if (error instanceof IntakeError) throw new Error(`frame ${error.code}`);
    throw error;
  }
};

export const validateBuilderRequest = (value: unknown): BuilderRequestV1 => {
  const request = exactObject(value, [
    'schemaVersion',
    'requestId',
    'sourceHash',
    'sourceText',
    'compilerOptionsDigest',
    'admissionProfileDigest',
  ], '$builderRequest');
  if (request.schemaVersion !== 'builder-request/v1') throw new Error('builder request version');
  const sourceText = stringValue(
    request.sourceText,
    'sourceText',
    ADMISSION_LIMITS.sourceUtf8Bytes,
  );
  return {
    schemaVersion: 'builder-request/v1',
    requestId: stringValue(request.requestId, 'requestId'),
    sourceHash: digestValue(request.sourceHash, 'sourceHash'),
    sourceText,
    compilerOptionsDigest: digestValue(request.compilerOptionsDigest, 'compilerOptionsDigest'),
    admissionProfileDigest: digestValue(request.admissionProfileDigest, 'admissionProfileDigest'),
  };
};

export const decodeBuilderRequestFrame = (bytes: Uint8Array): BuilderRequestV1 =>
  validateBuilderRequest(decodeFrame(bytes, ADMISSION_LIMITS.builderRequestBytes));
