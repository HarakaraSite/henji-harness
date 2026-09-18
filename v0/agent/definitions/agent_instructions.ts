const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The maximum accepted UTF-8 instruction size, in bytes. */
export const MAX_AGENT_INSTRUCTION_BYTES = 16 * 1024;
const MAX_OBSERVED_BYTES = MAX_AGENT_INSTRUCTION_BYTES + 1;
const CANDIDATE_NAMES = ['AGENTS.md', 'AGENTS.MD'] as const;

export type AgentInstructionSource = (typeof CANDIDATE_NAMES)[number];

/** One filesystem read projected into a source/text snapshot for runtime consumers. */
export interface AgentInstructionSnapshot {
  readonly source: AgentInstructionSource;
  readonly text: string;
  readonly formatted: string;
}

export interface InstructionFileInfo {
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

export interface InstructionFileHandle {
  read(buffer: Uint8Array): Promise<number | null>;
  stat(): Promise<InstructionFileInfo>;
  close(): void;
}

/** A small filesystem seam keeps direct discovery tests permission-free. */
export interface InstructionFileSystem {
  lstat(path: string): Promise<InstructionFileInfo>;
  open(path: string): Promise<InstructionFileHandle>;
}

const productionFileSystem: InstructionFileSystem = {
  async lstat(path) {
    const info = await Deno.lstat(path);
    return { isFile: info.isFile, isSymlink: info.isSymlink };
  },
  async open(path) {
    const file = await Deno.open(path, { read: true });
    return {
      read: (buffer) => file.read(buffer),
      stat: async () => {
        const info = await file.stat();
        return { isFile: info.isFile, isSymlink: info.isSymlink };
      },
      close: () => file.close(),
    };
  },
};

const normalizedAbsolute = (root: string): string => {
  const parts: string[] = [];
  for (const part of root.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
};

const candidatePath = (root: string, name: string): string => {
  const normalized = normalizedAbsolute(root);
  return normalized === '/' ? `/${name}` : `${normalized}/${name}`;
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const readBounded = async (file: InstructionFileHandle): Promise<Uint8Array | undefined> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = MAX_OBSERVED_BYTES - total;
      if (remaining <= 0) return undefined;
      const chunk = new Uint8Array(Math.min(8192, remaining));
      const count = await file.read(chunk);
      if (count === null) break;
      if (!Number.isInteger(count) || count < 0 || count > chunk.byteLength) return undefined;
      if (count === 0) break;
      chunks.push(chunk.slice(0, count));
      total += count;
      if (total > MAX_AGENT_INSTRUCTION_BYTES) return undefined;
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readCandidate = async (
  fileSystem: InstructionFileSystem,
  path: string,
  info: InstructionFileInfo,
): Promise<string | undefined> => {
  if (!info.isFile || info.isSymlink) return undefined;

  let file: InstructionFileHandle;
  try {
    file = await fileSystem.open(path);
  } catch {
    return undefined;
  }
  try {
    let openedInfo: InstructionFileInfo;
    try {
      openedInfo = await file.stat();
    } catch {
      return undefined;
    }
    if (!openedInfo.isFile || openedInfo.isSymlink) return undefined;
    const bytes = await readBounded(file);
    if (bytes === undefined) return undefined;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      return undefined;
    }
    if (text.includes('\0') || !hasWellFormedUnicode(text)) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0 || encoder.encode(trimmed).byteLength > MAX_AGENT_INSTRUCTION_BYTES) {
      return undefined;
    }
    return trimmed;
  } finally {
    try {
      file.close();
    } catch {
      // Best effort close; discovery remains silent on filesystem failures.
    }
  }
};

const formatAgentInstruction = (name: string, content: string): string =>
  `Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./${name}\n\n${content}`;

/**
 * Discover one optional workspace-root instruction and retain the accepted source/text exactly
 * once. The formatted system instruction is derived from that same snapshot.
 */
export const discoverAgentInstructionSnapshot = async (
  workspaceRoot: string,
  fileSystem: InstructionFileSystem = productionFileSystem,
): Promise<AgentInstructionSnapshot | undefined> => {
  const root = normalizedAbsolute(workspaceRoot);
  const seen = new Set<string>();
  for (const name of CANDIDATE_NAMES) {
    const path = candidatePath(root, name);
    if (seen.has(path)) continue;
    seen.add(path);
    let present = true;
    let info: InstructionFileInfo | undefined;
    try {
      info = await fileSystem.lstat(path);
      if (!info.isFile || info.isSymlink) return undefined;
    } catch (error) {
      if (isNotFound(error)) {
        present = false;
      } else {
        return undefined;
      }
    }
    if (!present || info === undefined) continue;
    const content = await readCandidate(fileSystem, path, info);
    if (content === undefined) return undefined;
    return Object.freeze({
      source: name,
      text: content,
      formatted: formatAgentInstruction(name, content),
    });
  }
  return undefined;
};
