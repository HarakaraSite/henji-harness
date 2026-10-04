import { ok, strictEqual } from 'node:assert';
import { configurationMain } from '../../v0/agent/cli/configuration_cli.ts';

const entry = new URL('../../v0/agent/cli/henji_cli.ts', import.meta.url).pathname;
const config = new URL('../../deno.v0.json', import.meta.url).pathname;
const decoder = new TextDecoder();

const isolatedCli = async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-183-cli-' });
  return {
    root,
    invoke: async (args: readonly string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--no-prompt',
          '--cached-only',
          '--unstable-worker-options',
          '--allow-all',
          '--config',
          config,
          entry,
          ...args,
        ],
        cwd: root,
        clearEnv: true,
        env: {
          HOME: `${root}/home`,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_DATA_HOME: `${root}/data`,
          XDG_STATE_HOME: `${root}/state`,
          DENO_DIR: Deno.env.get('DENO_DIR') ?? `${Deno.env.get('HOME')}/.cache/deno`,
        },
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      return {
        code: result.code,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
  };
};

Deno.test('183 public CLI errors explain unknown commands and options on stderr', async () => {
  const cli = await isolatedCli();
  try {
    const root = await cli.invoke(['list']);
    strictEqual(root.code, 1);
    strictEqual(root.stdout, '');
    ok(root.stderr.includes("Unknown command 'list'"));
    ok(root.stderr.includes('henji core list'));
    for (
      const args of [
        ['--unknown'],
        ['tui', '--unknown'],
        ['run', '--unknown'],
        ['run', '--stream', '--unknown'],
        ['sessions', '--unknown'],
        ['history', '--unknown'],
        ['agent', '--unknown'],
        ['tool', '--unknown'],
        ['diagnostics', '--unknown'],
        ['diagnostics', 'runtime', '--unknown'],
        ['core', 'list', '--unknown'],
        ['serve', '--unknown'],
      ]
    ) {
      const result = await cli.invoke(args);
      strictEqual(result.code, 1, result.stderr);
      strictEqual(result.stdout, '', args.join(' '));
      ok(result.stderr.startsWith('henji'), result.stderr);
      ok(result.stderr.includes('--unknown'), result.stderr);
      ok(result.stderr.includes('--help'), result.stderr);
    }
  } finally {
    await Deno.remove(cli.root, { recursive: true });
  }
});

Deno.test('183 CLI reports missing values and invalid values with the relevant usage', async () => {
  const cli = await isolatedCli();
  try {
    for (
      const [args, reason] of [
        [['agent', 'activate', '--file'], 'Missing value for --file'],
        [['tool', 'activate', '--name', 'read'], 'Missing required --folder'],
        [['tui', '--max-steps', 'zero'], '--max-steps must be a positive integer'],
        [['run', '--max-steps', 'zero'], '--max-steps must be a positive integer'],
        [['history', '--view', 'wrong'], '--view must be session, canonical or detail'],
        [
          ['sessions', 'delete', '--session', '18300000-0000-4000-8000-000000000001'],
          'requires --yes',
        ],
        [[
          'diagnostics',
          'executions',
          'request',
          '--id',
          '18300000-0000-4000-8000-000000000001',
          '--ordinal',
          '0',
        ], '--ordinal must be a positive integer'],
        [['serve', '--port', 'bad'], '--port must be an integer from 0 to 65535'],
      ] as const
    ) {
      const result = await cli.invoke(args);
      strictEqual(result.code, 1, result.stderr);
      strictEqual(result.stdout, '');
      ok(result.stderr.includes(reason), result.stderr);
      ok(result.stderr.includes('--help'), result.stderr);
    }
  } finally {
    await Deno.remove(cli.root, { recursive: true });
  }
});

Deno.test('183 subcommand help succeeds and run JSON errors retain the machine contract', async () => {
  const cli = await isolatedCli();
  try {
    for (
      const args of [
        ['core', 'list', '--help'],
        ['agent', 'activate', '--help'],
        ['tool', 'inspect', '--help'],
        ['sessions', 'delete', '--help'],
        ['diagnostics', 'executions', 'request', '--help'],
      ]
    ) {
      const result = await cli.invoke(args);
      strictEqual(result.code, 0, result.stderr);
      ok(result.stdout.startsWith('Usage: henji'));
      strictEqual(result.stderr, '');
    }
    const result = await cli.invoke(['run', '--json', '--unknown']);
    strictEqual(result.code, 1);
    strictEqual(result.stderr, '');
    const record = JSON.parse(result.stdout);
    strictEqual(record.kind, 'error');
    strictEqual(record.error.error.code, 'invalid_input');
    strictEqual(record.error.error.message, 'invalid agent invocation');
  } finally {
    await Deno.remove(cli.root, { recursive: true });
  }
});

Deno.test('183 inspect failures explain configuration rejection without writing failure JSON to stdout', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-183-inspect-' });
  try {
    const file = `${root}/invalid-agent.json`;
    await Deno.writeTextFile(file, '{}');
    await Deno.writeTextFile(
      `${root}/tools.json`,
      JSON.stringify({ schemaVersion: 1, tools: { read: `${root}/absent-tool` } }),
    );
    for (
      const [kind, args, reason] of [
        ['agent', ['inspect', '--file', file], 'name'],
        ['tool', ['inspect', '--name', 'read'], 'tool.json'],
      ] as const
    ) {
      let stdout = '';
      let stderr = '';
      strictEqual(
        await configurationMain(kind, args, {
          configRoot: root,
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: (text) => {
            stderr += text;
          },
        }),
        1,
      );
      strictEqual(stdout, '');
      ok(stderr.includes(reason), stderr);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
