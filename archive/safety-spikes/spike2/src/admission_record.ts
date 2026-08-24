import { domainDigest } from '../../spike1/src/digests.ts';
import { ADMISSION_LIMITS } from './admission_profile.ts';
import { canonicalSizeAtMost, digestValue, exactObject, timestampValue } from './runtime_schema.ts';

export interface AdmissionProcessingBindingV1 {
  readonly schemaVersion: 'admission-processing-binding/v1';
  readonly sealedCandidateDigest: string;
  readonly admissionGrantDigest: string;
  readonly admissionProfileDigest: string;
  readonly policyDigest: string;
  readonly preflightSourceDigest: string;
  readonly builderSourceDigest: string;
  readonly builderDependencyDigest: string;
  readonly parserDigest: string;
  readonly compilerDigest: string;
  readonly runtimeDigest: string;
  readonly compilerOptionsDigest: string;
}

export interface AdmissionRecordV1 {
  readonly schemaVersion: 'admission-record/v1';
  readonly admissionKey: string;
  readonly admissionId: string;
  readonly sealedProposalId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly definitionContentHash: string;
  readonly proposalDigest: string;
  readonly ticketDigest: string;
  readonly admissionGrantDigest: string;
  readonly admissionProfileDigest: string;
  readonly policyDigest: string;
  readonly preflightSourceDigest: string;
  readonly builderSourceDigest: string;
  readonly builderDependencyDigest: string;
  readonly parserDigest: string;
  readonly compilerDigest: string;
  readonly runtimeDigest: string;
  readonly compilerOptionsDigest: string;
  readonly closureDigest: string;
  readonly artifactHash: string;
  readonly artifactByteCount: number;
  readonly createdAt: string;
  readonly admissionDigest: string;
}

export const admissionKey = async (binding: AdmissionProcessingBindingV1): Promise<string> =>
  await domainDigest('henji/spike2/admission-key/v1', binding);

export const closureDigest = async (): Promise<string> =>
  await domainDigest('henji/spike2/module-closure/v1', {
    schemaVersion: 'module-closure/v1',
    modules: [],
  });

export interface AdmissionRecordInputV1 {
  readonly binding: AdmissionProcessingBindingV1;
  readonly sealedProposalId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly definitionContentHash: string;
  readonly proposalDigest: string;
  readonly ticketDigest: string;
  readonly artifactHash: string;
  readonly artifactByteCount: number;
  readonly createdAt: string;
}

export const createAdmissionRecord = async (
  input: AdmissionRecordInputV1,
): Promise<AdmissionRecordV1> => {
  const key = await admissionKey(input.binding);
  const closure = await closureDigest();
  const id = await domainDigest('henji/spike2/admission-id/v1', {
    admissionKey: key,
    artifactHash: input.artifactHash,
    closureDigest: closure,
  });
  const withoutDigest = {
    schemaVersion: 'admission-record/v1' as const,
    admissionKey: key,
    admissionId: id,
    sealedProposalId: input.sealedProposalId,
    revisionId: input.revisionId,
    revisionDigest: input.revisionDigest,
    definitionContentHash: input.definitionContentHash,
    proposalDigest: input.proposalDigest,
    ticketDigest: input.ticketDigest,
    admissionGrantDigest: input.binding.admissionGrantDigest,
    admissionProfileDigest: input.binding.admissionProfileDigest,
    policyDigest: input.binding.policyDigest,
    preflightSourceDigest: input.binding.preflightSourceDigest,
    builderSourceDigest: input.binding.builderSourceDigest,
    builderDependencyDigest: input.binding.builderDependencyDigest,
    parserDigest: input.binding.parserDigest,
    compilerDigest: input.binding.compilerDigest,
    runtimeDigest: input.binding.runtimeDigest,
    compilerOptionsDigest: input.binding.compilerOptionsDigest,
    closureDigest: closure,
    artifactHash: input.artifactHash,
    artifactByteCount: input.artifactByteCount,
    createdAt: timestampValue(input.createdAt, 'createdAt'),
  };
  const record = {
    ...withoutDigest,
    admissionDigest: await domainDigest('henji/spike2/admission-record/v1', withoutDigest),
  };
  validateAdmissionRecord(record);
  return record;
};

export const validateAdmissionRecord = (input: unknown): AdmissionRecordV1 => {
  const keys = [
    'schemaVersion',
    'admissionKey',
    'admissionId',
    'sealedProposalId',
    'revisionId',
    'revisionDigest',
    'definitionContentHash',
    'proposalDigest',
    'ticketDigest',
    'admissionGrantDigest',
    'admissionProfileDigest',
    'policyDigest',
    'preflightSourceDigest',
    'builderSourceDigest',
    'builderDependencyDigest',
    'parserDigest',
    'compilerDigest',
    'runtimeDigest',
    'compilerOptionsDigest',
    'closureDigest',
    'artifactHash',
    'artifactByteCount',
    'createdAt',
    'admissionDigest',
  ] as const;
  const record = exactObject(input, keys, '$record');
  if (record.schemaVersion !== 'admission-record/v1') throw new Error('record version');
  for (const field of keys) {
    if (
      field.endsWith('Digest') || field.endsWith('Hash') ||
      ['admissionKey', 'admissionId'].includes(field)
    ) {
      digestValue(record[field], field);
    }
  }
  digestValue(record.sealedProposalId, 'sealedProposalId');
  if (!/^revision:[0-9a-f]{64}$/.test(String(record.revisionId))) {
    throw new Error('record revisionId');
  }
  if (
    !Number.isSafeInteger(record.artifactByteCount) || Number(record.artifactByteCount) < 0 ||
    Number(record.artifactByteCount) > ADMISSION_LIMITS.emittedArtifactBytes
  ) throw new Error('record artifact bytes');
  timestampValue(record.createdAt, 'createdAt');
  canonicalSizeAtMost(record, ADMISSION_LIMITS.admissionRecordCanonicalBytes, '$record');
  return input as AdmissionRecordV1;
};

export const validateAdmissionRecordIntegrity = async (
  input: unknown,
): Promise<AdmissionRecordV1> => {
  const record = validateAdmissionRecord(input);
  const expectedClosure = await closureDigest();
  if (record.closureDigest !== expectedClosure) throw new Error('record closure digest');
  const expectedId = await domainDigest('henji/spike2/admission-id/v1', {
    admissionKey: record.admissionKey,
    artifactHash: record.artifactHash,
    closureDigest: record.closureDigest,
  });
  if (record.admissionId !== expectedId) throw new Error('record admissionId');
  const { admissionDigest: _admissionDigest, ...withoutDigest } = record;
  const expectedDigest = await domainDigest('henji/spike2/admission-record/v1', withoutDigest);
  if (record.admissionDigest !== expectedDigest) throw new Error('record admissionDigest');
  return record;
};
