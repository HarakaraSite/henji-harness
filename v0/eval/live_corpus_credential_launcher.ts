import {
  CredentialFileError,
  parseCredentialBytes as parseSharedCredentialBytes,
} from '../agent/provider/credential_file.ts';

/**
 * Fixed, repo-external credential transport for the separately authorized live
 * sentinel.  This module deliberately has no caller-configurable production
 * inputs: the seams below exist only for permission-free tests.
 */

export const CREDENTIAL_PATH =
  '/home/masat.guest/.config/henji-harness/openrouter-api-key' as const;
export const DENO_COMMAND = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno' as const;
export const CHILD_CWD = '/home/masat.guest/src/henji-harness' as const;
export const CHILD_ENTRYPOINT = 'v0/eval/live_corpus_cli.ts' as const;
export const CHILD_SUITE = 'sentinel' as const;
export const SECRET_ENV = 'HENJI_OPENROUTER_API_KEY' as const;
export const MAX_CREDENTIAL_BYTES = 4096 as const;

export type CredentialLauncherFailureCode =
  | 'arguments_invalid'
  | 'credential_metadata_invalid'
  | 'credential_metadata_changed'
  | 'credential_open_failed'
  | 'credential_read_failed'
  | 'credential_oversize'
  | 'credential_invalid'
  | 'child_spawn_failed'
  | 'child_wait_failed'
  | 'child_status_invalid';

export class CredentialLauncherError extends Error {
  readonly code: CredentialLauncherFailureCode;

  constructor(code: CredentialLauncherFailureCode) {
    super(code);
    this.name = 'CredentialLauncherError';
    this.code = code;
  }
}

/** The small subset of FileInfo used by the fixed metadata boundary. */
export interface CredentialFileMetadata {
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly mode: number | null;
  readonly size: number;
  readonly uid: number | null;
  readonly dev?: number;
  readonly ino?: number;
}

export interface CredentialFileHandle {
  readonly stat: () => Promise<CredentialFileMetadata>;
  readonly read: (buffer: Uint8Array) => Promise<number | null>;
  readonly close: () => void;
}

export interface CredentialFileSystem {
  readonly lstat: (path: string) => Promise<CredentialFileMetadata>;
  readonly open: (path: string) => Promise<CredentialFileHandle>;
  readonly effectiveUid: () => number | undefined;
}

