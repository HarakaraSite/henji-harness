import { grantTimeStatus, validateAdmissionGrant } from '../src/admission_grant.ts';
import { assertEquals, assertThrows } from './test_helpers.ts';

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const grant = {
  schemaVersion: 'admission-grant/v1',
  grantId: 'grant-1',
  sealedProposalId: hash('a'),
  revisionId: `revision:${'b'.repeat(64)}`,
  revisionDigest: hash('c'),
  contentHash: hash('d'),
  admissionProfileDigest: hash('e'),
  policyDigest: hash('f'),
  issuedAt: '2026-08-19T09:00:00.000Z',
  expiresAt: '2026-08-19T09:15:00.000Z',
} as const;

Deno.test('grant validates exact maximum TTL and time boundaries', () => {
  const validated = validateAdmissionGrant(grant);
  assertEquals(grantTimeStatus(validated, grant.issuedAt), 'valid');
  assertEquals(grantTimeStatus(validated, '2026-08-19T08:59:59.999Z'), 'not-yet-valid');
  assertEquals(grantTimeStatus(validated, grant.expiresAt), 'expired');
});

Deno.test('grant rejects TTL one millisecond above maximum', () => {
  assertThrows(() =>
    validateAdmissionGrant({
      ...grant,
      expiresAt: '2026-08-19T09:15:00.001Z',
    })
  );
});

Deno.test('grant rejects impossible and non-canonical timestamps', () => {
  assertThrows(() => validateAdmissionGrant({ ...grant, issuedAt: '2026-02-30T09:00:00.000Z' }));
  assertThrows(() => validateAdmissionGrant({ ...grant, issuedAt: '2026-08-19T09:00:00Z' }));
});

Deno.test('grant canonical identity is independent of object field order', () => {
  const reordered = Object.fromEntries(
    Object.entries(grant).reverse(),
  );
  assertEquals(validateAdmissionGrant(reordered), grant);
});
