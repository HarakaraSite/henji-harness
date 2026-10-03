import { deepStrictEqual } from 'node:assert';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const lineBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  number[]
>();

const fixtureCommand = (
  args: readonly string[],
  options: { stdin?: 'piped' } = {},
): Deno.ChildProcess =>
  new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--no-check',
      '--unstable-worker-options',
      '--allow-read=.,/tmp',
      '--allow-write=/tmp',
      '--config',
      'deno.v0.json',
      'tests/v0/fixtures/increment_149_history_init.ts',
      ...args,
    ],
    stdin: options.stdin ?? 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

const readLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
): Promise<string> => {
  const bytes = lineBuffers.get(reader) ?? [];
  while (true) {
    const newline = bytes.indexOf(10);
    if (newline >= 0) {
      const line = bytes.splice(0, newline);
      bytes.shift();
      lineBuffers.set(reader, bytes);
      return decoder.decode(Uint8Array.from(line));
    }
    const next = await reader.read();
    if (next.done) {
      throw new Error(
        `process ended before its barrier: ${decoder.decode(Uint8Array.from(bytes))}`,
      );
    }
    for (const byte of next.value) bytes.push(byte);
  }
};

const readAll = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return decoder.decode(concat(chunks));
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const collect = async (
  child: Deno.ChildProcess,
  stdout: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> = child.stdout.getReader(),
  stderr: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> = child.stderr.getReader(),
) => {
  const [out, err, status] = await Promise.all([
    readAll(stdout),
    readAll(stderr),
    child.status,
  ]);
  return { out, err, status };
};

Deno.test('Increment 149 two writer processes create and read back separate Sessions', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i149-two-writers-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  await Deno.mkdir(paths.root, { recursive: true, mode: 0o700 });
  const directory = await Deno.open(paths.root, { read: true });
  await directory.lock(true);
  let released = false;
  let first: Deno.ChildProcess | undefined;
  let second: Deno.ChildProcess | undefined;
  try {
    first = fixtureCommand(['create-session', stateRoot, workspaceRoot, 'writer-a']);
    second = fixtureCommand(['create-session', stateRoot, workspaceRoot, 'writer-b']);
    const firstStdout = first.stdout.getReader();
    const secondStdout = second.stdout.getReader();
    const firstStderr = first.stderr.getReader();
    const secondStderr = second.stderr.getReader();
    deepStrictEqual(await readLine(firstStdout), 'writer-lock-attempt');
    deepStrictEqual(await readLine(secondStdout), 'writer-lock-attempt');
    directory.unlockSync();
    directory.close();
    released = true;
    const [firstOutput, secondOutput] = await Promise.all([
      collect(first, firstStdout, firstStderr),
      collect(second, secondStdout, secondStderr),
    ]);
    for (const output of [firstOutput, secondOutput]) {
      if (output.status.code !== 0) {
        throw new Error(`writer fixture failed (${output.status.code}): ${output.err}`);
      }
    }
    const firstSession = JSON.parse(firstOutput.out) as { sessionId: string };
    const secondSession = JSON.parse(secondOutput.out) as { sessionId: string };
    if (firstSession.sessionId === secondSession.sessionId) {
      throw new Error('writer processes allocated the same Session');
    }
    const reader = new SqliteHistoryStore(stateRoot, workspaceRoot, {
      readOnly: true,
    });
    try {
      await reader.initialize();
      deepStrictEqual(
        (await reader.listWorker()).sessions.map((session) => session.id).sort(),
        [firstSession.sessionId, secondSession.sessionId].sort(),
      );
      for (const sessionId of [firstSession.sessionId, secondSession.sessionId]) {
        const record = await reader.readWorker(sessionId);
        const expectedTitle = sessionId === firstSession.sessionId ? 'writer-a' : 'writer-b';
        if (record.title !== expectedTitle) {
          throw new Error(`Session ${sessionId} was not read back`);
        }
      }
    } finally {
      reader.close();
    }
  } finally {
    if (!released) {
      directory.unlockSync();
      directory.close();
    }
    for (const child of [first, second]) {
      if (child === undefined) continue;
      try {
        child.kill('SIGKILL');
      } catch {
        // The child may already have exited.
      }
      await child.status.catch(() => undefined);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 149 Core waits for a file whose initial schema is not committed', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i149-schema-barrier-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const writer = fixtureCommand(
    ['prepare-schema-barrier', stateRoot, workspaceRoot],
    { stdin: 'piped' },
  );
  const writerStdout = writer.stdout.getReader();
  const writerStderr = writer.stderr.getReader();
  const writerInput = writer.stdin!.getWriter();
  let reader: Deno.ChildProcess | undefined;
  let readerStdout: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined;
  let readerStderr: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined;
  let released = false;
  try {
    deepStrictEqual(await readLine(writerStdout), 'database-created');
    const database = await Deno.stat(`${paths.root}/history.sqlite3`);
    if (!database.isFile) throw new Error('barrier file was not created');
    reader = fixtureCommand(['open-core', stateRoot, workspaceRoot]);
    readerStdout = reader.stdout.getReader();
    readerStderr = reader.stderr.getReader();
    deepStrictEqual(await readLine(readerStdout), 'core-opening');
    deepStrictEqual(await readLine(readerStdout), 'schema-lock-attempt');
    await writerInput.write(encoder.encode('\n'));
    await writerInput.close();
    released = true;
    const [writerResult, readerResult] = await Promise.all([
      Promise.all([readAll(writerStdout), readAll(writerStderr), writer.status]),
      collect(reader, readerStdout, readerStderr),
    ]);
    const [writerOutput, writerError, writerStatus] = writerResult;
    if (writerStatus.code !== 0) {
      throw new Error(
        `schema writer failed (${writerStatus.code}): ${writerError}\n${writerOutput}`,
      );
    }
    if (readerResult.status.code !== 0) {
      throw new Error(
        `Core reader failed (${readerResult.status.code}): ${readerResult.err}\n${readerResult.out}`,
      );
    }
    if (!writerOutput.includes('schema-ready')) throw new Error('schema writer did not finish');
    if (!readerResult.out.includes('"phase":"ready"')) {
      throw new Error(`Core did not complete after schema commit: ${readerResult.out}`);
    }
  } finally {
    if (!released) {
      try {
        await writerInput.write(encoder.encode('\n'));
        await writerInput.close();
      } catch {
        // The child may already have exited after reporting a fixture failure.
      }
    }
    if (reader !== undefined) {
      try {
        reader.kill('SIGKILL');
      } catch {
        // It may already have exited.
      }
      await reader.status.catch(() => undefined);
    }
    try {
      writer.kill('SIGKILL');
    } catch {
      // It may already have exited.
    }
    await writer.status.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 149 read-only store leaves an empty workspace database absent', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i149-readonly-empty-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot, {
    readOnly: true,
  });
  try {
    let rejected = false;
    try {
      await store.initialize();
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('read-only initialization unexpectedly created history');
    let rootExists = true;
    try {
      await Deno.stat(paths.root);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      rootExists = false;
    }
    if (rootExists) throw new Error('read-only initialization created the workspace DB directory');
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
