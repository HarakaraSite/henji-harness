import { domainDigest, rawDigest } from '../src/digests.ts';
import { NORMALIZER_DIGEST } from '../src/normalizer_identity.ts';
import { INTAKE_LIMITS } from '../src/limits.ts';

const root = new URL('../../', import.meta.url);
const info = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
  modules?: Array<{ specifier?: string }>;
};
if (!Array.isArray(info.modules)) throw new Error('normalizer graph JSON required');
const paths = info.modules.flatMap((module) => {
  if (typeof module.specifier !== 'string' || !module.specifier.startsWith('file:')) return [];
  const path = decodeURIComponent(new URL(module.specifier).pathname);
  const rootPath = decodeURIComponent(root.pathname);
  const logicalPath = path.startsWith(rootPath) ? path.slice(rootPath.length) : '';
  if (logicalPath === 'spike1/tools/normalizer_roots.ts') return [];
  if (!logicalPath.startsWith('spike0/src/') && !logicalPath.startsWith('spike1/src/')) return [];
  return [logicalPath];
}).sort();
const manifest = [];
for (const logicalPath of paths) {
  manifest.push({
    logicalPath,
    sourceHash: await rawDigest(
      'henji/spike1/source-file/v1',
      await Deno.readFile(new URL(logicalPath, root)),
    ),
  });
}
const decoderSourceDigest = await domainDigest('henji/spike1/decoder-source/v1', manifest);
const profileDigest = await domainDigest('henji/spike1/intake-profile/v1', INTAKE_LIMITS);
const submissionSchema = {
  schemaVersion: 'proposal-submission/v1',
  fields: [
    'schemaVersion',
    'replacement',
    'reason',
    'evidenceRefs',
    'expectedEffect',
    'knownRisks',
  ],
};
const actual = await domainDigest('henji/spike1/normalizer/v1', {
  decoderSourceDigest,
  submissionSchema,
  profileDigest,
});
if (actual !== NORMALIZER_DIGEST) throw new Error(`normalizer digest mismatch: ${actual}`);
