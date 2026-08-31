const MAX_VISITED_ENTRIES = 4_096;
const MAX_FILES = 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const encoder = new TextEncoder();

export interface FileReferenceEntry {
  readonly name: string;
  readonly isFile?: boolean;
  readonly isDirectory?: boolean;
  readonly isSymlink?: boolean;
}

export interface FileReferenceStat {
  readonly isFile?: boolean;
  readonly isDirectory?: boolean;
  readonly isSymlink?: boolean;
  readonly dev?: number | bigint;
  readonly ino?: number | bigint | null;
}

export interface FileReferenceFs {
  realPath(path: string): string | Promise<string>;
  readDir(
    path: string,
  ):
    | Iterable<FileReferenceEntry>
    | AsyncIterable<FileReferenceEntry>
    | Promise<Iterable<FileReferenceEntry> | AsyncIterable<FileReferenceEntry>>;
  lstat(path: string): FileReferenceStat | Promise<FileReferenceStat>;
}

export interface FileReferenceCandidate {
  readonly path: string;
}

export type PathCompletionResult =
  | { readonly kind: 'inserted'; readonly text: string; readonly replacement: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly count: number }
  | { readonly kind: 'incomplete' };

export interface FileReferenceIndexSnapshot {
  readonly complete: boolean;
  readonly candidates: readonly FileReferenceCandidate[];
  readonly visitedEntries: number;
  readonly totalBytes: number;
}

