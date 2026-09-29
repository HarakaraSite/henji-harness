import { CoalescingWriter, encodeScreenFrame, type ScreenFrame } from '../../v0/tui/terminal.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message?: string): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(message ?? `${left} !== ${right}`);
};

const decoder = new TextDecoder();
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

const frame = (
  rows: readonly string[],
  cursor: { readonly row: number; readonly cell: number } = { row: 0, cell: 0 },
  options: {
    readonly columns?: number;
    readonly scope?: string;
    readonly geometryGeneration?: number;
  } = {},
): ScreenFrame => ({
  rows,
  cursor,
  size: { columns: options.columns ?? 80, rows: rows.length },
  scope: options.scope ?? 'core/session',
  geometryGeneration: options.geometryGeneration ?? 0,
});

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

Deno.test('screen frame encoder writes a synchronized full repaint without line feeds', () => {
  const current = frame(['alpha', 'beta'], { row: 1, cell: 2 });
  const output = decode(encodeScreenFrame(current));
  assert(output.startsWith('\x1b[?2026h'));
  assert(output.endsWith('\x1b[?2026l'));
  assert(output.includes('\x1b[1;1Halpha\x1b[K'));
  assert(output.includes('\x1b[2;1Hbeta\x1b[K'));
  assert(output.endsWith('\x1b[2;3H\x1b[?2026l'));
  assert(!output.includes('\n'), 'screen rows must not scroll the terminal');
});

Deno.test('screen frame encoder updates changed rows and restores the cursor after row output', () => {
  const previous = frame(['alpha', 'long row']);
  const current = frame(['alpha', 'short']);
  assertEquals(
    decode(encodeScreenFrame(current, previous)),
    '\x1b[?2026h\x1b[2;1Hshort\x1b[K\x1b[1;1H\x1b[?2026l',
  );
});

Deno.test('screen frame encoder emits cursor-only changes and skips identical frames', () => {
  const previous = frame(['alpha'], { row: 0, cell: 0 });
  const moved = frame(['alpha'], { row: 0, cell: 3 });
  assertEquals(
    decode(encodeScreenFrame(moved, previous)),
    '\x1b[?2026h\x1b[1;4H\x1b[?2026l',
  );
  assertEquals(encodeScreenFrame(previous, previous).byteLength, 0);
});

Deno.test('queued resize frames replace pending frames and retain the returned geometry generation', async () => {
  const gate = deferred();
  const started = deferred();
  const writes: string[] = [];
  const callbacks: string[] = [];
  let blockFirstWrite = true;
  const writer = new CoalescingWriter(async (bytes) => {
    if (blockFirstWrite) {
      blockFirstWrite = false;
      started.resolve();
      await gate.promise;
    }
    writes.push(decode(bytes));
  });
  const original = frame(['same', 'screen'], { row: 1, cell: 2 });
  const shrunk = frame(['small'], { row: 0, cell: 1 }, { geometryGeneration: 1 });
  const returned = frame(['same', 'screen'], { row: 1, cell: 2 }, { geometryGeneration: 2 });

  writer.enqueueFrame(original, () => callbacks.push('original'));
  await started.promise;
  writer.enqueueFrame(shrunk, () => callbacks.push('shrunk'));
  writer.enqueueFrame(returned, () => callbacks.push('returned'));
  gate.resolve();
  await writer.flush();

  assertEquals(writes.length, 2, 'the pending smaller frame should be replaced');
  assertEquals(writes[0], decode(encodeScreenFrame(original)));
  assertEquals(writes[1], decode(encodeScreenFrame(returned)));
  assertEquals(callbacks, ['original', 'returned']);
});

Deno.test('partial writes finish a frame before committing its baseline', async () => {
  const gate = deferred();
  const started = deferred();
  const writtenBytes: number[] = [];
  let blockFirstWrite = true;
  const writer = new CoalescingWriter(async (bytes) => {
    if (blockFirstWrite) {
      blockFirstWrite = false;
      started.resolve();
      await gate.promise;
    }
    writtenBytes.push(bytes[0]!);
    return 1;
  });
  const original = frame(['alpha', 'beta'], { row: 1, cell: 3 });
  const skipped = frame(['not shown', 'beta'], { row: 0, cell: 0 });
  const latest = frame(['alpha', 'new'], { row: 1, cell: 3 });

  writer.enqueueFrame(original);
  await started.promise;
  writer.enqueueFrame(skipped);
  writer.enqueueFrame(latest);
  gate.resolve();
  await writer.flush();

  const expected = new Uint8Array([
    ...encodeScreenFrame(original),
    ...encodeScreenFrame(latest, original),
  ]);
  assertEquals(writtenBytes, [...expected]);
});

Deno.test('raw output invalidates the completed screen baseline', async () => {
  const writes: string[] = [];
  const writer = new CoalescingWriter((bytes) => {
    writes.push(decode(bytes));
  });
  const first = frame(['alpha']);
  const second = frame(['alpha']);
  writer.enqueueFrame(first);
  writer.enqueue(encode('\x1b[?25h'));
  writer.enqueueFrame(second);
  await writer.flush();

  assertEquals(writes, [
    decode(encodeScreenFrame(first)),
    '\x1b[?25h',
    decode(encodeScreenFrame(second)),
  ]);
});
