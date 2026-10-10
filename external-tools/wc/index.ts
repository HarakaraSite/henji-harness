import {
  type JsonValue,
  type Tool,
  type ToolFactory,
  ToolInputError,
  type ToolPathPolicy,
  TurnCancelledError,
} from '@henji/tool';
import { relative, sep } from 'node:path';

const RESULT_BYTES = 1024 * 1024;
const RESULT_RESERVE_BYTES = 256;
const READ_BUFFER_BYTES = 64 * 1024;
const encoder = new TextEncoder();

interface WcArguments {
  readonly files: readonly string[];
  readonly offset: number;
  readonly limit: number;
}

interface FileCounts {
  readonly path: string;
  readonly lines: number;
  readonly words: number;
  readonly bytes: number;
}

interface WcTotals {
  lines: number;
  words: number;
  bytes: number;
}

interface WcPayload {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  readonly pageTotals: WcTotals;
  readonly totals: WcTotals;
  readonly records: FileCounts[];
  readonly omitted: { bytes: boolean };
}

interface PreparedFile {
  readonly absolutePath: string;
  readonly displayPath: string;
}

const schema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        description: 'An explicitly selected file path under the configured tool allow paths.',
      },
      description:
        'Required explicit file paths. Pass one file as a one-element array. Directories are not expanded.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Zero-based offset into the per-file records; defaults to 0.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum per-file records to return; defaults to 100 and has no fixed maximum.',
    },
  },
  required: ['files'],
  additionalProperties: false,
} as const;

const asObject = (value: JsonValue): Record<string, JsonValue> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolInputError('wc expects an object');
  }
  return value as Record<string, JsonValue>;
};

const parseArguments = (value: JsonValue): WcArguments => {
  const args = asObject(value);
  const allowed = new Set(['files', 'offset', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new ToolInputError('wc received an unknown argument');
  }
  if (!Array.isArray(args.files) || args.files.some((path) => typeof path !== 'string')) {
    throw new ToolInputError('files must be an array of file paths');
  }
  if (args.files.some((path) => path.length === 0)) {
    throw new ToolInputError('files must contain non-empty file paths');
  }
  if (
    args.offset !== undefined &&
    (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0)
  ) throw new ToolInputError('offset must be a non-negative safe integer');
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1)
  ) throw new ToolInputError('limit must be a positive safe integer');

  return {
    files: args.files as string[],
    offset: typeof args.offset === 'number' ? args.offset : 0,
    limit: typeof args.limit === 'number' ? args.limit : 100,
  };
};

const workspaceRelative = (root: string, target: string): string => {
  const path = relative(root, target).split(sep).join('/');
  return path || '.';
};

const prepareFiles = async (
  root: string,
  files: readonly string[],
  pathPolicy: ToolPathPolicy,
): Promise<PreparedFile[]> => {
  const prepared: PreparedFile[] = [];
  for (const path of files) {
    const absolutePath = await pathPolicy.resolve(path, { followSymlinks: false });
    await pathPolicy.resolve(path);
    const info = await Deno.stat(absolutePath);
    if (!info.isFile) throw new ToolInputError(`wc files must name files: ${path}`);
    prepared.push({
      absolutePath,
      displayPath: workspaceRelative(root, absolutePath),
    });
  }
  return prepared;
};

const countFile = async (file: PreparedFile, signal?: AbortSignal): Promise<FileCounts> => {
  if (signal?.aborted) throw new TurnCancelledError();
  const handle = await Deno.open(file.absolutePath, { read: true });
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const buffer = new Uint8Array(READ_BUFFER_BYTES);
  let lines = 0;
  let words = 0;
  let bytes = 0;
  let inWord = false;

  const countWords = (text: string): void => {
    for (const segment of text.matchAll(/(\p{White_Space}+)|([^\p{White_Space}]+)/gu)) {
      if (segment[1] !== undefined) inWord = false;
      else {
        if (!inWord) words += 1;
        inWord = true;
      }
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new TurnCancelledError();
      const read = await handle.read(buffer);
      if (read === null) break;
      bytes += read;
      const chunk = buffer.subarray(0, read);
      for (const byte of chunk) if (byte === 10) lines += 1;
      countWords(decoder.decode(chunk, { stream: true }));
    }
    countWords(decoder.decode());
  } finally {
    handle.close();
  }

  return { path: file.displayPath, lines, words, bytes };
};

