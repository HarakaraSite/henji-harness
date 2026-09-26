import type { ProcessOperation } from '../runtime/process_contract.ts';
import {
  LinuxProcessExecutor,
  runtimeProcessRunnerLaunch,
  sourceProcessRunnerLaunch,
} from '../runtime/process_executor.ts';
import type { WorkerProcessReply, WorkerProcessRequest } from './worker_process_protocol.ts';

interface OwnedOperation {
  readonly operation: ProcessOperation;
  readonly readers: Record<'stdout' | 'stderr', ReadableStreamDefaultReader<Uint8Array>>;
  readonly executionId?: string;
  readonly callId?: string;
  physicallyClosed: boolean;
  drained: boolean;
  released: boolean;
}

/** Physical generation lifetime, independent of Worker finally blocks and semantic history. */
export class WorkerProcessOwner {
  private readonly executor = new LinuxProcessExecutor(
    Deno.build.standalone
      ? runtimeProcessRunnerLaunch(Deno.execPath(), ['--internal-process-runner'])
      : sourceProcessRunnerLaunch(),
  );
  private readonly operations = new Map<string, OwnedOperation>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(private readonly send: (reply: WorkerProcessReply) => void) {}

  async handle(message: WorkerProcessRequest): Promise<void> {
    const { request, operationId, correlation, requestId } = message;
    let result: Extract<WorkerProcessReply, { kind: 'process_response' }>['result'] = {};
    try {
      if (request.action === 'start') {
        const operation = this.executor.start(request.command);
        const owned: OwnedOperation = {
          operation,
          readers: { stdout: operation.stdout.getReader(), stderr: operation.stderr.getReader() },
          executionId: request.executionId,
          callId: request.callId,
          released: false,
          physicallyClosed: false,
          drained: false,
        };
        this.operations.set(operationId, owned);
        const release = () => {
          if (owned.physicallyClosed && owned.drained && owned.released) {
            this.operations.delete(operationId);
          }
        };
        void Promise.all([owned.readers.stdout.closed, owned.readers.stderr.closed]).then(() => {
          owned.drained = true;
          release();
        }, () => {});
        void operation.status.then(
          (status) =>
            this.send({ kind: 'process_event', correlation, operationId, event: { status } }),
          () => {},
        );
        void operation.closed.then(
          () => {
            owned.physicallyClosed = true;
            this.send({ kind: 'process_event', correlation, operationId, event: { closed: true } });
            release();
          },
          (error) =>
            this.send({
              kind: 'process_event',
              correlation,
              operationId,
              event: { closed: true, error: String(error) },
            }),
        );
        if (request.executionId !== undefined && this.cancellations.has(request.executionId)) {
          await operation.stop();
        }
      } else {
        const owned = this.operations.get(operationId);
        if (owned === undefined) throw new Error('unknown process operation');
        switch (request.action) {
          case 'read': {
            const read = await owned.readers[request.stream].read();
            result = {
              done: read.done,
              ...(read.value === undefined ? {} : { chunk: read.value }),
            };
            break;
          }
          case 'detach':
            await owned.readers[request.stream].cancel();
            break;
          case 'stop':
            await owned.operation.stop();
            break;
          case 'release':
            owned.released = true;
            if (owned.physicallyClosed && owned.drained) this.operations.delete(operationId);
            break;
        }
      }
    } catch (error) {
      result = { error: String(error) };
    }
    this.send({ kind: 'process_response', correlation, requestId, result });
  }

  cancelExecution(executionId: string): Promise<void> {
    const existing = this.cancellations.get(executionId);
    if (existing !== undefined) return existing;
    const stopping = Promise.all(
      [...this.operations.values()]
        .filter((owned) => owned.executionId === executionId && !owned.released)
        .map((owned) => owned.operation.stop()),
    ).then(() => {});
    this.cancellations.set(executionId, stopping);
    void stopping.catch(() => {});
    return stopping;
  }

  async wait(executionId?: string): Promise<void> {
    if (executionId !== undefined) await this.cancellations.get(executionId);
    await this.closing;
  }

  finishExecution(executionId: string): void {
    this.cancellations.delete(executionId);
  }

  close(): Promise<void> {
    return this.closing ??= this.executor.close().finally(() => this.operations.clear());
  }
}
