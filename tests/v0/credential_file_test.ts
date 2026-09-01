import { assert, assertEquals } from './test_helpers.ts';
import {
  CREDENTIAL_PATH,
  CredentialFileError,
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
  MAX_CREDENTIAL_BYTES,
  parseCredentialBytes,
  readCredentialFile,
} from '../../v0/agent/credential_file.ts';

const encoder = new TextEncoder();
const secret = 'test-only-token';

type Options = {
  readonly bytes?: Uint8Array;
  readonly metadata?: Partial<CredentialFileMetadata>;
  readonly openedMetadata?: Partial<CredentialFileMetadata>;
  readonly readChunk?: number;
  readonly closeError?: boolean;
};

const fakeFileSystem = (options: Options = {}): {
  readonly filesystem: CredentialFileSystem;
  readonly calls: Record<'lstat' | 'open' | 'stat' | 'read' | 'close', number>;
} => {
  const bytes = options.bytes ?? encoder.encode(secret);
  const base: CredentialFileMetadata = {
    isFile: true,
    isSymlink: false,
    mode: 0o600,
    size: bytes.byteLength,
    uid: 1000,
    dev: 3,
    ino: 4,
  };
  const metadata = { ...base, ...options.metadata };
  const opened = { ...metadata, ...options.openedMetadata };
  const calls = { lstat: 0, open: 0, stat: 0, read: 0, close: 0 };
  const filesystem: CredentialFileSystem = {
    effectiveUid: () => 1000,
    lstat: (path) => {
      calls.lstat += 1;
      assertEquals(path, CREDENTIAL_PATH);
      return Promise.resolve(metadata);
    },
    open: (path) => {
      calls.open += 1;
      assertEquals(path, CREDENTIAL_PATH);
      let offset = 0;
      const file: CredentialFileHandle = {
        stat: () => {
          calls.stat += 1;
          return Promise.resolve(opened);
        },
        read: (buffer) => {
          calls.read += 1;
          if (offset >= bytes.byteLength) return Promise.resolve(null);
          const count = Math.min(
            options.readChunk ?? buffer.byteLength,
            bytes.byteLength - offset,
          );
          buffer.set(bytes.subarray(offset, offset + count));
          offset += count;
          return Promise.resolve(count);
        },
        close: () => {
          calls.close += 1;
          if (options.closeError) throw new Error('redacted close failure');
        },
      };
      return Promise.resolve(file);
    },
  };
  return { filesystem, calls };
};

const expectFailure = async (
  filesystem: CredentialFileSystem,
  code: string,
): Promise<void> => {
  try {
    await readCredentialFile(filesystem);
  } catch (error) {
    assert(error instanceof CredentialFileError);
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected ${code}`);
};

Deno.test('credential source validates token syntax and strips only terminal newline sequences', () => {
  assertEquals(parseCredentialBytes(encoder.encode(secret)), secret);
  assertEquals(parseCredentialBytes(encoder.encode(`${secret}\n\r\n`)), secret);
  for (
    const value of [
      '',
      `${secret}\r`,
      `${secret}\nother`,
      `${secret}\u0000`,
      ` ${secret}`,
    ]
  ) {
    try {
      parseCredentialBytes(encoder.encode(value));
    } catch (error) {
      assert(error instanceof CredentialFileError);
      assertEquals(error.code, 'credential_invalid');
      continue;
    }
    throw new Error('expected credential_invalid');
  }
});

Deno.test('credential source performs bounded metadata/open/read/close and refreshes each call', async () => {
  const fake = fakeFileSystem({ readChunk: 2 });
  assertEquals(await readCredentialFile(fake.filesystem), secret);
  assertEquals(fake.calls, { lstat: 1, open: 1, stat: 1, read: 9, close: 1 });
  assertEquals(await readCredentialFile(fake.filesystem), secret);
  assertEquals(fake.calls.lstat, 2);
  assertEquals(fake.calls.open, 2);
});

Deno.test('credential source fails closed for metadata drift, oversize, and close failure', async () => {
  for (
    const options of [
      { metadata: { mode: 0o644 } },
      { openedMetadata: { ino: 9 } },
      {
        bytes: new Uint8Array(MAX_CREDENTIAL_BYTES + 1).fill(0x41),
        metadata: { size: MAX_CREDENTIAL_BYTES },
      },
      { closeError: true },
    ] as const
  ) {
    const fake = fakeFileSystem(options);
    await expectFailure(
      fake.filesystem,
      options.bytes !== undefined
        ? 'credential_oversize'
        : options.metadata !== undefined
        ? 'credential_metadata_invalid'
        : options.openedMetadata !== undefined
        ? 'credential_metadata_changed'
        : 'credential_read_failed',
    );
    assertEquals(fake.calls.close, options.metadata?.mode === undefined ? 1 : 0);
  }
});
