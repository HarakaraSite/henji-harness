import { error, type HarnessError } from '../domain/errors.ts';
import { resolveOperation } from './registry.ts';

export interface BrokerCall {
  readonly endpointId: string;
  readonly operationId: string;
  readonly body: unknown;
}
export interface BrokerOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly fetchFn?: typeof fetch;
}
export interface BrokerResponse {
  readonly status: number;
  readonly body: unknown;
}

const readBounded = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | HarnessError> => {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    return error('message_limit_exceeded', 'broker response exceeds the configured byte limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return error('message_limit_exceeded', 'broker response exceeds the configured byte limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const callBroker = async (
  call: BrokerCall,
  options: BrokerOptions,
): Promise<BrokerResponse | HarnessError> => {
  const operation = resolveOperation(call.endpointId, call.operationId);
  if (!operation) return error('protocol_violation', 'broker operation is not allowlisted');
  const text = JSON.stringify(call.body);
  if (new TextEncoder().encode(text).byteLength > options.maxRequestBytes) {
    return error('message_limit_exceeded', 'broker request exceeds the configured byte limit');
  }
  try {
    const response = await (options.fetchFn ?? fetch)(`${operation.origin}${operation.path}`, {
      method: operation.method,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: text,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const bytes = await readBounded(response, options.maxResponseBytes);
    if ('code' in bytes) return bytes;
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes));
      return response.ok
        ? { status: response.status, body }
        : error('plugin_exit', `provider request failed with status ${response.status}`);
    } catch {
      return error('invalid_model_response', 'provider response is not valid JSON');
    }
  } catch {
    return error('plugin_exit', 'broker request failed');
  }
};
