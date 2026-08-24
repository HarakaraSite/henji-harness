import type { DefinitionContentV1 } from '../../spike0/src/definition_content.ts';
import type { CandidateOrigin, RevisionPath } from './definition_proposal.ts';
import type { CandidateDefinitionRevisionV1 } from './definition_revision.ts';
import type { IntakeProvenanceV1 } from './provenance.ts';

export interface SubmissionBindingV1 {
  readonly submissionId: string;
  readonly originalContentHash: string;
  readonly ticketId: string;
  readonly authorizedPath: RevisionPath;
  readonly origin: CandidateOrigin;
  readonly originEvidenceDigest: string;
  readonly hostPluginId: string;
  readonly hostNamespace: string;
  readonly normalizerDigest: string;
  readonly intakeProfileDigest: string;
}
export interface ProcessingBindingV1 {
  readonly submissionBindingDigest: string;
  readonly proposalDigest: string;
  readonly ticketDigest: string;
  readonly baseSnapshotDigest: string;
  readonly liveContextDigest: string;
  readonly provenanceDigest: string;
  readonly revisionBudgetDigest: string;
}
export interface SealedCandidateV1 {
  readonly proposalId: string;
  readonly sealedProposalId: string;
  readonly ticketDigest: string;
  readonly proposalDigest: string;
  readonly provenance: IntakeProvenanceV1;
  readonly resolvedContent: DefinitionContentV1;
  readonly contentHash: string;
  readonly revision: CandidateDefinitionRevisionV1;
}
export interface ProposalRejectionV1 {
  readonly intakeId: string;
  readonly proposalId: string | null;
  readonly ticketId: string | null;
  readonly origin: CandidateOrigin;
  readonly originalContentHash: string;
  readonly stage: 'intake' | 'ticket' | 'stale' | 'scope' | 'budget' | 'merge' | 'seal';
  readonly code: string;
  readonly detailsDigest: string;
}
export type RevisionOutcomeV1 =
  | {
    readonly status: 'accepted';
    readonly submission: SubmissionBindingV1;
    readonly processing: ProcessingBindingV1;
    readonly processingKey: string;
    readonly candidate: SealedCandidateV1;
  }
  | {
    readonly status: 'rejected';
    readonly submission: SubmissionBindingV1;
    readonly processing: ProcessingBindingV1 | null;
    readonly processingKey: string | null;
    readonly rejection: ProposalRejectionV1;
  };
export interface RevisionOutcomeLedgerV1 {
  readonly schemaVersion: 'revision-outcome-ledger/v1';
  readonly entries: readonly RevisionOutcomeV1[];
}
export interface RevisionServiceRefusalV1 {
  readonly status: 'refused';
  readonly code: 'oversize_input' | 'ledger_capacity' | 'submission_conflict';
  readonly submissionId: string | null;
  readonly detailsDigest: string;
}
export type RevisionServiceResultV1 =
  | {
    readonly status: 'recorded';
    readonly outcome: RevisionOutcomeV1;
    readonly ledger: RevisionOutcomeLedgerV1;
  }
  | {
    readonly status: 'replayed';
    readonly outcome: RevisionOutcomeV1;
    readonly ledger: RevisionOutcomeLedgerV1;
  }
  | {
    readonly status: 'refused';
    readonly refusal: RevisionServiceRefusalV1;
    readonly ledger: RevisionOutcomeLedgerV1;
  };

export const EMPTY_LEDGER: RevisionOutcomeLedgerV1 = Object.freeze({
  schemaVersion: 'revision-outcome-ledger/v1',
  entries: Object.freeze([]),
});
