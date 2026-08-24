import { canonicalize, contentHash } from '../../spike0/src/canonical_content.ts';
import { normalizeDefinitionContent } from '../../spike0/src/definition_content.ts';
import { domainDigest, rawDigest } from '../../spike1/src/digests.ts';
import { validateAdmissionRequest } from './admission_request.ts';
import { admissionGrantDigest, grantTimeStatus } from './admission_grant.ts';
import { admissionPolicyDigest } from './admission_policy.ts';
import { buildAdmissionProfile } from './admission_profile.ts';
import { artifactBytesFromResponse, type BuilderPathsV1, runBuilder } from './builder_process.ts';
import type { BuilderRequestV1 } from './builder_protocol.ts';
import {
  lookupAcceptedCandidate,
  type SealedCandidateStoreV1,
  validateCandidateStore,
} from './candidate_store.ts';
import {
  type AdmissionGrantStoreV1,
  lookupAdmissionGrant,
  validateGrantStore,
} from './grant_store.ts';
import {
  admissionKey,
  type AdmissionProcessingBindingV1,
  type AdmissionRecordV1,
  createAdmissionRecord,
} from './admission_record.ts';
import { AdmissionStateStore } from './admission_registry.ts';
import { type ArtifactMetadataV1, publishArtifact } from './artifact_store.ts';
import type { AdmissionCountersV1 } from './observability.ts';
import { digestValue, exactObject, validatedClone } from './runtime_schema.ts';
import { checkAcceptedSubset, PreflightError } from './subset_checker.ts';

export interface TrustedAdmissionIdentityV1 {
  readonly preflightSourceDigest: string;
  readonly builderSourceDigest: string;
  readonly builderDependencyDigest: string;
  readonly parserDigest: string;
  readonly compilerDigest: string;
  readonly runtimeDigest: string;
}

export interface TrustedAdmissionIdentityProviderV1 {
  snapshot(): Promise<TrustedAdmissionIdentityV1>;
}

export interface AdmissionServiceDependenciesV1 {
  readonly candidates: SealedCandidateStoreV1;
  readonly grants: AdmissionGrantStoreV1;
  readonly state: AdmissionStateStore;
  readonly identityProvider: TrustedAdmissionIdentityProviderV1;
  readonly builderPaths: Omit<BuilderPathsV1, 'emptyWorkingDirectory'>;
  readonly buildRoot: string;
  readonly artifactDirectory: string;
  readonly clock: () => string;
  readonly counters: AdmissionCountersV1;
}

export type AdmissionResultV1 =
  | { readonly status: 'admitted'; readonly record: AdmissionRecordV1 }
  | { readonly status: 'replayed'; readonly record: AdmissionRecordV1 }
  | { readonly status: 'rejected'; readonly code: string; readonly orphanArtifactHash?: string };

const reject = (code: string, orphanArtifactHash?: string): AdmissionResultV1 =>
  orphanArtifactHash === undefined
    ? { status: 'rejected', code }
    : { status: 'rejected', code, orphanArtifactHash };

const validateCandidateIdentity = async (
  candidate: NonNullable<ReturnType<typeof lookupAcceptedCandidate>>,
): Promise<void> => {
  if (candidate.status !== 'accepted') throw new Error('candidate status');
  const sealed = candidate.candidate;
  if (
    sealed.revision.revisionId === '' ||
    sealed.revision.contentHash !== sealed.contentHash ||
    sealed.revision.proposalDigest !== sealed.proposalDigest ||
    sealed.revision.ticketDigest !== sealed.ticketDigest
  ) throw new Error('candidate nested identity');
  const normalized = normalizeDefinitionContent(sealed.resolvedContent);
  if (canonicalize(normalized) !== canonicalize(sealed.resolvedContent)) {
    throw new Error('candidate not normalized');
  }
  if (await contentHash(normalized) !== sealed.contentHash) {
    throw new Error('candidate content hash');
  }
  const expectedSubmissionBindingDigest = await domainDigest(
    'henji/spike1/submission-binding/v1',
    candidate.submission,
  );
  const expectedProcessingKey = await domainDigest(
    'henji/spike1/processing/v1',
    candidate.processing,
  );
  const expectedProvenanceDigest = await domainDigest(
    'henji/spike1/provenance/v1',
    sealed.provenance,
  );
  const revisionWithoutDigest = {
    schemaVersion: 'definition-revision/v1' as const,
    revisionId: sealed.revision.revisionId,
    contentHash: sealed.revision.contentHash,
    baseRevisionId: sealed.revision.baseRevisionId,
    baseContentHash: sealed.revision.baseContentHash,
    provenanceDigest: sealed.revision.provenanceDigest,
    proposalDigest: sealed.revision.proposalDigest,
    ticketDigest: sealed.revision.ticketDigest,
    createdAt: sealed.revision.createdAt,
  };
  const expectedRevisionDigest = await domainDigest(
    'henji/spike1/revision/v1',
    revisionWithoutDigest,
  );
  const expectedSealedProposalId = await domainDigest('henji/spike1/sealed-proposal/v1', {
    proposalDigest: sealed.proposalDigest,
    ticketDigest: sealed.ticketDigest,
    baseSnapshotDigest: candidate.processing.baseSnapshotDigest,
    liveContextDigest: candidate.processing.liveContextDigest,
    provenanceDigest: candidate.processing.provenanceDigest,
    contentHash: sealed.contentHash,
  });
  if (
    candidate.processing.submissionBindingDigest !== expectedSubmissionBindingDigest ||
    candidate.processingKey !== expectedProcessingKey ||
    sealed.revision.provenanceDigest !== expectedProvenanceDigest ||
    sealed.revision.revisionDigest !== expectedRevisionDigest ||
    sealed.sealedProposalId !== expectedSealedProposalId
  ) throw new Error('candidate derived identity');
};

