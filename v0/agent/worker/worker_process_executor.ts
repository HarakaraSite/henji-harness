import type {
  ProcessCommand,
  ProcessExecutor,
  ProcessOperation,
  ProcessStatus,
} from '../runtime/process_contract.ts';
import type { WorkerCorrelation } from './worker_protocol.ts';
import type {
  ProcessRequest,
  WorkerProcessReply,
  WorkerProcessRequest,
} from './worker_process_protocol.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
type ReplyResult = Extract<WorkerProcessReply, { kind: 'process_response' }>['result'];

/** Worker-local streams request one chunk at a time; raw process bytes never enter history. */
export class WorkerProcessExecutor implements ProcessExecutor {
  private readonly requests = new Map<string, ReturnType<typeof deferred<ReplyResult>>>();
  private readonly operations = new Map<
    string,
    {
      status: ReturnType<typeof deferred<ProcessStatus>>;
      closed: ReturnType<typeof deferred<void>>;
      operation: ProcessOperation;
    }
  >();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly post: (message: WorkerProcessRequest) => void,
    private readonly context: () => { correlation: WorkerCorrelation; executionId?: string },
  ) {}

  receive(message: WorkerProcessReply): void {
    if (message.kind === 'process_response') {
      const pending = this.requests.get(message.requestId);
      this.requests.delete(message.requestId);
      if (message.result.error !== undefined) pending?.reject(new Error(message.result.error));
      else pending?.resolve(message.result);
      return;
    }
    const owned = this.operations.get(message.operationId);
    if (owned === undefined) return;
    if ('status' in message.event) owned.status.resolve(message.event.status);
    else {
      if (message.event.error === undefined) owned.closed.resolve();
      else {
        owned.status.reject(new Error(message.event.error));
        owned.closed.reject(new Error(message.event.error));
      }
      this.operations.delete(message.operationId);
    }
  }

  private request(
    operationId: string,
    correlation: WorkerCorrelation,
    request: ProcessRequest,
  ): Promise<ReplyResult> {
    const requestId = crypto.randomUUID();
    const pending = deferred<ReplyResult>();
    this.requests.set(requestId, pending);
    this.post({ kind: 'process_request', correlation, operationId, requestId, request });
    return pending.promise;
  }

  start(command: ProcessCommand, context?: { readonly callId?: string }): ProcessOperation {
    if (this.closing !== undefined) throw new Error('process owner closed');
    const id = crypto.randomUUID();
    const { correlation, executionId } = this.context();
    const status = deferred<ProcessStatus>();
    const closed = deferred<void>();
    let physicallyClosed = false;
    void closed.promise.then(() => {
      physicallyClosed = true;
    }, () => {});
    const started = this.request(id, correlation, {
      action: 'start',
      command,
      executionId,
      callId: context?.callId,
    });
    void started.catch((error) => {
      status.reject(error);
      closed.reject(error);
      this.operations.delete(id);
    });
    const pipe = (stream: 'stdout' | 'stderr') =>
      new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await started;
          const read = await this.request(id, correlation, { action: 'read', stream });
          if (read.done) controller.close();
          else if (read.chunk !== undefined) controller.enqueue(read.chunk);
        },
        cancel: async () => {
          await started;
          await this.request(id, correlation, { action: 'detach', stream });
        },
      });
    const operation: ProcessOperation = {
      id,
      stdout: pipe('stdout'),
      stderr: pipe('stderr'),
      status: status.promise,
      closed: closed.promise,
      stop: async () => {
        await started;
        if (!physicallyClosed) await this.request(id, correlation, { action: 'stop' });
        await closed.promise;
      },
      release: async () => {
        await started;
        await this.request(id, correlation, { action: 'release' });
      },
    };
    this.operations.set(id, { status, closed, operation });
    return operation;
  }

  close(): Promise<void> {
    return this.closing ??= Promise.all(
      [...this.operations.values()].map(({ operation }) => operation.stop()),
    ).then(() => {});
  }
}
