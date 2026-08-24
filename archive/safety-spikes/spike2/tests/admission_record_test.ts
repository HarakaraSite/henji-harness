import { domainDigest } from '../../spike1/src/digests.ts';
import { canonicalize } from '../../spike0/src/canonical_content.ts';
import {
  type AdmissionProcessingBindingV1,
  createAdmissionRecord,
  validateAdmissionRecordIntegrity,
} from '../src/admission_record.ts';
import { assertEquals, assertRejects } from './test_helpers.ts';

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

const createFixtureRecord = async () =>
  await createAdmissionRecord({
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

Deno.test('AdmissionRecord rederives the canonical digest and golden identity', async () => {
  const record = await createFixtureRecord();
  const { admissionDigest: _admissionDigest, ...withoutDigest } = record;
  assertEquals(
    record.admissionDigest,
    await domainDigest('henji/spike2/admission-record/v1', withoutDigest),
  );
  assertEquals(
    record.admissionKey,
    'sha256:2a247c18cfc513db0f771498b33effefc484abd5a1436f8866e9d1ace4bf0e05',
  );
  assertEquals(
    record.admissionId,
    'sha256:72eebcf13d40e4d907c6ebd1d0721549a4ed726e3422ac74f6833fe805bfd76d',
  );
  assertEquals(
    record.closureDigest,
    await domainDigest('henji/spike2/module-closure/v1', {
      schemaVersion: 'module-closure/v1',
      modules: [],
    }),
  );
  assertEquals(
    record.admissionId,
    await domainDigest('henji/spike2/admission-id/v1', {
      admissionKey: record.admissionKey,
      artifactHash: record.artifactHash,
      closureDigest: record.closureDigest,
    }),
  );
  assertEquals(
    record.closureDigest,
    'sha256:d1980bfc31d0f61a593aca9a74e740c84bf3910722f60cf3a171115661a875e4',
  );
  assertEquals(
    record.admissionDigest,
    'sha256:0b772a599e38d2140e11abc2df9d2586679f558d4f26f4391bcc76adf8fcc105',
  );
  await validateAdmissionRecordIntegrity(record);
});

Deno.test('AdmissionRecord accepts reordered fields under canonical validation', async () => {
  const record = await createFixtureRecord();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  assertEquals(
    canonicalize(await validateAdmissionRecordIntegrity(reordered)),
    canonicalize(record),
  );
});

Deno.test('artifact hash alone cannot create an AdmissionRecord', async () => {
  await assertRejects(() =>
    createAdmissionRecord({
      artifactHash: hash('3'),
      artifactByteCount: 12,
    } as never)
  );
});

for (
  const [field, replacement] of [
    ['schemaVersion', 'wrong'],
    ['admissionKey', hash('f')],
    ['admissionId', hash('f')],
    ['sealedProposalId', hash('f')],
    ['revisionId', `revision:${'f'.repeat(64)}`],
    ['revisionDigest', hash('f')],
    ['definitionContentHash', hash('0')],
    ['proposalDigest', hash('f')],
    ['ticketDigest', hash('f')],
    ['admissionGrantDigest', hash('f')],
    ['admissionProfileDigest', hash('f')],
    ['policyDigest', hash('f')],
    ['preflightSourceDigest', hash('f')],
    ['builderSourceDigest', hash('f')],
    ['builderDependencyDigest', hash('f')],
    ['parserDigest', hash('f')],
    ['compilerDigest', hash('f')],
    ['runtimeDigest', hash('f')],
    ['compilerOptionsDigest', hash('f')],
    ['closureDigest', hash('f')],
    ['artifactHash', hash('f')],
    ['artifactByteCount', 13],
    ['createdAt', '2026-08-19T09:01:00.000Z'],
    ['admissionDigest', hash('f')],
  ] as const
) {
  Deno.test(`AdmissionRecord rejects mutation of ${field}`, async () => {
    const record = await createFixtureRecord();
    const forged = { ...record, [field]: replacement };
    await assertRejects(() => validateAdmissionRecordIntegrity(forged));
  });
}
