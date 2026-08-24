import { domainDigest } from '../../spike1/src/digests.ts';

export const FAILURE_PRECEDENCE = Object.freeze(
  [
    'request',
    'snapshot',
    'lookup',
    'identity',
    'replay-conflict-capacity',
    'grant-time',
    'content',
    'contract',
    'syntax',
    'dependency',
    'subset',
    'builder-capacity',
    'builder',
    'artifact',
    'record',
    'registry',
  ] as const,
);

export const REJECTION_CODES = Object.freeze(
  [
    'request_invalid',
    'snapshot_invalid',
    'candidate_not_found',
    'grant_not_found',
    'identity_mismatch',
    'admission_conflict',
    'registry_capacity',
    'artifact_capacity',
    'grant_invalid',
    'grant_not_yet_valid',
    'grant_expired',
    'content_invalid',
    'contract_invalid',
    'syntax_invalid',
    'dependency_forbidden',
    'unsupported_syntax',
    'subset_budget',
    'builder_busy',
    'builder_timeout',
    'builder_protocol',
    'compiler_diagnostic',
    'artifact_oversize',
    'artifact_publish',
    'artifact_collision',
    'record_invalid',
    'registry_write',
  ] as const,
);

export const ADMISSION_POLICY = Object.freeze(
  {
    schemaVersion: 'admission-policy/v1',
    policyVersion: 'spike2-policy-1',
    acceptedKind: 'text-transform',
    acceptedMediaType: 'application/typescript',
    requestedCapabilities: 'must-be-empty',
    dependencySyntax: 'deny-all',
    unknownSyntax: 'reject',
    compilerDiagnostics: 'reject-any',
    publishPrimitive: 'same-filesystem-hard-link-no-replace',
    existingAddress: 'same-bytes-idempotent',
    collision: 'reject-without-overwrite',
    registryWriter: 'module-private-capability-only',
    maxGrantTtlMilliseconds: 900_000,
    failurePrecedence: FAILURE_PRECEDENCE,
    rejectionCodes: REJECTION_CODES,
  } as const,
);

export type AdmissionRejectionCode = typeof REJECTION_CODES[number];

export const admissionPolicyDigest = async (): Promise<string> =>
  await domainDigest('henji/spike2/admission-policy/v1', ADMISSION_POLICY);
