import { deepStrictEqual, strictEqual } from 'node:assert';

Deno.test('compiled process tools survive binary replacement in existing and new child Agents', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i203-update-' });
  const binary = `${root}/henji`;
  let child: Deno.ChildProcess | undefined;
  let finished = false;
  let output: Promise<Deno.CommandOutput> | undefined;
  try {
    const includes = [
      'v0/agent/worker/worker_bootstrap.ts',
      'v0/agent/data/data_bootstrap.ts',
      'v0/agent/worker/worker_configuration.ts',
      'v0/agent/tools/run_typescript_hooks.ts',
      'v0/agent/tools/run_typescript_fetch_worker.ts',
    ];
    const compiled = await new Deno.Command(Deno.execPath(), {
      args: [
        'compile',
        '--no-prompt',
        '--cached-only',
        '--unstable-worker-options',
        '--allow-read',
        '--allow-write',
        '--allow-run=/bin/bash',
        '--allow-net',
        '--allow-sys=uid',
        '--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME,OPENAI_LOG,OPENAI_CUSTOM_HEADERS,NODE_V8_COVERAGE',
        '--config=deno.v0.json',
        ...includes.map((path) => `--include=${path}`),
        `--output=${binary}`,
        'tests/v0/fixtures/increment_203_binary_update.ts',
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    strictEqual(compiled.code, 0, new TextDecoder().decode(compiled.stderr));
    child = new Deno.Command(binary, {
      args: [root],
      clearEnv: true,
      env: {
        HOME: `${root}/home`,
        XDG_CONFIG_HOME: `${root}/xdg-config`,
        XDG_DATA_HOME: `${root}/xdg-data`,
        XDG_STATE_HOME: `${root}/xdg-state`,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    output = child.output().then((value) => {
      finished = true;
      return value;
    });
    let ready = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await Deno.stat(`${root}/ready`).catch(() => null)) {
        ready = true;
        break;
      }
      if (finished) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!ready) {
      if (!finished) child.kill('SIGKILL');
      throw new Error(new TextDecoder().decode((await output).stderr) || 'probe did not start');
    }
    // A different executable makes accidental use of the new pathname observable.
    await Deno.writeTextFile(`${root}/replacement`, '#!/bin/bash\nexit 88\n');
    await Deno.chmod(`${root}/replacement`, 0o755);
    await Deno.rename(`${root}/replacement`, binary);
    await Deno.writeTextFile(`${root}/continue`, 'continue');
    const result = await output;
    strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
    const records = new TextDecoder().decode(result.stdout).trim().split('\n').map((line) =>
      JSON.parse(line)
    );
    deepStrictEqual(records, [
      { stage: 'before-update', parentBash: true, parentTypescript: true },
      {
        stage: 'after-update',
        deletedExecPath: true,
        parentBash: true,
        parentTypescript: true,
        newChildBash: true,
        newChildTypescript: true,
      },
    ]);
  } finally {
    if (child !== undefined && !finished) child.kill('SIGKILL');
    await output;
    await Deno.remove(root, { recursive: true });
  }
});
