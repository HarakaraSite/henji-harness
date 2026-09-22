import { OpenRouterAgentError } from './openrouter_contract.ts';

export interface RequestHeaderContext {
  readonly credential: string;
  readonly sessionId?: string;
}

/** True when a declared header (other than `authorization`) carries the credential placeholder. */
export const usesCredentialHeader = (
  headers: Readonly<Record<string, string>> | undefined,
): boolean =>
  headers !== undefined &&
  Object.entries(headers).some(([name, value]) =>
    name !== 'authorization' && value.includes('{credential}')
  );

/**
 * Resolve declared `{credential}` / `{sessionId}` placeholders at request build time. Credential
 * values and the resolved headers never leave the adapter request boundary.
 */
export const substituteRequestHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  context: RequestHeaderContext,
): Readonly<Record<string, string>> => {
  if (headers === undefined) return Object.freeze({});
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    let substituted = value.replaceAll('{credential}', context.credential);
    if (substituted.includes('{sessionId}')) {
      if (context.sessionId === undefined) {
        throw new OpenRouterAgentError(
          'invalid_input',
          'declared header requires an unavailable session id',
          0,
          undefined,
          { stage: 'request_build', code: 'invalid_input' },
        );
      }
      substituted = substituted.replaceAll('{sessionId}', context.sessionId);
    }
    result[name] = substituted;
  }
  return Object.freeze(result);
};
