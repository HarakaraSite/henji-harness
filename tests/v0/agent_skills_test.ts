import { assert, assertEquals } from './test_helpers.ts';
import {
  createSkillTool,
  discoverSkills,
  MAX_CALLABLE_SKILLS,
  MAX_SKILL_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  parseSkillFile,
  type SkillFileHandle,
  type SkillFileSystem,
  type SkillPathInfo,
} from '../../v0/agent/skills.ts';
import { Registry } from '../../v0/agent/tools.ts';

const encoder = new TextEncoder();
const directory: SkillPathInfo = { isFile: false, isDirectory: true, isSymlink: false };
const file: SkillPathInfo = { isFile: true, isDirectory: false, isSymlink: false };

interface MemoryFile {
  readonly bytes: Uint8Array;
  readonly stat?: SkillPathInfo;
  readonly readError?: unknown;
}

const memoryFileSystem = (
  directoryEntries: Record<string, readonly string[]>,
  infos: Record<string, SkillPathInfo>,
  files: Record<string, MemoryFile>,
) => {
  let closes = 0;
  const fs: SkillFileSystem = {
    lstat(path) {
      const info = infos[path];
      if (info === undefined) throw new Deno.errors.NotFound();
      return Promise.resolve(info);
    },
    async *readDirectory(path) {
      const entries = directoryEntries[path];
      if (entries === undefined) throw new Deno.errors.NotFound();
      for (const entry of entries) yield entry;
    },
    open(path): Promise<SkillFileHandle> {
      const value = files[path];
      if (value === undefined) throw new Deno.errors.NotFound();
      let offset = 0;
      return Promise.resolve({
        read(buffer) {
          if (value.readError !== undefined) throw value.readError;
          const count = Math.min(buffer.byteLength, value.bytes.byteLength - offset);
          if (count === 0) return Promise.resolve(null);
          buffer.set(value.bytes.subarray(offset, offset + count));
          offset += count;
          return Promise.resolve(count);
        },
        stat: () => Promise.resolve(value.stat ?? file),
        close: () => {
          closes += 1;
        },
      });
    },
  };
  return { fs, closes: () => closes };
};

const skillText = (
  description: string,
  body: string,
  extra = '',
): string => `---\ndescription: ${description}${extra}\n---\n${body}`;

const oneSkill = (
  location: '.zot' | '.claude' | '.agents',
  directoryName: string,
  text: string,
) => {
  const locationPath = `/workspace/${location}/skills`;
  const directoryPath = `${locationPath}/${directoryName}`;
  const skillPath = `${directoryPath}/SKILL.md`;
  return memoryFileSystem(
    { [locationPath]: [directoryName] },
    { [locationPath]: directory, [directoryPath]: directory, [skillPath]: file },
    { [skillPath]: { bytes: encoder.encode(text) } },
  );
};

Deno.test('strict skill parser accepts minimal LF/CRLF and rejects unsupported metadata', () => {
  assertEquals(parseSkillFile(skillText('Review code.', 'Do the review.'), 'review'), {
    name: 'review',
    description: 'Review code.',
    disabled: false,
    body: 'Do the review.',
  });
  assertEquals(
    parseSkillFile(
      '---\r\nname: named\r\ndescription: "Review code."\r\ndisable-model-invocation: true\r\n---\r\nBody\r\n',
      'review',
    ),
    { name: 'named', description: 'Review code.', disabled: true, body: 'Body' },
  );
  assertEquals(
    parseSkillFile('---\r\ndescription: Lines.\r\n---\r\nline1\r\nline2\r\n', 'lines')?.body,
    'line1\r\nline2',
  );
  for (
    const invalid of [
      '\n---\ndescription: x\n---\nbody',
      '---\ndescription: x\nallowed-tools: bash\n---\nbody',
      '---\ndescription: x\npermissions: read\n---\nbody',
      '---\ndescription: x\ndescription: y\n---\nbody',
      '---\n description: x\n---\nbody',
      '---\ndescription: x # comment\n---\nbody',
      '---\ndescription: x\n---\n   ',
    ]
  ) assertEquals(parseSkillFile(invalid, 'review'), undefined);
});

Deno.test('description byte boundary accepts 160 and rejects 161', () => {
  assert(parseSkillFile(skillText('x'.repeat(160), 'body'), 'boundary'));
  assertEquals(parseSkillFile(skillText('x'.repeat(161), 'body'), 'boundary'), undefined);
});

