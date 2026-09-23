import type {
  WorkerCorrelation,
  WorkerDefinitionLoadRequest,
  WorkerHostCommand,
  WorkerToHostMessage,
} from './worker_protocol.ts';

const encoder = new TextEncoder();

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const fileSpecifier = (canonicalPath: string): string => {
  const url = new URL('file:///');
  url.pathname = canonicalPath;
  return url.href;
};

export interface WorkerModuleRevision {
  readonly canonicalSpecifier: string;
  readonly entrySha256: string;
  readonly sourceBytes: number;
}

/** Host-side pre-read and identity capture performed before a Worker imports an entry. */
export const readWorkerModuleRevision = async (
  path: string,
): Promise<WorkerModuleRevision> => {
  const canonicalPath = await Deno.realPath(path);
  const source = await Deno.readFile(canonicalPath);
  return {
    canonicalSpecifier: fileSpecifier(canonicalPath),
    entrySha256: await sha256Hex(source),
    sourceBytes: source.byteLength,
  };
};

/** Structural view shared by managed Definition and managed tool Definition revisions. */
export interface ManagedClosureRevisionView {
  readonly manifest: {
    readonly entry: string;
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[];
  };
  readonly physicalRoot: string;
}

/** Build a process-local managed closure descriptor from an already verified exact revision. */
export const managedClosureLoadRequest = (
  revision: ManagedClosureRevisionView,
): WorkerDefinitionLoadRequest => {
  const files = revision.manifest.files.map((file) => ({
    relativePath: file.path,
    canonicalSpecifier: fileSpecifier(`${revision.physicalRoot}/files/${file.path}`),
    sha256: file.sha256,
    sourceBytes: file.byteLength,
  }));
  const entry = files.find((file) => file.relativePath === revision.manifest.entry);
  if (entry === undefined) throw new Error('Managed Definition entry is absent from its closure');
  return Object.freeze({
    kind: 'managed' as const,
    entry: Object.freeze({
      canonicalSpecifier: entry.canonicalSpecifier,
      entrySha256: entry.sha256,
      sourceBytes: entry.sourceBytes,
    }),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
};

export const managedWorkerDefinitionLoadRequest = managedClosureLoadRequest;
export const managedToolDefinitionLoadRequest = managedClosureLoadRequest;

export type WorkerCapsuleStatus =
  | 'starting'
  | 'ready'
  | 'closed'
  | 'terminated'
  | 'error';

export interface WorkerCapsuleOptions {
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
  readonly timeout: ReturnType<typeof setTimeout>;
};

export type WorkerMessageListener = (message: WorkerToHostMessage) => void;

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

  send(command: WorkerHostCommand): void {
    this.worker.postMessage(command);
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
    const queuedIndex = this.messages.findIndex((message) => predicate(message));
    if (queuedIndex >= 0) {
      const [message] = this.messages.splice(queuedIndex, 1);
      return message as T;
    }
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `timed out waiting for Worker message after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const waiter: Waiter = {
        predicate,
        resolve: (message) => resolve(message as T),
        reject,
        timeout,
      };
      this.waiters.push(waiter);
    });
  }

  async close(correlation: WorkerCorrelation): Promise<void> {
    this.send({ kind: 'close', correlation });
    await this.waitForMessage(
      (message): message is Extract<WorkerToHostMessage, { kind: 'closed' }> =>
        message.kind === 'closed',
    );
    this.currentStatus = 'closed';
  }

  terminate(): void {
    this.worker.terminate();
    this.currentStatus = 'terminated';
    const error = new Error('Worker capsule terminated');
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
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
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    // Subscribers consume production messages as they arrive. Keep unmatched messages only for
    // the probe/waitForMessage path, where no subscriber owns delivery.
    if (this.listeners.size === 0) this.messages.push(message);
  }
}

export const workerTextByteLength = (value: string): number => encoder.encode(value).byteLength;