const validateTrustedIdentity = async (
  input: unknown,
  profile: Awaited<ReturnType<typeof buildAdmissionProfile>>,
): Promise<TrustedAdmissionIdentityV1> => {
  const fields = [
    'preflightSourceDigest',
    'builderSourceDigest',
    'builderDependencyDigest',
    'parserDigest',
    'compilerDigest',
    'runtimeDigest',
  ] as const;
  const raw = exactObject(input, fields, '$trustedIdentity');
  for (const field of fields) digestValue(raw[field], field);
  const identity = validatedClone(raw as unknown as TrustedAdmissionIdentityV1);
  const expectedParser = await domainDigest('henji/spike2/parser/v1', {
    product: 'typescript',
    version: '6.0.3',
    dependencyDigest: identity.builderDependencyDigest,
    subsetManifestDigest: profile.subsetManifestDigest,
    preflightSourceDigest: identity.preflightSourceDigest,
  });
  const expectedCompiler = await domainDigest('henji/spike2/compiler/v1', {
    product: 'typescript',
    version: '6.0.3',
    dependencyDigest: identity.builderDependencyDigest,
    compilerOptionsDigest: profile.compilerOptionsDigest,
  });
  if (identity.parserDigest !== expectedParser || identity.compilerDigest !== expectedCompiler) {
    throw new Error('trusted identity composition');
  }
  return identity;
};

