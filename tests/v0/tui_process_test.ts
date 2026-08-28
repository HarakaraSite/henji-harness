import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const ROOT = Deno.cwd();
const FIXTURE = `${ROOT}/tests/v0/fixtures/tui_process_fixture.ts`;
const LIMIT = 32 * 1024;
const DEADLINE = 2_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Chunk {
  readonly text: string;
  readonly delayMs?: number;
}

interface ProcessResult {
  readonly status: Deno.CommandStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly overflow: boolean;
  readonly durationMs: number;
}

const collect = async (
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
): Promise<{ text: string; overflow: boolean }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (total + item.value.byteLength > LIMIT) {
        overflow = true;
        stop();
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decoder.decode(bytes), overflow };
};

const runPty = async (mode: string, chunks: readonly Chunk[]): Promise<ProcessResult> => {
  const redirect = mode === 'non-tty' ? ' </dev/null >/dev/null' : '';
  const command =
    `stty -isig; sleep 0.1; ${DENO} run --no-prompt --no-remote --allow-read=${ROOT} --allow-write=${ROOT} --allow-run=/bin/bash ${FIXTURE} ${mode}${redirect}`;
  const child = new Deno.Command('/usr/bin/script', {
    args: ['-qfec', command, '/dev/null'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let killed = false;
  const stop = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Natural completion can race the deadline.
    }
  };
  const started = performance.now();
  const timer = setTimeout(stop, DEADLINE);
  const output = collect(child.stdout, stop);
  const errors = collect(child.stderr, stop);
  const writer = child.stdin.getWriter();
  try {
    for (const chunk of chunks) {
      await writer.write(encoder.encode(chunk.text));
      if (chunk.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
      }
    }
    await writer.close();
  } catch {
    stop();
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // Child may have closed its pty already.
    }
  }
  const [status, stdout, stderr] = await Promise.all([child.status, output, errors]);
  clearTimeout(timer);
  return {
    status,
    stdout: stdout.text,
    stderr: stderr.text,
    killed,
    overflow: stdout.overflow || stderr.overflow,
    durationMs: performance.now() - started,
  };
};

Deno.test('PTY accepts ASCII, Unicode, Backspace and Ctrl-D with a completed response', async () => {
  const result = await runPty('success', [{ text: 'ab\x7f中\n\x04' }]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < 500);
  assert(result.stdout.includes('user> a中\r\n'));
  assert(result.stdout.includes('assistant> fixture response'));
  assert(result.stderr === '');
  assert(!result.stdout.includes('\x1b[?1049h'));
});

Deno.test('PTY planner startup selects one fixed planner Definition', async () => {
  const result = await runPty('planner', [{ text: 'plan this\n\x04' }]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < 500);
  assert(result.stdout.includes('user> plan this\r\n'));
  assert(result.stdout.includes('assistant> fixture response'));
  assert(result.stderr === '');
});

Deno.test('PTY progress replaces the live line and leaves completed tool records in scrollback', async () => {
  const result = await runPty('progress', [{ text: 'progress task\n\x04' }]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < 1_000);
  assert(result.stdout.includes('tool~ bash stdout:↵first'));
  assert(result.stdout.includes('tool~ bash stdout:↵second'));
  assertEquals((result.stdout.match(/tool> bash/g) ?? []).length, 1);
  assertEquals((result.stdout.match(/tool< bash success>/g) ?? []).length, 1);
  assert(result.stdout.includes('assistant> fixture response'));
  assert(result.stderr === '');
});

