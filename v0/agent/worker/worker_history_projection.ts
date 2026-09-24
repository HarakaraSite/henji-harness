import type { LoopOutcome } from '../core/contracts.ts';
import type { HistoryCaptureResult } from '../history/history_store_contract.ts';

export const historyCaptureDurability = (
  capture: HistoryCaptureResult,
): Pick<
  LoopOutcome,
  | 'diagnosticDurability'
  | 'diagnosticPersistenceError'
> => ({
  ...(capture.diagnosticDurability === undefined ? {} : {
    diagnosticDurability: capture.diagnosticDurability,
  }),
  ...(capture.diagnosticPersistenceError === undefined ? {} : {
    diagnosticPersistenceError: capture.diagnosticPersistenceError,
  }),
});
