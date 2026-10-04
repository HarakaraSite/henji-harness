import { captureFailureDetails } from '../core/failure_details.ts';
import type { AuthProfileId } from './model_selection.ts';
import { throwIfCancelled, TurnCancelledError } from '../core/cancellation.ts';
import type { ModelExecutionContext } from '../core/execution_context.ts';
import type {
  ProviderEvidencePhase,
  ProviderEvidenceRequestMetadata,
} from './provider_evidence.ts';
import type { ProviderEvidenceRecorder } from './provider_evidence.ts';

interface AuxiliaryProviderEvidence {
  readonly providerEvidence: ProviderEvidenceRecorder;
  readonly phase: ProviderEvidencePhase;
  readonly modelStep: number;
  readonly requestMetadata: ProviderEvidenceRequestMetadata;
  readonly reportAuxiliaryStage?: (
    stage: Parameters<NonNullable<ModelExecutionContext['reportAuxiliaryStage']>>[0],
  ) => void;
}

/** Non-secret HTTP attachment instructions supplied by the tool's request contract. */
export type ProviderRequestAuthentication =
  | { readonly kind: 'bearer' }
  | { readonly kind: 'header'; readonly name: string };

/**
 * Worker-local, credential-resolving provider request seam exposed to tool Definitions.
 * It returns raw response bytes; credential values and Authorization never cross this boundary.
 */
export interface ProviderHttpRequest {
  readonly authProfile: AuthProfileId;
  readonly endpoint: string;
  readonly method: string;
  /** Defaults to Bearer; API-key services can choose their own header without seeing the key. */
  readonly authentication?: ProviderRequestAuthentication;
  readonly headers?: Readonly<Record<string, string>>;
  /** Request bytes passed to fetch. */
  readonly body?: Uint8Array<ArrayBuffer>;
  /** Non-secret facts supplied by the caller when known; credentials and origin are attached by the runtime. */
  readonly evidenceMetadata?: Omit<ProviderEvidenceRequestMetadata, 'authProfile' | 'origin'>;
  readonly evidence?: AuxiliaryProviderEvidence;
  readonly signal?: AbortSignal;
}

export interface HookProviderEvidenceScope {
  current?: Readonly<{
    recorder: ProviderEvidenceRecorder;
    reportAuxiliaryStage?: AuxiliaryProviderEvidence['reportAuxiliaryStage'];
  }>;
}

/** Add request evidence while an external hook handler is active. */
export const createHookScopedProviderRequest = (
  requestProvider: ProviderRequestFn,
  scope: HookProviderEvidenceScope,
): ProviderRequestFn =>
async (request) => {
  const current = scope.current;
  if (current === undefined || request.evidence !== undefined) {
    return await requestProvider(request);
  }
  return await requestProvider({
    ...request,
    evidence: {
      providerEvidence: current.recorder,
      phase: 'hook',
      // A hook request has no model-generation step. Zero records that fact explicitly.
      modelStep: 0,
      requestMetadata: {
        ...request.evidenceMetadata,
        authProfile: request.authProfile,
        origin: 'hook',
      },
      ...(current.reportAuxiliaryStage === undefined ? {} : {
        reportAuxiliaryStage: current.reportAuxiliaryStage,
      }),
    },
  });
};

export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

export type ProviderRequestFn = (
  request: ProviderHttpRequest,
) => Promise<ProviderHttpResponse>;

interface ProviderRequestDispatcherOptions {
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

/**
 * One ordering owner for every Worker-local auxiliary provider dispatch.
 * Credential and cancellation checks finish before the synchronous evidence→fetch boundary.
 */
export const createProviderRequestDispatcher = (
  options: ProviderRequestDispatcherOptions,
): ProviderRequestFn => {
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    const report = request.evidence?.reportAuxiliaryStage ??
      options.reportStage;
    report?.('aux_request_provider_entered');
    report?.('credential_resolve_entered');
    const credential = await options.resolveCredential(request.authProfile);
    report?.('credential_resolve_returned');
    if (!credential) {
      throw new Error(`credential for ${request.authProfile} is not configured`);
    }
    throwIfCancelled(request.signal);

    let requestHeaders: Headers;
    try {
      requestHeaders = new Headers(request.headers);
      if (request.authentication?.kind === 'header') {
        requestHeaders.set(request.authentication.name, credential);
      } else {
        requestHeaders.set('authorization', `Bearer ${credential}`);
      }
    } catch {
      // A native header validation error can include the supplied credential value.
      throw new Error('credential request headers could not be constructed');
    }

    const deadline = options.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
    const signal = request.signal === undefined
      ? deadline
      : deadline === undefined
      ? request.signal
      : AbortSignal.any([request.signal, deadline]);
    const evidenceInput = request.evidence;
    const evidence = evidenceInput?.providerEvidence;
    if (evidenceInput !== undefined && evidence !== undefined) {
      evidenceInput.reportAuxiliaryStage?.('evidence_start_entered');
      const requestStart = {
        lane: 'parent' as const,
        phase: evidenceInput.phase,
        modelStep: evidenceInput.modelStep,
        endpoint: evidenceInput.phase === 'hook'
          ? hookEvidenceEndpoint(request.endpoint)
          : request.endpoint,
        method: request.method,
        requestMetadata: evidenceInput.requestMetadata,
      };
      evidence.startRequestMetadata(requestStart);
    }

    let operation = 'auxiliary_fetch';
    try {
      report?.('fetch_entered');
      const pendingResponse = fetcher(request.endpoint, {
        method: request.method,
        signal,
        redirect: 'error',
        headers: requestHeaders,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      report?.('fetch_call_returned');
      const response = await pendingResponse;
      report?.('response_headers_received');
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      evidence?.recordResponse({ status: response.status });
      operation = 'auxiliary_body_read';
      report?.('response_body_read_entered');
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body !== null) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            chunks.push(item.value.slice());
            length += item.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      report?.('response_body_read_returned');
      if (request.signal?.aborted) throw new TurnCancelledError();
      if (deadline?.aborted) throw new Error('provider deadline exceeded');
      return { status: response.status, headers, bytes };
    } catch (error) {
      const code = request.signal?.aborted
        ? 'cancelled'
        : deadline?.aborted
        ? 'provider_timeout'
        : 'transport_error';
      const details = captureFailureDetails(error, { operation, secrets: [credential] });
      evidence?.recordRequestFailure(
        { stage: 'transport', code, details },
        evidenceInput?.modelStep,
      );
      if (request.signal?.aborted) throw new TurnCancelledError();
      if (deadline?.aborted) {
        throw Object.assign(new Error('provider deadline exceeded'), { failureDetails: details });
      }
      throw Object.assign(new Error(details.message ?? 'provider request failed'), {
        failureDetails: details,
      });
    }
  };
};

const hookEvidenceEndpoint = (endpoint: string): string => {
  try {
    const parsed = new URL(endpoint);
    // Keep the route needed to distinguish an API while dropping URL userinfo,
    // query values and fragments that may carry credentials or request data.
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
};
