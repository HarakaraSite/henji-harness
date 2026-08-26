import { assert, assertEquals } from './test_helpers.ts';
import {
  CHILD_ENTRYPOINT,
  DENO_COMMAND,
  main,
  SECRET_ENV,
  type SentinelChild,
  type SentinelCommandOptions,
} from '../../v0/agent/work_tools_sentinel_launcher.ts';
import {
  CREDENTIAL_PATH,
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
} from '../../v0/eval/live_corpus_credential_launcher.ts';

const ROOT = Deno.cwd();
const FIXTURE = `${ROOT}/tests/v0/fixtures/work_tools_sentinel_process_fixture.ts`;
const DUMMY_CREDENTIAL = 'dummy-work-tools-sentinel-secret';
const decoder = new TextDecoder();

const credentialFilesystem = (): CredentialFileSystem => {
  const bytes = new TextEncoder().encode(`${DUMMY_CREDENTIAL}\n`);
  const metadata: CredentialFileMetadata = {
    isFile: true,
    isSymlink: false,
    mode: 0o600,
    size: bytes.byteLength,
    uid: 1000,
    dev: 1,
    ino: 2,
  };
  return {
    effectiveUid: () => 1000,
    lstat: (path) => {
      assertEquals(path, CREDENTIAL_PATH);
      return Promise.resolve(metadata);
    },
    open: (path) => {
      assertEquals(path, CREDENTIAL_PATH);
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
        close: () => {},
      };
      return Promise.resolve(file);
    },
  };
};

const spawnFixture = (options: SentinelCommandOptions, mode?: string): SentinelChild => {
  const child = new Deno.Command(DENO_COMMAND, {
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      `--allow-env=${SECRET_ENV}`,
      `--allow-read=${options.cwd}`,
      `--allow-write=${options.cwd}`,
      '--allow-run=/bin/bash',
      FIXTURE,
      options.cwd,
      ...(mode === undefined ? [] : [mode]),
    ],
    cwd: '/tmp',
    clearEnv: true,
    env: { [SECRET_ENV]: DUMMY_CREDENTIAL },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    status: child.status.then((status) => ({
      success: status.success,
      code: status.code,
      signal: status.signal,
    })),
    kill: (signal = 'SIGTERM') => child.kill(signal),
  };
};

Deno.test('real embedded Deno child loads absolute fixture from unrelated cwd and is cleaned up', async () => {
  let workspacePath: string | undefined;
  let invocation: { command: string; options: SentinelCommandOptions } | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await main([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: async () => {
      const path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-work-tools-process-' });
      workspacePath = path;
      await Deno.chmod(path, 0o700);
      return path;
    },
    spawn: (command, options) => {
      invocation = { command, options };
      return spawnFixture(options);
    },
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 0);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  const report = JSON.parse(stdout[0]) as Record<string, unknown>;
  assertEquals(report.ok, true);
  assertEquals(report.externalRequests, 5);
  assert(invocation !== undefined);
  assertEquals(invocation.command, DENO_COMMAND);
  assertEquals(invocation.options.cwd, workspacePath);
  assertEquals(invocation.options.clearEnv, true);
  assertEquals(invocation.options.env, { [SECRET_ENV]: DUMMY_CREDENTIAL });
  assertEquals(invocation.options.stdin, 'null');
  assertEquals(invocation.options.stdout, 'piped');
  assertEquals(invocation.options.stderr, 'piped');
  assertEquals(invocation.options.args, [
    'run',
    '--no-prompt',
    '--no-remote',
    `--allow-env=${SECRET_ENV}`,
    '--allow-net=openrouter.ai',
    `--allow-read=${workspacePath}`,
    `--allow-write=${workspacePath}`,
    '--allow-run=/bin/bash',
    CHILD_ENTRYPOINT,
  ]);
  assert(!invocation.options.args.some((item) => item.includes(DUMMY_CREDENTIAL)));
  assert(!invocation.options.args.some((item) => item.includes('fixed local-work sentinel')));
  assert(workspacePath !== undefined);
  try {
    await Deno.stat(workspacePath);
    throw new Error('workspace was not removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
  assert(decoder.decode(new TextEncoder().encode(stdout[0])).endsWith('\n'));
});

Deno.test('real embedded Deno child preserves a provider failure report on nonzero exit', async () => {
  let workspacePath: string | undefined;
  const stderr: string[] = [];
  const exit = await main([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: async () => {
      const path = await Deno.makeTempDir({
        dir: '/tmp',
        prefix: 'henji-work-tools-process-failure-',
      });
      workspacePath = path;
      await Deno.chmod(path, 0o700);
      return path;
    },
    spawn: (_command, options) => spawnFixture(options, 'provider-failure'),
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(stderr.length, 1);
  const report = JSON.parse(stderr[0]) as Record<string, unknown>;
  assertEquals(report.stage, 'execution');
  assertEquals(report.code, 'provider_failure');
  assertEquals(report.externalRequests, 1);
  assertEquals(report.childCount, 1);
  assert(workspacePath !== undefined);
  try {
    await Deno.stat(workspacePath);
    throw new Error('provider-failure workspace was not removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});
