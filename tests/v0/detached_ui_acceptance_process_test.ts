import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const ROOT = Deno.cwd();
const FIXTURE = `${ROOT}/tests/v0/fixtures/detached_ui_interactive_acceptance.ts`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Chunk {
  readonly text: string;
  readonly delayMs: number;
}

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 128 * 1024) throw new Error('interactive acceptance output exceeded bound');
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(output);
};

const runPty = async (chunks: readonly Chunk[]) => {
  const command =
    `stty -isig -iexten; (sleep 0.7; kill -WINCH $$) >/dev/null 2>&1 & exec ${DENO} run --no-prompt --no-remote ${FIXTURE}`;
  const child = new Deno.Command('/usr/bin/script', {
    args: ['-qefc', command, '/dev/null'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Natural completion can race the timeout.
    }
  };
  const timer = setTimeout(kill, 5_000);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const writer = child.stdin.getWriter();
  try {
    for (const chunk of chunks) {
      await writer.write(encoder.encode(chunk.text));
      await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
    }
    await writer.close();
  } catch {
    kill();
  } finally {
    writer.releaseLock();
  }
  const [status, output, errors] = await Promise.all([child.status, stdout, stderr]);
  clearTimeout(timer);
  return { status, output, errors, killed };
};

Deno.test('provider-free retained acceptance drives the shipped UI through a real PTY', async () => {
  const result = await runPty([
    { text: '\x1b[11~', delayMs: 90 }, // F1 help
    { text: '\x1b[11~', delayMs: 90 }, // restore
    { text: '\x07', delayMs: 100 }, // Ctrl-G picker
    { text: '\x1b[B', delayMs: 60 },
    { text: '\r', delayMs: 160 }, // resume fake target
    { text: '\x14', delayMs: 100 }, // Ctrl-T history
    { text: '\x1b', delayMs: 80 },
    { text: '\x0b', delayMs: 80 }, // Ctrl-K context preview
    { text: '\r', delayMs: 1 }, // start fake compaction
    { text: '\x1b', delayMs: 120 }, // cancel while compacting
    { text: '\x1b[5~\x1b[6~\x0c', delayMs: 100 }, // PageUp/PageDown/Ctrl-L
    { text: 'line1\x0fline2\n', delayMs: 360 }, // multiline ordinary fake task
    { text: 'cancel me\n', delayMs: 35 },
    { text: '\x1b', delayMs: 160 }, // cancel delayed fake task
    { text: '\x04', delayMs: 120 },
    { text: '\x04', delayMs: 300 }, // discard recovery and clean exit
    { text: '\x04', delayMs: 120 }, // tolerate PTY read coalescing at shutdown
  ]);
  assert(result.status.success);
  assert(!result.killed);
  assertEquals(result.errors, '');
  const lines = result.output.trim().split('\n');
  const reportLine = [...lines].reverse().find((line) => line.includes('"interactive":true'));
  assert(reportLine !== undefined);
  const reportStart = reportLine!.indexOf('{');
  const reportEnd = reportLine!.lastIndexOf('}');
  assert(reportStart >= 0 && reportEnd > reportStart);
  const report = JSON.parse(reportLine!.slice(reportStart, reportEnd + 1)) as Record<
    string,
    unknown
  >;
  for (
    const key of [
      'ok',
      'interactive',
      'retained',
      'threeBands',
      'stream',
      'toolProgress',
      'toolResult',
      'final',
      'pageUp',
      'pageDown',
      'latest',
      'help',
      'picker',
      'history',
      'compaction',
      'compactionCancelled',
      'multiline',
      'resize',
      'cancelled',
      'navigation',
      'terminalRestored',
    ]
  ) assertEquals(report[key], true, key);
  assertEquals(report.rawProviderIdLeaked, false);
  assertEquals(report.providerUsed, false);
  assertEquals(report.persistentStateUsed, false);
  assertEquals(result.output.split('\x1b[?2004h').length - 1, 1);
  assertEquals(result.output.split('\x1b[?2004l').length - 1, 1);
});
