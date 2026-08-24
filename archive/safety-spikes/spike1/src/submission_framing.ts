import { domainDigest } from './digests.ts';
import { type BoundedSubmissionFrameV1, frameSubmission, IntakeError } from './intake_json.ts';
import { INTAKE_LIMITS } from './limits.ts';
import type { RevisionOutcomeLedgerV1, RevisionServiceRefusalV1 } from './revision_outcome.ts';

export type SubmissionFrameResult =
  | {
    readonly status: 'framed';
    readonly frame: BoundedSubmissionFrameV1;
    readonly ledger: RevisionOutcomeLedgerV1;
  }
  | {
    readonly status: 'refused';
    readonly refusal: RevisionServiceRefusalV1;
    readonly ledger: RevisionOutcomeLedgerV1;
  };

export const frameForRevisionService = async (
  chunks: readonly Uint8Array[],
  ledger: RevisionOutcomeLedgerV1,
): Promise<SubmissionFrameResult> => {
  try {
    return { status: 'framed', frame: frameSubmission(chunks, INTAKE_LIMITS), ledger };
  } catch (error) {
    if (!(error instanceof IntakeError) || error.code !== 'oversize_input') throw error;
    return {
      status: 'refused',
      refusal: {
        status: 'refused',
        code: 'oversize_input',
        submissionId: null,
        detailsDigest: await domainDigest('henji/spike1/service-refusal/v1', {
          code: 'oversize_input',
          submissionId: null,
          details: 'redacted',
        }),
      },
      ledger,
    };
  }
};
