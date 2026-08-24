import { domainDigest } from '../../spike1/src/digests.ts';
import {
  canonicalSizeAtMost,
  digestValue,
  exactObject,
  stringValue,
  timestampValue,
} from './runtime_schema.ts';

export interface AdmissionGrantV1 {
  readonly schemaVersion: 'admission-grant/v1';
  readonly grantId: string;
  readonly sealedProposalId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly contentHash: string;
  readonly admissionProfileDigest: string;
  readonly policyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export const validateAdmissionGrant = (input: unknown): AdmissionGrantV1 => {
  const grant = exactObject(input, [
    'schemaVersion',
    'grantId',
    'sealedProposalId',
    'revisionId',
    'revisionDigest',
    'contentHash',
    'admissionProfileDigest',
    'policyDigest',
    'issuedAt',
    'expiresAt',
  ], '$grant');
  canonicalSizeAtMost(grant, 4096, '$grant');
  if (grant.schemaVersion !== 'admission-grant/v1') throw new Error('grant schemaVersion');
  const result: AdmissionGrantV1 = {
    schemaVersion: 'admission-grant/v1',
    grantId: stringValue(grant.grantId, 'grantId'),
    sealedProposalId: digestValue(grant.sealedProposalId, 'sealedProposalId'),
    revisionId: stringValue(grant.revisionId, 'revisionId'),
    revisionDigest: digestValue(grant.revisionDigest, 'revisionDigest'),
    contentHash: digestValue(grant.contentHash, 'contentHash'),
    admissionProfileDigest: digestValue(grant.admissionProfileDigest, 'admissionProfileDigest'),
    policyDigest: digestValue(grant.policyDigest, 'policyDigest'),
    issuedAt: timestampValue(grant.issuedAt, 'issuedAt'),
    expiresAt: timestampValue(grant.expiresAt, 'expiresAt'),
  };
  const issued = Date.parse(result.issuedAt);
  const expires = Date.parse(result.expiresAt);
  if (issued >= expires || expires - issued > 900_000) throw new Error('grant lifetime');
  return result;
};

export const admissionGrantDigest = async (grant: AdmissionGrantV1): Promise<string> =>
  await domainDigest('henji/spike2/admission-grant/v1', grant);

export type GrantTimeStatus = 'valid' | 'not-yet-valid' | 'expired';
export const grantTimeStatus = (grant: AdmissionGrantV1, now: string): GrantTimeStatus => {
  const current = Date.parse(timestampValue(now, 'now'));
  if (current < Date.parse(grant.issuedAt)) return 'not-yet-valid';
  if (current >= Date.parse(grant.expiresAt)) return 'expired';
  return 'valid';
};
