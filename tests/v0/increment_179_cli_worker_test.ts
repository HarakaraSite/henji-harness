import { main as runtimeCliMain } from '../../v0/agent/cli/runtime_cli.ts';
import { RunWorkerPortError } from '../../v0/agent/cli/run_worker_protocol.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const runCli = async (
  root: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--unstable-worker-options',
      '--allow-read=.,/tmp',
      '--allow-write=/tmp',
      '--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME',
      '--config',
      'deno.v0.json',
      'v0/agent/cli/henji_cli.ts',
      'run',
      ...args,
    ],
    cwd: Deno.cwd(),
    clearEnv: true,
    env: {
      HOME: Deno.env.get('HOME') ?? '/tmp',
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
    },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode('hello'));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
};

Deno.test('Increment 179 CLI Worker returns typed configuration error data and drains before exit', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-179-cli-worker-' });
  try {
    const result = await runCli(root, [
      '--agent-file',
      `${root}/missing.json`,
      '--json',
    ]);
    assertEquals(result.code, 1);
    assertEquals(result.stderr, '');
    const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assertEquals(records.length, 1);
    assertEquals(records[0].v, 1);
    assertEquals(records[0].kind, 'error');
    assertEquals(records[0].error.error.code, 'configuration_rejected');
    assertEquals(records[0].error.error.stage, 'worker_start');
    assertEquals(records[0].error.error.rejections[0].file, `${root}/missing.json`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 179 CLI Worker maps runner startup errors from port data', async () => {
  for (
    const error of [
      {
        kind: 'configuration' as const,
        value: {
          code: 'configuration_rejected',
          message: 'configuration startup failed',
          stage: 'worker_start',
          reason: 'configuration load failed',
          rejections: [],
        },
      },
      {
        kind: 'instruction' as const,
        value: { code: 'instruction_io_failure', message: 'base instruction read failed' },
      },
    ]
  ) {
    let stdout = '';
    const exitCode = await runtimeCliMain(['--task', 'hello', '--json'], {
      stdinIsTerminal: () => true,
      resolveAgent: () => Promise.resolve({ choice: {} }),
      run: () => Promise.reject(new RunWorkerPortError(error)),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
    });
    assertEquals(exitCode, 1);
    const record = JSON.parse(stdout.trim());
    assertEquals(record.kind, 'error');
    assertEquals(record.error.error, error.value);
  }
});
