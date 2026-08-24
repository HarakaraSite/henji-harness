import { validateAdmissionRequest } from '../src/admission_request.ts';
import { assertEquals, assertThrows } from './test_helpers.ts';

const digest = `sha256:${'a'.repeat(64)}`;

Deno.test('request accepts sealedProposalId as its only authority', () => {
  assertEquals(
    validateAdmissionRequest({
      schemaVersion: 'admission-request/v1',
      sealedProposalId: digest,
    }),
    {
      schemaVersion: 'admission-request/v1',
      sealedProposalId: digest,
    },
  );
});

for (const injected of ['source', 'path', 'ticketId', 'artifactHash', 'legacyPlugin', 'unknown']) {
  Deno.test(`request rejects injected ${injected}`, () => {
    assertThrows(() =>
      validateAdmissionRequest({
        schemaVersion: 'admission-request/v1',
        sealedProposalId: digest,
        [injected]: 'forbidden',
      })
    );
  });
}

Deno.test('request rejects malformed sealed ID', () => {
  assertThrows(() =>
    validateAdmissionRequest({
      schemaVersion: 'admission-request/v1',
      sealedProposalId: 'candidate',
    })
  );
});

for (
  const malformed of [
    {},
    { schemaVersion: 'admission-request/v1' },
    { schemaVersion: 'wrong', sealedProposalId: digest },
    { schemaVersion: 'admission-request/v1', sealedProposalId: null },
    { schemaVersion: 'admission-request/v1', sealedProposalId: `sha256:${'a'.repeat(65)}` },
  ]
) {
  Deno.test(`request rejects malformed schema ${JSON.stringify(malformed)}`, () => {
    assertThrows(() => validateAdmissionRequest(malformed));
  });
}
