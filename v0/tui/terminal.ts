/**
 * The deliberately small terminal port used by the first TUI.  Production owns one stdin
 * reader for the lifetime of a terminal session; tests use the same port with a fake backend.
 */
export interface TerminalPort {
  stdinIsTerminal(): boolean;
  stdoutIsTerminal(): boolean;
  consoleSize(): { columns: number; rows: number };
  setRaw(mode: boolean, options?: { cbreak: boolean }): void;
  read(): Promise<Uint8Array | null>;
  drainAndCloseInput(maxMs: number, idleMs: number): Promise<void>;
  write(bytes: Uint8Array): void;
  addSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void;
  removeSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void;
  /** Optional UI-local resize signal hooks. They never enter the agent/session event stream. */
  addResize?(handler: () => void): void;
  removeResize?(handler: () => void): void;
}

const encoder = new TextEncoder();

export const BRACKETED_PASTE_ON = '\x1b[?2004h';
export const BRACKETED_PASTE_OFF = '\x1b[?2004l';
export const EDITOR_CURSOR_STYLE = '\x1b[6 q';
export const DEFAULT_CURSOR_STYLE = '\x1b[0 q';
export const SHOW_CURSOR = '\x1b[?25h';
export const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h';
export const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l';
export const ERASE_LINE = '\x1b[2K';
export const RESET_SGR = '\x1b[0m';
export const BLINK_SGR = '\x1b[5m';
export const BLUE_SGR = '\x1b[34m';
export const YELLOW_SGR = '\x1b[33m';
export const GREEN_SGR = '\x1b[32m';
export const MAGENTA_SGR = '\x1b[35m';
export const RESET_SCROLL_REGION = '\x1b[r';

export const staticBytes = (text: string): Uint8Array => encoder.encode(text);

/** Production Deno adapter. It never creates a second stdin reader. */
export class DenoTerminal implements TerminalPort {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private pendingRead: Promise<Uint8Array | null> | null = null;
  private inputClosed = false;
  private draining = false;

  stdinIsTerminal(): boolean {
    return Deno.stdin.isTerminal();
  }

  stdoutIsTerminal(): boolean {
    return Deno.stdout.isTerminal();
  }

  consoleSize(): { columns: number; rows: number } {
    return Deno.consoleSize();
  }

  setRaw(mode: boolean, options: { cbreak: boolean } = { cbreak: true }): void {
    Deno.stdin.setRaw(mode, options);
  }

  private getReader(): ReadableStreamDefaultReader<Uint8Array> {
    if (this.reader === undefined) this.reader = Deno.stdin.readable.getReader();
    return this.reader;
  }

  /** Return the one outstanding read, preserving single-reader ownership. */
  read(): Promise<Uint8Array | null> {
    if (this.inputClosed && !this.draining) return Promise.resolve(null);
    if (this.pendingRead !== null) return this.pendingRead;
    const reader = this.getReader();
    const pending = reader.read().then((item) => item.done ? null : item.value);
    this.pendingRead = pending;
    void pending.then(() => {
      if (this.pendingRead === pending) this.pendingRead = null;
    });
    return pending;
  }

