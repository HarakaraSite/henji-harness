import { canonicalBytes, contentHash } from '../../spike0/src/canonical_content.ts';
import { normalizeDefinitionContent } from '../../spike0/src/definition_content.ts';
import { domainDigest } from '../../spike1/src/digests.ts';
import { frameSubmission } from '../../spike1/src/intake_json.ts';
import { INTAKE_LIMITS, MAX_REVISION_BUDGET, measureStructure } from '../../spike1/src/limits.ts';
import { NORMALIZER_DIGEST } from '../../spike1/src/normalizer_identity.ts';
import { newCounters } from '../../spike1/src/observability.ts';
import { EMPTY_LEDGER } from '../../spike1/src/revision_outcome.ts';
import { revise, type RevisionRequestV1 } from '../../spike1/src/revision_service.ts';
import { admissionPolicyDigest } from '../src/admission_policy.ts';
import { buildAdmissionProfile } from '../src/admission_profile.ts';
import {
  AdmissionStateStore,
  EMPTY_ADMISSION_REGISTRY,
  EMPTY_ARTIFACT_INDEX,
} from '../src/admission_registry.ts';
import { admitCandidate } from '../src/admission_service.ts';
import { createAdmissionCounters } from '../src/observability.ts';
import { assert, assertEquals } from './test_helpers.ts';

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const acceptedSource = 'export default function(input: string): string { return input.trim(); }';

const acceptedOutcome = async (sourceText = acceptedSource) => {
  const base = normalizeDefinitionContent({
    schemaVersion: 'definition-content/v1',
    identity: { pluginId: 'p1', namespace: 'ns', kind: 'text-transform' },
    source: {
      mediaType: 'application/typescript',
      text: 'export default function(input: string): string { return input; }',
    },
    manifest: { displayName: 'P', description: '' },
    publicContract: { input: 'text', output: 'text' },
    pluginOwnedTests: [],
    config: {},
    requestedCapabilities: [],
  });
  const baseHash = await contentHash(base);
  const profileDigest = await domainDigest('henji/spike1/intake-profile/v1', INTAKE_LIMITS);
  const measured = measureStructure(base);
  const ticket = {
    schemaVersion: 'revision-ticket/v1' as const,
    ticketId: 'ticket-source',
    target: { pluginId: 'p1', namespace: 'ns', kind: 'text-transform' as const },
    exactBase: { revisionId: 'r0', contentHash: baseHash, deploymentStateDigest: 'd0' },
    allowedPaths: ['source' as const],
    mutationKind: 'full-replacement' as const,
    budget: { ...MAX_REVISION_BUDGET },
    evidenceScope: ['issue:1'],
    admissionProfile: 'future',
    policyVersion: 'policy-1',
  };
  const submission = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 'proposal-submission/v1',
    replacement: { mediaType: 'application/typescript', text: sourceText },
    reason: 'change',
    evidenceRefs: ['issue:1'],
    expectedEffect: 'better',
    knownRisks: [],
  }));
  const request: RevisionRequestV1 = {
    frame: frameSubmission([submission], INTAKE_LIMITS),
    envelope: {
      submissionId: 'submission-source',
      ticketId: ticket.ticketId,
      authorizedPath: 'source',
      origin: 'human',
      originEvidence: { actor: 'opaque' },
      hostPluginId: 'p1',
      hostNamespace: 'ns',
      normalizerDigest: NORMALIZER_DIGEST,
    },
    tickets: { tickets: { [ticket.ticketId]: ticket } },
    base: {
      schemaVersion: 'base-definition-snapshot/v1',
      revisionId: 'r0',
      contentHash: baseHash,
      target: ticket.target,
      resourceProfileDigest: profileDigest,
      canonicalByteCount: canonicalBytes(base).byteLength,
      structuralDepth: measured.depth,
      structuralEntryCount: measured.entries,
      content: base,
    },
    live: {
      baseRevisionId: 'r0',
      baseContentHash: baseHash,
      deploymentStateDigest: 'd0',
      policyVersion: 'policy-1',
    },
    ledger: EMPTY_LEDGER,
  };
  const result = await revise(request, {
    counters: newCounters(),
    identity: {
      issueRevisionId: () => `revision:${'1'.repeat(64)}`,
      now: () => '2026-08-19T09:00:00.000Z',
    },
  });
  assert(result.status === 'recorded' && result.outcome.status === 'accepted');
  return result.outcome;
};

