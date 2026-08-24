import { canonicalize, contentHash } from '../src/canonical_content.ts';
import { normalizeDefinitionContent } from '../src/definition_content.ts';
import { projectRevisionView, resolveRevisionView } from '../src/revision_view.ts';
import { assertEquals, assertNotEquals, assertRejects } from './assert.ts';

const baseInput = () => ({
  schemaVersion: 'definition-content/v1',
  identity: { pluginId: 'hidden-id', namespace: 'hidden-ns', kind: 'text-transform' },
  source: { mediaType: 'application/typescript', text: 'source\r\n' },
  manifest: { displayName: 'Name', description: '' },
  publicContract: { input: 'text', output: 'text' },
  pluginOwnedTests: [{ name: 'case', input: 'in', expectedOutput: 'out' }],
  config: { mode: 'strict' },
  requestedCapabilities: [],
});

Deno.test('Revision View excludes hidden fields and no-op preserves exact content', async () => {
  const base = normalizeDefinitionContent(baseInput());
  const baseHash = await contentHash(base);
  const view = projectRevisionView(base);
  assertEquals(Object.keys(view).sort(), ['config', 'manifest', 'pluginOwnedTests', 'source']);
  const serialized = canonicalize(view);
  for (const hidden of ['schemaVersion', 'identity', 'publicContract', 'requestedCapabilities']) {
    assertEquals(serialized.includes(hidden), false);
  }
  const resolved = await resolveRevisionView(base, baseHash, view);
  assertEquals(canonicalize(resolved), canonicalize(base));
  assertEquals(await contentHash(resolved), baseHash);
  assertEquals(resolved.identity, base.identity);
});

Deno.test('Revision View full replacement changes only visible content', async () => {
  const base = normalizeDefinitionContent(baseInput());
  const baseHash = await contentHash(base);
  const view = projectRevisionView(base);
  const changed = { ...view, manifest: { ...view.manifest, displayName: 'Changed' } };
  const resolved = await resolveRevisionView(base, baseHash, changed);
  assertNotEquals(await contentHash(resolved), baseHash);
  assertEquals(resolved.identity, base.identity);
  assertEquals(resolved.publicContract, base.publicContract);
});

Deno.test('Revision View rejects stale base, missing, null, hidden, and nested unknown fields', async () => {
  const base = normalizeDefinitionContent(baseInput());
  const baseHash = await contentHash(base);
  const view = projectRevisionView(base);
  await assertRejects(() => resolveRevisionView(base, 'sha256:stale', view), 'exact base');
  const { config: _config, ...missing } = view;
  await assertRejects(() => resolveRevisionView(base, baseHash, missing), 'requires exactly');
  await assertRejects(
    () => resolveRevisionView(base, baseHash, { ...view, config: null }),
    'config',
  );
  await assertRejects(
    () => resolveRevisionView(base, baseHash, { ...view, identity: base.identity }),
    'requires exactly',
  );
  await assertRejects(
    () => resolveRevisionView(base, baseHash, { ...view, source: { ...view.source, extra: true } }),
    'requires exactly',
  );
});

Deno.test('Revision projection and resolution do not mutate their inputs', async () => {
  const rawBase = baseInput();
  const baseBefore = structuredClone(rawBase);
  const base = normalizeDefinitionContent(rawBase);
  const view = projectRevisionView(base);
  const viewBefore = structuredClone(view);
  await resolveRevisionView(base, await contentHash(base), view);
  assertEquals(rawBase, baseBefore);
  assertEquals(view, viewBefore);
});
