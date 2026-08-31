import { assert, assertEquals } from './test_helpers.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ProcessResult {
  readonly status: Deno.CommandStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const copyTree = async (source: string, target: string): Promise<void> => {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
};

const collect = async (
  stream: ReadableStream<Uint8Array>,
  onText?: (text: string) => void,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const streamDecoder = new TextDecoder();
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 32 * 1024) {
        throw new Error('portable process output exceeded bound');
      }
      chunks.push(item.value);
      onText?.(streamDecoder.decode(item.value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(output);
};

const runShell = async (
  command: string,
  input = '',
  timeoutMs = 2_000,
  waitFor = '',
): Promise<ProcessResult> => {
  const child = new Deno.Command('/usr/bin/script', {
    args: ['-qfec', command, '/dev/null'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let timedOut = false;
  let resolveReady: (() => void) | undefined;
  let ready = waitFor === '';
  const readyPromise = new Promise<void>((resolve) => resolveReady = resolve);
  let observed = '';
  const observe = (text: string): void => {
    if (ready) return;
    observed += text;
    if (observed.includes(waitFor)) {
      ready = true;
      resolveReady?.();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The child can complete concurrently with the deadline.
    }
  }, timeoutMs);
  const stdout = collect(child.stdout, observe);
  const stderr = collect(child.stderr);
  const writer = child.stdin.getWriter();
  try {
    if (!ready) {
      await Promise.race([
        readyPromise,
        new Promise((resolve) => setTimeout(resolve, Math.max(1_000, timeoutMs - 250))),
      ]);
      if (!ready) {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // The child can complete concurrently with the deadline.
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    try {
      await writer.write(encoder.encode(input));
      await writer.close();
    } catch {
      // Startup failures close the PTY before the test input is sent.
    }
  } finally {
    writer.releaseLock();
  }
  const [status, output, errors] = await Promise.all([
    child.status,
    stdout,
    stderr,
  ]);
  clearTimeout(timer);
  return { status, stdout: output, stderr: errors, timedOut };
};

const withDisposableCheckout = async <T>(
  fn: (root: string, bin: string) => Promise<T>,
): Promise<T> => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-portable-checkout-',
    dir: '/tmp',
  });
  const bin = await Deno.makeTempDir({
    prefix: 'henji-portable-bin-',
    dir: '/tmp',
  });
  try {
    await Deno.copyFile('deno.v0.json', `${root}/deno.v0.json`);
    await copyTree('v0', `${root}/v0`);
    await Deno.chmod(`${root}/v0/agent/session_launcher.sh`, 0o755);
    // The temporary PATH entry delegates to the exact test process executable. The wrapper keeps
    // the source read permission-free for the external Deno installation while the launcher still
    // resolves a temporary absolute PATH entry.
    await Deno.writeTextFile(
      `${bin}/deno`,
      `#!/bin/sh\nexec ${Deno.execPath()} "$@"\n`,
    );
    await Deno.chmod(`${bin}/deno`, 0o755);
    return await fn(root, bin);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(bin, { recursive: true });
  }
};

Deno.test('portable documented command resolves Deno from PATH and reaches orientation before input', async () => {
  await withDisposableCheckout(async (root, bin) => {
    const result = await runShell(
      `cd ${root} && sleep 0.1 && env -u HENJI_OPENROUTER_API_KEY -u HENJI_SESSION_STATE_ROOT PATH=${bin}:/usr/bin:/bin deno task --quiet --config deno.v0.json agent:tui --no-session`,
      '\x04',
      2_000,
      'keys> idle Ctrl-C twice within 500 ms exit · empty Ctrl-D exit',
    );
    assert(result.status.success);
    assert(!result.timedOut);
    assertEquals(result.stderr, '');
    const orientation = result.stdout.indexOf('Henji Harness');
    const orientationComplete = result.stdout.indexOf(
      'keys> idle Ctrl-C twice within 500 ms exit',
    );
    const prompt = result.stdout.indexOf('\x1b[2K> ');
    assert(
      orientation >= 0 && orientationComplete > orientation &&
        prompt > orientationComplete,
    );
    assert(result.stdout.includes('workspace> '));
    assert(result.stdout.includes('agent> default'));
    assert(result.stdout.includes('model> openrouter /'));
    assert(result.stdout.includes('session> no session'));
    assert(
      result.stdout.includes(
        'credential> verified immediately before each provider request; not checked at startup',
      ),
    );
    assert(
      result.stdout.includes(
        'trust> NO HARD SANDBOX; bash/edit/write run with your OS-user access',
      ),
    );
    assert(result.stdout.includes('busy Alt+Enter follow-up'));
    assert(result.stdout.includes('idle Ctrl-C twice within 500 ms exit'));
    assertEquals(result.stdout.split('\x1b[?2004h').length - 1, 1);
    assertEquals(result.stdout.split('\x1b[?2004l').length - 1, 1);
    assert(!result.stdout.includes('provider_sensitive_marker'));
    assert(!result.stdout.includes('agent_failure'));
  });
});

Deno.test('portable launcher rejects missing or wrong PATH Deno with sanitized startup failure', async () => {
  await withDisposableCheckout(async (root, bin) => {
    const expectedFailure =
      '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}';
    const missing = await runShell(
      `cd ${root} && PATH=/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!missing.status.success);
    assertEquals(missing.stderr, '');
    assert(missing.stdout.includes(expectedFailure));
    const fake = `${bin}/deno`;
    await Deno.remove(fake);
    await Deno.writeTextFile(fake, '#!/bin/sh\nprintf "deno 2.9.3\\n"\n');
    await Deno.chmod(fake, 0o755);
    const wrong = await runShell(
      `cd ${root} && PATH=${bin}:/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!wrong.status.success);
    assertEquals(wrong.stderr, '');
    assert(wrong.stdout.includes(expectedFailure));
    assert(!wrong.stdout.includes('2.9.3'));

    await Deno.remove(fake);
    await Deno.mkdir(fake);
    const nonregular = await runShell(
      `cd ${root} && PATH=${bin}:/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!nonregular.status.success);
    assertEquals(nonregular.stderr, '');
    assert(nonregular.stdout.includes(expectedFailure));
    assert(!nonregular.stdout.includes(bin));

    await Deno.remove(fake, { recursive: true });
    await Deno.writeTextFile(fake, 'not executable\n');
    await Deno.chmod(fake, 0o644);
    const nonexecutable = await runShell(
      `cd ${root} && PATH=${bin}:/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!nonexecutable.status.success);
    assertEquals(nonexecutable.stderr, '');
    assert(nonexecutable.stdout.includes(expectedFailure));
    assert(!nonexecutable.stdout.includes(bin));

    const capture = `${root}/portable-child-calls`;
    await Deno.remove(fake);
    await Deno.writeTextFile(
      fake,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then\n' +
        '  printf "deno 2.9.4 (plausible)\\n"\n' +
        '  printf "raw probe marker\\n" >&2\n' +
        '  printf "raw probe stdout marker\\n"\n' +
        '  exit 7\n' +
        'fi\n' +
        'printf "child spawned\\n" >> "$HENJI_PORTABLE_CAPTURE"\n' +
        'printf "raw child marker\\n"\n',
    );
    await Deno.chmod(fake, 0o755);
    const probeFailure = await runShell(
      `cd ${root} && HENJI_PORTABLE_CAPTURE=${capture} PATH=${bin}:/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!probeFailure.status.success);
    assertEquals(probeFailure.stderr, '');
    assert(probeFailure.stdout.includes(expectedFailure));
    assert(!probeFailure.stdout.includes('2.9.4'));
    assert(!probeFailure.stdout.includes('raw probe'));
    assert(!probeFailure.stdout.includes('raw child'));
    assertEquals(await Deno.readTextFile(capture).catch(() => ''), '');

    await Deno.remove(fake);
    await Deno.writeTextFile(
      fake,
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then\n' +
        '  printf "deno 2.9.3\\n"\n' +
        '  exit 0\n' +
        'fi\n' +
        'printf "child spawned\\n" >> "$HENJI_PORTABLE_CAPTURE"\n',
    );
    await Deno.chmod(fake, 0o755);
    const wrongWithCapture = await runShell(
      `cd ${root} && HENJI_PORTABLE_CAPTURE=${capture} PATH=${bin}:/usr/bin:/bin sh v0/agent/session_launcher.sh --no-session`,
    );
    assert(!wrongWithCapture.status.success);
    assertEquals(wrongWithCapture.stderr, '');
    assert(wrongWithCapture.stdout.includes(expectedFailure));
    assert(!wrongWithCapture.stdout.includes('2.9.3'));
    assertEquals(await Deno.readTextFile(capture).catch(() => ''), '');
  });
});
