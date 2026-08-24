import {
  type AdmissionProcessingBindingV1,
  createAdmissionRecord,
} from '../src/admission_record.ts';
import {
  AdmissionStateStore,
  EMPTY_ADMISSION_REGISTRY,
  EMPTY_ARTIFACT_INDEX,
  validateAdmissionRegistrySnapshot,
  validateArtifactIndexSnapshot,
} from '../src/admission_registry.ts';
import { assertEquals, assertRejects, assertThrows } from './test_helpers.ts';

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const binding: AdmissionProcessingBindingV1 = {
  schemaVersion: 'admission-processing-binding/v1',
  sealedCandidateDigest: hash('1'),
  admissionGrantDigest: hash('2'),
  admissionProfileDigest: hash('3'),
  policyDigest: hash('4'),
  preflightSourceDigest: hash('5'),
  builderSourceDigest: hash('6'),
  builderDependencyDigest: hash('7'),
  parserDigest: hash('8'),
  compilerDigest: hash('9'),
  runtimeDigest: hash('a'),
  compilerOptionsDigest: hash('b'),
};

const indexedDigest = (index: number): string => `sha256:${index.toString(16).padStart(64, '0')}`;

const indexedRecord = async (index: number) =>
  await createAdmissionRecord({
    binding: { ...binding, sealedCandidateDigest: indexedDigest(index) },
    sealedProposalId: indexedDigest(index + 100),
    revisionId: `revision:${index.toString(16).padStart(64, '0')}`,
    revisionDigest: indexedDigest(index + 200),
    definitionContentHash: indexedDigest(index + 300),
    proposalDigest: indexedDigest(index + 400),
    ticketDigest: indexedDigest(index + 500),
    artifactHash: indexedDigest(index + 600),
    artifactByteCount: 1,
    createdAt: '2026-08-19T09:00:00.000Z',
  });

Deno.test('registry and artifact snapshots reject malformed capacity values', () => {
  assertThrows(() =>
    validateArtifactIndexSnapshot({
      schemaVersion: 'artifact-store-index/v1',
      entries: { [hash('a')]: { artifactHash: hash('a'), byteCount: -1 } },
    })
  );
  assertThrows(() =>
    validateArtifactIndexSnapshot({
      schemaVersion: 'wrong',
      entries: {},
    })
  );
});

Deno.test('state deep-copies records and snapshots across the opaque writer boundary', async () => {
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX);
  await state.validateSnapshots();
  const record = await createAdmissionRecord({
    binding,
    sealedProposalId: hash('c'),
    revisionId: `revision:${'d'.repeat(64)}`,
    revisionDigest: hash('e'),
    definitionContentHash: hash('f'),
    proposalDigest: hash('1'),
    ticketDigest: hash('2'),
    artifactHash: hash('3'),
    artifactByteCount: 12,
    createdAt: '2026-08-19T09:00:00.000Z',
  });
  const result = await state.transact(record.admissionKey, async (context) => {
    context.commitArtifact({
      artifactHash: record.artifactHash,
      byteCount: record.artifactByteCount,
    });
    await context.appendRecord(record);
    return record;
  });
  assertEquals(result.status, 'reserved');
  (record as { createdAt: string }).createdAt = '2026-08-19T09:01:00.000Z';
  assertEquals(
    state.registrySnapshot().entries[record.admissionKey].createdAt,
    '2026-08-19T09:00:00.000Z',
  );
  const snapshot = state.artifactSnapshot();
  assertThrows(() => {
    (snapshot.entries[record.artifactHash] as { byteCount: number }).byteCount = -1;
  });
  assertEquals(state.artifactSnapshot().entries[record.artifactHash].byteCount, 12);
});

Deno.test('registry rederives record identities and rejects forged snapshots', async () => {
  const record = await createAdmissionRecord({
    binding,
    sealedProposalId: hash('c'),
    revisionId: `revision:${'d'.repeat(64)}`,
    revisionDigest: hash('e'),
    definitionContentHash: hash('f'),
    proposalDigest: hash('1'),
    ticketDigest: hash('2'),
    artifactHash: hash('3'),
    artifactByteCount: 12,
    createdAt: '2026-08-19T09:00:00.000Z',
  });
  for (const field of ['admissionId', 'admissionDigest'] as const) {
    const forged = structuredClone(record) as { admissionId: string; admissionDigest: string };
    forged[field] = hash('0');
    await assertRejects(() =>
      validateAdmissionRegistrySnapshot({
        schemaVersion: 'admission-registry/v1',
        entries: { [record.admissionKey]: forged },
      })
    );
  }
});

Deno.test('state constructor does not evaluate unvalidated snapshot getters', async () => {
  let getterReads = 0;
  const malicious = Object.defineProperty({}, 'schemaVersion', {
    enumerable: true,
    get: () => {
      getterReads++;
      return 'admission-registry/v1';
    },
  });
  Object.defineProperty(malicious, 'entries', { enumerable: true, value: {} });
  const state = new AdmissionStateStore(
    malicious as never,
    EMPTY_ARTIFACT_INDEX,
  );
  assertEquals(getterReads, 0);
  await assertRejects(() => state.validateSnapshots());
  assertEquals(getterReads, 0);
});

