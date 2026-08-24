interface Module {
  readonly specifier?: string;
  readonly dependencies?: readonly {
    readonly code?: { readonly specifier?: string; readonly error?: string };
    readonly type?: { readonly specifier?: string; readonly error?: string };
  }[];
}
interface Info {
  readonly roots?: readonly string[];
  readonly modules?: readonly Module[];
}
const fail = (message: string): never => {
  throw new Error(`Spike 1 graph rejected: ${message}`);
};
const info = JSON.parse(await new Response(Deno.stdin.readable).text()) as Info;
if (!Array.isArray(info.roots) || !Array.isArray(info.modules)) fail('invalid info JSON');
const roots = info.roots as readonly string[];
const modules = info.modules as readonly Module[];
const expectedRoot = new URL('../tests/all_test.ts', import.meta.url).href;
if (roots.length !== 1 || roots[0] !== expectedRoot) fail('unexpected root');
const spike1Root = new URL('../', import.meta.url).href;
const spike0Root = new URL('../../spike0/src/', import.meta.url).href;
const specs = new Set<string>();
for (const module of modules) {
  if (typeof module.specifier !== 'string') fail('missing specifier');
  const specifier = module.specifier as string;
  if (!specifier.startsWith(spike1Root) && !specifier.startsWith(spike0Root)) {
    fail(`outside closure: ${specifier}`);
  }
  specs.add(specifier);
}
for (const module of modules) {
  for (const dependency of module.dependencies ?? []) {
    for (const resolution of [dependency.code, dependency.type]) {
      if (resolution?.error) fail(resolution.error);
      if (resolution?.specifier && !specs.has(resolution.specifier)) {
        fail(`unresolved graph member: ${resolution.specifier}`);
      }
    }
  }
}
for (
  const path of [
    'limits.ts',
    'intake_json.ts',
    'definition_proposal.ts',
    'revision_ticket.ts',
    'provenance.ts',
    'revision_context.ts',
    'mutation_scope.ts',
    'revision_service.ts',
    'definition_revision.ts',
    'revision_outcome.ts',
    'observability.ts',
    'normalizer_identity.ts',
    'runtime_schema.ts',
    'submission_framing.ts',
  ]
) {
  if (!specs.has(new URL(`../src/${path}`, import.meta.url).href)) {
    fail(`planned module absent: ${path}`);
  }
}
