import type { WorkerToHostMessage } from './worker_protocol.ts';

type MessagePredicate<T extends WorkerToHostMessage> = (
  message: WorkerToHostMessage,
) => message is T;

type Waiter = {
  readonly predicate: (message: WorkerToHostMessage) => boolean;
  readonly resolve: (message: WorkerToHostMessage) => void;
  readonly reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

export class HostMessageQueue {
  private readonly queue: WorkerToHostMessage[] = [];
  private readonly waiters: Waiter[] = [];

  publish(message: WorkerToHostMessage): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  wait<T extends WorkerToHostMessage>(
    predicate: MessagePredicate<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const queuedIndex = this.queue.findIndex((message) => predicate(message));
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return Promise.resolve(message as T);
    }
    return new Promise<T>((resolve, reject) => {
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

  fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}
