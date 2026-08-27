import { type JsonValue } from './contracts.ts';
import { type Tool, ToolInputError } from './tools.ts';
import { type ToolExecutionContext } from './execution_context.ts';
import { throwIfCancelled } from './cancellation.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const MAX_SKILL_FILE_BYTES = 65_536;
export const MAX_SKILL_RESULT_BYTES = 65_536;
export const MAX_SKILL_ENTRIES = 128;
export const MAX_CALLABLE_SKILLS = 24;
export const MAX_SKILL_RESULTS_BYTES = 512 * 1024;
export const MAX_SKILL_MANIFEST_BYTES = 8 * 1024;
export const MAX_SKILL_FRONTMATTER_BYTES = 4 * 1024;
export const MAX_SKILL_DESCRIPTION_BYTES = 160;

const LOCATIONS = ['.zot/skills', '.claude/skills', '.agents/skills'] as const;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MANIFEST_HEADER =
  'Available project skills. When a request matches one, call `skill` with its exact name to load the saved instructions.';

export interface SkillPathInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

export interface SkillFileHandle {
  read(buffer: Uint8Array): Promise<number | null>;
  stat(): Promise<SkillPathInfo>;
  close(): void;
}

export interface SkillFileSystem {
  lstat(path: string): Promise<SkillPathInfo>;
  readDirectory(path: string): AsyncIterable<string>;
  open(path: string): Promise<SkillFileHandle>;
}

export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly sourceDirectory: string;
  readonly body: string;
  readonly toolResult: string;
}

export interface SkillCatalog {
  readonly skills: readonly DiscoveredSkill[];
  readonly manifest?: string;
}

interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly body: string;
}

const productionFileSystem: SkillFileSystem = {
  async lstat(path) {
    const info = await Deno.lstat(path);
    return { isFile: info.isFile, isDirectory: info.isDirectory, isSymlink: info.isSymlink };
  },
  async *readDirectory(path) {
    for await (const entry of Deno.readDir(path)) yield entry.name;
  },
  async open(path) {
    const file = await Deno.open(path, { read: true });
    return {
      read: (buffer) => file.read(buffer),
      stat: async () => {
        const info = await file.stat();
        return { isFile: info.isFile, isDirectory: info.isDirectory, isSymlink: info.isSymlink };
      },
      close: () => file.close(),
    };
  },
};