Deno.test('project skill discovery emits exact relative manifest and immutable snapshot', async () => {
  const memory = oneSkill('.zot', 'code-review', skillText('Review code.', 'PRIVATE-BODY'));
  const catalog = await discoverSkills('/workspace/./', memory.fs);
  assertEquals(catalog.skills.length, 1);
  assertEquals(
    catalog.manifest,
    'Available project skills. When a request matches one, call `skill` with its exact name to load the saved instructions.\n- code-review — Review code. (source: ./.zot/skills/code-review)',
  );
  assert(!catalog.manifest?.includes('PRIVATE-BODY'));
  assert(!catalog.manifest?.includes('/workspace'));
  assertEquals(memory.closes(), 1);
  assert(Object.isFrozen(catalog) && Object.isFrozen(catalog.skills));
});

Deno.test('priority, sorted first-valid name, and disabled reservation are deterministic', async () => {
  const locationA = '/workspace/.zot/skills';
  const locationB = '/workspace/.claude/skills';
  const paths = [
    `${locationA}/z-last`,
    `${locationA}/a-first`,
    `${locationB}/fallback`,
  ];
  const infos: Record<string, SkillPathInfo> = {
    [locationA]: directory,
    [locationB]: directory,
  };
  const files: Record<string, MemoryFile> = {};
  for (const path of paths) {
    infos[path] = directory;
    infos[`${path}/SKILL.md`] = file;
  }
  files[`${locationA}/z-last/SKILL.md`] = {
    bytes: encoder.encode(
      skillText('Disabled.', 'hidden', '\nname: shared\ndisable-model-invocation: true'),
    ),
  };
  files[`${locationA}/a-first/SKILL.md`] = {
    bytes: encoder.encode(skillText('First.', 'first', '\nname: selected')),
  };
  files[`${locationB}/fallback/SKILL.md`] = {
    bytes: encoder.encode(skillText('Fallback.', 'fallback', '\nname: shared')),
  };
  const memory = memoryFileSystem(
    { [locationA]: ['z-last', 'a-first'], [locationB]: ['fallback'] },
    infos,
    files,
  );
  const catalog = await discoverSkills('/workspace', memory.fs);
  assertEquals(catalog.skills.map((skill) => skill.name), ['selected']);
  assert(!catalog.manifest?.includes('shared'));
});

Deno.test('oversized disabled result still reserves its high-priority effective name', async () => {
  const high = oneSkill(
    '.zot',
    'disabled',
    skillText('Disabled.', 'x'.repeat(65_400), '\nname: shared\ndisable-model-invocation: true'),
  );
  const low = oneSkill('.claude', 'enabled', skillText('Enabled.', 'body', '\nname: shared'));
  const combined: SkillFileSystem = {
    lstat: async (path) => {
      try {
        return await high.fs.lstat(path);
      } catch {
        return await low.fs.lstat(path);
      }
    },
    async *readDirectory(path) {
      try {
        for await (const entry of high.fs.readDirectory(path)) yield entry;
      } catch {
        for await (const entry of low.fs.readDirectory(path)) yield entry;
      }
    },
    open: async (path) => {
      try {
        return await high.fs.open(path);
      } catch {
        return await low.fs.open(path);
      }
    },
  };
  assertEquals((await discoverSkills('/workspace', combined)).skills, []);
});

Deno.test('invalid high-priority candidate does not reserve its effective name', async () => {
  const high = oneSkill('.zot', 'same', '---\ndescription: invalid\nallowed_tools: x\n---\nhigh');
  const low = oneSkill('.claude', 'same', skillText('Valid.', 'low'));
  const combined: SkillFileSystem = {
    lstat: async (path) => {
      try {
        return await high.fs.lstat(path);
      } catch {
        return await low.fs.lstat(path);
      }
    },
    async *readDirectory(path) {
      try {
        for await (const entry of high.fs.readDirectory(path)) yield entry;
      } catch {
        for await (const entry of low.fs.readDirectory(path)) yield entry;
      }
    },
    open: async (path) => {
      try {
        return await high.fs.open(path);
      } catch {
        return await low.fs.open(path);
      }
    },
  };
  const catalog = await discoverSkills('/workspace', combined);
  assertEquals(catalog.skills.map((skill) => skill.sourceDirectory), [
    './.claude/skills/same',
  ]);
});

Deno.test('129th direct entry skips the whole location', async () => {
  const location = '/workspace/.zot/skills';
  const memory = memoryFileSystem(
    { [location]: Array.from({ length: MAX_SKILL_ENTRIES + 1 }, (_, index) => `s${index}`) },
    { [location]: directory },
    {},
  );
  assertEquals((await discoverSkills('/workspace', memory.fs)).skills, []);
});