  /**
   * Consume input after shutdown starts. The first pending read is allowed to settle, then the
   * reader is observed for a short idle window. A final cancel settles a blocked Deno read.
   */
  async drainAndCloseInput(maxMs: number, idleMs: number): Promise<void> {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.draining = true;
    const reader = this.reader;
    if (reader === undefined) return;
    const max = Math.max(0, Number.isFinite(maxMs) ? maxMs : 0);
    const idle = Math.max(0, Number.isFinite(idleMs) ? idleMs : 0);
    const deadline = Date.now() + max;
    const settle = async (
      promise: Promise<Uint8Array | null>,
      timeout: number,
    ): Promise<
      { readonly kind: 'value'; readonly value: Uint8Array | null } | {
        readonly kind: 'timeout';
      }
    > => {
      if (timeout <= 0) return { kind: 'timeout' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          promise.then((value) => ({ kind: 'value' as const, value })),
          new Promise<{ readonly kind: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), timeout);
          }),
        ]);
        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    try {
      // The controller may have one read in flight. Do not issue a concurrent reader.read().
      if (this.pendingRead !== null) {
        const remaining = Math.max(0, deadline - Date.now());
        const result = await settle(this.pendingRead, Math.min(idle, remaining));
        if (result.kind === 'timeout' || result.value === null) return;
      }
      while (Date.now() < deadline) {
        const remaining = Math.min(idle, Math.max(0, deadline - Date.now()));
        if (remaining <= 0) break;
        const next = this.read();
        const result = await settle(next, remaining);
        if (result.kind === 'timeout' || result.value === null) break;
      }
    } finally {
      try {
        await reader.cancel('terminal shutdown');
      } catch {
        // Best effort: cleanup continues even when stdin is already closed.
      }
      try {
        reader.releaseLock();
      } catch {
        // A released/errored reader is already in the desired state.
      }
      this.reader = undefined;
      this.pendingRead = null;
      this.draining = false;
    }
  }

  write(bytes: Uint8Array): void {
    Deno.stdout.writeSync(bytes);
  }

  addSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void {
    Deno.addSignalListener(signal, handler);
  }

  removeSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void {
    Deno.removeSignalListener(signal, handler);
  }

  addResize(handler: () => void): void {
    Deno.addSignalListener('SIGWINCH', handler);
  }

  removeResize(handler: () => void): void {
    Deno.removeSignalListener('SIGWINCH', handler);
  }
}

export interface TerminalRendererGate {
  close(): void;
  clearLiveLine(): void;
  /** Retained production rendering owns an isolated terminal screen. */
  readonly usesAlternateScreen?: boolean;
}

type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
type SignalHandler = () => void;

/** Owns acquisition and the complete idempotent restore sequence. */
export class TerminalLifecycle {
  private acquired = false;
  private raw = false;
  private paste = false;
  private alternateScreen = false;
  private restoring: Promise<void> | null = null;
  private restoreFailed = false;
  private readonly signals = new Map<SignalName, SignalHandler>();
  private readonly resizeHandlers = new Set<(size: { columns: number; rows: number }) => void>();
  private resizeSignal: (() => void) | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeGeneration = 0;

  constructor(
    private readonly terminal: TerminalPort,
    private readonly renderer?: TerminalRendererGate,
  ) {}