const serviceFixture = async (outcome: Awaited<ReturnType<typeof acceptedOutcome>>) => {
  const profile = await buildAdmissionProfile();
  const policyDigest = await admissionPolicyDigest();
  const sealedId = outcome.candidate.sealedProposalId;
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const candidates = {
    schemaVersion: 'sealed-candidate-store/v1' as const,
    entries: { [sealedId]: outcome },
  };
  const grants = {
    schemaVersion: 'admission-grant-store/v1' as const,
    entries: {
      [sealedId]: {
        schemaVersion: 'admission-grant/v1' as const,
        grantId: 'grant-matrix',
        sealedProposalId: sealedId,
        revisionId: outcome.candidate.revision.revisionId,
        revisionDigest: outcome.candidate.revision.revisionDigest,
        contentHash: outcome.candidate.contentHash,
        admissionProfileDigest: profile.digest,
        policyDigest,
        issuedAt: '2026-08-19T09:00:00.000Z',
        expiresAt: '2026-08-19T09:15:00.000Z',
      },
    },
  };
  const builderDependencyDigest = hash('3');
  const preflightSourceDigest = hash('1');
  const identities = {
    preflightSourceDigest,
    builderSourceDigest: hash('2'),
    builderDependencyDigest,
    parserDigest: await domainDigest('henji/spike2/parser/v1', {
      product: 'typescript',
      version: '6.0.3',
      dependencyDigest: builderDependencyDigest,
      subsetManifestDigest: profile.subsetManifestDigest,
      preflightSourceDigest,
    }),
    compilerDigest: await domainDigest('henji/spike2/compiler/v1', {
      product: 'typescript',
      version: '6.0.3',
      dependencyDigest: builderDependencyDigest,
      compilerOptionsDigest: profile.compilerOptionsDigest,
    }),
    runtimeDigest: hash('6'),
  };
  const counters = createAdmissionCounters();
  return {
    candidates,
    grants,
    state: new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX),
    identityProvider: { snapshot: () => Promise.resolve(identities) },
    builderPaths: {
      denoExecutable: `${repositoryRoot}/.tools/deno/2.9.4/deno`,
      repositoryRoot,
      cacheDirectory: `${repositoryRoot}/.tools/deno-cache/spike2`,
    },
    buildRoot: '/unused-build-root',
    artifactDirectory: '/unused-artifact-root',
    clock: () => '2026-08-19T09:05:00.000Z',
    counters,
    request: { schemaVersion: 'admission-request/v1' as const, sealedProposalId: sealedId },
  };
};

const assertNoAdmissionSideEffects = (counters: ReturnType<typeof createAdmissionCounters>) =>
  assertEquals(
    [
      counters.clock,
      counters.broker,
      counters.builderProcess,
      counters.publish,
      counters.register,
      counters.currentWrite,
      counters.deploymentStateWrite,
    ],
    [0, 0, 0, 0, 0, 0, 0],
  );

