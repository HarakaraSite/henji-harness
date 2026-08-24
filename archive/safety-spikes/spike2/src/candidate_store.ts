import type { RevisionOutcomeV1 } from '../../spike1/src/revision_outcome.ts';
import { validateLedgerRuntime } from '../../spike1/src/runtime_schema.ts';
import { ADMISSION_LIMITS } from './admission_profile.ts';
import {
  boundedWalk,
  canonicalSizeAtMost,
  exactObject,
  isPlainObject,
  validatedClone,
} from './runtime_schema.ts';

export type AcceptedRevisionOutcomeV1 = Extract<RevisionOutcomeV1, { readonly status: 'accepted' }>;

export interface SealedCandidateStoreV1 {
  readonly schemaVersion: 'sealed-candidate-store/v1';
  readonly entries: Readonly<Record<string, AcceptedRevisionOutcomeV1>>;
}

export const validateCandidateStore = (input: unknown): SealedCandidateStoreV1 => {
  const root = exactObject(input, ['schemaVersion', 'entries'], '$candidateStore');
  if (root.schemaVersion !== 'sealed-candidate-store/v1' || !isPlainObject(root.entries)) {
    throw new Error('candidate store schema');
  }
  const keys = Reflect.ownKeys(root.entries);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('candidate store symbol key');
  if (keys.length > ADMISSION_LIMITS.candidateStoreEntries) {
    throw new Error('candidate store count');
  }
  boundedWalk(root, ADMISSION_LIMITS.astDepth, ADMISSION_LIMITS.astNodes * 64);
  canonicalSizeAtMost(root, ADMISSION_LIMITS.candidateStoreCanonicalBytes, '$candidateStore');
  const entries = root.entries as Record<string, AcceptedRevisionOutcomeV1>;
  const submissionIds = new Set<string>();
  const proposalIds = new Set<string>();
  const processingKeys = new Set<string>();
  const revisionIds = new Set<string>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('candidate entry');
    const outcome = descriptor.value;
    validateLedgerRuntime({ schemaVersion: 'revision-outcome-ledger/v1', entries: [outcome] });
    if (outcome.status !== 'accepted' || outcome.candidate.sealedProposalId !== key) {
      throw new Error('candidate store identity');
    }
    if (
      submissionIds.has(outcome.submission.submissionId) ||
      proposalIds.has(outcome.candidate.proposalId) || processingKeys.has(outcome.processingKey) ||
      revisionIds.has(outcome.candidate.revision.revisionId)
    ) throw new Error('candidate store duplicate inner identity');
    submissionIds.add(outcome.submission.submissionId);
    proposalIds.add(outcome.candidate.proposalId);
    processingKeys.add(outcome.processingKey);
    revisionIds.add(outcome.candidate.revision.revisionId);
    canonicalSizeAtMost(outcome, ADMISSION_LIMITS.canonicalCandidateSnapshotBytes, '$candidate');
  }
  return validatedClone(input as SealedCandidateStoreV1);
};

export const lookupAcceptedCandidate = (
  store: SealedCandidateStoreV1,
  sealedProposalId: string,
): AcceptedRevisionOutcomeV1 | undefined => store.entries[sealedProposalId];
