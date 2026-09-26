import type { ProcessCommand, ProcessStatus } from '../runtime/process_contract.ts';
import type { WorkerCorrelation } from './worker_protocol.ts';

export type ProcessRequest =
  | {
    readonly action: 'start';
    readonly command: ProcessCommand;
    readonly executionId?: string;
    readonly callId?: string;
  }
  | { readonly action: 'read' | 'detach'; readonly stream: 'stdout' | 'stderr' }
  | { readonly action: 'stop' | 'release' };

export interface WorkerProcessRequest {
  readonly kind: 'process_request';
  readonly correlation: WorkerCorrelation;
  readonly operationId: string;
  readonly requestId: string;
  readonly request: ProcessRequest;
}

export type WorkerProcessReply =
  | {
    readonly kind: 'process_response';
    readonly correlation: WorkerCorrelation;
    readonly requestId: string;
    readonly result: {
      readonly done?: boolean;
      readonly chunk?: Uint8Array;
      readonly error?: string;
    };
  }
  | {
    readonly kind: 'process_event';
    readonly correlation: WorkerCorrelation;
    readonly operationId: string;
    readonly event: { readonly status: ProcessStatus } | {
      readonly closed: true;
      readonly error?: string;
    };
  };
