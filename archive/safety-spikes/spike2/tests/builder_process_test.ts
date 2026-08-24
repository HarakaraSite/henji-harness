import { rawDigest } from '../../spike1/src/digests.ts';
import { buildAdmissionProfile } from '../src/admission_profile.ts';
import { artifactBytesFromResponse, runBuilder } from '../src/builder_process.ts';
import type { BuilderRequestV1 } from '../src/builder_protocol.ts';
import { assert, assertEquals } from './test_helpers.ts';

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

const fixtureRequest = (): BuilderRequestV1 => ({
  schemaVersion: 'builder-request/v1',
  requestId: `sha256:${'1'.repeat(64)}`,
  sourceHash: `sha256:${'2'.repeat(64)}`,
  sourceText: 'x'.repeat(65_536),
  compilerOptionsDigest: `sha256:${'3'.repeat(64)}`,
  admissionProfileDigest: `sha256:${'4'.repeat(64)}`,
});

const runFixture = async (source: string) => {
  const testRoot = `${repositoryRoot}/.tools/spike2-test-tmp`;
  const root = await Deno.makeTempDir({ dir: testRoot, prefix: 'builder-hostile-' });
  const work = `${root}/work`;
  await Deno.mkdir(`${root}/spike2/builder`, { recursive: true });
  await Deno.mkdir(`${root}/spike2/src`, { recursive: true });
  await Deno.mkdir(work);
  await Deno.writeTextFile(`${root}/deno.spike2.json`, '{}');
  await Deno.writeTextFile(`${root}/deno.spike2.lock`, '{"version":"5"}');
  await Deno.writeTextFile(`${root}/spike2/builder/main.ts`, source);
  try {
    return await runBuilder({
      denoExecutable: `${repositoryRoot}/.tools/deno/2.9.4/deno`,
      repositoryRoot: root,
      cacheDirectory: `${repositoryRoot}/.tools/deno-cache/spike2`,
      emptyWorkingDirectory: work,
    }, fixtureRequest());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

Deno.test('fixed Builder compiles in memory without candidate execution', async () => {
  const testRoot = `${repositoryRoot}/.tools/spike2-test-tmp`;
  await Deno.mkdir(testRoot, { recursive: true, mode: 0o700 });
  const emptyWorkingDirectory = await Deno.makeTempDir({ dir: testRoot, prefix: 'builder-' });
  try {
    const sourceText = 'export default function(input: string): string { return input.trim(); }';
    const profile = await buildAdmissionProfile();
    const request: BuilderRequestV1 = {
      schemaVersion: 'builder-request/v1',
      requestId: `sha256:${'1'.repeat(64)}`,
      sourceHash: await rawDigest(
        'henji/spike2/candidate-source/v1',
        new TextEncoder().encode(sourceText),
      ),
      sourceText,
      compilerOptionsDigest: profile.compilerOptionsDigest,
      admissionProfileDigest: profile.digest,
    };
    const result = await runBuilder({
      denoExecutable: `${repositoryRoot}/.tools/deno/2.9.4/deno`,
      repositoryRoot,
      cacheDirectory: `${repositoryRoot}/.tools/deno-cache/spike2`,
      emptyWorkingDirectory,
    }, request);
    assertEquals(result.status, 'completed');
    if (result.status !== 'completed') return;
    assertEquals(result.response.status, 'compiled');
    if (result.response.status !== 'compiled') return;
    const artifact = new TextDecoder().decode(artifactBytesFromResponse(result.response));
    assert(artifact.includes('input.trim()'));
    assertEquals((await Array.fromAsync(Deno.readDir(emptyWorkingDirectory))).length, 0);
  } finally {
    await Deno.remove(emptyWorkingDirectory);
  }
});

Deno.test('Builder absolute deadline covers a child that never reads stdin and reaps it', async () => {
  const testRoot = `${repositoryRoot}/.tools/spike2-test-tmp`;
  const fixtureRoot = await Deno.makeTempDir({ dir: testRoot, prefix: 'builder-timeout-' });
  const workingDirectory = `${fixtureRoot}/work`;
  await Deno.mkdir(`${fixtureRoot}/spike2/builder`, { recursive: true });
  await Deno.mkdir(`${fixtureRoot}/spike2/src`, { recursive: true });
  await Deno.mkdir(workingDirectory);
  await Deno.writeTextFile(`${fixtureRoot}/deno.spike2.json`, '{}');
  await Deno.writeTextFile(`${fixtureRoot}/deno.spike2.lock`, '{"version":"5"}');
  await Deno.writeTextFile(
    `${fixtureRoot}/spike2/builder/main.ts`,
    'setInterval(() => {}, 1_000);\n',
  );
  try {
    const request = fixtureRequest();
    const started = performance.now();
    const result = await runBuilder({
      denoExecutable: `${repositoryRoot}/.tools/deno/2.9.4/deno`,
      repositoryRoot: fixtureRoot,
      cacheDirectory: `${repositoryRoot}/.tools/deno-cache/spike2`,
      emptyWorkingDirectory: workingDirectory,
    }, request);
    assertEquals(result.status, 'failed');
    if (result.status === 'failed') assertEquals(result.code, 'builder_timeout');
    assert(performance.now() - started < 3_500, 'deadline was not bounded');
  } finally {
    await Deno.remove(fixtureRoot, { recursive: true });
  }
});

for (
  const [name, source] of [
    ['closed stdin', 'Deno.stdin.close(); Deno.exit(0);'],
    [
      'partial stdout frame',
      'await Deno.stdin.readable.cancel(); await Deno.stdout.write(new Uint8Array([0,0,0,10,123]));',
    ],
    [
      'oversize stdout',
      'await Deno.stdin.readable.cancel(); await Deno.stdout.write(new Uint8Array(262_149));',
    ],
    [
      'stdout at response limit',
      'await Deno.stdin.readable.cancel(); await Deno.stdout.write(new Uint8Array(262_148));',
    ],
    [
      'nonzero exit with oversize stderr',
      'await Deno.stdin.readable.cancel(); await Deno.stderr.write(new Uint8Array(20_000)); Deno.exit(7);',
    ],
    [
      'stderr at limit',
      'await Deno.stdin.readable.cancel(); await Deno.stderr.write(new Uint8Array(16_384)); Deno.exit(0);',
    ],
    [
      'response then nonzero exit',
      `
        const reader = Deno.stdin.readable.getReader();
        await reader.read();
        await reader.cancel();
        const payload = new TextEncoder().encode(JSON.stringify({
          schemaVersion: 'builder-response/v1',
          requestId: 'sha256:${'1'.repeat(64)}',
          status: 'compiled',
          sourceHash: 'sha256:${'2'.repeat(64)}',
          compilerOptionsDigest: 'sha256:${'3'.repeat(64)}',
          emittedMediaType: 'application/javascript+module',
          artifactBytesBase64: 'YQ==',
          artifactByteCount: 1,
          diagnostics: [],
          closure: { schemaVersion: 'module-closure/v1', modules: [] },
        }));
        const frame = new Uint8Array(4 + payload.byteLength);
        new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
        frame.set(payload, 4);
        await Deno.stdout.write(frame);
        Deno.exit(7);
      `,
    ],
  ] as const
) {
  Deno.test(`Builder rejects hostile child: ${name}`, async () => {
    const result = await runFixture(source);
    assertEquals(result.status, 'failed');
    if (result.status === 'failed') assertEquals(result.code, 'builder_protocol');
    if (name === 'nonzero exit with oversize stderr') {
      assert(result.stderr.endsWith('[truncated]'));
    }
    if (name === 'stderr at limit') assert(!result.stderr.endsWith('[truncated]'));
  });
}

Deno.test('Builder concurrency capacity rejects the second process and releases after timeout', async () => {
  const first = runFixture('setInterval(() => {}, 1_000);');
  const second = runFixture('setInterval(() => {}, 1_000);');
  const [left, right] = await Promise.all([first, second]);
  const results = [left, right];
  assertEquals(
    results.filter((result) => result.status === 'failed' && result.code === 'builder_busy').length,
    1,
  );
  assertEquals(
    results.filter((result) => result.status === 'failed' && result.code === 'builder_timeout')
      .length,
    1,
  );
});
