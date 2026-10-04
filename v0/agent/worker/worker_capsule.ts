import type {
  WorkerCorrelation,
  WorkerHostCommand,
  WorkerToHostMessage,
} from './worker_protocol.ts';

const encoder = new TextEncoder();

type WorkerCapsuleStatus =
  | 'starting'
  | 'ready'
  | 'closed'
  | 'terminated'
  | 'error';

interface WorkerCapsuleOptions {
  readonly permissions?: 'inherit' | 'none';
}

type WorkerWithDenoOptions = WorkerOptions & {
  deno?: { readonly permissions: 'inherit' | 'none' };
};

type MessagePredicate<T extends WorkerToHostMessage> = (
  message: WorkerToHostMessage,
) => message is T;

type Waiter = {
  readonly predicate: (message: WorkerToHostMessage) => boolean;
  readonly resolve: (message: WorkerToHostMessage) => void;
  readonly reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type WorkerMessageListener = (message: WorkerToHostMessage) => void;

const eventMessage = (event: ErrorEvent): string =>
  event.message ||
  (event.error instanceof Error ? event.error.message : 'uncaught Worker error');

/**
 * Minimal Host bridge for the real module Worker. It intentionally exposes no callable value or
 * Host object to the Worker; all normal messages are data-only protocol values.
 */
export class WorkerCapsule {
  readonly worker: Worker;
  private readonly messages: WorkerToHostMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<WorkerMessageListener>();
  private currentStatus: WorkerCapsuleStatus = 'starting';

  constructor(scriptUrl: string | URL, options: WorkerCapsuleOptions = {}) {
    const workerOptions: WorkerWithDenoOptions = { type: 'module' };
    if (options.permissions !== undefined) {
      workerOptions.deno = { permissions: options.permissions };
    }
    this.worker = new Worker(scriptUrl, workerOptions);
    this.worker.onmessage = (event: MessageEvent<WorkerToHostMessage>) => {
      this.enqueue(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.currentStatus = 'error';
      this.enqueue({
        kind: 'worker_error',
        stage: 'uncaught',
        message: eventMessage(event),
      });
    };
    this.worker.onmessageerror = () => {
      this.currentStatus = 'error';
      this.enqueue({
        kind: 'worker_error',
        stage: 'uncaught',
        message: 'Worker message could not cross the structured-clone boundary',
      });
    };
  }

  get status(): WorkerCapsuleStatus {
    return this.currentStatus;
  }

  send(command: WorkerHostCommand, transfer?: Transferable[]): void {
    this.worker.postMessage(command, transfer ?? []);
  }

  /** Observe every data-only message without exposing the underlying Worker object. */
  subscribe(listener: WorkerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Deliberately probe-only: used to observe DataCloneError without widening the normal seam. */
  postRawForProbe(value: unknown): void {
    this.worker.postMessage(value);
  }

  async waitForMessage<T extends WorkerToHostMessage>(
    predicate: MessagePredicate<T>,
    timeoutMs = 5_000,
  ): Promise<T> {
    return await this.waitForMessageWithTimeout(predicate, timeoutMs);
  }

  private async waitForMessageWithTimeout<T extends WorkerToHostMessage>(
    predicate: MessagePredicate<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const queuedIndex = this.messages.findIndex((message) => predicate(message));
    if (queuedIndex >= 0) {
      const [message] = this.messages.splice(queuedIndex, 1);
      return message as T;
    }
    return await new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (message) => resolve(message as T),
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `timed out waiting for Worker message after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  async close(correlation: WorkerCorrelation): Promise<void> {
    if (
      this.currentStatus === 'error' || this.currentStatus === 'terminated' ||
      this.currentStatus === 'closed'
    ) return;
    this.send({ kind: 'close', correlation });
    const response = await this.waitForMessageWithTimeout(
      (message): message is Extract<WorkerToHostMessage, { kind: 'closed' | 'worker_error' }> =>
        (message.kind === 'closed' &&
          message.correlation.session === correlation.session &&
          message.correlation.instanceCorrelation === correlation.instanceCorrelation &&
          message.correlation.workerGeneration === correlation.workerGeneration &&
          message.correlation.baseStateRevision === correlation.baseStateRevision &&
          message.correlation.command === correlation.command) ||
        (message.kind === 'worker_error' &&
          (message.correlation === undefined ||
            (message.correlation.session === correlation.session &&
              message.correlation.instanceCorrelation === correlation.instanceCorrelation &&
              message.correlation.workerGeneration === correlation.workerGeneration &&
              message.correlation.baseStateRevision === correlation.baseStateRevision &&
              message.correlation.command === correlation.command))),
    );
    if (response.kind === 'worker_error') throw new Error(response.message);
    this.currentStatus = 'closed';
  }

  terminate(): void {
    this.worker.terminate();
    this.currentStatus = 'terminated';
    const error = new Error('Worker capsule terminated');
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private enqueue(message: WorkerToHostMessage): void {
    if (message.kind === 'ready') this.currentStatus = 'ready';
    if (message.kind === 'closed') this.currentStatus = 'closed';
    for (const listener of this.listeners) listener(message);
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    // Subscribers consume production messages as they arrive. Keep unmatched messages only for
    // the probe/waitForMessage path, where no subscriber owns delivery.
    if (this.listeners.size === 0) this.messages.push(message);
  }
}

export const workerTextByteLength = (value: string): number => encoder.encode(value).byteLength;
