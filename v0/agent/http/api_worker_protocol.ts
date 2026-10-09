import type { CoreService } from '../host/core_service.ts';
import type { CoreServiceErrorData } from '../host/core_service_error.ts';

type FunctionKey<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

export type ApiOperationName =
  | Exclude<
    FunctionKey<CoreService>,
    'beginShutdown' | 'close' | 'subscribeSession'
  >
  | 'subscribeSession';

export interface ApiWorkerStart {
  readonly hostname: string;
  readonly port: number;
}

export type ApiWorkerToMain =
  | { readonly kind: 'ready'; readonly url: string }
  | {
    readonly kind: 'operation';
    readonly id: number;
    readonly operation: ApiOperationName;
    readonly args: readonly unknown[];
    readonly subscriptionId?: number;
  }
  | {
    readonly kind: 'session.ack';
    readonly subscriptionId: number;
    readonly sequence: number;
  }
  | { readonly kind: 'unsubscribe'; readonly subscriptionId: number }
  | { readonly kind: 'shutdown.response.returned' }
  | { readonly kind: 'drained' }
  | { readonly kind: 'listener.closed' }
  | { readonly kind: 'listener.failed'; readonly error: string };

export type MainToApiWorker =
  | { readonly kind: 'start'; readonly options: ApiWorkerStart }
  | { readonly kind: 'reply'; readonly id: number; readonly value: unknown }
  | {
    readonly kind: 'reply.error';
    readonly id: number;
    readonly error: CoreServiceErrorData;
  }
  | {
    readonly kind: 'session.frame';
    readonly sequence: number;
    readonly subscriptionId: number;
    readonly bytes?: Uint8Array<ArrayBuffer>;
  }
  | { readonly kind: 'shutdown.accepted' }
  | { readonly kind: 'drain' }
  | { readonly kind: 'stop.listener' };
