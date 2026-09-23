import type { LoopOutcome } from '../core/contracts.ts';
import type { HistoryCaptureResult } from '../history/history_store_contract.ts';
import type { ProviderEvidenceV1, ProviderEvidenceV5 } from '../provider/provider_evidence.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { DefinitionRevisionRef } from '../session/session_store.ts';

export const attributeProviderEvidenceV5 = (input: {
  readonly evidence: ProviderEvidenceV1;
  readonly outcome: LoopOutcome;
  readonly sessionId: string;
  readonly build: BuildManifestV1;
  readonly definition: DefinitionRevisionRef;
  readonly hasContextBasis: boolean;
}): ProviderEvidenceV5 => {
  const { schemaVersion: _schemaVersion, outcome: _outcome, ...evidence } = structuredClone(
    input.evidence,
  );
  const base = {
    ...evidence,
    schemaVersion: 5 as const,
    sessionId: input.sessionId,
    build: structuredClone(input.build),
    definition: structuredClone(input.definition),
    requests: evidence.requests.map((record, index) => ({
      ...record,
      request: {
        ...record.request,
        ...(record.request.contextRequestOrdinal === undefined && !input.hasContextBasis
          ? { contextRequestOrdinal: index + 1 }
          : record.request.contextRequestOrdinal === undefined
          ? {}
          : { contextRequestOrdinal: record.request.contextRequestOrdinal }),
      },
    })),
  };
  const asEvidence = (value: unknown): ProviderEvidenceV5 => value as ProviderEvidenceV5;
  switch (input.outcome.stopReason) {
    case 'final':
    case 'tool_terminal':
      return asEvidence({
        ...base,
        capture: 'complete',
        normalizedOutcome: 'completed',
        outcome: input.outcome.stopReason,
      });
    case 'cancelled':
      return asEvidence({
        ...base,
        capture: 'complete',
        normalizedOutcome: 'cancelled',
        outcome: 'cancelled',
      });
    case 'max_steps':
    case 'contract_failure':
      return asEvidence({
        ...base,
        capture: 'complete',
        normalizedOutcome: 'failed',
        outcome: input.outcome.stopReason,
      });
    case 'interrupted':
      return asEvidence({
        ...base,
        capture: 'partial',
        normalizedOutcome: 'interrupted',
        settlement: 'interrupted',
      });
  }
};

export const historyCaptureDurability = (
  capture: HistoryCaptureResult,
): Pick<
  LoopOutcome,
  | 'providerEvidenceDurability'
  | 'providerEvidencePersistenceError'
  | 'diagnosticDurability'
  | 'diagnosticPersistenceError'
> => ({
  ...(capture.evidenceDurability === undefined ? {} : {
    providerEvidenceDurability: capture.evidenceDurability,
  }),
  ...(capture.evidencePersistenceError === undefined ? {} : {
    providerEvidencePersistenceError: capture.evidencePersistenceError,
  }),
  ...(capture.diagnosticDurability === undefined ? {} : {
    diagnosticDurability: capture.diagnosticDurability,
  }),
  ...(capture.diagnosticPersistenceError === undefined ? {} : {
    diagnosticPersistenceError: capture.diagnosticPersistenceError,
  }),
});
