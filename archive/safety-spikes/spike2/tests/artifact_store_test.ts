import {
  artifactHash,
  type ArtifactMetadataV1,
  publishArtifact,
  publishArtifactAtAddressForTest,
} from '../src/artifact_store.ts';
import { assert, assertEquals } from './test_helpers.ts';

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const metadata: ArtifactMetadataV1 = {
  schemaVersion: 'artifact-preimage/v1',
  emittedMediaType: 'application/javascript+module',
  compilerOptionsDigest: `sha256:${'1'.repeat(64)}`,
  builderDependencyDigest: `sha256:${'2'.repeat(64)}`,
};

Deno.test('artifact publish is create-only and same bytes are idempotent', async () => {
  const root = await Deno.makeTempDir({
    dir: `${repositoryRoot}/.tools/spike2-test-tmp`,
    prefix: 'artifact-',
  });
  try {
    const bytes = new TextEncoder().encode('export default 1;\n');
    const [left, right] = await Promise.all([
      publishArtifact(root, bytes, metadata),
      publishArtifact(root, bytes, metadata),
    ]);
    assertEquals([left.status, right.status].sort(), ['existing', 'published']);
    assertEquals(left.artifactHash, await artifactHash(metadata, bytes));
    assertEquals(await Deno.readFile(left.path), bytes);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('different bytes at one injected address never overwrite the winner', async () => {
  const root = await Deno.makeTempDir({
    dir: `${repositoryRoot}/.tools/spike2-test-tmp`,
    prefix: 'collision-',
  });
  try {
    const address = `sha256:${'a'.repeat(64)}`;
    const left = new TextEncoder().encode('left');
    const right = new TextEncoder().encode('right');
    const results = await Promise.allSettled([
      publishArtifactAtAddressForTest(root, left, metadata, address),
      publishArtifactAtAddressForTest(root, right, metadata, address),
    ]);
    assertEquals(results.filter((result) => result.status === 'fulfilled').length, 1);
    assertEquals(results.filter((result) => result.status === 'rejected').length, 1);
    const destination = `${root}/${address.replace(':', '-')}`;
    const actual = await Deno.readFile(destination);
    assert(
      actual.every((byte, index) => byte === left[index]) ||
        actual.every((byte, index) => byte === right[index]),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
