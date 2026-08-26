import { assert, assertEquals } from './test_helpers.ts';
import {
  discoverAgentInstructions,
  formatAgentInstructions,
  type InstructionFileHandle,
  type InstructionFileInfo,
  type InstructionFileSystem,
  MAX_AGENT_INSTRUCTION_BYTES,
} from '../../v0/agent/agent_instructions.ts';

type Node = {
  readonly info: InstructionFileInfo;
  readonly bytes?: Uint8Array;
  readonly lstatError?: unknown;
  readonly openError?: unknown;
  readonly readError?: unknown;
  readonly statError?: unknown;
  readonly statInfo?: InstructionFileInfo;
};

const encoder = new TextEncoder();
const notFound = () => new Deno.errors.NotFound();

const makeMemoryFs = (nodes: Record<string, Node>) => {
  let lstatCalls = 0;
  let openCalls = 0;
  let readObserved = 0;
  let closeCalls = 0;
  const fileSystem: InstructionFileSystem = {
    lstat(path) {
      lstatCalls += 1;
      const node = nodes[path];
      if (!node) throw notFound();
      if (node.lstatError !== undefined) throw node.lstatError;
      return Promise.resolve(node.info);
    },
    open(path): Promise<InstructionFileHandle> {
      openCalls += 1;
      const node = nodes[path];
      if (!node) throw notFound();
      if (node.openError !== undefined) throw node.openError;
      const bytes = node.bytes ?? new Uint8Array();
      let offset = 0;
      return Promise.resolve({
        read(buffer) {
          if (node.readError !== undefined) throw node.readError;
          const amount = Math.min(buffer.byteLength, bytes.byteLength - offset);
          if (amount <= 0) return Promise.resolve(null);
          buffer.set(bytes.subarray(offset, offset + amount));
          offset += amount;
          readObserved += amount;
          return Promise.resolve(amount);
        },
        stat() {
          if (node.statError !== undefined) throw node.statError;
          return Promise.resolve(node.statInfo ?? node.info);
        },
        close() {
          closeCalls += 1;
        },
      });
    },
  };
  return {
    fileSystem,
    get lstatCalls() {
      return lstatCalls;
    },
    get openCalls() {
      return openCalls;
    },
    get readObserved() {
      return readObserved;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
};

const regular = (bytes: Uint8Array): Node => ({
  info: { isFile: true, isSymlink: false },
  bytes,
});
const special = (isSymlink = false): Node => ({ info: { isFile: false, isSymlink } });
const invalid = (bytes: Uint8Array): Node => ({
  info: { isFile: true, isSymlink: false },
  bytes,
});

Deno.test('workspace discovery uses exact filenames, priority, and formatter', async () => {
  const lower = makeMemoryFs({
    '/workspace/AGENTS.md': regular(encoder.encode('  lower instructions\n\n')),
    '/workspace/AGENTS.MD': regular(encoder.encode('upper instructions')),
  });
  assertEquals(
    await discoverAgentInstructions('/workspace/./', lower.fileSystem),
    'Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./AGENTS.md\n\nlower instructions',
  );
  assertEquals(lower.openCalls, 1);
  assertEquals(
    formatAgentInstructions('AGENTS.MD', '  upper instructions\n'),
    'Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./AGENTS.MD\n\nupper instructions',
  );
});

Deno.test('missing lowercase advances to uppercase, but invalid lowercase wins', async () => {
  const fallback = makeMemoryFs({
    '/workspace/AGENTS.MD': regular(encoder.encode('upper instructions')),
  });
  assert(
    (await discoverAgentInstructions('/workspace', fallback.fileSystem))?.endsWith(
      'upper instructions',
    ),
  );
  const invalidLower = makeMemoryFs({
    '/workspace/AGENTS.md': invalid(encoder.encode('   ')),
    '/workspace/AGENTS.MD': regular(encoder.encode('must not leak')),
  });
  assertEquals(await discoverAgentInstructions('/workspace', invalidLower.fileSystem), undefined);
  assertEquals(invalidLower.openCalls, 1);
});

Deno.test('only regular non-symlink files are accepted', async () => {
  for (const node of [special(), special(true)]) {
    const fs = makeMemoryFs({ '/workspace/AGENTS.md': node });
    assertEquals(await discoverAgentInstructions('/workspace', fs.fileSystem), undefined);
    assertEquals(fs.openCalls, 0);
  }
  const symlinkWithUppercaseFallback = makeMemoryFs({
    '/workspace/AGENTS.md': special(true),
    '/workspace/AGENTS.MD': regular(encoder.encode('must not leak')),
  });
  assertEquals(
    await discoverAgentInstructions('/workspace', symlinkWithUppercaseFallback.fileSystem),
    undefined,
  );
  assertEquals(symlinkWithUppercaseFallback.openCalls, 0);
  assertEquals(symlinkWithUppercaseFallback.lstatCalls, 1);

  const changed = makeMemoryFs({
    '/workspace/AGENTS.md': {
      info: { isFile: true, isSymlink: false },
      bytes: encoder.encode('not accepted after open'),
      statInfo: { isFile: false, isSymlink: false },
    },
  });
  assertEquals(await discoverAgentInstructions('/workspace', changed.fileSystem), undefined);
  assertEquals(changed.readObserved, 0);
  assertEquals(changed.closeCalls, 1);
});

Deno.test('bounded UTF-8 decoding accepts 16 KiB and skips 16 KiB plus one', async () => {
  const accepted = makeMemoryFs({
    '/workspace/AGENTS.md': regular(encoder.encode('x'.repeat(MAX_AGENT_INSTRUCTION_BYTES))),
  });
  assert(
    (await discoverAgentInstructions('/workspace', accepted.fileSystem))?.endsWith('x'.repeat(8)),
  );
  assertEquals(accepted.readObserved, MAX_AGENT_INSTRUCTION_BYTES);
  assertEquals(accepted.closeCalls, 1);

  const oversize = makeMemoryFs({
    '/workspace/AGENTS.md': regular(encoder.encode('x'.repeat(MAX_AGENT_INSTRUCTION_BYTES + 1))),
  });
  assertEquals(await discoverAgentInstructions('/workspace', oversize.fileSystem), undefined);
  assertEquals(oversize.readObserved, MAX_AGENT_INSTRUCTION_BYTES + 1);
  assertEquals(oversize.closeCalls, 1);
});

Deno.test('decoder rejects malformed UTF-8, NUL, and blank content while stripping BOM', async () => {
  const malformed = makeMemoryFs({
    '/workspace/AGENTS.md': invalid(new Uint8Array([0xc3, 0x28])),
  });
  assertEquals(await discoverAgentInstructions('/workspace', malformed.fileSystem), undefined);
  const nul = makeMemoryFs({
    '/workspace/AGENTS.md': regular(encoder.encode('valid\0invalid')),
  });
  assertEquals(await discoverAgentInstructions('/workspace', nul.fileSystem), undefined);
  const bom = makeMemoryFs({
    '/workspace/AGENTS.md': regular(
      new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('bom text')]),
    ),
  });
  assert((await discoverAgentInstructions('/workspace', bom.fileSystem))?.endsWith('bom text'));
});

