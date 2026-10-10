import { BASH_OUTPUT_DEFAULT_WINDOW_BYTES } from './bash_output.ts';

const TOOL_PREVIEW_HEAD_BYTES = 96;
const TOOL_NAME_BYTES = 64;
/** Byte budgets for one `search` preview element; a possible ellipsis is included. */
const SEARCH_MODE_BYTES = 8;
const SEARCH_PATTERN_BYTES = 38;
const SEARCH_GLOB_BYTES = 23;
const SEARCH_PATH_BYTES = 22;
/** Purpose comments are read from this prefix of generated code, never from the whole body. */
const RUN_TYPESCRIPT_SCAN_BYTES = 2048;
const encoder = new TextEncoder();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedHead = (text: string, limit = TOOL_PREVIEW_HEAD_BYTES): string => {
  let used = 0;
  let result = '';
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (used + size > limit) break;
    result += character;
    used += size;
  }
  return used < encoder.encode(text).byteLength ? `${result}…` : result;
};

/** The tool name exactly as shown in activity text, also used by Host-local styling. */
export const toolActivityName = (name: string): string => boundedHead(name, TOOL_NAME_BYTES);

export const pendingToolActivityText = (name: string, preview = ''): string =>
  preview.length === 0 ? `${toolActivityName(name)} …` : `${toolActivityName(name)} ${preview} …`;

export const settledToolActivityText = (
  name: string,
  outcome: 'success' | 'error',
  preview = '',
): string =>
  preview.length === 0
    ? `${toolActivityName(name)} ${outcome === 'success' ? '✓' : '✗'}`
    : `${toolActivityName(name)} ${preview} ${outcome === 'success' ? '✓' : '✗'}`;

/** Recover the stable call preview when progress and result events no longer carry arguments. */
export const previewFromToolActivityText = (text: string, name: string): string => {
  const base = toolActivityName(name);
  if (!text.startsWith(base)) return '';
  const rest = text.slice(base.length).trim();
  for (const marker of ['…', '✓', '✗']) {
    if (rest.endsWith(marker)) {
      const preview = rest.slice(0, rest.length - marker.length).trim();
      return preview;
    }
  }
  const preview = rest.trim();
  return preview.length === 0 || preview === '…' || preview === '✓' || preview === '✗'
    ? ''
    : preview;
};

const firstLine = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const head = value.split('\n', 1)[0]?.trim() ?? '';
  return head.length === 0 ? undefined : head;
};

/** Keep one element inside its byte budget so the elements after it stay visible. */
const boundedElement = (text: string, budget: number): string =>
  encoder.encode(text).byteLength <= budget ? text : boundedHead(text, budget - 3);

const quotedElement = (text: string, budget: number): string =>
  `"${boundedElement(text, budget - 2)}"`;

/** `mode` first, then the parameters that identify what is being searched. */
const searchPreview = (args: Record<string, unknown>): string | undefined => {
  const mode = firstLine(args.mode);
  if (mode === undefined) return undefined;
  const parts = [boundedElement(mode, SEARCH_MODE_BYTES)];
  const pattern = firstLine(args.pattern);
  if (pattern !== undefined) parts.push(quotedElement(pattern, SEARCH_PATTERN_BYTES));
  const glob = firstLine(args.glob);
  if (glob !== undefined) parts.push(`glob=${quotedElement(glob, SEARCH_GLOB_BYTES - 5)}`);
  const path = firstLine(args.path);
  if (path !== undefined) parts.push(boundedElement(path, SEARCH_PATH_BYTES));
  return parts.join(' ');
};

/** The purpose comment of one scanned line, or undefined when the line is not a `//` comment. */
const purposeComment = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('//')) return undefined;
  const comment = trimmed.slice(2).trim();
  return comment.length === 0 ? undefined : comment;
};

/** The leading purpose comment: the first non-blank line, and only when it is a `//` comment. */
const runTypescriptPreview = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  let line = '';
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (used + size > RUN_TYPESCRIPT_SCAN_BYTES) break;
    used += size;
    if (character !== '\n') {
      line += character;
      continue;
    }
    if (line.trim().length === 0) {
      line = '';
      continue;
    }
    return purposeComment(line);
  }
  return line.trim().length === 0 ? undefined : purposeComment(line);
};