Deno.test('file byte bound and opened-file type are enforced and handles close', async () => {
  const base = skillText('Valid.', 'body');
  const exactText = `${base}${' '.repeat(MAX_SKILL_FILE_BYTES - encoder.encode(base).byteLength)}`;
  const exact = oneSkill('.zot', 'exact', exactText);
  assertEquals((await discoverSkills('/workspace', exact.fs)).skills.length, 1);
  assertEquals(exact.closes(), 1);

  const oversizeText = `${base}${
    ' '.repeat(MAX_SKILL_FILE_BYTES + 1 - encoder.encode(base).byteLength)
  }`;
  const oversize = oneSkill('.zot', 'large', oversizeText);
  assertEquals((await discoverSkills('/workspace', oversize.fs)).skills.length, 0);
  assertEquals(oversize.closes(), 1);
  const changed = oneSkill('.zot', 'changed', skillText('Valid.', 'body'));
  const originalOpen = changed.fs.open;
  changed.fs.open = async (path) => {
    const handle = await originalOpen(path);
    return { ...handle, stat: () => Promise.resolve(directory) };
  };
  assertEquals((await discoverSkills('/workspace', changed.fs)).skills.length, 0);
  assertEquals(changed.closes(), 1);
});

Deno.test('result and aggregate byte ceilings accept exact limits and stop before overflow', async () => {
  const oversizeName = 'oversize-result';
  const oversizeDescription = 'Oversize.';
  const oversizeSource = `./.zot/skills/${oversizeName}`;
  const oversizePrefix =
    `# Skill: ${oversizeName}\n\n${oversizeDescription}\n\nSkill directory: ${oversizeSource}\nResolve relative paths in these instructions from that directory.\n\n---\n\n`;
  const oversizeBody = 'x'.repeat(65_537 - encoder.encode(oversizePrefix).byteLength);
  const oversize = oneSkill(
    '.zot',
    oversizeName,
    skillText(oversizeDescription, oversizeBody),
  );
  assertEquals((await discoverSkills('/workspace', oversize.fs)).skills.length, 0);

  const location = '/workspace/.zot/skills';
  const names = Array.from({ length: 9 }, (_, index) => `aggregate-${index}`);
  const infos: Record<string, SkillPathInfo> = { [location]: directory };
  const files: Record<string, MemoryFile> = {};
  for (const name of names) {
    const path = `${location}/${name}`;
    infos[path] = directory;
    infos[`${path}/SKILL.md`] = file;
    const description = 'Aggregate.';
    const source = `./.zot/skills/${name}`;
    const prefix =
      `# Skill: ${name}\n\n${description}\n\nSkill directory: ${source}\nResolve relative paths in these instructions from that directory.\n\n---\n\n`;
    const body = 'x'.repeat(65_536 - encoder.encode(prefix).byteLength);
    files[`${path}/SKILL.md`] = { bytes: encoder.encode(skillText(description, body)) };
  }
  const catalog = await discoverSkills(
    '/workspace',
    memoryFileSystem({ [location]: names }, infos, files).fs,
  );
  assertEquals(catalog.skills.length, 8);
  assertEquals(
    catalog.skills.reduce((total, skill) => total + encoder.encode(skill.toolResult).byteLength, 0),
    512 * 1024,
  );
  assert(catalog.skills.every((skill) => encoder.encode(skill.toolResult).byteLength === 65_536));
});

