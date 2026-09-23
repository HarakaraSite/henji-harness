import { CoalescingWriter, TerminalLifecycle, type TerminalPort } from '../../v0/tui/terminal.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const decoder = new TextDecoder();
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const frame = (text: string): Uint8Array => encode(`\x1b[2J\x1b[H${text}`);

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

Deno.test('coalescing writer preserves chunk order', async () => {
  const written: string[] = [];
  const writer = new CoalescingWriter((bytes) => {
    written.push(decoder.decode(bytes));
    return Promise.resolve();
  });
  writer.enqueue(encode('a'));
  writer.enqueue(encode('b'));
  writer.enqueue(encode('c'));
  await writer.flush();
  assertEquals(written, ['a', 'b', 'c']);
});

Deno.test('coalescing writer drops superseded pending full frames', async () => {
  const gate = deferred();
  const written: string[] = [];
  let first = true;
  const writer = new CoalescingWriter(async (bytes) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    written.push(decoder.decode(bytes));
  });
  writer.enqueue(encode('start'));
  writer.enqueue(frame('F1'));
  writer.enqueue(frame('F2'));
  gate.resolve();
  await writer.flush();
  assertEquals(written, ['start', decoder.decode(frame('F2'))]);
});

Deno.test('coalescing writer keeps a non-frame chunk between frames', async () => {
  const gate = deferred();
  const written: string[] = [];
  let first = true;
  const writer = new CoalescingWriter(async (bytes) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    written.push(decoder.decode(bytes));
  });
  writer.enqueue(encode('start'));
  writer.enqueue(frame('F1'));
  writer.enqueue(encode('control'));
  writer.enqueue(frame('F2'));
  gate.resolve();
  await writer.flush();
  assertEquals(written, [
    'start',
    decoder.decode(frame('F1')),
    'control',
    decoder.decode(frame('F2')),
  ]);
});

Deno.test('coalescing writer flush drains chunks enqueued while flushing', async () => {
  const gate = deferred();
  const written: string[] = [];
  let first = true;
  const writer = new CoalescingWriter(async (bytes) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    written.push(decoder.decode(bytes));
  });
  writer.enqueue(encode('a'));
  const flushed = writer.flush();
  writer.enqueue(encode('b'));
  gate.resolve();
  await flushed;
  assertEquals(written, ['a', 'b']);
});

Deno.test('coalescing writer reports a failed frame and still sends later restore controls', async () => {
  const written: string[] = [];
  let failures = 0;
  let rejectFrame = true;
  const writer = new CoalescingWriter((bytes) => {
    const value = decoder.decode(bytes);
    if (rejectFrame && value.startsWith('\x1b[2J\x1b[H')) {
      rejectFrame = false;
      throw new Error('frame write failed');
    }
    written.push(value);
    return Promise.resolve();
  }, () => failures += 1);
  writer.enqueue(frame('failed'));
  writer.enqueue(encode('\x1b[?2004l'));
  writer.enqueue(encode('\x1b[?1049l'));
  let failed = false;
  try {
    await writer.flush();
  } catch {
    failed = true;
  }
  assert(failed);
  assertEquals(failures, 1);
  assertEquals(written, ['\x1b[?2004l', '\x1b[?1049l']);
});

class FlushTerminal implements TerminalPort {
  readonly writes: string[] = [];
  flushStarted = false;
  private readonly gate = deferred();

  stdinIsTerminal(): boolean {
    return true;
  }

  stdoutIsTerminal(): boolean {
    return true;
  }

  consoleSize(): { columns: number; rows: number } {
    return { columns: 80, rows: 24 };
  }

  setRaw(): void {}

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }

  write(bytes: Uint8Array): void {
    this.writes.push(decoder.decode(bytes));
  }

  flush(): Promise<void> {
    this.flushStarted = true;
    return this.gate.promise;
  }

  releaseFlush(): void {
    this.gate.resolve();
  }

  addSignal(): void {}

  removeSignal(): void {}
}

Deno.test('terminal lifecycle waits for queued output to flush on restore', async () => {
  const terminal = new FlushTerminal();
  const lifecycle = new TerminalLifecycle(terminal);
  await lifecycle.acquire();
  let restored = false;
  const restoring = lifecycle.restore().then(() => {
    restored = true;
  });
  await Promise.resolve();
  assert(terminal.flushStarted, 'restore must request a flush');
  assert(!restored, 'restore must not settle before the flush completes');
  terminal.releaseFlush();
  await restoring;
  assert(restored, 'restore settles after the flush completes');
  assertEquals(lifecycle.restoreStatus(), 'ok');
});