const normalizeAbsolute = (root: string): string => {
  const parts: string[] = [];
  for (const part of root.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

const join = (root: string, relative: string): string =>
  root === '/' ? `/${relative}` : `${root}/${relative}`;

const wellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const scalar = (value: string): string | undefined => {
  if (value.length === 0 || value.trim() !== value || value.includes('#')) return undefined;
  const first = value[0];
  if (first === "'" || first === '"') {
    if (value.length < 2 || value.at(-1) !== first) return undefined;
    const inner = value.slice(1, -1);
    if (inner.includes(first) || inner.includes('\\')) return undefined;
    return inner;
  }
  if (value.includes("'") || value.includes('"')) return undefined;
  return value;
};

/** Parse the deliberately strict, non-YAML skill format. */
export const parseSkillFile = (text: string, directoryName: string): ParsedSkill | undefined => {
  if (!IDENTIFIER.test(directoryName) || text.includes('\0') || !wellFormedUnicode(text)) {
    return undefined;
  }
  const openingBytes = text.startsWith('---\r\n') ? 5 : text.startsWith('---\n') ? 4 : 0;
  if (openingBytes === 0) return undefined;
  const lines: string[] = [];
  let cursor = openingBytes;
  let frontmatterText: string | undefined;
  let bodyStart = -1;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? text.length : newline;
    const hasCr = lineEnd > cursor && text[lineEnd - 1] === '\r';
    const line = text.slice(cursor, hasCr ? lineEnd - 1 : lineEnd);
    if (line === '---') {
      frontmatterText = text.slice(openingBytes, cursor);
      bodyStart = newline < 0 ? text.length : newline + 1;
      break;
    }
    if (newline < 0) break;
    lines.push(line);
    cursor = newline + 1;
  }
  if (
    frontmatterText === undefined || lines.length === 0 ||
    encoder.encode(frontmatterText).byteLength > MAX_SKILL_FRONTMATTER_BYTES
  ) return undefined;

  const values = new Map<string, string>();
  for (const line of lines) {
    if (line.length === 0 || /^\s/.test(line) || line.startsWith('#')) return undefined;
    const match = /^([a-z][a-z-]*): (.+)$/.exec(line);
    if (!match) return undefined;
    const [, key, raw] = match;
    if (!['name', 'description', 'disable-model-invocation'].includes(key) || values.has(key)) {
      return undefined;
    }
    values.set(key, raw);
  }
  const descriptionRaw = values.get('description');
  if (descriptionRaw === undefined) return undefined;
  const description = scalar(descriptionRaw);
  const name = values.has('name') ? scalar(values.get('name')!) : directoryName;
  if (
    name === undefined || !IDENTIFIER.test(name) || description === undefined ||
    description.trim().length === 0 || description.includes('\n') || description.includes('\r') ||
    encoder.encode(description).byteLength > MAX_SKILL_DESCRIPTION_BYTES
  ) return undefined;
  const disableRaw = values.get('disable-model-invocation');
  if (disableRaw !== undefined && disableRaw !== 'true' && disableRaw !== 'false') return undefined;
  const body = text.slice(bodyStart).trim();
  if (body.length === 0 || body.includes('\0') || !wellFormedUnicode(body)) return undefined;
  return { name, description, disabled: disableRaw === 'true', body };
};

const readBounded = async (file: SkillFileHandle): Promise<Uint8Array | undefined> => {
  const output = new Uint8Array(MAX_SKILL_FILE_BYTES + 1);
  let offset = 0;
  try {
    while (offset < output.byteLength) {
      const count = await file.read(output.subarray(offset));
      if (count === null) break;
      if (!Number.isInteger(count) || count < 0 || count > output.byteLength - offset) {
        return undefined;
      }
      if (count === 0) break;
      offset += count;
    }
  } catch {
    return undefined;
  }
  if (offset > MAX_SKILL_FILE_BYTES) return undefined;
  return output.slice(0, offset);
};

const readSkill = async (
  fileSystem: SkillFileSystem,
  path: string,
): Promise<string | undefined> => {
  let info: SkillPathInfo;
  try {
    info = await fileSystem.lstat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile || info.isSymlink) return undefined;
  let file: SkillFileHandle;
  try {
    file = await fileSystem.open(path);
  } catch {
    return undefined;
  }
  try {
    let opened: SkillPathInfo;
    try {
      opened = await file.stat();
    } catch {
      return undefined;
    }
    if (!opened.isFile || opened.isSymlink) return undefined;
    const bytes = await readBounded(file);
    if (bytes === undefined) return undefined;
    try {
      let text = decoder.decode(bytes);
      if (text.startsWith('\ufeff')) text = text.slice(1);
      return text;
    } catch {
      return undefined;
    }
  } finally {
    try {
      file.close();
    } catch {
      // Discovery is intentionally silent.
    }
  }
};

const formatToolResult = (skill: Omit<DiscoveredSkill, 'toolResult'>): string =>
  `# Skill: ${skill.name}\n\n${skill.description}\n\nSkill directory: ${skill.sourceDirectory}\n` +
  `Resolve relative paths in these instructions from that directory.\n\n---\n\n${skill.body}`;

const manifestFor = (skills: readonly DiscoveredSkill[]): string | undefined =>
  skills.length === 0 ? undefined : [
    MANIFEST_HEADER,
    ...skills.map((skill) =>
      `- ${skill.name} — ${skill.description} (source: ${skill.sourceDirectory})`
    ),
  ].join('\n');

const frozenCatalog = (skills: readonly DiscoveredSkill[]): SkillCatalog => {
  const sorted = [...skills].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  const frozen = Object.freeze(sorted.map((skill) => Object.freeze({ ...skill })));
  return Object.freeze({ skills: frozen, manifest: manifestFor(frozen) });
};

export const emptySkillCatalog = (): SkillCatalog => frozenCatalog([]);

/** Discover a single immutable project-local catalog. All candidate failures are silent. */
export const discoverSkills = async (
  workspaceRoot: string,
  fileSystem: SkillFileSystem = productionFileSystem,
): Promise<SkillCatalog> => {
  const root = normalizeAbsolute(workspaceRoot);
  const reserved = new Set<string>();
  const accepted: DiscoveredSkill[] = [];
  let aggregateBytes = 0;
  let stopped = false;

  for (const location of LOCATIONS) {
    if (stopped) break;
    const absoluteLocation = join(root, location);
    let locationInfo: SkillPathInfo;
    try {
      locationInfo = await fileSystem.lstat(absoluteLocation);
    } catch {
      continue;
    }
    if (!locationInfo.isDirectory || locationInfo.isSymlink) continue;
    const entries: string[] = [];
    try {
      for await (const entry of fileSystem.readDirectory(absoluteLocation)) {
        entries.push(entry);
        if (entries.length > MAX_SKILL_ENTRIES) break;
      }
    } catch {
      continue;
    }
    if (entries.length > MAX_SKILL_ENTRIES) continue;
    entries.sort();
    for (const directoryName of entries) {
      if (!IDENTIFIER.test(directoryName)) continue;
      const relativeDirectory = `${location}/${directoryName}`;
      const absoluteDirectory = join(root, relativeDirectory);
      let directoryInfo: SkillPathInfo;
      try {
        directoryInfo = await fileSystem.lstat(absoluteDirectory);
      } catch {
        continue;
      }
      if (!directoryInfo.isDirectory || directoryInfo.isSymlink) continue;
      const text = await readSkill(fileSystem, `${absoluteDirectory}/SKILL.md`);
      if (text === undefined) continue;
      const parsed = parseSkillFile(text, directoryName);
      if (parsed === undefined || reserved.has(parsed.name)) continue;
      const sourceDirectory = `./${relativeDirectory}`;
      reserved.add(parsed.name);
      if (parsed.disabled) continue;
      const base = {
        name: parsed.name,
        description: parsed.description,
        sourceDirectory,
        body: parsed.body,
      };
      const toolResult = formatToolResult(base);
      if (encoder.encode(toolResult).byteLength > MAX_SKILL_RESULT_BYTES) continue;
      if (accepted.length >= MAX_CALLABLE_SKILLS) {
        stopped = true;
        break;
      }
      const resultBytes = encoder.encode(toolResult).byteLength;
      if (aggregateBytes + resultBytes > MAX_SKILL_RESULTS_BYTES) {
        stopped = true;
        break;
      }
      const candidate = Object.freeze({ ...base, toolResult });
      const next = [...accepted, candidate].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      const manifest = manifestFor(next)!;
      if (encoder.encode(manifest).byteLength > MAX_SKILL_MANIFEST_BYTES) {
        stopped = true;
        break;
      }
      accepted.push(candidate);
      aggregateBytes += resultBytes;
    }
  }
  return frozenCatalog(accepted);
};

export const createSkillTool = (catalog: SkillCatalog): Tool => {
  const lookup = new Map(catalog.skills.map((skill) => [skill.name, skill.toolResult]));
  return {
    name: 'skill',
    description: 'Load the saved instructions for one project skill listed in the system manifest.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    execute(argumentsValue: JsonValue, context?: ToolExecutionContext): string {
      throwIfCancelled(context?.signal);
      const name = typeof argumentsValue === 'object' && argumentsValue !== null &&
          !Array.isArray(argumentsValue)
        ? (argumentsValue as { readonly name?: JsonValue }).name
        : undefined;
      if (
        typeof argumentsValue !== 'object' || argumentsValue === null ||
        Array.isArray(argumentsValue) || Object.keys(argumentsValue).length !== 1 ||
        typeof name !== 'string' || !IDENTIFIER.test(name)
      ) throw new ToolInputError('expected an object with only a valid skill name');
      const result = lookup.get(name);
      if (result === undefined) throw new Error('skill not found');
      throwIfCancelled(context?.signal);
      return result;
    },
  };
};