Deno.test('BOM is accepted while malformed UTF-8, NUL, symlinks, and read errors are skipped', async () => {
  const bom = oneSkill('.zot', 'bom', skillText('BOM.', 'body'));
  const bomPath = '/workspace/.zot/skills/bom/SKILL.md';
  const original = await bom.fs.open(bomPath);
  const collected = new Uint8Array(128);
  const count = await original.read(collected);
  original.close();
  assert(count !== null);
  const payload = collected.slice(0, count);
  const withBom = memoryFileSystem(
    { '/workspace/.zot/skills': ['bom'] },
    {
      '/workspace/.zot/skills': directory,
      '/workspace/.zot/skills/bom': directory,
      [bomPath]: file,
    },
    { [bomPath]: { bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...payload]) } },
  );
  assertEquals((await discoverSkills('/workspace', withBom.fs)).skills.length, 1);

  for (const bytes of [new Uint8Array([0xc3, 0x28]), encoder.encode(skillText('NUL.', 'a\0b'))]) {
    const path = '/workspace/.zot/skills/invalid/SKILL.md';
    const fs = memoryFileSystem(
      { '/workspace/.zot/skills': ['invalid'] },
      {
        '/workspace/.zot/skills': directory,
        '/workspace/.zot/skills/invalid': directory,
        [path]: file,
      },
      { [path]: { bytes } },
    );
    assertEquals((await discoverSkills('/workspace', fs.fs)).skills.length, 0);
  }

  const locationSymlink = memoryFileSystem({}, {
    '/workspace/.zot/skills': { ...directory, isSymlink: true },
  }, {});
  assertEquals((await discoverSkills('/workspace', locationSymlink.fs)).skills.length, 0);
  const directorySymlink = oneSkill('.zot', 'linked', skillText('Linked.', 'body'));
  const linkedPath = '/workspace/.zot/skills/linked';
  const wrappedDirectory: SkillFileSystem = {
    ...directorySymlink.fs,
    lstat: async (path) =>
      path === linkedPath
        ? { ...directory, isSymlink: true }
        : await directorySymlink.fs.lstat(path),
  };
  assertEquals((await discoverSkills('/workspace', wrappedDirectory)).skills.length, 0);
  const fileSymlink = oneSkill('.zot', 'linked-file', skillText('Linked.', 'body'));
  const linkedFilePath = '/workspace/.zot/skills/linked-file/SKILL.md';
  const wrappedFile: SkillFileSystem = {
    ...fileSymlink.fs,
    lstat: async (path) =>
      path === linkedFilePath ? { ...file, isSymlink: true } : await fileSymlink.fs.lstat(path),
  };
  assertEquals((await discoverSkills('/workspace', wrappedFile)).skills.length, 0);
  const readFailure = oneSkill('.zot', 'read-failure', skillText('Read.', 'body'));
  const failingOpen: SkillFileSystem = {
    ...readFailure.fs,
    open: async (path) => {
      const handle = await readFailure.fs.open(path);
      return {
        ...handle,
        read: () => {
          throw new Error('read');
        },
      };
    },
  };
  assertEquals(await discoverSkills('/workspace', failingOpen), {
    skills: [],
    manifest: undefined,
  });
  assertEquals(readFailure.closes(), 1);
});

Deno.test('callable skill count stops at 24 in deterministic name order', async () => {
  const location = '/workspace/.zot/skills';
  const names = Array.from(
    { length: MAX_CALLABLE_SKILLS + 1 },
    (_, index) => `skill-${String(index).padStart(2, '0')}`,
  );
  const infos: Record<string, SkillPathInfo> = { [location]: directory };
  const files: Record<string, MemoryFile> = {};
  for (const name of names) {
    const path = `${location}/${name}`;
    infos[path] = directory;
    infos[`${path}/SKILL.md`] = file;
    files[`${path}/SKILL.md`] = { bytes: encoder.encode(skillText(`Skill ${name}.`, 'body')) };
  }
  const catalog = await discoverSkills(
    '/workspace',
    memoryFileSystem({ [location]: [...names].reverse() }, infos, files).fs,
  );
  assertEquals(catalog.skills.length, MAX_CALLABLE_SKILLS);
  assertEquals(catalog.skills.at(-1)?.name, 'skill-23');
});

Deno.test('skill tool has exact schema, static errors, relative success, and snapshot behavior', async () => {
  const memory = oneSkill('.agents', 'review', skillText('Review code.', 'SAVED BODY'));
  const catalog = await discoverSkills('/workspace', memory.fs);
  const registry = new Registry([createSkillTool(catalog)]);
  assertEquals(registry.definitions()[0].inputSchema, {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  });
  const invalid = await registry.dispatch({
    callId: '1',
    name: 'skill',
    arguments: { name: '../review' },
  });
  assertEquals(
    invalid.content.text,
    'invalid arguments: expected an object with only a valid skill name',
  );
  const unknown = await registry.dispatch({
    callId: '2',
    name: 'skill',
    arguments: { name: 'missing' },
  });
  assertEquals(unknown.content.text, 'tool execution error: skill not found');
  const success = await registry.dispatch({
    callId: '3',
    name: 'skill',
    arguments: { name: 'review' },
  });
  assertEquals(
    success.content.text,
    '# Skill: review\n\nReview code.\n\nSkill directory: ./.agents/skills/review\nResolve relative paths in these instructions from that directory.\n\n---\n\nSAVED BODY',
  );
  assertEquals(success.terminal, null);
});
