import { ADMISSION_LIMITS } from './admission_profile.ts';
import { type AdmissionGrantV1, validateAdmissionGrant } from './admission_grant.ts';
import {
  boundedWalk,
  canonicalSizeAtMost,
  exactObject,
  isPlainObject,
  validatedClone,
} from './runtime_schema.ts';

export interface AdmissionGrantStoreV1 {
  readonly schemaVersion: 'admission-grant-store/v1';
  readonly entries: Readonly<Record<string, AdmissionGrantV1>>;
}

export const validateGrantStore = (input: unknown): AdmissionGrantStoreV1 => {
  const root = exactObject(input, ['schemaVersion', 'entries'], '$grantStore');
  if (root.schemaVersion !== 'admission-grant-store/v1' || !isPlainObject(root.entries)) {
    throw new Error('grant store schema');
  }
  const keys = Reflect.ownKeys(root.entries);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('grant store symbol key');
  if (keys.length > ADMISSION_LIMITS.grantStoreEntries) throw new Error('grant store count');
  boundedWalk(root, 16, ADMISSION_LIMITS.grantStoreEntries * 16);
  canonicalSizeAtMost(root, ADMISSION_LIMITS.grantStoreCanonicalBytes, '$grantStore');
  const grantIds = new Set<string>();
  const entries = root.entries as Record<string, AdmissionGrantV1>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('grant entry');
    const grant = validateAdmissionGrant(descriptor.value);
    if (grant.sealedProposalId !== key || grantIds.has(grant.grantId)) {
      throw new Error('grant store identity');
    }
    grantIds.add(grant.grantId);
  }
  return validatedClone(input as AdmissionGrantStoreV1);
};

export const lookupAdmissionGrant = (
  store: AdmissionGrantStoreV1,
  sealedProposalId: string,
): AdmissionGrantV1 | undefined => store.entries[sealedProposalId];
