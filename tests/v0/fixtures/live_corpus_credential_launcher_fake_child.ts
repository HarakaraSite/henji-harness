const expectedSecret = 'dummy-process-launcher-secret';
const encoder = new TextEncoder();

const secret = Deno.env.get('HENJI_OPENROUTER_API_KEY');
let inheritedEnvironment = false;
for (const name of ['PATH', 'HOME']) {
  try {
    inheritedEnvironment ||= Deno.env.get(name) !== undefined;
  } catch {
    // The exact secret allowlist intentionally rejects unrelated variables.
  }
}
if (secret !== expectedSecret || inheritedEnvironment || Deno.args.length !== 0) {
  Deno.exit(17);
}

const stdinProbe = new Uint8Array(1);
const stdinResult = await Deno.stdin.read(stdinProbe);
if (stdinResult !== null) Deno.exit(18);

await Deno.stdout.write(encoder.encode('fake-child-ok\n'));
await Deno.stderr.write(encoder.encode('fake-child-stderr\n'));
