import { canonicalBytes, contentHash } from '../../spike0/src/canonical_content.ts';
import { normalizeDefinitionContent } from '../../spike0/src/definition_content.ts';
import { frameSubmission } from '../src/intake_json.ts';
import { INTAKE_LIMITS, MAX_REVISION_BUDGET, measureStructure } from '../src/limits.ts';
import { newCounters } from '../src/observability.ts';
import { NORMALIZER_DIGEST } from '../src/normalizer_identity.ts';
import { EMPTY_LEDGER } from '../src/revision_outcome.ts';
import { revise, type RevisionRequestV1 } from '../src/revision_service.ts';
import { domainDigest } from '../src/digests.ts';
import { validateLedgerRuntime } from '../src/runtime_schema.ts';
import { assert, assertEquals } from './assert.ts';

const encoder = new TextEncoder();
const submission = (replacement: unknown = { mode: 'new' }) =>
  encoder.encode(JSON.stringify({
    schemaVersion: 'proposal-submission/v1',
    replacement,
    reason: 'change',
    evidenceRefs: ['issue:1'],
    expectedEffect: 'better',
    knownRisks: ['risk'],
  }));

const fixture = async (origin: 'ai' | 'human' | 'third-party' | 'legacy' = 'human') => {
  const base = normalizeDefinitionContent({
    schemaVersion: 'definition-content/v1',
    identity: { pluginId: 'p1', namespace: 'ns', kind: 'text-transform' },
    source: { mediaType: 'application/typescript', text: 'export default 1;\n' },
    manifest: { displayName: 'P', description: '' },
    publicContract: { input: 'text', output: 'text' },
    pluginOwnedTests: [],
    config: { mode: 'old' },
    requestedCapabilities: [],
  });
  const hash = await contentHash(base);
  const profileDigest = await domainDigest('henji/spike1/intake-profile/v1', INTAKE_LIMITS);
  const measured = measureStructure(base);
  const ticket = {
    schemaVersion: 'revision-ticket/v1' as const,
    ticketId: 't1',
    target: { pluginId: 'p1', namespace: 'ns', kind: 'text-transform' as const },
    exactBase: { revisionId: 'r0', contentHash: hash, deploymentStateDigest: 'd0' },
    allowedPaths: ['config' as const],
    mutationKind: 'full-replacement' as const,
    budget: { ...MAX_REVISION_BUDGET },
    evidenceScope: ['issue:1'],
    admissionProfile: 'future',
    policyVersion: 'policy-1',
  };
  const request: RevisionRequestV1 = {
    frame: frameSubmission([submission()], INTAKE_LIMITS),
    envelope: {
      submissionId: 's1',
      ticketId: 't1',
      authorizedPath: 'config',
      origin,
      originEvidence: { actor: 'opaque' },
      hostPluginId: 'p1',
      hostNamespace: 'ns',
      normalizerDigest: NORMALIZER_DIGEST,
    },
    tickets: { tickets: { t1: ticket } },
    base: {
      schemaVersion: 'base-definition-snapshot/v1',
      revisionId: 'r0',
      contentHash: hash,
      target: ticket.target,
      resourceProfileDigest: profileDigest,
      canonicalByteCount: canonicalBytes(base).byteLength,
      structuralDepth: measured.depth,
      structuralEntryCount: measured.entries,
      content: base,
    },
    live: {
      baseRevisionId: 'r0',
      baseContentHash: hash,
      deploymentStateDigest: 'd0',
      policyVersion: 'policy-1',
    },
    ledger: EMPTY_LEDGER,
  };
  return request;
};

const dependencies = () => {
  const counters = newCounters();
  let id = 0;
  let clock = 0;
  return {
    counters,
    identity: {
      issueRevisionId: () => `revision:${String(++id).padStart(64, '0')}`,
      now: () => `2026-08-19T00:00:${String(++clock).padStart(2, '0')}.000Z`,
    },
  };
};