const bashPreview = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const compact = value.trim().replace(/\s+/gu, ' ');
  if (compact.length === 0) return undefined;
  // A later line can change the command even when its first line is identical.
  if (compact === value.trim() && encoder.encode(compact).byteLength <= TOOL_PREVIEW_HEAD_BYTES) {
    return compact;
  }
  let fingerprint = 2166136261;
  for (const byte of encoder.encode(value)) {
    fingerprint = Math.imul(fingerprint ^ byte, 16777619);
  }
  return `${boundedHead(compact, TOOL_PREVIEW_HEAD_BYTES - 16)} #${
    (fingerprint >>> 0).toString(16).padStart(8, '0')
  }`;
};

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const nonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const inclusiveRange = (offset: number, length: number): string =>
  `${offset}–${BigInt(offset) + BigInt(length) - 1n}`;

const readPreview = (args: Record<string, unknown>): string | undefined => {
  const path = firstLine(args.path);
  if (path === undefined) return undefined;
  const hasOffset = Object.hasOwn(args, 'offset');
  const hasLimit = Object.hasOwn(args, 'limit');
  if (!hasOffset && !hasLimit) return path;
  const offset = hasOffset && positiveSafeInteger(args.offset) ? args.offset : 1;
  if (hasOffset && !positiveSafeInteger(args.offset)) return path;
  if (!hasLimit) return `${path} lines ${offset}+`;
  if (!positiveSafeInteger(args.limit)) return path;
  return `${path} lines ${inclusiveRange(offset, args.limit)}`;
};

const bashOutputPreview = (args: Record<string, unknown>): string | undefined => {
  if (args.stream !== 'stdout' && args.stream !== 'stderr') return undefined;
  const hasOffset = Object.hasOwn(args, 'offset');
  const hasLimit = Object.hasOwn(args, 'limit');
  const offset = hasOffset && nonNegativeSafeInteger(args.offset) ? args.offset : 0;
  if (hasOffset && !nonNegativeSafeInteger(args.offset)) return undefined;
  const limit = hasLimit && positiveSafeInteger(args.limit)
    ? args.limit
    : BASH_OUTPUT_DEFAULT_WINDOW_BYTES;
  if (hasLimit && !positiveSafeInteger(args.limit)) return undefined;
  return `${args.stream} bytes ${inclusiveRange(offset, limit)}`;
};

/** Host-visible semantic preview for known tools; unknown tools remain name-only. */
export const toolActivityPreview = (name: string, args: unknown): string => {
  if (!isObject(args)) return '';
  let preview: string | undefined;
  switch (name) {
    case 'bash':
      preview = bashPreview(args.command);
      break;
    case 'read':
      preview = readPreview(args);
      break;
    case 'write':
    case 'edit':
      preview = firstLine(args.path);
      break;
    case 'bash_output':
      preview = bashOutputPreview(args);
      break;
    case 'web_search':
      preview = firstLine(args.query);
      break;
    case 'web_fetch':
      preview = firstLine(args.url);
      break;
    case 'search':
      preview = searchPreview(args);
      break;
    case 'ls':
      preview = [
        args.tree === true ? 'tree' : '',
        firstLine(args.path) ?? '.',
        typeof args.depth === 'number' && Number.isSafeInteger(args.depth) && args.depth >= 0
          ? `depth=${args.depth}`
          : '',
      ]
        .filter(Boolean).join(' ');
      break;
    case 'find':
    case 'grep': {
      const pattern = firstLine(args.pattern);
      const globs = Array.isArray(args.glob)
        ? args.glob.filter((g) => typeof g === 'string').join(',')
        : undefined;
      preview = [
        pattern === undefined ? '' : quotedElement(pattern, SEARCH_PATTERN_BYTES),
        globs ? `glob=${quotedElement(globs, SEARCH_GLOB_BYTES)}` : '',
        boundedElement(firstLine(args.path) ?? '.', SEARCH_PATH_BYTES),
        positiveSafeInteger(args.limit) ? `limit=${args.limit}` : '',
      ].filter(Boolean).join(' ');
      break;
    }
    case 'wc':
      preview = Array.isArray(args.files)
        ? args.files.filter((p) => typeof p === 'string').join(', ')
        : undefined;
      break;
    case 'run_typescript':
      preview = runTypescriptPreview(args.code);
      break;
    case 'skill':
      preview = firstLine(args.name);
      break;
    case 'spawn_subagent':
      preview = [firstLine(args.agent), firstLine(args.task)]
        .filter((part) => part !== undefined).join(' ');
      break;
    default:
      return '';
  }
  return preview === undefined ? '' : boundedHead(preview);
};