const makeProcessRoot = async (prefix: string): Promise<string> => {
  const root = await Deno.makeTempDir({
    dir: `${repositoryRoot}/.tools/spike2-test-tmp`,
    prefix,
  });
  await Deno.mkdir(`${root}/spike2/builder`, { recursive: true, mode: 0o700 });
  await Deno.mkdir(`${root}/spike2/src`, { recursive: true, mode: 0o700 });
  await Deno.mkdir(`${root}/build`, { recursive: true, mode: 0o700 });
  await Deno.mkdir(`${root}/artifacts`, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${root}/deno.spike2.json`, '{}');
  await Deno.writeTextFile(`${root}/deno.spike2.lock`, '{"version":"5"}');
  return root;
};

Deno.test('Admission runs Builder once, publishes once, registers once, then exact-replays', async () => {
  const outcome = await acceptedOutcome();
  const profile = await buildAdmissionProfile();
  const policyDigest = await admissionPolicyDigest();
  const sealedId = outcome.candidate.sealedProposalId;
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const candidates = {
    schemaVersion: 'sealed-candidate-store/v1' as const,
    entries: { [sealedId]: outcome },
  };
  const grants = {
    schemaVersion: 'admission-grant-store/v1' as const,
    entries: {
      [sealedId]: {
        schemaVersion: 'admission-grant/v1' as const,
        grantId: 'grant-1',
        sealedProposalId: sealedId,
        revisionId: outcome.candidate.revision.revisionId,
        revisionDigest: outcome.candidate.revision.revisionDigest,
        contentHash: outcome.candidate.contentHash,
        admissionProfileDigest: profile.digest,
        policyDigest,
        issuedAt: '2026-08-19T09:00:00.000Z',
        expiresAt: '2026-08-19T09:15:00.000Z',
      },
    },
  };
  const testBase = `${repositoryRoot}/.tools/spike2-test-tmp`;
  const root = await Deno.makeTempDir({ dir: testBase, prefix: 'admission-' });
  const buildRoot = `${root}/build`;
  const artifactDirectory = `${root}/artifacts`;
  await Deno.mkdir(buildRoot, { mode: 0o700 });
  await Deno.mkdir(artifactDirectory, { mode: 0o700 });
  try {
    const counters = createAdmissionCounters();
    const builderDependencyDigest = hash('3');
    const preflightSourceDigest = hash('1');
    const identities = {
      preflightSourceDigest,
      builderSourceDigest: hash('2'),
      builderDependencyDigest,
      parserDigest: await domainDigest('henji/spike2/parser/v1', {
        product: 'typescript',
        version: '6.0.3',
        dependencyDigest: builderDependencyDigest,
        subsetManifestDigest: profile.subsetManifestDigest,
        preflightSourceDigest,
      }),
      compilerDigest: await domainDigest('henji/spike2/compiler/v1', {
        product: 'typescript',
        version: '6.0.3',
        dependencyDigest: builderDependencyDigest,
        compilerOptionsDigest: profile.compilerOptionsDigest,
      }),
      runtimeDigest: hash('6'),
    };
    const dependencies = {
      candidates,
      grants,
      state: new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX),
      identityProvider: { snapshot: () => Promise.resolve(identities) },
      builderPaths: {
        denoExecutable: `${repositoryRoot}/.tools/deno/2.9.4/deno`,
        repositoryRoot,
        cacheDirectory: `${repositoryRoot}/.tools/deno-cache/spike2`,
      },
      buildRoot,
      artifactDirectory,
      clock: () => '2026-08-19T09:05:00.000Z',
      counters,
    };
    const request = { schemaVersion: 'admission-request/v1', sealedProposalId: sealedId };
    const invalidCounters = createAdmissionCounters();
    const invalidIdentity = await admitCandidate(request, {
      ...dependencies,
      state: new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX),
      counters: invalidCounters,
      identityProvider: {
        snapshot: () => Promise.resolve({ ...identities, runtimeDigest: 'invalid' }),
      },
    });
    assertEquals(invalidIdentity, { status: 'rejected', code: 'identity_mismatch' });
    assertEquals(
      [invalidCounters.clock, invalidCounters.builderProcess, invalidCounters.publish],
      [0, 0, 0],
    );
    const extraIdentity = await admitCandidate(request, {
      ...dependencies,
      state: new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX),
      counters: invalidCounters,
      identityProvider: {
        snapshot: () => Promise.resolve({ ...identities, extraDigest: hash('7') } as never),
      },
    });
    assertEquals(extraIdentity, { status: 'rejected', code: 'identity_mismatch' });
    assertEquals(
      [invalidCounters.clock, invalidCounters.builderProcess, invalidCounters.publish],
      [0, 0, 0],
    );

    const originalExpiry = grants.entries[sealedId].expiresAt;
    const originalCandidate = candidates.entries[sealedId];
    const mutatedCandidate = structuredClone(originalCandidate);
    (mutatedCandidate.candidate.resolvedContent.source as { text: string }).text =
      'forbidden mutation';
    const admissionPromise = admitCandidate(request, dependencies);
    (grants.entries[sealedId] as { expiresAt: string }).expiresAt = '2026-08-19T09:00:00.000Z';
    (candidates.entries as Record<string, typeof originalCandidate>)[sealedId] = mutatedCandidate;
    (grants.entries[sealedId] as { expiresAt: string }).expiresAt = originalExpiry;
    (candidates.entries as Record<string, typeof originalCandidate>)[sealedId] = originalCandidate;
    const admitted = await admissionPromise;
    assertEquals(admitted.status, 'admitted');
    const replayed = await admitCandidate(request, dependencies);
    assertEquals(replayed.status, 'replayed');
    assertEquals(
      [
        counters.clock,
        counters.builderProcess,
        counters.publish,
        counters.register,
        counters.currentWrite,
        counters.deploymentStateWrite,
      ],
      [1, 1, 1, 1, 0, 0],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Admission authority and failure precedence preserve exact counters', async () => {
  const outcome = await acceptedOutcome();

  const invalidFixture = await serviceFixture(outcome);
  const invalidRequest = await admitCandidate({
    schemaVersion: 'admission-request/v1',
    sealedProposalId: invalidFixture.request.sealedProposalId,
    source: 'raw source is not an authority',
  }, invalidFixture);
  assertEquals(invalidRequest, { status: 'rejected', code: 'request_invalid' });
  assertNoAdmissionSideEffects(invalidFixture.counters);

  const snapshotFixture = await serviceFixture(outcome);
  const snapshotInvalid = await admitCandidate(snapshotFixture.request, {
    ...snapshotFixture,
    candidates: { schemaVersion: 'wrong', entries: {} } as never,
  });
  assertEquals(snapshotInvalid, { status: 'rejected', code: 'snapshot_invalid' });
  assertNoAdmissionSideEffects(snapshotFixture.counters);

  const missingCandidateFixture = await serviceFixture(outcome);
  const missingCandidate = await admitCandidate(missingCandidateFixture.request, {
    ...missingCandidateFixture,
    candidates: {
      schemaVersion: 'sealed-candidate-store/v1',
      entries: {},
    } as never,
  });
  assertEquals(missingCandidate, { status: 'rejected', code: 'candidate_not_found' });
  assertNoAdmissionSideEffects(missingCandidateFixture.counters);

  const missingGrantFixture = await serviceFixture(outcome);
  const missingGrant = await admitCandidate(missingGrantFixture.request, {
    ...missingGrantFixture,
    grants: {
      schemaVersion: 'admission-grant-store/v1',
      entries: {},
    } as never,
  });
  assertEquals(missingGrant, { status: 'rejected', code: 'grant_not_found' });
  assertNoAdmissionSideEffects(missingGrantFixture.counters);

  const identityFixture = await serviceFixture(outcome);
  const wrongGrant = structuredClone(identityFixture.grants);
  (wrongGrant.entries[identityFixture.request.sealedProposalId] as { revisionId: string })
    .revisionId = `revision:${'f'.repeat(64)}`;
  const identityMismatch = await admitCandidate(identityFixture.request, {
    ...identityFixture,
    grants: wrongGrant,
  });
  assertEquals(identityMismatch, { status: 'rejected', code: 'identity_mismatch' });
  assertNoAdmissionSideEffects(identityFixture.counters);

  const notYetFixture = await serviceFixture(outcome);
  notYetFixture.clock = () => '2026-08-19T08:59:59.999Z';
  const notYet = await admitCandidate(notYetFixture.request, notYetFixture);
  assertEquals(notYet, { status: 'rejected', code: 'grant_not_yet_valid' });
  assertEquals(notYetFixture.counters.clock, 1);
  assertEquals(
    [
      notYetFixture.counters.builderProcess,
      notYetFixture.counters.publish,
      notYetFixture.counters.register,
      notYetFixture.counters.currentWrite,
      notYetFixture.counters.deploymentStateWrite,
    ],
    [0, 0, 0, 0, 0],
  );

  const expiredFixture = await serviceFixture(outcome);
  expiredFixture.clock = () => '2026-08-19T09:15:00.000Z';
  const expired = await admitCandidate(expiredFixture.request, expiredFixture);
  assertEquals(expired, { status: 'rejected', code: 'grant_expired' });
  assertEquals(expiredFixture.counters.clock, 1);
  assertEquals(
    [
      expiredFixture.counters.builderProcess,
      expiredFixture.counters.publish,
      expiredFixture.counters.register,
      expiredFixture.counters.currentWrite,
      expiredFixture.counters.deploymentStateWrite,
    ],
    [0, 0, 0, 0, 0],
  );

  const syntaxFixture = await serviceFixture(
    await acceptedOutcome(
      'export default function(input: string): string { while (true) {} return input; }',
    ),
  );
  const syntaxRejected = await admitCandidate(syntaxFixture.request, syntaxFixture);
  assertEquals(syntaxRejected, { status: 'rejected', code: 'unsupported_syntax' });
  assertEquals(syntaxFixture.counters.clock, 1);
  assertEquals(
    [
      syntaxFixture.counters.builderProcess,
      syntaxFixture.counters.publish,
      syntaxFixture.counters.register,
      syntaxFixture.counters.currentWrite,
      syntaxFixture.counters.deploymentStateWrite,
    ],
    [0, 0, 0, 0, 0],
  );
});

Deno.test('Admission rederives every accepted-candidate identity before Builder', async () => {
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  const mutations: readonly [string, (candidate: Record<string, unknown>) => void][] = [
    [
      'submission nested field',
      (candidate) => {
        const submission = candidate.submission as Record<string, unknown>;
        submission.submissionId = hash('f');
      },
    ],
    [
      'submission binding digest',
      (candidate) => {
        const processing = candidate.processing as Record<string, unknown>;
        processing.submissionBindingDigest = hash('f');
      },
    ],
    [
      'processing nested field',
      (candidate) => {
        const processing = candidate.processing as Record<string, unknown>;
        processing.baseSnapshotDigest = hash('f');
      },
    ],
    [
      'processing key',
      (candidate) => {
        candidate.processingKey = hash('f');
      },
    ],
    [
      'provenance nested field',
      (candidate) => {
        const sealed = candidate.candidate as Record<string, unknown>;
        const provenance = sealed.provenance as Record<string, unknown>;
        provenance.hostNamespace = 'mutated-namespace';
      },
    ],
    [
      'provenance digest',
      (candidate) => {
        const sealed = candidate.candidate as Record<string, unknown>;
        const revision = sealed.revision as Record<string, unknown>;
        revision.provenanceDigest = hash('f');
      },
    ],
    [
      'revision digest',
      (candidate) => {
        const sealed = candidate.candidate as Record<string, unknown>;
        const revision = sealed.revision as Record<string, unknown>;
        revision.revisionDigest = hash('f');
      },
    ],
    [
      'revision base identity',
      (candidate) => {
        const sealed = candidate.candidate as Record<string, unknown>;
        const revision = sealed.revision as Record<string, unknown>;
        revision.baseRevisionId = 'mutated-base';
      },
    ],
    [
      'revision createdAt',
      (candidate) => {
        const sealed = candidate.candidate as Record<string, unknown>;
        const revision = sealed.revision as Record<string, unknown>;
        revision.createdAt = '2026-08-19T09:01:00.000Z';
      },
    ],
  ];
  for (const [, mutate] of mutations) {
    const fixture = await serviceFixture(await acceptedOutcome());
    const sealedId = fixture.request.sealedProposalId;
    const forged = structuredClone(fixture.candidates.entries[sealedId]) as unknown as Record<
      string,
      unknown
    >;
    mutate(forged);
    (fixture.candidates.entries as Record<string, unknown>)[sealedId] = forged;
    const result = await admitCandidate(fixture.request, fixture);
    assertEquals(result, { status: 'rejected', code: 'identity_mismatch' });
    assertNoAdmissionSideEffects(fixture.counters);
  }

  const sealedFixture = await serviceFixture(await acceptedOutcome());
  const originalSealedId = sealedFixture.request.sealedProposalId;
  const forgedSealedId = hash('f');
  const forged = structuredClone(
    sealedFixture.candidates.entries[originalSealedId],
  ) as unknown as Record<string, unknown>;
  (forged.candidate as Record<string, unknown>).sealedProposalId = forgedSealedId;
  const forgedGrant = structuredClone(
    sealedFixture.grants.entries[originalSealedId],
  ) as unknown as Record<string, unknown>;
  forgedGrant.sealedProposalId = forgedSealedId;
  (sealedFixture.candidates.entries as Record<string, unknown>)[forgedSealedId] = forged;
  delete (sealedFixture.candidates.entries as Record<string, unknown>)[originalSealedId];
  (sealedFixture.grants.entries as Record<string, unknown>)[forgedSealedId] = forgedGrant;
  delete (sealedFixture.grants.entries as Record<string, unknown>)[originalSealedId];
  const forgedRequest = { ...sealedFixture.request, sealedProposalId: forgedSealedId };
  const sealedResult = await admitCandidate(forgedRequest, sealedFixture);
  assertEquals(sealedResult, { status: 'rejected', code: 'identity_mismatch' });
  assertNoAdmissionSideEffects(sealedFixture.counters);
});

Deno.test('Admission rejects forged authority fields and keeps earlier failures dominant', async () => {
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  for (const field of ['contentHash', 'admissionProfileDigest', 'policyDigest'] as const) {
    const fixture = await serviceFixture(await acceptedOutcome());
    const sealedId = fixture.request.sealedProposalId;
    const forged = structuredClone(fixture.grants.entries[sealedId]);
    (forged as Record<string, unknown>)[field] = hash('f');
    (fixture.grants.entries as Record<string, unknown>)[sealedId] = forged;
    const result = await admitCandidate(fixture.request, fixture);
    assertEquals(result, { status: 'rejected', code: 'identity_mismatch' });
    assertNoAdmissionSideEffects(fixture.counters);
  }

  const candidateHashFixture = await serviceFixture(await acceptedOutcome());
  const candidateHashId = candidateHashFixture.request.sealedProposalId;
  const forgedCandidate = structuredClone(
    candidateHashFixture.candidates.entries[candidateHashId],
  );
  (forgedCandidate.candidate as { contentHash: string }).contentHash = hash('f');
  (candidateHashFixture.candidates.entries as Record<string, unknown>)[candidateHashId] =
    forgedCandidate;
  const candidateHashResult = await admitCandidate(
    candidateHashFixture.request,
    candidateHashFixture,
  );
  assertEquals(candidateHashResult, { status: 'rejected', code: 'identity_mismatch' });
  assertNoAdmissionSideEffects(candidateHashFixture.counters);

  const malformedHashFixture = await serviceFixture(await acceptedOutcome());
  const malformedHashId = malformedHashFixture.request.sealedProposalId;
  const malformedCandidate = structuredClone(
    malformedHashFixture.candidates.entries[malformedHashId],
  );
  (malformedCandidate.candidate.revision as { revisionDigest: string }).revisionDigest =
    'not-a-hash';
  (malformedHashFixture.candidates.entries as Record<string, unknown>)[malformedHashId] =
    malformedCandidate;
  const malformedHashResult = await admitCandidate(
    malformedHashFixture.request,
    malformedHashFixture,
  );
  assertEquals(malformedHashResult, { status: 'rejected', code: 'snapshot_invalid' });
  assertNoAdmissionSideEffects(malformedHashFixture.counters);

  const rejectedFixture = await serviceFixture(await acceptedOutcome());
  const rejectedId = rejectedFixture.request.sealedProposalId;
  const rejectedOutcome = structuredClone(rejectedFixture.candidates.entries[rejectedId]) as Record<
    string,
    unknown
  >;
  rejectedOutcome.status = 'rejected';
  (rejectedFixture.candidates.entries as Record<string, unknown>)[rejectedId] = rejectedOutcome;
  const rejectedResult = await admitCandidate(rejectedFixture.request, rejectedFixture);
  assertEquals(rejectedResult, { status: 'rejected', code: 'snapshot_invalid' });
  assertNoAdmissionSideEffects(rejectedFixture.counters);

  const precedenceFixture = await serviceFixture(await acceptedOutcome());
  const invalidRequest = await admitCandidate({ schemaVersion: 'wrong' }, {
    ...precedenceFixture,
    candidates: { schemaVersion: 'wrong', entries: {} } as never,
    identityProvider: { snapshot: () => Promise.reject(new Error('must not be called')) },
  });
  assertEquals(invalidRequest, { status: 'rejected', code: 'request_invalid' });
  assertNoAdmissionSideEffects(precedenceFixture.counters);

  const snapshotFailure = await admitCandidate(precedenceFixture.request, {
    ...precedenceFixture,
    candidates: { schemaVersion: 'wrong', entries: {} } as never,
    identityProvider: { snapshot: () => Promise.reject(new Error('must not be called')) },
  });
  assertEquals(snapshotFailure, { status: 'rejected', code: 'snapshot_invalid' });
  assertNoAdmissionSideEffects(precedenceFixture.counters);

  const lookupFixture = await serviceFixture(await acceptedOutcome());
  const missingGrant = await admitCandidate(lookupFixture.request, {
    ...lookupFixture,
    grants: { schemaVersion: 'admission-grant-store/v1', entries: {} } as never,
    identityProvider: { snapshot: () => Promise.reject(new Error('must not be called')) },
  });
  assertEquals(missingGrant, { status: 'rejected', code: 'grant_not_found' });
  assertNoAdmissionSideEffects(lookupFixture.counters);
});

Deno.test('Admission Builder terminal failure does not publish or register', async () => {
  const root = await makeProcessRoot('service-builder-timeout-');
  try {
    await Deno.writeTextFile(
      `${root}/spike2/builder/main.ts`,
      'setInterval(() => {}, 1_000);\n',
    );
    const fixture = await serviceFixture(await acceptedOutcome());
    fixture.buildRoot = `${root}/build`;
    fixture.artifactDirectory = `${root}/artifacts`;
    fixture.builderPaths = {
      ...fixture.builderPaths,
      repositoryRoot: root,
    };
    const result = await admitCandidate(fixture.request, fixture);
    assertEquals(result, { status: 'rejected', code: 'builder_timeout' });
    assertEquals(
      [
        fixture.counters.clock,
        fixture.counters.builderProcess,
        fixture.counters.publish,
        fixture.counters.register,
        fixture.counters.currentWrite,
        fixture.counters.deploymentStateWrite,
      ],
      [1, 1, 0, 0, 0, 0],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Admission artifact publish failure stops before registry write', async () => {
  const root = await makeProcessRoot('service-artifact-failure-');
  const artifactFile = `${root}/not-a-directory`;
  await Deno.writeTextFile(artifactFile, 'sentinel');
  try {
    const fixture = await serviceFixture(await acceptedOutcome());
    fixture.buildRoot = `${root}/build`;
    fixture.artifactDirectory = artifactFile;
    const result = await admitCandidate(fixture.request, fixture);
    assertEquals(result, { status: 'rejected', code: 'artifact_publish' });
    assertEquals(
      [
        fixture.counters.clock,
        fixture.counters.builderProcess,
        fixture.counters.publish,
        fixture.counters.register,
      ],
      [1, 1, 1, 0],
    );
    assertEquals(await Deno.readTextFile(artifactFile), 'sentinel');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Admission registry write failure reports orphan artifact and keeps current writes at zero', async () => {
  const root = await makeProcessRoot('service-registry-failure-');
  try {
    const fixture = await serviceFixture(await acceptedOutcome());
    fixture.buildRoot = `${root}/build`;
    fixture.artifactDirectory = `${root}/artifacts`;
    const failingState = {
      validateSnapshots: async () => await Promise.resolve(),
      transact: async (
        _key: string,
        operation: (context: {
          readonly existing: undefined;
          commitArtifact(entry: { artifactHash: string; byteCount: number }): void;
          appendRecord(record: unknown): Promise<void>;
        }) => Promise<unknown>,
      ) => {
        const value = await operation({
          existing: undefined,
          commitArtifact: () => undefined,
          appendRecord: async () => {
            await Promise.resolve();
            throw new Error('injected registry write failure');
          },
        });
        return { status: 'reserved' as const, value };
      },
    };
    const result = await admitCandidate(fixture.request, {
      ...fixture,
      state: failingState as never,
    });
    assert(result.status === 'rejected');
    assertEquals(result.code, 'registry_write');
    assert(result.orphanArtifactHash?.startsWith('sha256:'));
    assertEquals(
      [
        fixture.counters.clock,
        fixture.counters.builderProcess,
        fixture.counters.publish,
        fixture.counters.register,
        fixture.counters.currentWrite,
        fixture.counters.deploymentStateWrite,
      ],
      [1, 1, 1, 0, 0, 0],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
