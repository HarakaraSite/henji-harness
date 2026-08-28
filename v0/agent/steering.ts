/** Maximum UTF-8 bytes admitted for one mid-turn steering message. */
export const MAX_STEERING_TEXT_BYTES = 65_536;

export type SteerRequestResult =
  | 'accepted'
  | 'idle'
  | 'already_accepted';

export type SteeringState = 'open-empty' | 'pending' | 'consumed' | 'closed';

const encoder = new TextEncoder();

/** Validate steering input without changing the state of its owner. */
export const validateSteeringText = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError('steering text must not be blank');
  }
  if (value.includes('\0')) {
    throw new RangeError('steering text must not contain NUL');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new RangeError('steering text must be well-formed Unicode');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RangeError('steering text must be well-formed Unicode');
    }
  }
  if (encoder.encode(value).byteLength > MAX_STEERING_TEXT_BYTES) {
    throw new RangeError('steering text exceeds 65536 UTF-8 bytes');
  }
  return value;
};

/**
 * The one-message owner for one accepted parent turn.
 *
 * Admission and consumption are synchronous so the safe boundary in the loop can atomically
 * take the value. The owner deliberately does not expose a mutable peek or replacement API.
 */
export class SteeringOwner {
  private stateValue: SteeringState = 'open-empty';
  private admitted = false;
  private pendingText: string | undefined;

  get state(): SteeringState {
    return this.stateValue;
  }

  get hasBeenAdmitted(): boolean {
    return this.admitted;
  }

  /** Admit exactly one validated message for this turn. */
  admit(value: unknown): SteerRequestResult {
    const text = validateSteeringText(value);
    if (this.stateValue === 'closed') return this.admitted ? 'already_accepted' : 'idle';
    if (this.admitted || this.stateValue === 'pending' || this.stateValue === 'consumed') {
      return 'already_accepted';
    }
    this.admitted = true;
    this.pendingText = text;
    this.stateValue = 'pending';
    return 'accepted';
  }

  /** Alias used by narrow session/controller seams. */
  accept(value: unknown): SteerRequestResult {
    return this.admit(value);
  }

  /** Alias matching the public session operation. */
  steer(value: unknown): SteerRequestResult {
    return this.admit(value);
  }

  /** Atomically consume the pending message at the loop's safe continuation boundary. */
  consume(): string | undefined {
    if (this.stateValue !== 'pending') return undefined;
    const text = this.pendingText;
    this.pendingText = undefined;
    this.stateValue = 'consumed';
    return text;
  }

  /** Close this turn's lane. Pending text is always discarded. */
  close(): void {
    this.pendingText = undefined;
    this.stateValue = 'closed';
  }
}

/** Internal loop port; kept structural so tests and child loops need no owner dependency. */
export interface SteeringConsumer {
  consume(): string | undefined;
  close(): void;
}

export const createSteeringOwner = (): SteeringOwner => new SteeringOwner();
