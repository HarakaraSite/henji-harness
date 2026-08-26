import { assert, assertEquals } from './test_helpers.ts';
import { DENO_COMMAND } from '../../v0/eval/live_corpus_credential_launcher.ts';

const ROOT = Deno.cwd();
const FIXTURE = `${ROOT}/tests/v0/fixtures/live_corpus_credential_launcher_process_fixture.ts`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const runFixture = async (): Promise<Deno.CommandStatus & { stdout: string; stderr: string }> => {
  const child = new Deno.Command(DENO_COMMAND, {
    args: ['run', '--no-prompt', '--no-remote', `--allow-run=${DENO_COMMAND}`, FIXTURE],
    cwd: ROOT,
    clearEnv: true,
    env: {},
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const output = await child;
  return {
    ...output,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

Deno.test('real embedded Deno.Command boundary runs one fake child with isolated secret env', async () => {
  const result = await runFixture();
  assert(result.success);
  assertEquals(result.code, 0);
  assertEquals(result.signal, null);
  assertEquals(result.stdout, 'fake-child-ok\n');
  assertEquals(result.stderr, 'fake-child-stderr\n');
  assert(!result.stdout.includes('dummy-process-launcher-secret'));
  assert(!result.stderr.includes('dummy-process-launcher-secret'));
  assert(encoder.encode(result.stdout).byteLength > 0);
});
