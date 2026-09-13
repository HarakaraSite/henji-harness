/** Provider evidence storage failures shared by the SQLite adapter and diagnostics CLI. */
export class ProviderEvidenceStoreError extends Error {
  constructor(
    readonly code:
      | 'provider_evidence_not_found'
      | 'provider_evidence_invalid'
      | 'provider_evidence_io_failure',
    message = code,
  ) {
    super(message);
    this.name = 'ProviderEvidenceStoreError';
  }
}
