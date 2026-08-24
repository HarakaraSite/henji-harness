import { error, type HarnessError } from '../domain/errors.ts';
import type { RequestEnvelope, ResponseEnvelope } from '../protocol/envelope.ts';

export class Router {
  #pending = new Map<string, RequestEnvelope>();
  #completed = new Set<string>();
  register(request: RequestEnvelope): HarnessError | undefined {
    if (this.#pending.has(request.id) || this.#completed.has(request.id)) {
      return error('protocol_violation', 'request id has already been registered');
    }
    this.#pending.set(request.id, request);
  }
  accept(response: ResponseEnvelope): RequestEnvelope | HarnessError {
    if (this.#completed.has(response.replyTo)) {
      return error('protocol_violation', 'request received more than one final response');
    }
    const request = this.#pending.get(response.replyTo);
    if (!request) {
      return error('protocol_violation', 'response does not correlate to a pending request');
    }
    this.#pending.delete(response.replyTo);
    this.#completed.add(response.replyTo);
    return request;
  }
}
