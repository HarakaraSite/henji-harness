import type { AuthProfileId } from './model_selection.ts';

/**
 * Worker-local, credential-resolving provider request seam exposed to tool Definitions.
 * It returns raw response bytes; credential values and Authorization never cross this boundary.
 */
export interface ProviderHttpRequest {
  readonly authProfile: AuthProfileId;
  readonly endpoint: string;
  readonly method: 'POST' | 'GET';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
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
