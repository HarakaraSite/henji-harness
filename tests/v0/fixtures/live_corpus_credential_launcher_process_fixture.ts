import {
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
  type CredentialLauncherCommandOptions,
  DENO_COMMAND,
  main,
} from '../../../v0/eval/live_corpus_credential_launcher.ts';

const DUMMY_CREDENTIAL = 'dummy-process-launcher-secret';
const encoder = new TextEncoder();
const bytes = encoder.encode(`${DUMMY_CREDENTIAL}\n`);
const metadata: CredentialFileMetadata = {
  isFile: true,
  isSymlink: false,
  mode: 0o600,
  size: bytes.byteLength,
  uid: 1000,
  dev: 1,
  ino: 1,
};

const filesystem: CredentialFileSystem = {
  effectiveUid: () => 1000,
  lstat: () => Promise.resolve(metadata),
  open: () => {
    let offset = 0;
    const file: CredentialFileHandle = {
      stat: () => Promise.resolve(metadata),
      read: (buffer) => {
        if (offset >= bytes.byteLength) return Promise.resolve(null);
        const count = Math.min(buffer.byteLength, bytes.byteLength - offset);
        buffer.set(bytes.subarray(offset, offset + count));
        offset += count;
        return Promise.resolve(count);
      },
      close: () => undefined,
    };
    return Promise.resolve(file);
  },
};

const fakeChildPath =
  `${Deno.cwd()}/tests/v0/fixtures/live_corpus_credential_launcher_fake_child.ts`;

const spawnFakeChild = (
  command: typeof DENO_COMMAND,
  options: CredentialLauncherCommandOptions,
) => {
  if (command !== DENO_COMMAND) throw new Error('unexpected executable');
  return new Deno.Command(command, {
    ...options,
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      '--allow-env=HENJI_OPENROUTER_API_KEY',
      fakeChildPath,
    ],
  }).spawn();
};

Deno.exit(await main([], { filesystem, spawn: spawnFakeChild }));