const byteCompare = (a: string, b: string): number => {
  const left = encoder.encode(a), right = encoder.encode(b);
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};
const pathBytes = (value: string): number => encoder.encode(value).byteLength;
const isWellFormed = (value: string): boolean => {
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

/** JSON-string escaping is safe for terminal insertion and includes controls and bidi marks. */
export const escapeFileReference = (path: string): string => {
  let out = '';
  for (const character of path) {
    const code = character.codePointAt(0)!;
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isBidi(code)) {
      out += `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
    } else out += character;
  }
  return out;
};
const isBidi = (code: number): boolean =>
  code === 0x061c || (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

export const quoteFileReference = (path: string): string => `"${escapeFileReference(path)}"`;

class DenoFileReferenceFs implements FileReferenceFs {
  realPath(path: string): Promise<string> {
    return Deno.realPath(path);
  }
  readDir(path: string): AsyncIterable<FileReferenceEntry> {
    return Deno.readDir(path);
  }
  async lstat(path: string): Promise<FileReferenceStat> {
    return await Deno.lstat(path) as unknown as FileReferenceStat;
  }
}

/** Immutable bounded workspace-relative path index. It never reads file contents. */
export class WorkspacePathIndex {
  constructor(
    private readonly root: string,
    private readonly snapshotValue: FileReferenceIndexSnapshot,
  ) {}

  static empty(root = ''): WorkspacePathIndex {
    return new WorkspacePathIndex(
      root,
      Object.freeze({
        complete: true,
        candidates: Object.freeze([]),
        visitedEntries: 0,
        totalBytes: 0,
      }),
    );
  }
  static incomplete(root = ''): WorkspacePathIndex {
    return new WorkspacePathIndex(
      root,
      Object.freeze({
        complete: false,
        candidates: Object.freeze([]),
        visitedEntries: 0,
        totalBytes: 0,
      }),
    );
  }
  static fromCandidates(candidates: readonly string[], root = ''): WorkspacePathIndex {
    const accepted = candidates.filter(validCandidate).map((path) => ({ path })).sort((a, b) =>
      byteCompare(a.path, b.path)
    );
    const totalBytes = accepted.reduce((sum, item) => sum + pathBytes(item.path), 0);
    if (accepted.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
      return WorkspacePathIndex.incomplete(root);
    }
    return new WorkspacePathIndex(
      root,
      Object.freeze({
        complete: true,
        candidates: Object.freeze(accepted.map((item) => Object.freeze(item))),
        visitedEntries: accepted.length,
        totalBytes,
      }),
    );
  }
  get rootPath(): string {
    return this.root;
  }
  get complete(): boolean {
    return this.snapshotValue.complete;
  }
  get candidates(): readonly FileReferenceCandidate[] {
    return this.snapshotValue.candidates;
  }
  snapshot(): FileReferenceIndexSnapshot {
    return this.snapshotValue;
  }
  completePath(fragment: string): PathCompletionResult {
    if (
      !this.complete || typeof fragment !== 'string' || fragment.length === 0 ||
      fragment.startsWith('/') || fragment.includes('\0')
    ) return !this.complete ? { kind: 'incomplete' } : { kind: 'none' };
    const normalized = fragment.startsWith('./') ? fragment.slice(2) : fragment;
    if (
      normalized.length === 0 ||
      normalized.split('/').some((part) => part === '.' || part === '..')
    ) {
      return { kind: 'none' };
    }
    const matches = this.candidates.filter((item) => item.path.startsWith(normalized));
    if (matches.length === 0) return { kind: 'none' };
    if (matches.length !== 1) return { kind: 'ambiguous', count: matches.length };
    const value = quoteFileReference(`./${matches[0].path}`);
    return { kind: 'inserted', text: value, replacement: value };
  }
  match(fragment: string): PathCompletionResult {
    return this.completePath(fragment);
  }
}

interface MutableScan {
  readonly candidates: string[];
  visited: number;
  totalBytes: number;
  complete: boolean;
}

const join = (root: string, relative: string): string =>
  relative.length === 0 ? root : `${root}/${relative}`;
const validCandidate = (path: string): boolean =>
  isWellFormed(path) && path.length > 0 && !path.includes('\0') && !path.startsWith('/') &&
  !path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') &&
  pathBytes(path) <= MAX_PATH_BYTES;
const entries = async function* (
  value: Iterable<FileReferenceEntry> | AsyncIterable<FileReferenceEntry>,
): AsyncGenerator<FileReferenceEntry> {
  if (Symbol.asyncIterator in Object(value)) {
    for await (const entry of value as AsyncIterable<FileReferenceEntry>) {
      yield entry;
    }
  } else for (const entry of value as Iterable<FileReferenceEntry>) yield entry;
};

const sameIdentity = (left: FileReferenceStat, right: FileReferenceStat): boolean =>
  left.isSymlink === right.isSymlink &&
  (left.isDirectory === undefined || right.isDirectory === undefined ||
    left.isDirectory === right.isDirectory) &&
  (left.isFile === undefined || right.isFile === undefined || left.isFile === right.isFile) &&
  (left.dev === undefined || right.dev === undefined || left.dev === right.dev) &&
  (left.ino === undefined || right.ino === undefined || left.ino === right.ino);

export async function buildWorkspacePathIndex(
  root: string,
  filesystem: FileReferenceFs = new DenoFileReferenceFs(),
): Promise<WorkspacePathIndex> {
  const scan: MutableScan = { candidates: [], visited: 0, totalBytes: 0, complete: true };
  let canonical: string;
  let initial: FileReferenceStat;
  try {
    canonical = await filesystem.realPath(root);
    initial = await filesystem.lstat(canonical);
  } catch {
    return WorkspacePathIndex.incomplete(root);
  }
  if (initial.isSymlink || initial.isDirectory === false) {
    return WorkspacePathIndex.incomplete(canonical);
  }

  const visit = async (
    directory: string,
    relative: string,
    depth: number,
    knownStat?: FileReferenceStat,
  ): Promise<void> => {
    if (!scan.complete) return;
    if (depth > MAX_DEPTH) {
      scan.complete = false;
      return;
    }
    let before: FileReferenceStat;
    let listed: FileReferenceEntry[];
    try {
      before = knownStat ?? await filesystem.lstat(directory);
      if (before.isSymlink || before.isDirectory !== true) {
        scan.complete = false;
        return;
      }
      listed = [];
      for await (const entry of entries(await filesystem.readDir(directory))) {
        // Root-private names are excluded before the global budget and before any child lstat or
        // traversal. The iterator is stopped as soon as the remaining entry budget is spent;
        // no unbounded directory listing may accumulate in memory.
        if (relative.length === 0 && (entry.name === '.git' || entry.name === '_refs')) continue;
        if (scan.visited + listed.length >= MAX_VISITED_ENTRIES) {
          scan.complete = false;
          break;
        }
        listed.push(entry);
      }
      const after = await filesystem.lstat(directory);
      if (
        after.isSymlink || after.isDirectory !== true || !sameIdentity(before, after)
      ) {
        scan.complete = false;
        return;
      }
    } catch {
      scan.complete = false;
      return;
    }
    listed.sort((a, b) => byteCompare(a.name, b.name));
    for (const entry of listed) {
      if (!scan.complete) return;
      // Exclusions happen on the root listing before any lstat/read/traversal.
      if (relative.length === 0 && (entry.name === '.git' || entry.name === '_refs')) continue;
      scan.visited += 1;
      if (scan.visited > MAX_VISITED_ENTRIES) {
        scan.complete = false;
        return;
      }
      if (
        !isWellFormed(entry.name) || entry.name.includes('\0') || entry.name === '.' ||
        entry.name === '..' || entry.name.includes('/')
      ) continue;
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (pathBytes(childRelative) > MAX_PATH_BYTES) {
        scan.complete = false;
        return;
      }
      let stat: FileReferenceStat;
      try {
        stat = await filesystem.lstat(join(canonical, childRelative));
      } catch {
        scan.complete = false;
        return;
      }
      if (stat.isSymlink || entry.isSymlink) continue;
      if (stat.isDirectory || entry.isDirectory) {
        await visit(join(canonical, childRelative), childRelative, depth + 1, stat);
        continue;
      }
      if (!(stat.isFile || entry.isFile)) continue;
      if (scan.candidates.length >= MAX_FILES) {
        scan.complete = false;
        return;
      }
      scan.candidates.push(childRelative);
      scan.totalBytes += pathBytes(childRelative);
      if (scan.totalBytes > MAX_TOTAL_BYTES) {
        scan.complete = false;
        return;
      }
    }
  };
  await visit(canonical, '', 0, initial);
  try {
    const ending = await filesystem.lstat(canonical);
    if (!sameIdentity(initial, ending)) scan.complete = false;
    const endingRoot = await filesystem.realPath(canonical);
    if (endingRoot !== canonical) scan.complete = false;
  } catch {
    scan.complete = false;
  }
  if (!scan.complete) return WorkspacePathIndex.incomplete(canonical);
  return new WorkspacePathIndex(
    canonical,
    Object.freeze({
      complete: true,
      candidates: Object.freeze(scan.candidates.map((path) => Object.freeze({ path }))),
      visitedEntries: scan.visited,
      totalBytes: scan.totalBytes,
    }),
  );
}

export const createWorkspacePathIndex = buildWorkspacePathIndex;
export const FILE_REFERENCE_MAX_VISITED = MAX_VISITED_ENTRIES;
export const FILE_REFERENCE_MAX_FILES = MAX_FILES;
export const FILE_REFERENCE_MAX_PATH_BYTES = MAX_PATH_BYTES;
export const FILE_REFERENCE_MAX_TOTAL_BYTES = MAX_TOTAL_BYTES;
export const FILE_REFERENCE_MAX_DEPTH = MAX_DEPTH;
