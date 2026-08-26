import { assert, assertEquals } from './test_helpers.ts';
import {
  CHILD_CWD,
  CHILD_ENTRYPOINT,
  CHILD_SUITE,
  CREDENTIAL_PATH,
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
  type CredentialLauncherChild,
  type CredentialLauncherChildStatus,
  CredentialLauncherError,
  DENO_COMMAND,
  main,
  MAX_CREDENTIAL_BYTES,
  parseCredentialBytes,
  readCredential,
  SECRET_ENV,
} from '../../v0/eval/live_corpus_credential_launcher.ts';

const DUMMY_CREDENTIAL = 'dummy-launcher-secret';
const REDACTION_MARKER = 'raw-path-or-secret-marker';
const encoder = new TextEncoder();

type FileOptions = {
  readonly metadata?: Partial<CredentialFileMetadata>;
  readonly openedMetadata?: Partial<CredentialFileMetadata>;
  readonly bytes?: Uint8Array;
  readonly readChunk?: number;
  readonly lstatError?: Error;
  readonly openError?: Error;
  readonly statError?: Error;
  readonly readError?: Error;
  readonly closeError?: Error;
  readonly effectiveUid?: number | null;
};

const baseMetadata = (size: number): CredentialFileMetadata => ({
  isFile: true,
  isSymlink: false,
  mode: 0o600,
  size,
  uid: 1000,
  dev: 7,
  ino: 11,
});

const fakeFileSystem = (options: FileOptions = {}): {
  readonly filesystem: CredentialFileSystem;
  readonly calls: { lstat: number; open: number; stat: number; read: number; close: number };
} => {
  const bytes = options.bytes ?? encoder.encode(DUMMY_CREDENTIAL);
  const metadata = { ...baseMetadata(bytes.byteLength), ...options.metadata };
  const openedMetadata = { ...metadata, ...options.openedMetadata };
  const calls = { lstat: 0, open: 0, stat: 0, read: 0, close: 0 };
  const filesystem: CredentialFileSystem = {
    effectiveUid: () => options.effectiveUid === null ? undefined : options.effectiveUid ?? 1000,
    lstat: (path) => {
      calls.lstat += 1;
      assertEquals(path, CREDENTIAL_PATH);
      if (options.lstatError) throw options.lstatError;
      return Promise.resolve(metadata);
    },
    open: (path) => {
      calls.open += 1;
      assertEquals(path, CREDENTIAL_PATH);
      if (options.openError) throw options.openError;
      let offset = 0;
      const handle: CredentialFileHandle = {
        stat: () => {
          calls.stat += 1;
          if (options.statError) throw options.statError;
          return Promise.resolve(openedMetadata);
        },
        read: (buffer) => {
          calls.read += 1;
          if (options.readError) throw options.readError;
          if (offset >= bytes.byteLength) return Promise.resolve(null);
          const chunk = Math.min(
            buffer.byteLength,
            options.readChunk ?? buffer.byteLength,
            bytes.byteLength - offset,
          );
          buffer.set(bytes.subarray(offset, offset + chunk));
          offset += chunk;
          return Promise.resolve(chunk);
        },
        close: () => {
          calls.close += 1;
          if (options.closeError) throw options.closeError;
        },
      };
      return Promise.resolve(handle);
    },
  };
  return { filesystem, calls };
};

