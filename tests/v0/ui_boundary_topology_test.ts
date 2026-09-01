import { assert, assertEquals } from './test_helpers.ts';

const CORE_FILES = [
  'v0/domain.ts',
  'v0/model.ts',
  'v0/agent/agent_catalog.ts',
  'v0/agent/agent_definition.ts',
  'v0/agent/agent_identity.ts',
  'v0/agent/agent_instructions.ts',
  'v0/agent/cancellation.ts',
  'v0/agent/canonical_identity.ts',
  'v0/agent/cli.ts',
  'v0/agent/credential_file.ts',
  'v0/agent/context.ts',
  'v0/agent/contracts.ts',
  'v0/agent/events.ts',
  'v0/agent/failure_diagnostic.ts',
  'v0/agent/failure_diagnostic_store.ts',
  'v0/agent/execution_context.ts',
  'v0/agent/fixture_model.ts',
  'v0/agent/loop.ts',
  'v0/agent/openrouter_model.ts',
  'v0/agent/planner_delegation.ts',
  'v0/agent/registries.ts',
  'v0/agent/resolved_manifest.ts',
  'v0/agent/resource_identity.ts',
  'v0/agent/runtime.ts',
  'v0/agent/runtime_cli.ts',
  'v0/agent/session.ts',
  'v0/agent/session_cli.ts',
  'v0/agent/session_history.ts',
  'v0/agent/session_navigation.ts',
  'v0/agent/session_store.ts',
  'v0/agent/semantic_context.ts',
  'v0/agent/skills.ts',
  'v0/agent/steering.ts',
  'v0/agent/tools.ts',
  'v0/agent/tui_cli.ts',
  'v0/agent/tui_presentation_adapter.ts',
  'v0/agent/startup_orientation.ts',
  'v0/agent/work_tools.ts',
  'v0/presentation/contract.ts',
  'v0/tui/controller.ts',
  'v0/tui/input.ts',
  'v0/tui/layout.ts',
  'v0/tui/pending_input.ts',
  'v0/tui/file_reference.ts',
  'v0/tui/render.ts',
  'v0/tui/state.ts',
  'v0/tui/terminal.ts',
] as const;