const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const createWcTool = (input: Parameters<ToolFactory>[0]): Tool => ({
  name: 'wc',
  fileAccess: 'read',
  description: [
    'Count lines, words, and raw bytes in explicitly named files. files is required and must be an array, including for one file; directories are not expanded. Each file is read as a stream, so large files are counted without loading them into memory. Paths use this tool’s configured allow paths (default allow is /); common-denied files are rejected.',
    'lines counts LF bytes (a trailing partial line is not counted). words are non-empty text runs separated by Unicode White_Space. bytes counts raw file bytes, independent of UTF-8 decoding. Invalid UTF-8 is decoded with replacement characters for word counting.',
    'totals covers every file in files, even when offset/limit page the per-file records. pageTotals sums only the records returned on this page. offset defaults to 0 and limit to 100 with no fixed maximum. The result is limited to 1 MiB; omitted.bytes reports when that output budget shortened the returned records. totals remain complete.',
    'Examples: {"files":["README.md"]}, {"files":["src/a.ts","src/b.ts"],"offset":100,"limit":100}.',
  ].join('\n\n'),
  inputSchema: schema,
  promptGuidelines: [
    'Use wc for line, word, and byte counts of explicitly selected files. Always provide files as an array, including a single path. Do not use it to recursively count a directory; choose the file paths first.',
    'Read totals for the complete files array and pageTotals for the current per-file records. lines count LF, words split on Unicode White_Space, and bytes are raw bytes. If omitted.bytes is true, totals are still complete but some per-file records were not returned.',
  ],
  async execute(argumentsValue, context) {
    const args = parseArguments(argumentsValue);
    const root = await Deno.realPath(input.workspace.root);
    const files = await prepareFiles(root, args.files, input.pathPolicy);
    const totals = { lines: 0, words: 0, bytes: 0 };
    const records: FileCounts[] = [];
    const payload: WcPayload = {
      offset: args.offset,
      limit: args.limit,
      total: files.length,
      returned: 0,
      hasMore: false,
      nextOffset: null,
      pageTotals: { lines: 0, words: 0, bytes: 0 },
      totals,
      records,
      omitted: { bytes: false },
    };
    let serializedBytes = jsonBytes(payload);
    let byteOmitted = false;

    for (let index = 0; index < files.length; index += 1) {
      const counts = await countFile(files[index]!, context?.signal);
      totals.lines += counts.lines;
      totals.words += counts.words;
      totals.bytes += counts.bytes;

      if (index < args.offset || index >= args.offset + args.limit || byteOmitted) continue;
      const recordBytes = jsonBytes(counts) + (records.length === 0 ? 0 : 1);
      if (serializedBytes + recordBytes + RESULT_RESERVE_BYTES > RESULT_BYTES) {
        byteOmitted = true;
        payload.omitted.bytes = true;
        continue;
      }
      records.push(counts);
      serializedBytes += recordBytes;
      payload.pageTotals.lines += counts.lines;
      payload.pageTotals.words += counts.words;
      payload.pageTotals.bytes += counts.bytes;
    }

    payload.returned = records.length;
    const next = args.offset + records.length;
    payload.hasMore = next < files.length;
    payload.nextOffset = payload.hasMore ? next : null;
    const result = JSON.stringify(payload);
    if (encoder.encode(result).byteLength > RESULT_BYTES) {
      throw new Error('wc result exceeded its byte budget');
    }
    return result;
  },
});

const factory: ToolFactory = (input) => createWcTool(input);

export default factory;