Deno.test('all origins use one intake and seal while preserving hidden fields', async () => {
  for (const origin of ['ai', 'human', 'third-party', 'legacy'] as const) {
    const request = await fixture(origin);
    const deps = dependencies();
    const result = await revise(request, deps);
    assert(result.status === 'recorded' && result.outcome.status === 'accepted');
    assertEquals(result.outcome.candidate.resolvedContent.config, { mode: 'new' });
    assertEquals(result.outcome.candidate.resolvedContent.identity, request.base.content.identity);
    assertEquals(result.outcome.candidate.provenance.origin, origin);
    assertEquals([deps.counters.id, deps.counters.clock, deps.counters.merge], [1, 1, 1]);
    assertEquals([
      deps.counters.artifact,
      deps.counters.admission,
      deps.counters.registryWrite,
      deps.counters.currentWrite,
      deps.counters.process,
      deps.counters.broker,
    ], [0, 0, 0, 0, 0, 0]);
  }
});

Deno.test('revision service refuses forged and oversize frames before cloning or content hashing', async () => {
  const request = await fixture();
  const deps = dependencies();
  const result = await revise({
    ...request,
    frame: { bytes: new Uint8Array(INTAKE_LIMITS.maxRawBytes + 1) } as never,
  }, deps);
  assertEquals(result.status, 'refused');
  assert(result.status === 'refused');
  assertEquals(result.refusal.code, 'oversize_input');
  assertEquals([deps.counters.hash, deps.counters.id, deps.counters.clock], [0, 0, 0]);
  assertEquals(result.ledger, request.ledger);
});

Deno.test('exact retry replays without ID clock or append; changed binding conflicts', async () => {
  const request = await fixture();
  const firstDeps = dependencies();
  const first = await revise(request, firstDeps);
  assert(first.status === 'recorded');
  const retryDeps = dependencies();
  const retry = await revise({ ...request, ledger: first.ledger }, retryDeps);
  assertEquals(retry.status, 'replayed');
  assertEquals(retry.ledger.entries.length, 1);
  assertEquals([retryDeps.counters.id, retryDeps.counters.clock], [0, 0]);
  const conflict = await revise({
    ...request,
    envelope: { ...request.envelope, hostNamespace: 'other' },
    ledger: first.ledger,
  }, dependencies());
  assertEquals(conflict.status, 'refused');
  assertEquals(conflict.ledger.entries.length, 1);
});

Deno.test('stale scope budget and schema failures reject before revision issuance', async () => {
  const cases: Array<(request: RevisionRequestV1) => RevisionRequestV1> = [
    (r) => ({ ...r, live: { ...r.live, baseRevisionId: 'stale' } }),
    (r) => ({ ...r, envelope: { ...r.envelope, authorizedPath: 'manifest' } }),
    (r) => ({ ...r, frame: frameSubmission([submission('x'.repeat(40_000))], INTAKE_LIMITS) }),
    (r) => ({ ...r, frame: frameSubmission([encoder.encode('{"unknown":1}')], INTAKE_LIMITS) }),
  ];
  for (const mutate of cases) {
    const deps = dependencies();
    const result = await revise(mutate(await fixture()), deps);
    assert(result.status === 'recorded' && result.outcome.status === 'rejected');
    assertEquals([deps.counters.id, deps.counters.clock], [0, 0]);
    if (result.outcome.rejection.stage === 'stale' || result.outcome.rejection.stage === 'scope') {
      assertEquals([deps.counters.hash, deps.counters.merge], [0, 0]);
    }
  }
});

Deno.test('untrusted duplicate key text is absent from rejection history', async () => {
  const marker = 'PRIVATE_MARKER_PATH';
  const baseRequest = await fixture();
  const request = {
    ...baseRequest,
    frame: frameSubmission([
      encoder.encode(`{"schemaVersion":"proposal-submission/v1","${marker}":1,"${marker}":2}`),
    ], INTAKE_LIMITS),
  };
  const result = await revise(request, dependencies());
  assert(result.status === 'recorded' && result.outcome.status === 'rejected');
  assertEquals(result.outcome.rejection.code, 'duplicate_key');
  assert(!JSON.stringify(result).includes(marker));
});