const UI_FILES = CORE_FILES.filter((file) => file.startsWith('v0/tui/'));
const UI_IMPL_FORBIDDEN = [
  /(?:from\s*|import\s*)['"][^'"]*\/agent\//,
  /\bAgentSession\b/,
  /\bAgentEvent\b/,
  /\bLoopOutcome\b/,
  /\bMessage\b/,
];
const normalize = (sourceFile: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined;
  const base = sourceFile.slice(0, sourceFile.lastIndexOf('/') + 1);
  const parts = `${base}${specifier}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (normalized.length === 0) return undefined;
      normalized.pop();
    } else normalized.push(part);
  }
  const file = normalized.join('/');
  return file.endsWith('.ts') ? file : `${file}.ts`;
};

const imports = (sourceFile: string, source: string): string[] => {
  const result: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
    const imported = normalize(sourceFile, match[1]);
    if (imported !== undefined) result.push(imported);
  }
  return result;
};

const readInventory = async (): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    CORE_FILES.map(async (file) => [file, await Deno.readTextFile(file)] as const),
  );
  return new Map(entries);
};

const reachableFrom = (
  sources: ReadonlyMap<string, string>,
  roots: readonly string[],
): Set<string> => {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    const source = sources.get(file);
    if (source === undefined) throw new Error(`missing source ${file}`);
    reachable.add(file);
    for (const imported of imports(file, source)) {
      if (!sources.has(imported)) {
        throw new Error(`import escapes inventory: ${file} -> ${imported}`);
      }
      pending.push(imported);
    }
  }
  return reachable;
};

const assertGraphInvariant = (sources: ReadonlyMap<string, string>): void => {
  const reachable = reachableFrom(sources, [
    'v0/agent/runtime.ts',
    'v0/agent/session.ts',
    'v0/agent/cli.ts',
    'v0/agent/runtime_cli.ts',
    'v0/agent/tui_cli.ts',
  ]);
  assertEquals([...reachable].sort(), [...CORE_FILES].sort());
  const headless = reachableFrom(sources, ['v0/agent/runtime_cli.ts']);
  for (const file of headless) {
    if (
      file.startsWith('v0/tui/') || file === 'v0/agent/tui_cli.ts' ||
      file === 'v0/agent/tui_presentation_adapter.ts'
    ) {
      throw new Error(`headless UI escape ${file}`);
    }
  }
  const contract = sources.get('v0/presentation/contract.ts');
  if (contract === undefined || /(?:from\s*|import\s*)['"]\.?\.?\//u.test(contract)) {
    throw new Error('contract import escape');
  }
  for (const file of UI_FILES) {
    const source = sources.get(file)!;
    for (const pattern of UI_IMPL_FORBIDDEN) {
      if (pattern.test(source)) throw new Error(`UI implementation leaked into ${file}`);
    }
    for (const imported of imports(file, source)) {
      if (imported !== 'v0/presentation/contract.ts' && !imported.startsWith('v0/tui/')) {
        throw new Error(`${file} imports core ${imported}`);
      }
    }
  }
  for (
    const file of CORE_FILES.filter((candidate) =>
      candidate.startsWith('v0/agent/') && candidate !== 'v0/agent/tui_cli.ts' &&
      candidate !== 'v0/agent/tui_presentation_adapter.ts'
    )
  ) {
    if (imports(file, sources.get(file)!).some((imported) => imported.startsWith('v0/tui/'))) {
      throw new Error(`core reverse edge ${file}`);
    }
  }
  for (const file of ['v0/domain.ts', 'v0/model.ts']) {
    if (imports(file, sources.get(file)!).some((imported) => imported.startsWith('v0/tui/'))) {
      throw new Error(`root reverse edge ${file}`);
    }
  }
  if (
    imports(
      'v0/agent/tui_presentation_adapter.ts',
      sources.get('v0/agent/tui_presentation_adapter.ts')!,
    ).some((imported) => imported.startsWith('v0/tui/'))
  ) {
    throw new Error('adapter bypasses neutral boundary');
  }
  if (sources.get('v0/agent/session_history.ts')!.includes('../tui/render.ts')) {
    throw new Error('history reverse edge');
  }
};

Deno.test('boundary topology rejects every supplied-source mutation class', async () => {
  const original = await readInventory();
  const reject = (file: string, addition: string): void => {
    const sources = new Map(original);
    sources.set(file, `${sources.get(file)!}\n${addition}\n`);
    let rejected = false;
    try {
      assertGraphInvariant(sources);
    } catch {
      rejected = true;
    }
    assert(rejected, `mutation accepted: ${file}`);
  };
  reject('v0/domain.ts', "import './tui/state.ts';");
  reject('v0/model.ts', "import './tui/layout.ts';");
  reject('v0/agent/openrouter_model.ts', "import '../tui/render.ts';");
  reject('v0/tui/state.ts', "import '../agent/runtime.ts';");
  reject('v0/agent/tui_presentation_adapter.ts', "import '../tui/render.ts';");
  reject('v0/agent/runtime_cli.ts', "import '../tui/render.ts';");
  reject('v0/agent/runtime.ts', "import './escape-inventory.ts';");
});

Deno.test('neutral boundary and detached TUI have a closed, one-way import graph', async () => {
  const sources = await readInventory();
  assertEquals(
    [...reachableFrom(sources, [
      'v0/agent/runtime.ts',
      'v0/agent/session.ts',
      'v0/agent/cli.ts',
      'v0/agent/runtime_cli.ts',
      'v0/agent/tui_cli.ts',
    ])].sort(),
    [...CORE_FILES].sort(),
  );

  const contract = sources.get('v0/presentation/contract.ts')!;
  assert(!/(?:from\s*|import\s*)['"]\.?\.?\//.test(contract), 'contract must remain data-only');
  for (const file of UI_FILES) {
    const source = sources.get(file)!;
    for (const pattern of UI_IMPL_FORBIDDEN) {
      assert(!pattern.test(source), `UI implementation leaked into ${file}`);
    }
    for (const imported of imports(file, source)) {
      assert(
        imported === 'v0/presentation/contract.ts' || imported.startsWith('v0/tui/'),
        `${file} imports core ${imported}`,
      );
    }
  }
  for (
    const file of CORE_FILES.filter((candidate) =>
      candidate.startsWith('v0/agent/') && candidate !== 'v0/agent/tui_cli.ts' &&
      candidate !== 'v0/agent/tui_presentation_adapter.ts'
    )
  ) {
    for (const imported of imports(file, sources.get(file)!)) {
      assert(!imported.startsWith('v0/tui/'), `core reverse edge ${file} -> ${imported}`);
    }
  }
  for (
    const imported of imports(
      'v0/agent/tui_presentation_adapter.ts',
      sources.get('v0/agent/tui_presentation_adapter.ts')!,
    )
  ) {
    assert(!imported.startsWith('v0/tui/'), 'adapter bypasses neutral boundary');
  }
  assert(!sources.get('v0/agent/session_history.ts')!.includes('../tui/render.ts'));
});

Deno.test('headless agent:run closure never materializes the human UI', async () => {
  const sources = await readInventory();
  const reachable = reachableFrom(sources, ['v0/agent/runtime_cli.ts']);
  for (const file of reachable) {
    assert(!file.startsWith('v0/tui/'), `headless closure reached ${file}`);
    assert(file !== 'v0/agent/tui_cli.ts', 'headless closure reached composition root');
    assert(file !== 'v0/agent/tui_presentation_adapter.ts', 'headless closure reached adapter');
  }
});
