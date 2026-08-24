import { assertEquals, assertStringIncludes } from '@std/assert';

Deno.test('CLI fails without a Runner-owned API key', async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['run', '--no-prompt', '--allow-env', 'src/cli/main.ts', '--task', 'plan'],
    cwd: Deno.cwd(),
    clearEnv: true,
    stdout: 'piped',
    stderr: 'piped',
  });
  const result = await command.output();
  assertEquals(result.success, false);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    'HENJI_OPENROUTER_API_KEY is required',
  );
});