Deno.test('ticket runtime schema rejects wrong version and unknown fields', async () => {
  for (
    const mutate of [
      (ticket: Record<string, unknown>) => ticket.schemaVersion = 'wrong',
      (ticket: Record<string, unknown>) => ticket.extra = true,
      (ticket: Record<string, unknown>) => (ticket.budget as Record<string, unknown>).extra = 1,
    ]
  ) {
    const request = await fixture();
    const ticket = structuredClone(request.tickets.tickets.t1) as unknown as Record<
      string,
      unknown
    >;
    mutate(ticket);
    const result = await revise(
      { ...request, tickets: { tickets: { t1: ticket as never } } },
      dependencies(),
    );
    assert(result.status === 'recorded' && result.outcome.status === 'rejected');
    assertEquals(result.outcome.rejection.code, 'invalid_ticket_schema');
  }
});

Deno.test('ticket store key must match the ticket identity', async () => {
  const request = await fixture();
  const ticket = { ...request.tickets.tickets.t1, ticketId: 'aliased' };
  const result = await revise({
    ...request,
    tickets: { tickets: { t1: ticket, aliased: request.tickets.tickets.t1 } },
  }, dependencies());
  assert(result.status === 'recorded' && result.outcome.status === 'rejected');
  assertEquals(result.outcome.rejection.code, 'ticket_identity_mismatch');
  assertEquals(result.outcome.processing, null);
});

Deno.test('invalid base target and content become stable structured rejections', async () => {
  for (
    const base of [
      { ...(await fixture()).base, target: null },
      {
        ...(await fixture()).base,
        target: { pluginId: 'p1', namespace: 'ns', kind: 'text-transform', extra: true },
      },
      { ...(await fixture()).base, content: { schemaVersion: 'definition-content/v1' } },
    ]
  ) {
    const request = await fixture();
    const result = await revise({ ...request, base: base as never }, dependencies());
    assert(result.status === 'recorded' && result.outcome.status === 'rejected');
    assertEquals(result.outcome.rejection.code, 'invalid_base_context_schema');
    assertEquals(result.outcome.processing, null);
  }
});

Deno.test('pre-processing and post-processing rejection boundaries are explicit', async () => {
  const request = await fixture();
  const unknown = await revise({
    ...request,
    envelope: { ...request.envelope, ticketId: 'missing' },
  }, dependencies());
  assert(unknown.status === 'recorded' && unknown.outcome.status === 'rejected');
  assertEquals([unknown.outcome.processing, unknown.outcome.processingKey], [null, null]);
  const stale = await revise(
    { ...request, live: { ...request.live, policyVersion: 'stale' } },
    dependencies(),
  );
  assert(stale.status === 'recorded' && stale.outcome.status === 'rejected');
  assert(stale.outcome.processing !== null && stale.outcome.processingKey !== null);
});

Deno.test('full ledger replays existing submissions and refuses new ones', async () => {
  const request = await fixture();
  const deps = dependencies();
  let full = EMPTY_LEDGER;
  let firstOutcome: Awaited<ReturnType<typeof revise>> | undefined;
  for (let index = 1; index <= INTAKE_LIMITS.maxLedgerEntries; index++) {
    const result = await revise({
      ...request,
      envelope: { ...request.envelope, submissionId: `s${index}` },
      ledger: full,
    }, deps);
    assert(result.status === 'recorded');
    firstOutcome ??= result;
    full = result.ledger;
  }
  assert(firstOutcome?.status === 'recorded');
  const replay = await revise({ ...request, ledger: full }, dependencies());
  assertEquals(replay.status, 'replayed');
  const refusal = await revise({
    ...request,
    envelope: { ...request.envelope, submissionId: 'new' },
    ledger: full,
  }, dependencies());
  assertEquals(refusal.status, 'refused');
});

