import type { CandidateOrigin } from './definition_proposal.ts';
export interface IntakeProvenanceV1 {
  readonly origin: CandidateOrigin;
  readonly originalContentHash: string;
  readonly normalizerDigest: string;
  readonly hostPluginId: string;
  readonly hostNamespace: string;
  readonly originEvidenceDigest: string;
}
