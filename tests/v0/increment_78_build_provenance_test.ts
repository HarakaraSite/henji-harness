import { buildInputFiles, hasDirtyBuildInputs } from '../../scripts/build_henji.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const git = async (root: string, ...args: string[]): Promise<void> => {
  const output = await new Deno.Command('git', {
    cwd: root,
    args,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
};

Deno.test('Increment 78 dirty provenance includes the builder but excludes unrelated files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-78-dirty-' });
  try {
    await Deno.writeTextFile(`${root}/runtime.ts`, 'export const runtime = 1;\n');
    await Deno.writeTextFile(`${root}/builder.ts`, 'export const builder = 1;\n');
    await Deno.writeTextFile(`${root}/notes.md`, 'baseline\n');
    await git(root, 'init', '-q');
    await git(root, 'add', '.');
    await git(
      root,
      '-c',
      'user.name=Henji Test',
      '-c',
      'user.email=henji-test@example.invalid',
      'commit',
      '-qm',
      'baseline',
    );

    const inputs = ['runtime.ts', 'builder.ts'];
    assert(!(await hasDirtyBuildInputs(root, inputs)));
    await Deno.writeTextFile(`${root}/notes.md`, 'unrelated change\n');
    assert(!(await hasDirtyBuildInputs(root, inputs)));
    await Deno.writeTextFile(`${root}/builder.ts`, 'export const builder = 2;\n');
    assert(await hasDirtyBuildInputs(root, inputs));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 78 current build input graph includes its generator', async () => {
  const inputs = await buildInputFiles(Deno.cwd());
  assert(inputs.includes('scripts/build_henji.ts'));
  assert(inputs.includes('v0/agent/cli/henji_cli.ts'));
  assert(inputs.includes('v0/agent/hook_api.ts'));
  assert(inputs.includes('deno.v0.json'));
  for (
    const entry of [
      'v0/agent/cli/tui_cli.ts',
      'v0/agent/cli/run_worker_client.ts',
      'v0/agent/cli/serve_cli.ts',
      'v0/agent/cli/core_cli.ts',
      'v0/agent/cli/session_cli.ts',
      'v0/agent/cli/history_cli.ts',
      'v0/agent/cli/configuration_cli.ts',
      'v0/agent/cli/failure_diagnostic_cli.ts',
      'v0/agent/runtime/process_runner.ts',
      'v0/agent/tools/run_typescript_process_entry.ts',
    ]
  ) assert(inputs.includes(entry), `CLI command entry missing from build inputs: ${entry}`);
  for (
    const path of [
      'v0/agent/provider/openrouter_model.ts',
      'v0/agent/provider/openrouter_transport.ts',
      'v0/agent/provider/openai_responses_model.ts',
      'v0/agent/provider/openai_responses_request.ts',
    ]
  ) assert(inputs.includes(path), `Deferred provider source missing from build inputs: ${path}`);
});