Deno.test('ledger canonical byte ceiling accepts equality and rejects one byte over', async () => {
  const request = await fixture();
  const invalid = {
    ...request,
    frame: frameSubmission([encoder.encode('{"unknown":1}')], INTAKE_LIMITS),
  };
  const seed = await revise(invalid, dependencies());
  assert(seed.status === 'recorded' && seed.outcome.status === 'rejected');
  const entries = Array.from({ length: INTAKE_LIMITS.maxLedgerEntries }, (_, index) => {
    const entry = structuredClone(seed.outcome) as Extract<
      typeof seed.outcome,
      { status: 'rejected' }
    >;
    const id = `capacity-${String(index).padStart(2, '0')}`;
    (entry.submission as { submissionId: string }).submissionId = id;
    (entry.rejection as { intakeId: string; code: string }).intakeId = id;
    (entry.rejection as { code: string }).code = '';
    const deficit = INTAKE_LIMITS.maxOutcomeCanonicalBytes - canonicalBytes(entry).byteLength;
    assert(deficit >= 0);
    (entry.rejection as { code: string }).code = 'x'.repeat(deficit);
    assertEquals(canonicalBytes(entry).byteLength, INTAKE_LIMITS.maxOutcomeCanonicalBytes);
    return entry;
  });
  const full = { schemaVersion: 'revision-outcome-ledger/v1' as const, entries };
  assertEquals(
    entries.reduce((total, entry) => total + canonicalBytes(entry).byteLength, 0),
    INTAKE_LIMITS.maxLedgerOutcomeBytes,
  );
  assertEquals(canonicalBytes(full).byteLength, INTAKE_LIMITS.maxLedgerCanonicalBytes);
  validateLedgerRuntime(full);
  const replay = await revise({
    ...invalid,
    envelope: { ...invalid.envelope, submissionId: 'capacity-00' },
    ledger: full,
  }, dependencies());
  assertEquals(replay.status, 'replayed');
  const next = structuredClone(full) as typeof full;
  (next.entries[0].rejection as { code: string }).code += 'x';
  assertEquals(canonicalBytes(next).byteLength, INTAKE_LIMITS.maxLedgerCanonicalBytes + 1);
  let threw = false;
  try {
    validateLedgerRuntime(next);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test('malformed nested ledger values are rejected at the trusted boundary', async () => {
  const request = await fixture();
  const first = await revise(request, dependencies());
  assert(first.status === 'recorded' && first.outcome.status === 'accepted');
  for (
    const mutate of [
      (entry: Record<string, unknown>) =>
        delete (entry.processing as Record<string, unknown>).ticketDigest,
      (entry: Record<string, unknown>) =>
        delete ((entry.candidate as Record<string, unknown>).revision as Record<string, unknown>)
          .revisionDigest,
      (entry: Record<string, unknown>) =>
        ((entry.candidate as Record<string, unknown>).provenance as Record<string, unknown>).extra =
          true,
      (entry: Record<string, unknown>) =>
        ((entry.candidate as Record<string, unknown>).revision as Record<string, unknown>)
          .createdAt = 1,
    ]
  ) {
    const malformed = structuredClone(first.ledger) as unknown as {
      entries: Array<Record<string, unknown>>;
    };
    mutate(malformed.entries[0]);
    let threw = false;
    try {
      await revise({ ...request, ledger: malformed as never }, dependencies());
    } catch {
      threw = true;
    }
    assert(threw);
  }
});

Deno.test('every stored submission binding field participates in retry conflict', async () => {
  const request = await fixture();
  const first = await revise(request, dependencies());
  assert(first.status === 'recorded');
  const alternatives: Record<string, unknown> = {
    originalContentHash: `sha256:${'1'.repeat(64)}`,
    ticketId: 'other',
    authorizedPath: 'manifest',
    origin: 'ai',
    originEvidenceDigest: `sha256:${'2'.repeat(64)}`,
    hostPluginId: 'other',
    hostNamespace: 'other',
    normalizerDigest: `sha256:${'3'.repeat(64)}`,
    intakeProfileDigest: `sha256:${'4'.repeat(64)}`,
  };
  for (const [field, value] of Object.entries(alternatives)) {
    const ledger = structuredClone(first.ledger) as unknown as {
      entries: Array<Record<string, unknown>>;
    };
    (ledger.entries[0].submission as Record<string, unknown>)[field] = value;
    const result = await revise({ ...request, ledger: ledger as never }, dependencies());
    assertEquals(result.status, 'refused');
    assert(result.status === 'refused');
    assertEquals(result.refusal.code, 'submission_conflict');
  }
});

Deno.test('exact retry binding comparison is independent of property insertion order', async () => {
  const request = await fixture();
  const first = await revise(request, dependencies());
  assert(first.status === 'recorded');
  const ledger = structuredClone(first.ledger) as unknown as {
    entries: Array<{ submission: Record<string, unknown> }>;
  };
  ledger.entries[0].submission = Object.fromEntries(
    Object.entries(ledger.entries[0].submission).reverse(),
  );
  const result = await revise({ ...request, ledger: ledger as never }, dependencies());
  assertEquals(result.status, 'replayed');
});

Deno.test('request cloning and returned candidate are deeply immutable', async () => {
  const request = await fixture();
  const result = await revise(request, dependencies());
  assert(result.status === 'recorded' && result.outcome.status === 'accepted');
  (request.base.content.config as Record<string, unknown>).mode = 'caller-mutated';
  assertEquals(result.outcome.candidate.resolvedContent.config, { mode: 'new' });
  assert(Object.isFrozen(result.outcome.candidate));
  assert(Object.isFrozen(result.outcome.candidate.resolvedContent));
  assert(Object.isFrozen(result.outcome.candidate.revision));
});

Deno.test('same content with a different submission has a distinct revision identity', async () => {
  const request = await fixture();
  const deps = dependencies();
  const first = await revise(request, deps);
  assert(first.status === 'recorded' && first.outcome.status === 'accepted');
  const second = await revise({
    ...request,
    envelope: { ...request.envelope, submissionId: 's2' },
    ledger: first.ledger,
  }, deps);
  assert(second.status === 'recorded' && second.outcome.status === 'accepted');
  assertEquals(first.outcome.candidate.contentHash, second.outcome.candidate.contentHash);
  assert(first.outcome.candidate.proposalId !== second.outcome.candidate.proposalId);
  assert(
    first.outcome.candidate.revision.revisionId !== second.outcome.candidate.revision.revisionId,
  );
  assert(
    first.outcome.candidate.revision.revisionDigest !==
      second.outcome.candidate.revision.revisionDigest,
  );
});

Deno.test('deterministic identity domains have pinned golden vectors', async () => {
  const request = await fixture();
  const result = await revise(request, dependencies());
  assert(result.status === 'recorded' && result.outcome.status === 'accepted');
  assertEquals({
    submission: result.outcome.processing.submissionBindingDigest,
    proposalId: result.outcome.candidate.proposalId,
    proposal: result.outcome.candidate.proposalDigest,
    ticket: result.outcome.candidate.ticketDigest,
    processing: result.outcome.processingKey,
    sealed: result.outcome.candidate.sealedProposalId,
    revision: result.outcome.candidate.revision.revisionDigest,
  }, {
    submission: 'sha256:ec93de3c2c57189b0da46450c8641a7773e54994dddc4a043b5e7fce336088e6',
    proposalId: 'sha256:4e856059dc0eb128bd4a3c9a1958ba337d24213e553cc9226dbd3d6191783b64',
    proposal: 'sha256:f297bdc8bc3951193465a99d0e0a23478e569db677ec22a5ff5e5c8feef799b3',
    ticket: 'sha256:acd711196d82931e82291c7bb9773821fb24c5c4681634ee9438d51002832b83',
    processing: 'sha256:831ad3e7e03a41ef7909d197840bba95aa25eb4497a5ebf0fa6f7e76b54a8b05',
    sealed: 'sha256:633dd0ce2b635f28d4c10b435e0d4012842e54684295a1d957f50eebd366fe21',
    revision: 'sha256:16d0391a974cf6afe0cafab218b38d7f110aeab995d66a6d2541998c4ffd788d',
  });
});

Deno.test('normalization paths are redacted and exact retry precedes context validation', async () => {
  const marker = 'PRIVATE_NORMALIZE_MARKER';
  const request = await fixture();
  const rejected = await revise({
    ...request,
    frame: frameSubmission([encoder.encode(
      `{"schemaVersion":"proposal-submission/v1","replacement":{"${marker}":1e400},"reason":"","evidenceRefs":[],"expectedEffect":"","knownRisks":[]}`,
    )], INTAKE_LIMITS),
  }, dependencies());
  assert(rejected.status === 'recorded' && rejected.outcome.status === 'rejected');
  assertEquals(rejected.outcome.rejection.code, 'submission_invalid');
  assert(!JSON.stringify(rejected).includes(marker));
  const accepted = await revise(request, dependencies());
  assert(accepted.status === 'recorded');
  const replay = await revise({
    ...request,
    live: { ...request.live, baseContentHash: 'invalid' },
    ledger: accepted.ledger,
  }, dependencies());
  assertEquals(replay.status, 'replayed');
});

Deno.test('config structural budget rejects before content hash and merge', async () => {
  const request = await fixture();
  const originalTicket = request.tickets.tickets.t1;
  const ticket = { ...originalTicket, budget: { ...originalTicket.budget, maxConfigDepth: 1 } };
  const deps = dependencies();
  const result = await revise({
    ...request,
    frame: frameSubmission([submission({ nested: { value: true } })], INTAKE_LIMITS),
    tickets: { tickets: { t1: ticket } },
  }, deps);
  assert(result.status === 'recorded' && result.outcome.status === 'rejected');
  assertEquals([deps.counters.hash, deps.counters.merge, deps.counters.id], [0, 0, 0]);
});

Deno.test('ticket base live and host identity mismatches all fail closed', async () => {
  const differentHash = `sha256:${'a'.repeat(64)}`;
  const cases: Array<(request: RevisionRequestV1) => RevisionRequestV1> = [
    (r) => ({
      ...r,
      tickets: {
        tickets: {
          t1: {
            ...r.tickets.tickets.t1,
            exactBase: { ...r.tickets.tickets.t1.exactBase, revisionId: 'other' },
          },
        },
      },
    }),
    (r) => ({
      ...r,
      tickets: {
        tickets: {
          t1: {
            ...r.tickets.tickets.t1,
            exactBase: { ...r.tickets.tickets.t1.exactBase, contentHash: differentHash },
          },
        },
      },
    }),
    (r) => ({ ...r, base: { ...r.base, revisionId: 'other' } }),
    (r) => ({ ...r, base: { ...r.base, contentHash: differentHash } }),
    (r) => ({ ...r, live: { ...r.live, deploymentStateDigest: 'other' } }),
    (r) => ({ ...r, live: { ...r.live, policyVersion: 'other' } }),
    (r) => ({ ...r, envelope: { ...r.envelope, hostPluginId: 'other' } }),
    (r) => ({ ...r, envelope: { ...r.envelope, hostNamespace: 'other' } }),
  ];
  for (const mutate of cases) {
    const result = await revise(mutate(await fixture()), dependencies());
    assert(result.status === 'recorded' && result.outcome.status === 'rejected');
    assertEquals(result.outcome.rejection.stage, 'stale');
  }
});

Deno.test('narrative evidence and risk limits and evidence scope are enforced', async () => {
  const request = await fixture();
  const original = JSON.parse(new TextDecoder().decode(request.frame.bytes));
  const cases = [
    { ...original, reason: 'x'.repeat(MAX_REVISION_BUDGET.maxReasonBytes + 1) },
    { ...original, expectedEffect: 'x'.repeat(MAX_REVISION_BUDGET.maxExpectedEffectBytes + 1) },
    { ...original, evidenceRefs: ['x'.repeat(MAX_REVISION_BUDGET.maxEvidenceRefBytesEach + 1)] },
    { ...original, knownRisks: ['x'.repeat(MAX_REVISION_BUDGET.maxKnownRiskBytesEach + 1)] },
    { ...original, evidenceRefs: ['outside-scope'] },
  ];
  for (const value of cases) {
    const result = await revise({
      ...request,
      frame: frameSubmission([encoder.encode(JSON.stringify(value))], INTAKE_LIMITS),
    }, dependencies());
    assert(result.status === 'recorded' && result.outcome.status === 'rejected');
    assertEquals([result.outcome.processing === null, result.outcome.rejection.stage], [
      result.outcome.rejection.stage === 'intake',
      result.outcome.rejection.stage,
    ]);
  }
});
