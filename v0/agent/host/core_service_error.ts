/** Error data that can cross a Worker boundary without relying on instanceof. */
export class CoreServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'CoreServiceError';
  }
}

export interface CoreServiceErrorData {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export const coreServiceErrorData = (error: unknown): CoreServiceErrorData | undefined =>
  error instanceof CoreServiceError
    ? { status: error.status, code: error.code, message: error.message }
    : undefined;