Deno.test('PTY busy steering is admitted once after the gated tool batch and committed as user text', async () => {
  const result = await runPty('steering', [
    { text: '', delayMs: 300 },
    { text: 'task\n', delayMs: 30 },
    { text: '\x1b[200~fix\t\x1b[201~\n', delayMs: 300 },
    { text: '\x04', delayMs: 200 },
  ]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  assert(result.stdout.includes('busy · steer pending'));
  assert(result.stdout.includes('steer> fix⇥'));
  assert(result.stdout.includes('assistant> steered response'));
  assertEquals((result.stdout.match(/steer> /g) ?? []).length, 1);
  assert(!result.stdout.includes('user> fix'));
  assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
  assert(result.stderr === '');
});

Deno.test('PTY steering draft is discarded by delayed Escape before the gated batch can consume it', async () => {
  const result = await runPty('steering', [
    { text: '', delayMs: 300 },
    { text: 'task\n', delayMs: 30 },
    { text: 'discarded\x1b', delayMs: 70 },
    { text: '\x04', delayMs: 300 },
  ]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  assert(result.stdout.includes('cancelling'));
  assert(result.stdout.includes('[cancelled]'));
  assert(!result.stdout.includes('steer> discarded'));
  assert(!result.stdout.includes('assistant> steered response'));
  assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
  assert(result.stderr === '');
});

Deno.test('PTY delayed assistant chunks replace before the final and restore once', async () => {
  const result = await runPty('assistant-progress', [
    { text: '', delayMs: 300 },
    { text: 'assistant task\n', delayMs: 40 },
    { text: '\x04', delayMs: 500 },
  ]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  const first = result.stdout.indexOf('assistant~ first chunk');
  const second = result.stdout.indexOf('assistant~ second chunk');
  const final = result.stdout.indexOf('assistant> fixture response');
  assert(first >= 0 && second > first && final > second);
  assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
  assert(!result.stdout.includes('late chunk'));
  assert(result.stderr === '');
});

Deno.test('PTY delayed assistant cancellation settles before one restore with no final or late chunk', async () => {
  const result = await runPty('assistant-progress-cancel', [
    { text: '', delayMs: 300 },
    { text: 'cancel assistant\n', delayMs: 30 },
    { text: '\x1b', delayMs: 120 },
    { text: '\x04', delayMs: 200 },
  ]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  assert(result.stdout.includes('assistant~ first chunk'));
  assert(!result.stdout.includes('assistant~ second chunk'));
  assert(!result.stdout.includes('assistant> fixture response'));
  assert(result.stdout.includes('[cancelled]'));
  assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
  assert(!result.stdout.includes('late chunk'));
  assert(result.stderr === '');
});

Deno.test('PTY bracketed paste submits one exact multiline task and visibly escapes tab', async () => {
  const result = await runPty('success', [{ text: '\x1b[200~line1\nline2\t\x1b[201~\n\x04' }]);
  assert(result.status.success);
  assert(result.stdout.includes('user> line1\r\nline2⇥\r\n'));
  assertEquals((result.stdout.match(/user> /g) ?? []).length, 1);
});

Deno.test('PTY busy Escape cancels, discards input, and returns to ready', async () => {
  const result = await runPty('busy', [
    { text: '', delayMs: 500 },
    { text: 'task\n', delayMs: 30 },
    { text: 'discarded\x1b', delayMs: 70 },
    { text: '\x04', delayMs: 200 },
  ]);
  assert(result.status.success);
  assert(result.stdout.includes('cancelling'));
  assert(result.stdout.includes('[cancelled]'));
  assert(!result.stdout.includes('assistant> fixture response'));
  assert(!result.stdout.includes('user> discarded'));
});

Deno.test('PTY same-chunk Enter then Ctrl-C exits after the current turn', async () => {
  const result = await runPty('busy', [
    { text: '', delayMs: 200 },
    { text: 'task\n\x03', delayMs: 300 },
  ]);
  assert(result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  assert(result.stdout.includes('cancelling; exiting'));
  assert(result.stdout.includes('[cancelled]'));
  assert(!result.stdout.includes('assistant> fixture response'));
  assert(!result.stdout.includes('agent_failure'));
});

Deno.test('PTY OS signals cancel busy turns, settle before restore, and preserve exit mapping', async () => {
  for (
    const [signal, expectedExit] of [
      ['SIGINT', 0],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const
  ) {
    const result = await runPty(`signal-${signal}`, [{ text: 'signal me\n', delayMs: 250 }]);
    assertEquals(result.status.success, expectedExit === 0);
    assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
    assertEquals(result.status.code, expectedExit);
    assert(result.stdout.includes('cancelling; exiting'));
    const cancelled = result.stdout.indexOf('[cancelled]');
    const restored = result.stdout.indexOf('\x1b[?2004l');
    assert(cancelled >= 0 && restored > cancelled);
    assert(!result.stdout.includes('assistant> fixture response'));
  }
});

Deno.test('PTY cancellation cleanup failure takes fatal precedence and restores once', async () => {
  const result = await runPty('busy-cleanup-failure', [
    { text: 'poison\n', delayMs: 30 },
    { text: '\x1b', delayMs: 70 },
  ]);
  assert(!result.status.success);
  assertEquals(result.status.code, 1);
  assert(result.stdout.includes('"code":"agent_failure"'));
  assert(!result.stdout.includes('cancellation cleanup failed'));
  assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
});

Deno.test('PTY pending nonzero signal cleanup failure waits, sanitizes, and exits 1', async () => {
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    const result = await runPty(`signal-cleanup-failure-${signal}`, [{ text: 'poison\n' }]);
    assert(!result.status.success);
    assertEquals(result.status.code, 1);
    assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
    const cancelling = result.stdout.indexOf('cancelling; exiting');
    const restored = result.stdout.indexOf('\x1b[?2004l');
    const failure = result.stdout.indexOf('"code":"agent_failure"');
    assert(cancelling >= 0 && restored > cancelling && failure > restored);
    assert(!result.stdout.includes('cancellation cleanup failed'));
    assert(!result.stdout.includes('[cancelled]'));
    assert(!result.stdout.includes('assistant> fixture response'));
    assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
    assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
  }
});

Deno.test('PTY idle Ctrl-C double press exits and clears the editor', async () => {
  const result = await runPty('success', [
    { text: '', delayMs: 500 },
    { text: 'draft\x03', delayMs: 40 },
    { text: '\x03' },
  ]);
  assert(result.status.success);
  assert(result.stdout.includes('press Ctrl-C again to exit'));
  assert(!result.stdout.includes('user> draft'));
});

Deno.test('PTY model failure restores controls and returns sanitized failure', async () => {
  const result = await runPty('failure', [{ text: 'fail\n' }]);
  assert(!result.status.success);
  assert(result.stdout.includes('\x1b[?2004h'));
  assert(result.stdout.includes('\x1b[?2004l'));
  assert(result.stdout.includes('\x1b[2K'));
  assert(result.stdout.includes('\x1b[0m'));
  assert(result.stdout.includes('\x1b[r'));
  assert(result.stdout.includes('\x1b[0 q'));
  assert(result.stdout.includes('\x1b[?25h'));
  assert(result.stdout.includes('"code":"agent_failure"'));
  assert(!result.stdout.includes('fixture model failure'));
});

Deno.test('non-TTY direct fixture invocation fails before raw acquisition or session', async () => {
  const result = await runPty('non-tty', []);
  assert(!result.status.success);
  assert(result.stdout.includes('"code":"invalid_invocation"'));
  assert(!result.stdout.includes('\x1b[?2004h'));
});

Deno.test('PTY invalid agent selection fails before session and raw acquisition', async () => {
  const result = await runPty('invalid-selection', []);
  assert(!result.status.success);
  assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
  assert(result.stdout.includes('"code":"invalid_invocation"'));
  assert(!result.stdout.includes('\x1b[?2004h'));
});

Deno.test('PTY late input is drained before raw restore and never becomes shell output', async () => {
  const result = await runPty('success', [{ text: 'task\n\x04late-after-exit' }]);
  assert(result.status.success);
  assert(result.stdout.includes('\x1b[?2004h'));
  assert(result.stdout.includes('\x1b[?2004l'));
  assert(!result.stdout.includes('late-after-exit\nassistant>'));
});

Deno.test('PTY injected crash restores once and does not emit raw diagnostics', async () => {
  const result = await runPty('crash', []);
  assert(!result.status.success);
  const pasteOn = `${String.fromCodePoint(0x1b)}[?2004h`;
  const pasteOff = `${String.fromCodePoint(0x1b)}[?2004l`;
  assertEquals(result.stdout.split(pasteOn).length - 1, 1);
  assertEquals(result.stdout.split(pasteOff).length - 1, 1);
  assert(result.stdout.includes('"code":"terminal_failure"'));
  assert(!result.stdout.includes('uncaught fixture failure'));
});

Deno.test('detached error and unhandled rejection use one guarded sanitized shutdown', async () => {
  for (
    const [mode, marker] of [
      ['detached-error', 'uncaught fixture failure'],
      ['unhandled-rejection', 'unhandled fixture rejection'],
    ] as const
  ) {
    const result = await runPty(mode, []);
    assert(!result.status.success);
    assert(!result.killed && !result.overflow && result.durationMs < DEADLINE);
    assert(result.stdout.includes('"code":"terminal_failure"'));
    assert(!result.stdout.includes(marker));
    assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
    assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
    assert(!result.stdout.includes('late'));
  }
});
