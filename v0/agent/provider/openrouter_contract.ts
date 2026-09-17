import type { FailureCode, FailureStage, ParseReason } from '../session/failure_diagnostic.ts';
import type { OpenRouterExplicitReasoningEffort } from './openrouter_model_catalog.ts';
import {
  MAX_COMPLETE_MODEL_REQUEST_BYTES,
  MAX_CONVERSATION_TEXT_BYTES,
  MAX_SERIALIZED_MODEL_MESSAGES_BYTES,
} from '../../resource_limits.ts';

export const MAX_MESSAGE_BYTES = MAX_SERIALIZED_MODEL_MESSAGES_BYTES;
export const MAX_REQUEST_BYTES = MAX_COMPLETE_MODEL_REQUEST_BYTES;
/** Buffered provider bodies are distinct from incrementally consumed SSE responses. */
export const MAX_BUFFERED_RESPONSE_BYTES = 1024 * 1024;
export const MAX_ASSISTANT_TEXT_BYTES = MAX_CONVERSATION_TEXT_BYTES;
export const MAX_ASSISTANT_PROGRESS_TEXT_BYTES = MAX_ASSISTANT_TEXT_BYTES;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

/** Structural provider profile consumed by the normal OpenRouter adapter. */
export interface OpenRouterAgentProfile {
  readonly id: string;
  readonly model: string;
  readonly origin: string;
  readonly path: string;
  readonly method: 'POST';
  readonly secretEnv: string;
  readonly maxCompletionTokens: number;
  readonly stream: false;
  readonly reasoningEffort?: OpenRouterExplicitReasoningEffort;
  /** Wire field for reasoning effort; OpenAI-compatible Chat Completions uses `reasoning_effort`. */
  readonly reasoningEffortField?: 'reasoning' | 'reasoning_effort';
}

export type OpenRouterResponseMode = 'json' | 'sse';

export type AgentTransportErrorCode =
  | 'invalid_input'
  | 'missing_credential'
  | 'provider_timeout'
  | 'transport_error'
  | 'http_error'
  | 'response_error'
  | 'limit_exceeded';

/** Typed, sanitized facts projected at the provider boundary. */
export interface OpenRouterFailureFact {
  readonly stage: FailureStage;
  readonly code: FailureCode;
  /** Number of fetch calls made by this generate invocation. */
  readonly requestCount: number;
  /** Provider-owned retries performed inside this generate invocation. */
  readonly retryCount: number;
  readonly httpStatus?: number;
  readonly parseReason?: ParseReason;
}

type OpenRouterFailureFactInput =
  & Omit<
    OpenRouterFailureFact,
    'requestCount' | 'retryCount'
  >
  & { readonly retryCount?: number };

/** A failure surface that deliberately retains no credential or provider body. */
export class OpenRouterAgentError extends Error {
  readonly code: AgentTransportErrorCode;
  readonly requestCount: number;
  readonly status?: number;
  readonly failureFact: OpenRouterFailureFact;

  constructor(
    code: AgentTransportErrorCode,
    message: string,
    requestCount: number,
    status?: number,
    failureFact?: OpenRouterFailureFactInput,
  ) {
    super(message);
    this.name = 'OpenRouterAgentError';
    this.code = code;
    this.requestCount = requestCount;
    this.status = status;
    const defaultStage: FailureStage = code === 'missing_credential'
      ? 'credential_resolution'
      : code === 'transport_error' || code === 'provider_timeout'
      ? 'transport'
      : code === 'http_error'
      ? 'http'
      : code === 'response_error' || code === 'limit_exceeded' && requestCount === 1
      ? 'response_parse'
      : 'request_build';
    this.failureFact = Object.freeze({
      stage: failureFact?.stage ?? defaultStage,
      code: failureFact?.code ?? code,
      requestCount,
      retryCount: failureFact?.retryCount ?? 0,
      ...(status === undefined && failureFact?.httpStatus === undefined
        ? {}
        : { httpStatus: failureFact?.httpStatus ?? status }),
      ...(failureFact?.parseReason === undefined ? {} : { parseReason: failureFact.parseReason }),
    });
  }
}

/** A host-owned source is consulted afresh for every provider request. */
export type CredentialSource = () =>
  | string
  | undefined
  | Promise<string | undefined>;

/** Direct-test-only observation of bounded stream text accounting work. */
export interface StreamTextAccountingObserver {
  readonly onFragmentBytes?: (bytes: number) => void;
  readonly onProgressCodePoint?: () => void;
}

export interface OpenRouterAgentModelOptions {
  /** Tests inject this; production defaults to the host-owned global fetch. */
  readonly fetcher?: typeof fetch;
  /** A test-only dummy credential. It is never serialized into a request body. */
  readonly credential?: string;
  /** A host-owned source, useful for testing the missing-credential boundary. */
  readonly credentialSource?: CredentialSource;
  /** Tests may use a local endpoint; callers cannot select it through ModelRequest. */
  readonly endpoint?: string;
  /** Internal composition input; omitted callers retain the canonical production profile. */
  readonly profile?: OpenRouterAgentProfile;
  /** Evidence identity for a declared Chat Completions provider; defaults to built-in OpenRouter. */
  readonly evidenceIdentity?: {
    readonly provider: string;
    readonly api: 'openrouter-chat-completions' | 'openai-chat-completions';
    readonly authProfile: 'openrouter-api-key' | 'openai-api-key';
  };
  readonly timeoutMs?: number;
  readonly parentSignal?: AbortSignal;
  /** Internal runtime composition; omitted callers retain the canonical JSON response mode. */
  readonly responseMode?: OpenRouterResponseMode;
  /** Direct-test-only work observation; production callers omit this field. */
  readonly testTextAccountingObserver?: StreamTextAccountingObserver;
}
