export interface CandidateDefinitionRevisionV1 {
  readonly schemaVersion: 'definition-revision/v1';
  readonly revisionId: string;
  readonly contentHash: string;
  readonly baseRevisionId: string;
  readonly baseContentHash: string;
  readonly provenanceDigest: string;
  readonly proposalDigest: string;
  readonly ticketDigest: string;
  readonly createdAt: string;
  readonly revisionDigest: string;
}

export interface RevisionIdentityPort {
  issueRevisionId(): string;
  now(): string;
}
