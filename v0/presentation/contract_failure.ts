import type {
  PresentationDiagnosticDurability,
  PresentationDiagnosticPersistenceError,
  PresentationFailureDiagnostic,
} from './contract_types.ts';

/** Stable, data-only one-line diagnostic fields for retained presentation. */
export const formatPresentationFailureDiagnostic = (
  diagnostic: PresentationFailureDiagnostic,
  durable: PresentationDiagnosticDurability,
  persistenceError?: PresentationDiagnosticPersistenceError,
): string => {
  const fields = [
    `id=${diagnostic.diagnosticId}`,
    `stage=${diagnostic.stage}`,
    `code=${diagnostic.code}`,
    `lane=${diagnostic.lane}`,
    `requests=${diagnostic.providerRequestCount}`,
  ];
  if (diagnostic.httpStatus !== undefined) {
    fields.push(`http=${diagnostic.httpStatus}`);
  }
  if (diagnostic.parseReason !== undefined) {
    fields.push(`reason=${diagnostic.parseReason}`);
  }
  if (
    diagnostic.stage === 'unknown_stage' || diagnostic.code === 'unknown_code'
  ) {
    fields.push('reason=not_instrumented');
  }
  fields.push(
    `turn=${diagnostic.turnNumber}`,
    `step=${diagnostic.modelStep}`,
    `occurredAt=${diagnostic.occurredAt}`,
    'retry=0',
    `durable=${durable}`,
  );
  if (persistenceError !== undefined) fields.push(`store=${persistenceError}`);
  return fields.join(' · ');
};

/** Stable error used whenever a presentation sink cannot accept a frame. */
export class PresentationDeliveryError extends Error {
  constructor() {
    super('agent event delivery failed');
    this.name = 'PresentationDeliveryError';
  }
}

export class PresentationNavigationFatalError extends Error {
  constructor(message = 'session navigation transaction failed') {
    super(message);
    this.name = 'NavigationFatalError';
  }
}

export class PresentationNavigationCancelledError extends Error {
  constructor(message = 'session navigation cancelled') {
    super(message);
    this.name = 'NavigationCancelledError';
  }
}

export const isPresentationError = (error: unknown, name: string): boolean =>
  error instanceof Error && error.name === name;
