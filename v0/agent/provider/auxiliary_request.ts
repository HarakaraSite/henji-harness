import type { AuthProfileId } from './model_selection.ts';
import { throwIfCancelled, TurnCancelledError } from '../core/cancellation.ts';
import type { ModelExecutionContext } from '../core/execution_context.ts';
import type {
  ProviderEvidencePhase,
  ProviderEvidenceRequestMetadata,
} from './provider_evidence.ts';

export interface AuxiliaryProviderEvidence {
  readonly execution: ModelExecutionContext;
  readonly phase: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly requestMetadata: ProviderEvidenceRequestMetadata;
  readonly captureBoundary: string;
  readonly serializerVersion: string;
}

/**
 * Worker-local, credential-resolving provider request seam exposed to tool Definitions.
 * It returns raw response bytes; credential values and Authorization never cross this boundary.
 */
export interface ProviderHttpRequest {
  readonly authProfile: AuthProfileId;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  /** Final bytes passed unchanged to both exact capture and fetch. */
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly evidence?: AuxiliaryProviderEvidence;
  readonly signal?: AbortSignal;
}

export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

export type ProviderRequestFn = (
  request: ProviderHttpRequest,
) => Promise<ProviderHttpResponse>;

export interface ProviderRequestDispatcherOptions {
  readonly resolveCredential: (
    authProfile: AuthProfileId,
  ) => string | undefined | PromiseLike<string | undefined>;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly reportStage?: (
    stage:
      | 'aux_request_provider_entered'
      | 'credential_resolve_entered'
      | 'credential_resolve_returned'
      | 'fetch_entered'
      | 'fetch_call_returned'
      | 'response_headers_received'
      | 'response_body_read_entered'
      | 'response_body_read_returned',
  ) => void;
}

const decoder = new TextDecoder();

/**
 * One ordering owner for every Worker-local auxiliary provider dispatch.
 * Credential and cancellation checks finish before the synchronous evidence→fetch boundary.
 */
export const createProviderRequestDispatcher = (
  options: ProviderRequestDispatcherOptions,
): ProviderRequestFn => {
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    const report = request.evidence?.execution.reportAuxiliaryStage ??
      options.reportStage;
    report?.('aux_request_provider_entered');
    report?.('credential_resolve_entered');
    const credential = await options.resolveCredential(request.authProfile);
    report?.('credential_resolve_returned');
    if (!credential) {
      throw new Error('host provider credential is not configured');
    }
    throwIfCancelled(request.signal);

    const deadline = options.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
    const signal = request.signal === undefined
      ? deadline
      : deadline === undefined
      ? request.signal
      : AbortSignal.any([request.signal, deadline]);
    const body = request.body ?? new Uint8Array();
    const evidenceInput = request.evidence;
    const evidence = evidenceInput?.execution.providerEvidence;
    if (evidenceInput !== undefined && evidence !== undefined) {
      const execution = evidenceInput.execution;
      execution.reportAuxiliaryStage?.('evidence_start_entered');
      const requestStart = {
        lane: execution.lane === 'child' ? 'planner' as const : 'parent' as const,
        phase: evidenceInput.phase,
        modelStep: evidenceInput.modelStep,
        endpoint: request.endpoint,
        method: request.method,
        requestMetadata: evidenceInput.requestMetadata,
      };
      if (execution.providerExactRequestObserver === undefined) {
        evidence.startRequest({
          ...requestStart,
          requestBody: decoder.decode(body),
        });
      } else {
        execution.providerExactRequestObserver({
          bytes: body,
          captureBoundary: evidenceInput.captureBoundary,
          serializerVersion: evidenceInput.serializerVersion,
          endpoint: request.endpoint,
          method: request.method,
          lane: requestStart.lane,
          phase: evidenceInput.phase,
          modelStep: evidenceInput.modelStep,
          requestMetadata: evidenceInput.requestMetadata,
          monolithicFallback: true,
        });
        evidence.startRequestMetadata(requestStart);
      }
    }

    try {
      report?.('fetch_entered');
      const pendingResponse = fetcher(request.endpoint, {
        method: request.method,
        signal,
        redirect: 'error',
        headers: {
          ...(request.headers ?? {}),
          authorization: `Bearer ${credential}`,
        },
        body,
      });
      report?.('fetch_call_returned');
      const response = await pendingResponse;
      report?.('response_headers_received');
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      report?.('response_body_read_entered');
      const bytes = new Uint8Array(await response.arrayBuffer());
      report?.('response_body_read_returned');
      if (request.signal?.aborted) throw new TurnCancelledError();
      if (deadline?.aborted) throw new Error('provider deadline exceeded');
      return { status: response.status, headers, bytes };
    } catch (error) {
      if (request.signal?.aborted) throw new TurnCancelledError();
      if (deadline?.aborted) throw new Error('provider deadline exceeded');
      throw error;
    }
  };
};
