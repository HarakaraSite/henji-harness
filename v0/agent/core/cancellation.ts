/** Internal state for one accepted user turn's cancellation lifetime. */
export type TurnCancellationState =
  | 'active'
  | 'cancel_requested'
  | 'settled'
  | 'cleanup_failed';

export type CancelRequestResult = 'requested' | 'already_requested' | 'idle';

/** A cancellation request that has completed cleanup and may be reported as a cancelled turn. */
export class TurnCancelledError extends Error {
  constructor() {
    super('turn cancelled');
    this.name = 'TurnCancelledError';
  }
}

/** Cancellation was requested but an owned resource could not be safely settled. */
export class CancellationCleanupError extends Error {
  constructor() {
    super('cancellation cleanup failed');
    this.name = 'CancellationCleanupError';
  }
}

/** The small owner used to arbitrate cancellation against ordinary turn settlement. */
export interface TurnCancellation {
  readonly signal: AbortSignal;
  readonly state: TurnCancellationState;
  request(): Exclude<CancelRequestResult, 'idle'>;
  trySettleNormally(): boolean;
  settleCancelled(): void;
  markCleanupFailed(): void;
}

export class TurnCancellationOwner implements TurnCancellation {
  private _state: TurnCancellationState = 'active';
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): TurnCancellationState {
    return this._state;
  }

  request(): Exclude<CancelRequestResult, 'idle'> {
    if (this._state === 'active') {
      this._state = 'cancel_requested';
      this.controller.abort();
      return 'requested';
    }
    return 'already_requested';
  }

  trySettleNormally(): boolean {
    if (this._state !== 'active') return false;
    this._state = 'settled';
    return true;
  }

  settleCancelled(): void {
    if (this._state === 'cancel_requested') this._state = 'settled';
  }

  markCleanupFailed(): void {
    if (this._state === 'active' || this._state === 'cancel_requested') {
      this._state = 'cleanup_failed';
    }
  }
}

export const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new TurnCancelledError();
};

export const isTurnCancelledError = (error: unknown): error is TurnCancelledError =>
  error instanceof TurnCancelledError;

export const isCancellationCleanupError = (
  error: unknown,
): error is CancellationCleanupError => error instanceof CancellationCleanupError;