Deno.test('state snapshots both inputs before the first asynchronous integrity check', async () => {
  const artifacts = {
    schemaVersion: 'artifact-store-index/v1' as const,
    entries: { [hash('a')]: { artifactHash: hash('a'), byteCount: 12 } },
  };
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, artifacts);
  const validation = state.validateSnapshots();
  delete (artifacts.entries as Record<string, unknown>)[hash('a')];
  await validation;
  assertEquals(state.artifactSnapshot().entries[hash('a')].byteCount, 12);
});

Deno.test('artifact last slot is serialized and committed capacity is retained', async () => {
  const entries: Record<string, { artifactHash: string; byteCount: number }> = {};
  for (let index = 0; index < 63; index++) {
    const artifactHash = `sha256:${index.toString(16).padStart(64, '0')}`;
    entries[artifactHash] = { artifactHash, byteCount: 1 };
  }
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, {
    schemaVersion: 'artifact-store-index/v1',
    entries,
  });
  await state.validateSnapshots();
  const finalArtifact = `sha256:${'f'.repeat(63)}e`;
  const outcomes = await Promise.all([
    state.transact(hash('1'), async (context) => {
      context.commitArtifact({ artifactHash: finalArtifact, byteCount: 1 });
      return await Promise.resolve('first');
    }),
    state.transact(hash('2'), async () => await Promise.resolve('second')),
  ]);
  assertEquals(outcomes[0], { status: 'reserved', value: 'first' });
  assertEquals(outcomes[1], { status: 'rejected', code: 'artifact_capacity' });
  assertEquals(Object.keys(state.artifactSnapshot().entries).length, 64);
});

Deno.test('registry last slot is serialized and rejects a competing reservation', async () => {
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX);
  await state.validateSnapshots();
  for (let index = 0; index < 64; index++) {
    const record = await indexedRecord(index);
    const result = await state.transact(record.admissionKey, async (context) => {
      await context.appendRecord(record);
      return index;
    });
    assertEquals(result, { status: 'reserved', value: index });
  }
  const overflow = await state.transact(
    `sha256:${'f'.repeat(64)}`,
    async () => await Promise.resolve('overflow'),
  );
  assertEquals(overflow, { status: 'rejected', code: 'registry_capacity' });
  assertEquals(Object.keys(state.registrySnapshot().entries).length, 64);
});

Deno.test('artifact byte capacity accepts the inclusive final reservation boundary', async () => {
  const entries: Record<string, { artifactHash: string; byteCount: number }> = {};
  for (let index = 0; index < 63; index++) {
    const artifactHash = indexedDigest(index + 700);
    entries[artifactHash] = {
      artifactHash,
      byteCount: 131_072,
    };
  }
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, {
    schemaVersion: 'artifact-store-index/v1',
    entries,
  });
  await state.validateSnapshots();
  const finalArtifact = indexedDigest(800);
  const result = await state.transact(`sha256:${'e'.repeat(64)}`, async (context) => {
    context.commitArtifact({ artifactHash: finalArtifact, byteCount: 131_072 });
    return await Promise.resolve('full');
  });
  assertEquals(result, { status: 'reserved', value: 'full' });
  assertEquals(Object.keys(state.artifactSnapshot().entries).length, 64);
});

Deno.test('registry limb rejects duplicate commit and mutex releases after a thrown operation', async () => {
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX);
  await state.validateSnapshots();
  const record = await indexedRecord(900);
  const first = await state.transact(record.admissionKey, async (context) => {
    await context.appendRecord(record);
    await assertRejects(() => context.appendRecord(record));
    return 'committed';
  });
  assertEquals(first, { status: 'reserved', value: 'committed' });
  await assertRejects(() =>
    state.transact(indexedDigest(901), async (context) => {
      context.commitArtifact({ artifactHash: indexedDigest(902), byteCount: 1 });
      await Promise.resolve();
      throw new Error('injected failure');
    })
  );
  const released = await state.transact(
    indexedDigest(903),
    async () => await Promise.resolve('released'),
  );
  assertEquals(released, { status: 'reserved', value: 'released' });
  assertEquals(state.artifactSnapshot().entries[indexedDigest(902)].byteCount, 1);
});

Deno.test('cancelled transaction releases the reservation mutex and retains no uncommitted limb', async () => {
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX);
  await state.validateSnapshots();
  await assertRejects(() =>
    state.transact(indexedDigest(904), async () => {
      await Promise.reject(new Error('cancelled'));
      return 'unreachable';
    })
  );
  const next = await state.transact(
    indexedDigest(905),
    async () => await Promise.resolve('released'),
  );
  assertEquals(next, { status: 'reserved', value: 'released' });
  assertEquals(state.registrySnapshot().entries, {});
  assertEquals(state.artifactSnapshot().entries, {});
});

Deno.test('failed transaction releases mutex and rejects duplicate limb commit', async () => {
  const state = new AdmissionStateStore(EMPTY_ADMISSION_REGISTRY, EMPTY_ARTIFACT_INDEX);
  await state.validateSnapshots();
  await assertRejects(() =>
    state.transact(hash('1'), async (context) => {
      context.commitArtifact({ artifactHash: hash('e'), byteCount: 1 });
      await Promise.resolve();
      context.commitArtifact({ artifactHash: hash('f'), byteCount: 1 });
    })
  );
  const next = await state.transact(hash('2'), async () => await Promise.resolve('released'));
  assertEquals(next, { status: 'reserved', value: 'released' });
  assertEquals(state.artifactSnapshot().entries[hash('e')].byteCount, 1);
});
