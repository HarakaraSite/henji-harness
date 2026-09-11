import { BASH_OUTPUT_DEFAULT_WINDOW_BYTES } from './bash_output.ts';

const TOOL_PREVIEW_HEAD_BYTES = 96;
const TOOL_NAME_BYTES = 64;
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

const shortToolName = (name: string): string => boundedHead(name, TOOL_NAME_BYTES);

export const pendingToolActivityText = (name: string, preview = ''): string =>
  preview.length === 0 ? `${shortToolName(name)} …` : `${shortToolName(name)} ${preview} …`;

export const settledToolActivityText = (
  name: string,
  outcome: 'success' | 'error',
  preview = '',
): string =>
  preview.length === 0
    ? `${shortToolName(name)} ${outcome === 'success' ? '✓' : '✗'}`
    : `${shortToolName(name)} ${preview} ${outcome === 'success' ? '✓' : '✗'}`;

/** Recover the stable call preview when progress and result events no longer carry arguments. */
export const previewFromToolActivityText = (text: string, name: string): string => {
  const base = shortToolName(name);
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
      preview = firstLine(args.command);
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
    case 'skill':
      preview = firstLine(args.name);
      break;
    default:
      return '';
  }
  return preview === undefined ? '' : boundedHead(preview);
};