Deno.test('read, open, and stat failures are silent and close opened handles', async () => {
  const cases: Node[] = [
    { info: { isFile: true, isSymlink: false }, openError: new Error('open') },
    {
      info: { isFile: true, isSymlink: false },
      bytes: encoder.encode('secret marker'),
      readError: new Error('read'),
    },
    {
      info: { isFile: true, isSymlink: false },
      bytes: encoder.encode('secret marker'),
      statError: new Error('stat'),
    },
  ];
  for (const node of cases) {
    const fs = makeMemoryFs({ '/workspace/AGENTS.md': node });
    assertEquals(await discoverAgentInstructions('/workspace', fs.fileSystem), undefined);
    assertEquals(fs.closeCalls, node.openError === undefined ? 1 : 0);
  }
  const lstatFailure = makeMemoryFs({
    '/workspace/AGENTS.md': {
      info: { isFile: true, isSymlink: false },
      lstatError: new Error('permission denied'),
    },
    '/workspace/AGENTS.MD': regular(encoder.encode('must not fall through')),
  });
  assertEquals(await discoverAgentInstructions('/workspace', lstatFailure.fileSystem), undefined);
});

Deno.test('no candidates and ignored spelling variants produce no context', async () => {
  const fs = makeMemoryFs({
    '/workspace/agents.md': regular(encoder.encode('ignored')),
    '/workspace/AGENT.md': regular(encoder.encode('ignored')),
    '/workspace/CLAUDE.md': regular(encoder.encode('ignored')),
  });
  assertEquals(await discoverAgentInstructions('/workspace', fs.fileSystem), undefined);
  assertEquals(fs.lstatCalls, 2);
});

Deno.test('discovery never searches ancestors, children, or siblings', async () => {
  const fs = makeMemoryFs({
    '/AGENTS.md': regular(encoder.encode('ancestor marker')),
    '/workspace/child/AGENTS.md': regular(encoder.encode('child marker')),
    '/workspace-sibling/AGENTS.md': regular(encoder.encode('sibling marker')),
  });
  assertEquals(await discoverAgentInstructions('/workspace', fs.fileSystem), undefined);
  assertEquals(fs.lstatCalls, 2);
});
