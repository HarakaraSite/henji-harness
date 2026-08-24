import { canonicalSizeAtMost, exactObject, stringValue } from './runtime_schema.ts';

export interface AdmissionRequestV1 {
  readonly schemaVersion: 'admission-request/v1';
  readonly sealedProposalId: string;
}

export const validateAdmissionRequest = (input: unknown): AdmissionRequestV1 => {
  const request = exactObject(input, ['schemaVersion', 'sealedProposalId'], '$request');
  canonicalSizeAtMost(request, 512, '$request');
  if (request.schemaVersion !== 'admission-request/v1') throw new Error('request schemaVersion');
  const sealedProposalId = stringValue(request.sealedProposalId, 'sealedProposalId');
  if (!/^sha256:[0-9a-f]{64}$/.test(sealedProposalId)) throw new Error('sealedProposalId format');
  return { schemaVersion: 'admission-request/v1', sealedProposalId };
};
