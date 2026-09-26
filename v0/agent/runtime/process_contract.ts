/** Physical process data; semantic tool results and output stores belong to the caller. */
export interface ProcessCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProcessStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ProcessOperation {
  readonly id: string;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** The user's command status, independent of retained background processes. */
  readonly status: Promise<ProcessStatus>;
  /** Resolves after the runner and the owned group's remaining processes have ended. */
  readonly closed: Promise<void>;
  /** Stop the owned group and await physical cleanup. */
  stop(): Promise<void>;
  /** Release a settled call's references; normally returned background work remains owned. */
  release(): Promise<void>;
}

export interface ProcessExecutor {
  start(command: ProcessCommand, context?: { readonly callId?: string }): ProcessOperation;
  close(): Promise<void>;
}

/** Source runtime or the compiled executable's internal runner entry. */
export interface ProcessRunnerLaunch {
  readonly executable: string;
  readonly args: readonly string[];
}
