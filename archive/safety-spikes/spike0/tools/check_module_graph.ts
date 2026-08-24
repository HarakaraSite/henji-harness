interface InfoDependency {
  readonly code?: { readonly specifier?: string; readonly error?: string };
  readonly type?: { readonly specifier?: string; readonly error?: string };
}

interface InfoModule {
  readonly specifier?: string;
  readonly dependencies?: readonly InfoDependency[];
}

interface InfoOutput {
  readonly roots?: readonly string[];
  readonly modules?: readonly InfoModule[];
}

const fail = (message: string): never => {
  throw new Error(`module graph rejected: ${message}`);
};

const raw = await new Response(Deno.stdin.readable).text();
const info = JSON.parse(raw) as InfoOutput;
if (!Array.isArray(info.roots) || !Array.isArray(info.modules)) fail('invalid deno info JSON');
const roots = info.roots as readonly string[];
const modules = info.modules as readonly InfoModule[];

const spikeRoot = new URL('../', import.meta.url).href;
const expectedRoot = new URL('../tests/all_test.ts', import.meta.url).href;
if (roots.length !== 1 || roots[0] !== expectedRoot) fail('unexpected graph root');

const specifiers = new Set<string>();
for (const module of modules) {
  if (typeof module.specifier !== 'string') fail('module without a specifier');
  const specifier = module.specifier as string;
  const url = new URL(specifier);
  if (url.protocol !== 'file:' || !url.href.startsWith(spikeRoot)) {
    fail(`specifier outside spike0: ${module.specifier}`);
  }
  specifiers.add(url.href);
}

for (const module of modules) {
  for (const dependency of module.dependencies ?? []) {
    for (const resolution of [dependency.code, dependency.type]) {
      if (resolution?.error) fail(`unresolved dependency: ${resolution.error}`);
      if (resolution?.specifier && !specifiers.has(new URL(resolution.specifier).href)) {
        fail(`dependency outside resolved graph: ${resolution.specifier}`);
      }
    }
  }
}

for (
  const path of [
    'src/definition_content.ts',
    'src/field_ownership.ts',
    'src/revision_view.ts',
    'src/canonical_content.ts',
  ]
) {
  const expected = new URL(`../${path}`, import.meta.url).href;
  if (!specifiers.has(expected)) fail(`planned source is absent from graph: ${path}`);
}
