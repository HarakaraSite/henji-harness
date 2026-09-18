import {
  AGENT_DEFINITION_API_CONTRACT,
  type BuildManifestV1,
  HENJI_TOOL_DEFINITION_API_CONTRACT,
  isBuildManifest,
} from '../../v0/agent/runtime/build_manifest.ts';
import {
  builtinDefinitionRef,
  builtinToolDefinitionRef,
} from '../../v0/agent/definitions/managed_resource_ref.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const manifest = (overrides: Partial<BuildManifestV1> = {}): BuildManifestV1 => ({
  schemaVersion: 1,
  productVersion: '0.2.1',
  buildId: 'a'.repeat(64),
  sourceRevision: 'abc123',
  sourceDirty: false,
  denoVersion: '2.9.6',
  target: 'aarch64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  supportedAgentDefinitionApiContracts: [AGENT_DEFINITION_API_CONTRACT],
  supportedToolDefinitionApiContracts: [HENJI_TOOL_DEFINITION_API_CONTRACT],
  ...overrides,
});

Deno.test('Increment 77 builtin Definition revision uses the embedded closure digest', async () => {
  const digest = 'c'.repeat(64);
  const compiled = manifest({
    builtinResources: [{ kind: 'agent-definition', resourceId: 'builtin/default', digest }],
  });
  const ref = await builtinDefinitionRef('default', compiled);
  assertEquals(ref.revision.digest, digest);

  // The revision no longer depends on the whole-runtime hash.
  const rebuilt = manifest({
    embeddedRuntimeSha256: 'd'.repeat(64),
    builtinResources: [{ kind: 'agent-definition', resourceId: 'builtin/default', digest }],
  });
  assertEquals((await builtinDefinitionRef('default', rebuilt)).revision.digest, digest);
});

Deno.test('Increment 77 builtin tool revision uses the embedded closure digest', async () => {
  const digest = 'e'.repeat(64);
  const compiled = manifest({
    builtinResources: [{
      kind: 'tool-definition',
      resourceId: 'builtin/web-search',
      identity: 'tool:web_search',
      digest,
    }],
  });
  const ref = await builtinToolDefinitionRef(
    'builtin/web-search',
    'tool:web_search',
    HENJI_TOOL_DEFINITION_API_CONTRACT,
    compiled,
  );
  assertEquals(ref.revision.digest, digest);
});

Deno.test('Increment 77 compiled manifest without a builtin entry fails instead of falling back', async () => {
  let definitionThrew = false;
  try {
    await builtinDefinitionRef('default', manifest());
  } catch {
    definitionThrew = true;
  }
  assert(definitionThrew, 'a compiled manifest must carry the builtin Definition revision');

  let toolThrew = false;
  try {
    await builtinToolDefinitionRef(
      'builtin/web-search',
      'tool:web_search',
      HENJI_TOOL_DEFINITION_API_CONTRACT,
      manifest(),
    );
  } catch {
    toolThrew = true;
  }
  assert(toolThrew, 'a compiled manifest must carry the builtin tool revision');
});

Deno.test('Increment 77 development manifest keeps a deterministic builtin revision', async () => {
  const development = manifest({ sourceRevision: 'development', sourceDirty: true });
  const first = await builtinDefinitionRef('default', development);
  const second = await builtinDefinitionRef('default', development);
  assertEquals(first, second);
  assert(first.revision.digest.length === 64);
});

Deno.test('Increment 77 build manifest accepts only well-formed builtin resource entries', () => {
  assert(isBuildManifest(manifest()));
  assert(
    isBuildManifest(manifest({
      builtinResources: [{
        kind: 'agent-definition',
        resourceId: 'builtin/default',
        digest: 'c'.repeat(64),
      }],
    })),
  );
  assert(
    !isBuildManifest({
      ...manifest(),
      builtinResources: [{ kind: 'other', resourceId: 'builtin/default', digest: 'c'.repeat(64) }],
    }),
  );
  assert(
    !isBuildManifest({
      ...manifest(),
      builtinResources: [{
        kind: 'agent-definition',
        resourceId: 'builtin/default',
        digest: 'short',
      }],
    }),
  );
});