export interface CredentialLauncherChildStatus {
  readonly success: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface CredentialLauncherChild {
  readonly status: Promise<CredentialLauncherChildStatus>;
}

export interface CredentialLauncherCommandOptions {
  readonly args: readonly string[];
  readonly cwd: typeof CHILD_CWD;
  readonly clearEnv: true;
  readonly env: Readonly<Record<typeof SECRET_ENV, string>>;
  readonly stdin: 'null';
  readonly stdout: 'inherit';
  readonly stderr: 'inherit';
}

export interface CredentialLauncherDependencies {
  /** Test-only filesystem seam. Production always uses the fixed path. */
  readonly filesystem?: CredentialFileSystem;
  /** Test-only process seam. Production always uses the fixed executable/options. */
  readonly spawn?: (
    command: typeof DENO_COMMAND,
    options: CredentialLauncherCommandOptions,
  ) => CredentialLauncherChild;
  /** Test-only error-output seam. Child streams remain inherited. */
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const encoder = new TextEncoder();
const optionalNumber = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const fromFileInfo = (info: Deno.FileInfo): CredentialFileMetadata => ({
  isFile: info.isFile,
  isSymlink: info.isSymlink,
  mode: info.mode,
  size: info.size,
  uid: info.uid,
  ...(optionalNumber(info.dev) === undefined ? {} : { dev: optionalNumber(info.dev) }),
  ...(optionalNumber(info.ino) === undefined ? {} : { ino: optionalNumber(info.ino) }),
});

const defaultFileSystem: CredentialFileSystem = {
  lstat: async (path) => fromFileInfo(await Deno.lstat(path)),
  open: async (path) => {
    const file = await Deno.open(path, { read: true });
    return {
      stat: async () => fromFileInfo(await file.stat()),
      read: (buffer) => file.read(buffer),
      close: () => file.close(),
    };
  },
  effectiveUid: () => {
    try {
      const uid = Deno.uid();
      return typeof uid === 'number' && Number.isSafeInteger(uid) ? uid : undefined;
    } catch {
      return undefined;
    }
  },
};

const defaultSpawn = (
  command: typeof DENO_COMMAND,
  options: CredentialLauncherCommandOptions,
): CredentialLauncherChild => {
  const child = new Deno.Command(command, {
    args: [...options.args],
    cwd: options.cwd,
    clearEnv: options.clearEnv,
    env: { ...options.env },
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  }).spawn();
  return {
    status: child.status.then((status) => ({
      success: status.success,
      code: status.code,
      signal: status.signal,
    })),
  };
};

const staticFailureCodes: readonly CredentialLauncherFailureCode[] = [
  'arguments_invalid',
  'credential_metadata_invalid',
  'credential_metadata_changed',
  'credential_open_failed',
  'credential_read_failed',
  'credential_oversize',
  'credential_invalid',
  'child_spawn_failed',
  'child_wait_failed',
  'child_status_invalid',
];

const isFailureCode = (value: string): value is CredentialLauncherFailureCode =>
  staticFailureCodes.includes(value as CredentialLauncherFailureCode);

const fail = (code: CredentialLauncherFailureCode): never => {
  throw new CredentialLauncherError(code);
};

const validateMetadata = (
  metadata: CredentialFileMetadata,
  effectiveUid: number | undefined,
): void => {
  if (
    metadata.isFile !== true || metadata.isSymlink !== false || metadata.mode === null ||
    !Number.isSafeInteger(metadata.mode) || (metadata.mode & 0o7777) !== 0o600 ||
    effectiveUid === undefined || metadata.uid === null || metadata.uid !== effectiveUid ||
    !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
    metadata.size > MAX_CREDENTIAL_BYTES
  ) {
    fail('credential_metadata_invalid');
  }
};

const compareStableIdentity = (
  before: CredentialFileMetadata,
  after: CredentialFileMetadata,
): void => {
  for (const key of ['dev', 'ino'] as const) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (beforeValue !== undefined || afterValue !== undefined) {
      if (
        beforeValue === undefined || afterValue === undefined ||
        !Number.isSafeInteger(beforeValue) || !Number.isSafeInteger(afterValue) ||
        beforeValue !== afterValue
      ) {
        fail('credential_metadata_changed');
      }
    }
  }
};

/** Decode and validate the single-token credential without exposing its value. */
export const parseCredentialBytes = (bytes: Uint8Array): string => {
  try {
    return parseSharedCredentialBytes(bytes);
  } catch (error) {
    if (error instanceof CredentialFileError) return fail(error.code);
    return fail('credential_invalid');
  }
};

/** Read, validate, close, and only then decode the fixed credential file. */
export const readCredential = async (
  filesystem: CredentialFileSystem = defaultFileSystem,
): Promise<string> => {
  let effectiveUid: number | undefined;
  try {
    effectiveUid = filesystem.effectiveUid();
  } catch {
    fail('credential_metadata_invalid');
  }
  let metadata!: CredentialFileMetadata;
  try {
    metadata = await filesystem.lstat(CREDENTIAL_PATH);
  } catch {
    fail('credential_metadata_invalid');
  }
  validateMetadata(metadata, effectiveUid);

  let file!: CredentialFileHandle;
  try {
    file = await filesystem.open(CREDENTIAL_PATH);
  } catch {
    fail('credential_open_failed');
  }

  let bytes: Uint8Array | undefined;
  let failure: CredentialLauncherError | undefined;
  try {
    let openedMetadata!: CredentialFileMetadata;
    try {
      openedMetadata = await file.stat();
    } catch {
      fail('credential_read_failed');
    }
    validateMetadata(openedMetadata, effectiveUid);
    if (openedMetadata.size !== metadata.size) fail('credential_metadata_changed');
    compareStableIdentity(metadata, openedMetadata);

    const buffer = new Uint8Array(MAX_CREDENTIAL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      let count: number | null = null;
      try {
        count = await file.read(buffer.subarray(offset));
      } catch {
        fail('credential_read_failed');
      }
      if (count === null) break;
      if (
        !Number.isSafeInteger(count) || count <= 0 || count > buffer.byteLength - offset
      ) {
        fail('credential_read_failed');
      }
      offset += count;
    }
    if (offset > MAX_CREDENTIAL_BYTES) fail('credential_oversize');
    if (offset !== metadata.size) fail('credential_metadata_changed');
    bytes = buffer.slice(0, offset);
  } catch (error) {
    if (error instanceof CredentialLauncherError) failure = error;
    else failure = new CredentialLauncherError('credential_read_failed');
  }

  try {
    file.close();
  } catch {
    if (failure === undefined) failure = new CredentialLauncherError('credential_read_failed');
  }
  if (failure !== undefined) throw failure;
  return parseCredentialBytes(bytes!);
};

const commandOptions = (credential: string): CredentialLauncherCommandOptions => ({
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
  env: { [SECRET_ENV]: credential },
  stdin: 'null',
  stdout: 'inherit',
  stderr: 'inherit',
});

const signalExitCodes: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGILL: 132,
  SIGTRAP: 133,
  SIGABRT: 134,
  SIGBUS: 135,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGSEGV: 139,
  SIGUSR2: 140,
  SIGPIPE: 141,
  SIGALRM: 142,
  SIGTERM: 143,
  SIGUSR1: 138,
  SIGSTKFLT: 144,
  SIGCHLD: 145,
  SIGCONT: 146,
  SIGSTOP: 147,
  SIGTSTP: 148,
  SIGTTIN: 149,
  SIGTTOU: 150,
  SIGURG: 151,
  SIGXCPU: 152,
  SIGXFSZ: 153,
  SIGVTALRM: 154,
  SIGPROF: 155,
  SIGWINCH: 156,
  SIGIO: 157,
  SIGPWR: 158,
  SIGSYS: 159,
};