const expectReadCode = async (
  filesystem: CredentialFileSystem,
  code: string,
): Promise<void> => {
  try {
    await readCredential(filesystem);
  } catch (error) {
    assert(error instanceof CredentialLauncherError);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const child = (status: Partial<CredentialLauncherChildStatus> = {}): CredentialLauncherChild => ({
  status: Promise.resolve({ success: true, code: 0, signal: null, ...status }),
});

Deno.test('credential parser accepts one token with each permitted terminal newline form', () => {
  assertEquals(parseCredentialBytes(encoder.encode(DUMMY_CREDENTIAL)), DUMMY_CREDENTIAL);
  assertEquals(parseCredentialBytes(encoder.encode(`${DUMMY_CREDENTIAL}\n`)), DUMMY_CREDENTIAL);
  assertEquals(parseCredentialBytes(encoder.encode(`${DUMMY_CREDENTIAL}\r\n`)), DUMMY_CREDENTIAL);
  assertEquals(parseCredentialBytes(encoder.encode(`${DUMMY_CREDENTIAL}\n\n\n`)), DUMMY_CREDENTIAL);
  assertEquals(
    parseCredentialBytes(encoder.encode(`${DUMMY_CREDENTIAL}\r\n\r\n`)),
    DUMMY_CREDENTIAL,
  );
  assertEquals(
    parseCredentialBytes(encoder.encode(`${DUMMY_CREDENTIAL}\n\r\n\n`)),
    DUMMY_CREDENTIAL,
  );
});

Deno.test('credential parser rejects empty-after-strip, embedded newline, controls, whitespace, and bad UTF-8', () => {
  const invalid = [
    new Uint8Array(),
    encoder.encode('\n'),
    encoder.encode(`${DUMMY_CREDENTIAL}\nembedded`),
    encoder.encode(`embedded\n${DUMMY_CREDENTIAL}`),
    encoder.encode(`${DUMMY_CREDENTIAL}\r`),
    encoder.encode(`${DUMMY_CREDENTIAL}\r\nextra`),
    encoder.encode(`${DUMMY_CREDENTIAL}\u0000`),
    encoder.encode(`${DUMMY_CREDENTIAL}\u007f`),
    encoder.encode(`${DUMMY_CREDENTIAL}\u0080`),
    encoder.encode(` ${DUMMY_CREDENTIAL}`),
    encoder.encode(`${DUMMY_CREDENTIAL}\u2003`),
    new Uint8Array([0xc3, 0x28]),
  ];
  for (const bytes of invalid) {
    try {
      parseCredentialBytes(bytes);
    } catch (error) {
      assert(error instanceof CredentialLauncherError);
      assertEquals(error.code, 'credential_invalid');
      continue;
    }
    throw new Error('expected credential_invalid');
  }
});

Deno.test('metadata is fail-closed and the handle is always closed after open', async () => {
  const cases: readonly [string, FileOptions][] = [
    ['credential_metadata_invalid', { metadata: { isFile: false } }],
    ['credential_metadata_invalid', { metadata: { isSymlink: true } }],
    ['credential_metadata_invalid', { metadata: { mode: 0o644 } }],
    ['credential_metadata_invalid', { metadata: { uid: 1001 } }],
    ['credential_metadata_invalid', { effectiveUid: null }],
    ['credential_metadata_invalid', { metadata: { size: 0 } }],
    ['credential_metadata_invalid', { metadata: { size: MAX_CREDENTIAL_BYTES + 1 } }],
    ['credential_metadata_changed', { openedMetadata: { size: 1 } }],
    ['credential_metadata_changed', { openedMetadata: { dev: 8 } }],
    ['credential_metadata_changed', { openedMetadata: { ino: 12 } }],
    ['credential_read_failed', { statError: new Error(REDACTION_MARKER) }],
    ['credential_read_failed', { readError: new Error(REDACTION_MARKER) }],
    ['credential_read_failed', { closeError: new Error(REDACTION_MARKER) }],
  ];
  for (const [code, options] of cases) {
    const fake = fakeFileSystem(options);
    await expectReadCode(fake.filesystem, code);
    assertEquals(fake.calls.close, fake.calls.open === 1 ? 1 : 0);
  }
  const short = fakeFileSystem({
    bytes: encoder.encode('short'),
    metadata: { size: 99 },
    openedMetadata: { size: 99 },
  });
  await expectReadCode(short.filesystem, 'credential_metadata_changed');
  assertEquals(short.calls.close, 1);
});

Deno.test('bounded read rejects an extra byte and never parses it', async () => {
  const fake = fakeFileSystem({
    bytes: new Uint8Array(MAX_CREDENTIAL_BYTES + 1).fill(0x41),
    metadata: { size: MAX_CREDENTIAL_BYTES },
  });
  await expectReadCode(fake.filesystem, 'credential_oversize');
  assertEquals(fake.calls.close, 1);
  assert(fake.calls.read <= 2);
});

Deno.test('metadata/open failures are static and do not expose raw errors', async () => {
  for (
    const [options, code] of [
      [{ lstatError: new Error(REDACTION_MARKER) }, 'credential_metadata_invalid'],
      [{ openError: new Error(REDACTION_MARKER) }, 'credential_open_failed'],
    ] as const
  ) {
    const fake = fakeFileSystem(options);
    const stderr: string[] = [];
    const exit = await main([], {
      filesystem: fake.filesystem,
      writeStderr: (text) => {
        stderr.push(text);
      },
      spawn: () => {
        throw new Error('spawn must not run');
      },
    });
    assertEquals(exit, 1);
    assertEquals(stderr, [`${code}\n`]);
    assert(!stderr.join('').includes(REDACTION_MARKER));
  }
});

Deno.test('arguments fail before file access and child creation', async () => {
  const fake = fakeFileSystem();
  let spawnCount = 0;
  const stderr: string[] = [];
  const exit = await main(['caller-selected-path'], {
    filesystem: fake.filesystem,
    spawn: () => {
      spawnCount += 1;
      return child();
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(fake.calls.lstat, 0);
  assertEquals(spawnCount, 0);
  assertEquals(stderr, ['arguments_invalid\n']);
});

Deno.test('valid credential uses one exact clear-env child and propagates status', async () => {
  const fake = fakeFileSystem({ bytes: encoder.encode(`${DUMMY_CREDENTIAL}\n`) });
  let invocation: { command: string; options: unknown } | undefined;
  const exit = await main([], {
    filesystem: fake.filesystem,
    spawn: (command, options) => {
      invocation = { command, options };
      return child();
    },
    writeStderr: () => {
      throw new Error('stderr must remain empty on success');
    },
  });
  assertEquals(exit, 0);
  assert(invocation !== undefined);
  assertEquals(invocation.command, DENO_COMMAND);
  assertEquals(invocation.options, {
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      '--allow-env=HENJI_OPENROUTER_API_KEY',
      '--allow-net=openrouter.ai',
      '--allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json',
      CHILD_ENTRYPOINT,
      CHILD_SUITE,
    ],
    cwd: CHILD_CWD,
    clearEnv: true,
    env: { [SECRET_ENV]: DUMMY_CREDENTIAL },
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  });
});

Deno.test('child failures are sanitized, single-spawn, and signal mapping is allowlisted', async () => {
  const statuses: readonly [CredentialLauncherChildStatus, number][] = [
    [{ success: false, code: 23, signal: null }, 23],
    [{ success: false, code: null, signal: 'SIGTERM' }, 143],
    [{ success: false, code: null, signal: 'SIGUSR1' }, 138],
    [{ success: false, code: null, signal: 'SIGUNKNOWN' }, 1],
  ];
  for (const [status, expectedExit] of statuses) {
    const fake = fakeFileSystem();
    const stderr: string[] = [];
    let spawnCount = 0;
    const exit = await main([], {
      filesystem: fake.filesystem,
      spawn: () => {
        spawnCount += 1;
        return child(status);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    assertEquals(exit, expectedExit);
    assertEquals(spawnCount, 1);
    assertEquals(stderr, []);
  }

  for (const failure of ['child_spawn_failed', 'child_wait_failed'] as const) {
    const fake = fakeFileSystem();
    const stderr: string[] = [];
    const exit = await main([], {
      filesystem: fake.filesystem,
      spawn: () => {
        if (failure === 'child_spawn_failed') throw new Error(REDACTION_MARKER);
        return { status: Promise.reject(new Error(REDACTION_MARKER)) };
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    assertEquals(exit, 1);
    assertEquals(stderr, [`${failure}\n`]);
    assert(!stderr.join('').includes(REDACTION_MARKER));
  }
});