export const admitCandidate = async (
  rawRequest: unknown,
  dependencies: AdmissionServiceDependenciesV1,
): Promise<AdmissionResultV1> => {
  let request;
  try {
    request = validateAdmissionRequest(rawRequest);
  } catch {
    return reject('request_invalid');
  }
  let candidates: SealedCandidateStoreV1;
  let grants: AdmissionGrantStoreV1;
  try {
    candidates = validateCandidateStore(dependencies.candidates);
    grants = validateGrantStore(dependencies.grants);
    await dependencies.state.validateSnapshots();
  } catch {
    return reject('snapshot_invalid');
  }
  const candidate = lookupAcceptedCandidate(candidates, request.sealedProposalId);
  if (!candidate) return reject('candidate_not_found');
  const grant = lookupAdmissionGrant(grants, request.sealedProposalId);
  if (!grant) return reject('grant_not_found');

  const profile = await buildAdmissionProfile();
  const policyDigest = await admissionPolicyDigest();
  let identities: TrustedAdmissionIdentityV1;
  try {
    identities = await validateTrustedIdentity(
      await dependencies.identityProvider.snapshot(),
      profile,
    );
  } catch {
    return reject('identity_mismatch');
  }
  try {
    await validateCandidateIdentity(candidate);
  } catch {
    return reject('identity_mismatch');
  }
  const sealed = candidate.candidate;
  if (
    grant.sealedProposalId !== sealed.sealedProposalId ||
    grant.revisionId !== sealed.revision.revisionId ||
    grant.revisionDigest !== sealed.revision.revisionDigest ||
    grant.contentHash !== sealed.contentHash || grant.admissionProfileDigest !== profile.digest ||
    grant.policyDigest !== policyDigest
  ) return reject('identity_mismatch');

  const binding: AdmissionProcessingBindingV1 = {
    schemaVersion: 'admission-processing-binding/v1',
    sealedCandidateDigest: await domainDigest('henji/spike2/sealed-candidate/v1', sealed),
    admissionGrantDigest: await admissionGrantDigest(grant),
    admissionProfileDigest: profile.digest,
    policyDigest,
    ...identities,
    compilerOptionsDigest: profile.compilerOptionsDigest,
  };
  const key = await admissionKey(binding);
  const transaction = await dependencies.state.transact(key, async (context) => {
    if (context.existing) {
      const expected = await createAdmissionRecord({
        binding,
        sealedProposalId: sealed.sealedProposalId,
        revisionId: sealed.revision.revisionId,
        revisionDigest: sealed.revision.revisionDigest,
        definitionContentHash: sealed.contentHash,
        proposalDigest: sealed.proposalDigest,
        ticketDigest: sealed.ticketDigest,
        artifactHash: context.existing.artifactHash,
        artifactByteCount: context.existing.artifactByteCount,
        createdAt: context.existing.createdAt,
      });
      if (canonicalize(expected) !== canonicalize(context.existing)) {
        return reject('admission_conflict');
      }
      return { status: 'replayed', record: context.existing } as AdmissionResultV1;
    }

    dependencies.counters.clock++;
    const now = dependencies.clock();
    const time = grantTimeStatus(grant, now);
    if (time === 'not-yet-valid') return reject('grant_not_yet_valid');
    if (time === 'expired') return reject('grant_expired');
    const content = sealed.resolvedContent;
    if (
      content.identity.kind !== 'text-transform' ||
      content.source.mediaType !== 'application/typescript' ||
      content.publicContract.input !== 'text' || content.publicContract.output !== 'text' ||
      content.requestedCapabilities.length !== 0
    ) return reject('contract_invalid');
    try {
      checkAcceptedSubset(content.source.text);
    } catch (error) {
      if (error instanceof PreflightError) return reject(error.code);
      return reject('syntax_invalid');
    }

    let workingDirectory: string | undefined;
    let orphanArtifactHash: string | undefined;
    try {
      workingDirectory = await Deno.makeTempDir({ dir: dependencies.buildRoot, prefix: 'build-' });
      const sourceHash = await rawDigest(
        'henji/spike2/candidate-source/v1',
        new TextEncoder().encode(content.source.text),
      );
      const builderRequest: BuilderRequestV1 = {
        schemaVersion: 'builder-request/v1',
        requestId: key,
        sourceHash,
        sourceText: content.source.text,
        compilerOptionsDigest: profile.compilerOptionsDigest,
        admissionProfileDigest: profile.digest,
      };
      dependencies.counters.builderProcess++;
      const built = await runBuilder({
        ...dependencies.builderPaths,
        emptyWorkingDirectory: workingDirectory,
      }, builderRequest);
      if (built.status === 'failed') return reject(built.code);
      if (built.response.status === 'rejected') return reject(built.response.code);
      const javascriptBytes = artifactBytesFromResponse(built.response);
      const metadata: ArtifactMetadataV1 = {
        schemaVersion: 'artifact-preimage/v1',
        emittedMediaType: 'application/javascript+module',
        compilerOptionsDigest: profile.compilerOptionsDigest,
        builderDependencyDigest: identities.builderDependencyDigest,
      };
      dependencies.counters.publish++;
      let published;
      try {
        published = await publishArtifact(
          dependencies.artifactDirectory,
          javascriptBytes,
          metadata,
          (entry) => {
            orphanArtifactHash = entry.artifactHash;
            context.commitArtifact(entry);
          },
        );
      } catch (error) {
        const code = error instanceof Error && error.message === 'artifact_collision'
          ? 'artifact_collision'
          : 'artifact_publish';
        return reject(code, orphanArtifactHash);
      }
      orphanArtifactHash = published.artifactHash;
      try {
        await Deno.remove(workingDirectory);
      } catch {
        return reject('artifact_publish', orphanArtifactHash);
      }
      workingDirectory = undefined;
      let record;
      try {
        record = await createAdmissionRecord({
          binding,
          sealedProposalId: sealed.sealedProposalId,
          revisionId: sealed.revision.revisionId,
          revisionDigest: sealed.revision.revisionDigest,
          definitionContentHash: sealed.contentHash,
          proposalDigest: sealed.proposalDigest,
          ticketDigest: sealed.ticketDigest,
          artifactHash: published.artifactHash,
          artifactByteCount: published.byteCount,
          createdAt: now,
        });
      } catch {
        return reject('record_invalid', orphanArtifactHash);
      }
      try {
        await context.appendRecord(record);
      } catch {
        return reject('registry_write', orphanArtifactHash);
      }
      dependencies.counters.register++;
      return { status: 'admitted', record } as AdmissionResultV1;
    } catch {
      return reject('builder_protocol', orphanArtifactHash);
    } finally {
      if (workingDirectory !== undefined) {
        try {
          await Deno.remove(workingDirectory);
        } catch {
          // The operation is already rejected; no candidate or artifact is removed here.
        }
      }
    }
  });
  if (transaction.status === 'rejected') return reject(transaction.code);
  return transaction.value;
};