  addSignals(handlers: Partial<Record<SignalName, SignalHandler>>): void {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const handler = handlers[signal];
      if (handler === undefined || this.signals.has(signal)) continue;
      this.terminal.addSignal(signal, handler);
      this.signals.set(signal, handler);
    }
  }

  /**
   * Subscribe to a bounded/coalesced UI-local resize notification. The callback receives a fresh
   * size and is never called after the returned unregister function or restore begins.
   */
  subscribeResize(handler: (size: { columns: number; rows: number }) => void): () => void {
    this.resizeHandlers.add(handler);
    if (this.resizeSignal === null && this.terminal.addResize !== undefined) {
      this.resizeSignal = () => {
        if (this.restoring !== null || this.resizeTimer !== null) return;
        const generation = this.resizeGeneration;
        this.resizeTimer = setTimeout(() => {
          this.resizeTimer = null;
          if (this.restoring !== null || generation !== this.resizeGeneration) return;
          let size: { columns: number; rows: number };
          try {
            size = this.terminal.consoleSize();
          } catch {
            return;
          }
          if (
            !Number.isSafeInteger(size.columns) || !Number.isSafeInteger(size.rows) ||
            size.columns <= 0 || size.rows <= 0
          ) return;
          for (const callback of this.resizeHandlers) callback(size);
        }, 0);
      };
      this.terminal.addResize(this.resizeSignal);
    }
    return () => {
      this.resizeHandlers.delete(handler);
      if (this.resizeHandlers.size === 0) this.removeResizeHandlers();
    };
  }

  async acquire(): Promise<void> {
    try {
      // Enter the retained screen before any startup frame can be emitted. Mark the mode before
      // writing so a partial host write still receives the best-effort matching restore sequence.
      if (this.renderer?.usesAlternateScreen === true) {
        this.alternateScreen = true;
        this.terminal.write(staticBytes(ENTER_ALTERNATE_SCREEN));
      }
      // Mark raw as needing restoration before invoking the host operation: setRaw may partially
      // change terminal state before reporting an error.
      this.raw = true;
      // Ctrl-C is a Host-local input action while the retained TUI is idle. Keep signal
      // generation disabled so the terminal delivers byte 0x03 through InputDecoder; external
      // SIGINT still arrives through the separately installed signal listener.
      this.terminal.setRaw(true, { cbreak: false });
      this.acquired = true;
      this.paste = true;
      this.terminal.write(staticBytes(BRACKETED_PASTE_ON));
      this.terminal.write(staticBytes(EDITOR_CURSOR_STYLE));
    } catch (error) {
      await this.restore();
      throw error;
    }
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  read(): Promise<Uint8Array | null> {
    return this.terminal.read();
  }

  /** Cleanup errors are intentionally swallowed after the first operation has been attempted. */
  async restore(): Promise<void> {
    if (this.restoring !== null) return this.restoring;
    this.restoring = this.restoreOnce();
    await this.restoring;
  }

  /** Sanitized latched result; no terminal/path/input detail is exposed. */
  restoreStatus(): 'ok' | 'failed' {
    return this.restoreFailed ? 'failed' : 'ok';
  }

  private async restoreOnce(): Promise<void> {
    this.removeResizeHandlers();
    // Closing is the first operation: late event delivery can no longer write dynamic output.
    try {
      this.renderer?.close();
    } catch {
      this.restoreFailed = true;
    }
    // Composition/startup can fail before terminal acquisition. Remove any signal hooks but do
    // not emit terminal controls or touch stdin when no terminal state was acquired.
    if (!this.raw && !this.acquired && !this.paste && !this.alternateScreen) {
      this.removeSignals();
      return;
    }
    if (this.paste) {
      try {
        this.terminal.write(staticBytes(BRACKETED_PASTE_OFF));
      } catch {
        this.restoreFailed = true;
        // Continue all remaining restore operations.
      }
      this.paste = false;
    }
    try {
      await this.terminal.drainAndCloseInput(1_000, 50);
    } catch {
      this.restoreFailed = true;
      // Continue with terminal control restoration.
    }
    try {
      this.renderer?.clearLiveLine();
    } catch {
      this.restoreFailed = true;
      // Continue with static controls and raw restore.
    }
    const controls = this.alternateScreen
      ? [RESET_SGR, RESET_SCROLL_REGION, DEFAULT_CURSOR_STYLE]
      : [RESET_SGR, RESET_SCROLL_REGION, DEFAULT_CURSOR_STYLE, SHOW_CURSOR];
    for (const sequence of controls) {
      try {
        this.terminal.write(staticBytes(sequence));
      } catch {
        this.restoreFailed = true;
        // Each operation is independent and best effort.
      }
    }
    if (this.raw) {
      try {
        this.terminal.setRaw(false, { cbreak: true });
      } catch {
        this.restoreFailed = true;
        // No further restoration is possible through this port.
      }
      this.raw = false;
    }
    if (this.alternateScreen) {
      try {
        this.terminal.write(staticBytes(EXIT_ALTERNATE_SCREEN));
      } catch {
        this.restoreFailed = true;
      } finally {
        this.alternateScreen = false;
      }
      // Show the cursor after returning to the user's original screen. This preserves the
      // existing lifecycle contract for normal exit while ensuring the restored screen is usable.
      try {
        this.terminal.write(staticBytes(SHOW_CURSOR));
      } catch {
        this.restoreFailed = true;
      }
    }
    this.removeSignals();
    this.acquired = false;
  }

  private removeSignals(): void {
    for (const [signal, handler] of this.signals) {
      try {
        this.terminal.removeSignal(signal, handler);
      } catch {
        this.restoreFailed = true;
        // The process may already be shutting down.
      }
    }
    this.signals.clear();
  }

  private removeResizeHandlers(): void {
    this.resizeGeneration += 1;
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.resizeSignal !== null) {
      try {
        this.terminal.removeResize?.(this.resizeSignal);
      } catch {
        this.restoreFailed = true;
      }
      this.resizeSignal = null;
    }
    this.resizeHandlers.clear();
  }
}
