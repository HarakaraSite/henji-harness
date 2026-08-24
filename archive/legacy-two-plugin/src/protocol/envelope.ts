import { error, type HarnessError } from '../domain/errors.ts';

export const ENVELOPE_VERSION = 1;

interface EnvelopeBase {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly parentId?: string;
  readonly targetId?: string;
}

export interface RequestEnvelope extends EnvelopeBase {
  readonly kind: 'request';
  readonly method: string;
  readonly payload: unknown;
}

export interface ResponseEnvelope extends EnvelopeBase {
  readonly kind: 'response';
  readonly replyTo: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface EventEnvelope extends EnvelopeBase {
  readonly kind: 'event';
  readonly name: string;
  readonly payload: unknown;
}

export interface CancelEnvelope extends EnvelopeBase {
  readonly kind: 'cancel';
  readonly replyTo: string;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope | CancelEnvelope;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const parseEnvelope = (value: unknown): Envelope | HarnessError => {
  if (!isRecord(value) || value.v !== ENVELOPE_VERSION || !validId(value.id)) {
    return error('invalid_envelope', 'envelope requires v: 1 and a non-empty id');
  }
  if (
    (value.parentId !== undefined && !validId(value.parentId)) ||
    (value.targetId !== undefined && !validId(value.targetId))
  ) {
    return error(
      'invalid_envelope',
      'parentId and targetId must be non-empty strings when present',
    );
  }
  switch (value.kind) {
    case 'request':
      return validId(value.method) && 'payload' in value
        ? value as unknown as RequestEnvelope
        : error('invalid_envelope', 'request requires method and payload');
    case 'event':
      return validId(value.name) && 'payload' in value
        ? value as unknown as EventEnvelope
        : error('invalid_envelope', 'event requires name and payload');
    case 'cancel':
      return validId(value.replyTo)
        ? value as unknown as CancelEnvelope
        : error('invalid_envelope', 'cancel requires replyTo');
    case 'response':
      if (!validId(value.replyTo) || typeof value.ok !== 'boolean') {
        return error('invalid_envelope', 'response requires replyTo and boolean ok');
      }
      if (
        (value.ok && !('payload' in value)) ||
        (!value.ok &&
          (!isRecord(value.error) || !validId(value.error.code) || !validId(value.error.message)))
      ) {
        return error(
          'invalid_envelope',
          'successful response requires payload; failed response requires error',
        );
      }
      return value as unknown as ResponseEnvelope;
    default:
      return error('invalid_envelope', 'envelope kind is not supported');
  }
};
