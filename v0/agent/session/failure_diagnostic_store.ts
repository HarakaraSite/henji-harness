import type { FailureDiagnosticPersister, FailureDiagnosticV1 } from './failure_diagnostic.ts';

export const MAX_FAILURE_DIAGNOSTICS = 16;
export const MAX_FAILURE_DIAGNOSTIC_BYTES = 16 * 1024;

export type FailureDiagnosticStoreErrorCode =
  | 'diagnostic_not_found'
  | 'diagnostic_busy'
  | 'diagnostic_invalid'
  | 'diagnostic_capacity'
  | 'diagnostic_io_failure';

export class FailureDiagnosticStoreError extends Error {
  constructor(
    readonly code: FailureDiagnosticStoreErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'FailureDiagnosticStoreError';
  }
}

export interface FailureDiagnosticStore {
  list(): Promise<readonly FailureDiagnosticV1[]>;
  read(id: string): Promise<FailureDiagnosticV1>;
  write(diagnostic: FailureDiagnosticV1): Promise<void>;
  delete(id: string): Promise<void>;
  persist: FailureDiagnosticPersister;
}
