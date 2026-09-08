import type { BashOutputStore } from './bash_output.ts';

export interface Workspace {
  readonly root: string;
}

export interface WorkToolSeams {
  /** Test-only hook executed after the temp file is synced and before rename. */
  readonly beforeRename?: (
    target: string,
    temporary: string,
  ) => void | Promise<void>;
  /** Test-only hook executed after rename and before cancellation arbitration. */
  readonly afterRename?: (
    target: string,
    temporary: string,
  ) => void | Promise<void>;
  /** Test-only hook for exercising cancellation cleanup failures. */
  readonly cleanupTemporary?: (temporary: string) => void | Promise<void>;
  /** Direct-test store injection; production creates one Registry-owned store. */
  readonly bashOutputStore?: BashOutputStore;
  readonly bash?: BashToolSeams;
}

export interface BashToolSeams {
  /** Test-only hook at the bounded stdout/stderr capture cleanup boundary. */
  readonly beforeCapture?: (waitForSettlement: boolean) => void | Promise<void>;
}
