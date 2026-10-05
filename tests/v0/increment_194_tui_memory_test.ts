import { ok, strictEqual } from 'node:assert';

Deno.test('Increment 194 remote TUI releases consumed stream frames while input and exit remain pending', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--no-prompt',
      '--cached-only',
      '--v8-flags=--expose-gc',
      '--allow-net=127.0.0.1',
      '--config',
      'deno.v0.json',
      'tests/v0/fixtures/increment_194_tui_memory.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
  const observation = JSON.parse(new TextDecoder().decode(result.stdout));
  strictEqual(observation.resynced, true);
  // The confirmed regression retains about 24 MiB for these additional 1,500 frames.
  // This tolerance detects that retention; it is not a product memory limit.
  ok(observation.growthMiB < 8, JSON.stringify(observation));
});