const childExitCode = (status: CredentialLauncherChildStatus): number => {
  if (status.success && status.code === 0 && status.signal === null) return 0;
  if (status.success) {
    fail('child_status_invalid');
  }
  if (status.signal !== null) return signalExitCodes[status.signal] ?? 1;
  if (status.code !== null && Number.isSafeInteger(status.code) && status.code >= 0) {
    return status.code;
  }
  fail('child_status_invalid');
  return 1;
};

const writeStaticFailure = async (
  code: CredentialLauncherFailureCode,
  writer: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  try {
    await writer(`${code}\n`);
  } catch {
    // Do not replace a sanitized failure with a raw stream error.
  }
};

const defaultWriteStderr = async (text: string): Promise<void> => {
  const bytes = encoder.encode(text);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = await Deno.stderr.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - offset) return;
    offset += count;
  }
};

/** Run the fixed sentinel child, returning its sanitized process status. */
export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: CredentialLauncherDependencies = {},
): Promise<number> => {
  try {
    if (args.length !== 0) fail('arguments_invalid');
    const credential = await readCredential(dependencies.filesystem ?? defaultFileSystem);
    const spawn = dependencies.spawn ?? defaultSpawn;
    let child!: CredentialLauncherChild;
    try {
      child = spawn(DENO_COMMAND, commandOptions(credential));
    } catch {
      fail('child_spawn_failed');
    }
    let status!: CredentialLauncherChildStatus;
    try {
      status = await child.status;
    } catch {
      fail('child_wait_failed');
    }
    return childExitCode(status);
  } catch (error) {
    const code = error instanceof CredentialLauncherError && isFailureCode(error.code)
      ? error.code
      : 'child_status_invalid';
    await writeStaticFailure(code, dependencies.writeStderr ?? defaultWriteStderr);
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
