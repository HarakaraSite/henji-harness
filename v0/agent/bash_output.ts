import { type Tool, ToolInputError } from './tools.ts';
import type { JsonValue } from './contracts.ts';

export type BashOutputStream = 'stdout' | 'stderr';

export const BASH_OUTPUT_COMMAND_LIMIT_BYTES = 32 * 1024 * 1024;
export const BASH_OUTPUT_REGISTRY_LIMIT_BYTES = 128 * 1024 * 1024;
export const BASH_OUTPUT_RETAINED_STREAM_LIMIT = 4_096;
export const BASH_OUTPUT_SEGMENT_BYTES = 64 * 1024;
export const BASH_OUTPUT_DEFAULT_WINDOW_BYTES = 49_152;
export const BASH_OUTPUT_MIN_WINDOW_BYTES = 4;
export const BASH_OUTPUT_MAX_WINDOW_BYTES = 49_152;

export type BashOutputLimitReason =
  | 'command_bytes'
  | 'registry_bytes'
  | 'retained_streams';

export interface BashOutputLimitSnapshot {
  readonly reason: BashOutputLimitReason;
  readonly commandBytes: number;
  readonly commandLimitBytes: number;
  readonly registryBytes: number;
  readonly registryLimitBytes: number;
  readonly retainedStreams: number;
  readonly retainedStreamLimit: number;
}

export interface BashOutputAppendResult {
  readonly storedBytes: number;
  readonly limit?: BashOutputLimitSnapshot;
}

export interface BashOutputCommandSummary {
  readonly outputId?: string;
  readonly streams: Readonly<Partial<Record<BashOutputStream, number>>>;
  readonly commandBytes: number;
  readonly registryBytes: number;
  readonly retainedStreams: number;
  readonly limit?: BashOutputLimitSnapshot;
  readonly available: boolean;
}

export interface BashOutputWindow {
  readonly outputId: string;
  readonly stream: BashOutputStream;
  readonly offset: number;
  readonly text: string;
  readonly nextOffset: number | null;
  readonly complete: boolean;
  readonly totalBytes: number;
}

export interface BashOutputCommandCapture {
  readonly outputId: string;
  append(
    stream: BashOutputStream,
    text: string,
  ): Promise<BashOutputAppendResult>;
  finish(): Promise<BashOutputCommandSummary>;
  summary(): Promise<BashOutputCommandSummary>;
  abandon(): Promise<void>;
}

export interface BashOutputStore {
  beginCommand(): BashOutputCommandCapture;
  read(
    outputId: string,
    stream: BashOutputStream,
    offset: number,
    limit: number,
  ): Promise<BashOutputWindow>;
  close(): Promise<void>;
}

export class BashOutputPersistenceError extends Error {
  constructor() {
    super('bash output persistence failed');
    this.name = 'BashOutputPersistenceError';
  }
}

export class BashOutputReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BashOutputReadError';
  }
}

interface BashOutputExtent {
  readonly logicalOffset: number;
  fileOffset: number;
  readonly length: number;
}

interface BashOutputStreamRecord {
  readonly stream: BashOutputStream;
  readonly extents: BashOutputExtent[];
  buffer: Uint8Array;
  totalBytes: number;
  persistedBytes: number;
}

interface BashOutputCommandRecord {
  readonly outputId: string;
  readonly streams: Map<BashOutputStream, BashOutputStreamRecord>;
  commandBytes: number;
  finalized: boolean;
  failed: boolean;
  limit?: BashOutputLimitSnapshot;
}

interface BashOutputStoreLimits {
  readonly commandBytes: number;
  readonly registryBytes: number;
  readonly retainedStreams: number;
  readonly segmentBytes: number;
}

export interface BashOutputStoreDiagnostics {
  readonly registryBytes: number;
  readonly retainedStreams: number;
  readonly extents: number;
  readonly openHandles: number;
}

export interface BashOutputStoreTestOptions {
  readonly limits?: Partial<BashOutputStoreLimits>;
  readonly onSpoolOpened?: (path: string) => void | Promise<void>;
  readonly beforeWrite?: () => void | Promise<void>;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const encoder = new TextEncoder();
const fatalDecoder = (): TextDecoder => new TextDecoder('utf-8', { fatal: true });

const validPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
};

const scalarBoundaryPrefix = (
  bytes: Uint8Array,
  maximum: number,
): Uint8Array => {
  let end = Math.min(bytes.byteLength, maximum);
  if (end === bytes.byteLength) return bytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
};

const writeAll = async (
  file: Deno.FsFile,
  bytes: Uint8Array,
): Promise<void> => {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = await file.write(bytes.subarray(written));
    if (count <= 0) throw new Error('temporary output write made no progress');
    written += count;
  }
};

const readAll = async (file: Deno.FsFile, bytes: Uint8Array): Promise<void> => {
  let read = 0;
  while (read < bytes.byteLength) {
    const count = await file.read(bytes.subarray(read));
    if (count === null || count <= 0) {
      throw new Error('temporary output ended unexpectedly');
    }
    read += count;
  }
};

class DenoBashOutputStore implements BashOutputStore {
  private readonly mutex = new AsyncMutex();
  private readonly commands = new Map<string, BashOutputCommandRecord>();
  private readonly limits: BashOutputStoreLimits;
  private readonly onSpoolOpened?: (path: string) => void | Promise<void>;
  private readonly beforeWrite?: () => void | Promise<void>;
  private file?: Deno.FsFile;
  private fileOffset = 0;
  private registryBytes = 0;
  private retainedStreams = 0;
  private closed = false;

  constructor(options: BashOutputStoreTestOptions = {}) {
    this.limits = {
      commandBytes: options.limits?.commandBytes ??
        BASH_OUTPUT_COMMAND_LIMIT_BYTES,
      registryBytes: options.limits?.registryBytes ??
        BASH_OUTPUT_REGISTRY_LIMIT_BYTES,
      retainedStreams: options.limits?.retainedStreams ??
        BASH_OUTPUT_RETAINED_STREAM_LIMIT,
      segmentBytes: options.limits?.segmentBytes ?? BASH_OUTPUT_SEGMENT_BYTES,
    };
    if (
      !validPositiveInteger(this.limits.commandBytes) ||
      !validPositiveInteger(this.limits.registryBytes) ||
      !validPositiveInteger(this.limits.retainedStreams) ||
      !validPositiveInteger(this.limits.segmentBytes)
    ) {
      throw new RangeError(
        'bash output store limits must be positive integers',
      );
    }
    this.onSpoolOpened = options.onSpoolOpened;
    this.beforeWrite = options.beforeWrite;
  }

  beginCommand(): BashOutputCommandCapture {
    if (this.closed) throw new BashOutputPersistenceError();
    const state: BashOutputCommandRecord = {
      outputId: crypto.randomUUID(),
      streams: new Map(),
      commandBytes: 0,
      finalized: false,
      failed: false,
    };
    this.commands.set(state.outputId, state);
    return Object.freeze({
      outputId: state.outputId,
      append: (stream: BashOutputStream, text: string) => this.append(state, stream, text),
      finish: () => this.finish(state),
      summary: () => this.summary(state),
      abandon: () => this.abandon(state),
    });
  }

  async read(
    outputId: string,
    stream: BashOutputStream,
    offset: number,
    limit: number,
  ): Promise<BashOutputWindow> {
    return await this.mutex.run(async () => {
      const command = this.commands.get(outputId);
      const record = command?.streams.get(stream);
      if (!command || command.failed || !command.finalized) {
        throw new BashOutputReadError('unknown or unavailable bash outputId');
      }
      if (!record) {
        throw new BashOutputReadError('bash output stream was not retained');
      }
      if (
        !Number.isSafeInteger(offset) || offset < 0 ||
        offset > record.totalBytes
      ) {
        throw new BashOutputReadError('bash output offset is out of range');
      }
      if (offset < record.totalBytes) {
        const first = await this.readRecordRange(record, offset, 1);
        if ((first[0] & 0xc0) === 0x80) {
          throw new BashOutputReadError(
            'bash output offset is not a UTF-8 boundary',
          );
        }
      }
      const requested = Math.min(limit, record.totalBytes - offset);
      let selected = await this.readRecordRange(record, offset, requested);
      if (offset + selected.byteLength < record.totalBytes) {
        for (;;) {
          try {
            fatalDecoder().decode(selected);
            break;
          } catch {
            if (selected.byteLength === 0) {
              throw new BashOutputPersistenceError();
            }
            selected = selected.subarray(0, selected.byteLength - 1);
          }
        }
      }
      let text: string;
      try {
        text = fatalDecoder().decode(selected);
      } catch {
        throw new BashOutputPersistenceError();
      }
      const next = offset + selected.byteLength;
      const complete = next === record.totalBytes;
      return Object.freeze({
        outputId,
        stream,
        offset,
        text,
        nextOffset: complete ? null : next,
        complete,
        totalBytes: record.totalBytes,
      });
    });
  }

  async close(): Promise<void> {
    await this.mutex.run(() => {
      if (this.closed) return;
      this.closed = true;
      this.file?.close();
      this.file = undefined;
    });
  }

  async diagnostics(): Promise<BashOutputStoreDiagnostics> {
    return await this.mutex.run(() =>
      Object.freeze({
        registryBytes: this.registryBytes,
        retainedStreams: this.retainedStreams,
        extents: [...this.commands.values()].reduce(
          (total, command) =>
            total + [...command.streams.values()].reduce(
              (sum, stream) => sum + stream.extents.length,
              0,
            ),
          0,
        ),
        openHandles: this.file === undefined ? 0 : 1,
      })
    );
  }

  private async append(
    command: BashOutputCommandRecord,
    stream: BashOutputStream,
    text: string,
  ): Promise<BashOutputAppendResult> {
    try {
      return await this.mutex.run(async () => {
        if (this.closed || command.failed || command.finalized) {
          throw new BashOutputPersistenceError();
        }
        if (command.limit !== undefined || text.length === 0) {
          return Object.freeze({
            storedBytes: 0,
            ...(command.limit ? { limit: command.limit } : {}),
          });
        }
        const bytes = encoder.encode(text);
        const commandRemaining = this.limits.commandBytes -
          command.commandBytes;
        const registryRemaining = this.limits.registryBytes -
          this.registryBytes;
        const available = Math.min(commandRemaining, registryRemaining);
        if (available <= 0) {
          command.limit = this.limitSnapshot(
            command,
            commandRemaining <= registryRemaining ? 'command_bytes' : 'registry_bytes',
          );
          return Object.freeze({ storedBytes: 0, limit: command.limit });
        }
        let record = command.streams.get(stream);
        if (!record && this.retainedStreams >= this.limits.retainedStreams) {
          command.limit = this.limitSnapshot(command, 'retained_streams');
          return Object.freeze({ storedBytes: 0, limit: command.limit });
        }
        const accepted = scalarBoundaryPrefix(bytes, available);
        if (accepted.byteLength > 0) {
          if (!record) {
            record = {
              stream,
              extents: [],
              buffer: new Uint8Array(),
              totalBytes: 0,
              persistedBytes: 0,
            };
            command.streams.set(stream, record);
            this.retainedStreams += 1;
          }
          command.commandBytes += accepted.byteLength;
          this.registryBytes += accepted.byteLength;
          record.totalBytes += accepted.byteLength;
          await this.appendRecord(record, accepted);
        }
        if (accepted.byteLength < bytes.byteLength) {
          command.limit = this.limitSnapshot(
            command,
            commandRemaining <= registryRemaining ? 'command_bytes' : 'registry_bytes',
          );
        }
        return Object.freeze({
          storedBytes: accepted.byteLength,
          ...(command.limit ? { limit: command.limit } : {}),
        });
      });
    } catch {
      await this.markFailed(command);
      throw new BashOutputPersistenceError();
    }
  }

  private async finish(
    command: BashOutputCommandRecord,
  ): Promise<BashOutputCommandSummary> {
    try {
      return await this.mutex.run(async () => {
        if (this.closed || command.failed) {
          throw new BashOutputPersistenceError();
        }
        if (!command.finalized) {
          for (const record of command.streams.values()) {
            await this.flush(record);
          }
          command.finalized = true;
        }
        const summary = this.summaryLocked(command);
        if (command.streams.size === 0) this.commands.delete(command.outputId);
        return summary;
      });
    } catch {
      await this.markFailed(command);
      throw new BashOutputPersistenceError();
    }
  }

  private async summary(
    command: BashOutputCommandRecord,
  ): Promise<BashOutputCommandSummary> {
    return await this.mutex.run(() => this.summaryLocked(command));
  }

  private async abandon(command: BashOutputCommandRecord): Promise<void> {
    try {
      await this.mutex.run(async () => {
        if (!this.commands.has(command.outputId)) return;
        if (this.closed || command.failed) {
          throw new BashOutputPersistenceError();
        }

        this.commands.delete(command.outputId);
        this.registryBytes -= command.commandBytes;
        this.retainedStreams -= command.streams.size;
        await this.compactFile();

        command.failed = true;
        command.finalized = true;
        command.streams.clear();
      });
    } catch {
      throw new BashOutputPersistenceError();
    }
  }

  private summaryLocked(
    command: BashOutputCommandRecord,
  ): BashOutputCommandSummary {
    const streams: Partial<Record<BashOutputStream, number>> = {};
    if (!command.failed) {
      for (const [stream, record] of command.streams) {
        streams[stream] = record.totalBytes;
      }
    }
    const available = !command.failed && command.finalized &&
      command.streams.size > 0;
    return Object.freeze({
      ...(available ? { outputId: command.outputId } : {}),
      streams: Object.freeze(streams),
      commandBytes: command.commandBytes,
      registryBytes: this.registryBytes,
      retainedStreams: this.retainedStreams,
      ...(command.limit ? { limit: command.limit } : {}),
      available,
    });
  }

  private limitSnapshot(
    command: BashOutputCommandRecord,
    reason: BashOutputLimitReason,
  ): BashOutputLimitSnapshot {
    return Object.freeze({
      reason,
      commandBytes: command.commandBytes,
      commandLimitBytes: this.limits.commandBytes,
      registryBytes: this.registryBytes,
      registryLimitBytes: this.limits.registryBytes,
      retainedStreams: this.retainedStreams,
      retainedStreamLimit: this.limits.retainedStreams,
    });
  }

  private async appendRecord(
    record: BashOutputStreamRecord,
    bytes: Uint8Array,
  ): Promise<void> {
    record.buffer = concat(record.buffer, bytes);
    while (record.buffer.byteLength >= this.limits.segmentBytes) {
      const segment = record.buffer.slice(0, this.limits.segmentBytes);
      record.buffer = record.buffer.slice(this.limits.segmentBytes);
      await this.persist(record, segment);
    }
  }

  private async flush(record: BashOutputStreamRecord): Promise<void> {
    if (record.buffer.byteLength === 0) return;
    const segment = record.buffer;
    record.buffer = new Uint8Array();
    await this.persist(record, segment);
  }

  private async persist(
    record: BashOutputStreamRecord,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.beforeWrite?.();
    const file = await this.ensureFile();
    await file.seek(this.fileOffset, Deno.SeekMode.Start);
    await writeAll(file, bytes);
    record.extents.push({
      logicalOffset: record.persistedBytes,
      fileOffset: this.fileOffset,
      length: bytes.byteLength,
    });
    record.persistedBytes += bytes.byteLength;
    this.fileOffset += bytes.byteLength;
  }

  private async compactFile(): Promise<void> {
    const file = this.file;
    if (file === undefined) {
      this.fileOffset = 0;
      return;
    }
    const extents = [...this.commands.values()]
      .flatMap((command) => [...command.streams.values()])
      .flatMap((record) => record.extents)
      .sort((left, right) => left.fileOffset - right.fileOffset);
    let targetOffset = 0;
    for (const extent of extents) {
      if (targetOffset > extent.fileOffset) {
        throw new BashOutputPersistenceError();
      }
      if (targetOffset !== extent.fileOffset) {
        const bytes = new Uint8Array(extent.length);
        await file.seek(extent.fileOffset, Deno.SeekMode.Start);
        await readAll(file, bytes);
        await file.seek(targetOffset, Deno.SeekMode.Start);
        await writeAll(file, bytes);
        extent.fileOffset = targetOffset;
      }
      targetOffset += extent.length;
    }
    await file.truncate(targetOffset);
    this.fileOffset = targetOffset;
  }

  private async ensureFile(): Promise<Deno.FsFile> {
    if (this.file !== undefined) return this.file;
    const path = await Deno.makeTempFile({
      dir: '/tmp',
      prefix: 'henji-bash-output-',
      suffix: '.spool',
    });
    let file: Deno.FsFile | undefined;
    try {
      await Deno.chmod(path, 0o600);
      file = await Deno.open(path, { read: true, write: true });
      await this.onSpoolOpened?.(path);
      await Deno.remove(path);
      this.file = file;
      return file;
    } catch (error) {
      file?.close();
      await Deno.remove(path).catch(() => undefined);
      throw error;
    }
  }

  private async readRecordRange(
    record: BashOutputStreamRecord,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array();
    const file = this.file;
    if (!file) throw new BashOutputPersistenceError();
    const result = new Uint8Array(length);
    let written = 0;
    const end = offset + length;
    for (const extent of record.extents) {
      const extentEnd = extent.logicalOffset + extent.length;
      const start = Math.max(offset, extent.logicalOffset);
      const stop = Math.min(end, extentEnd);
      if (start >= stop) continue;
      const count = stop - start;
      await file.seek(
        extent.fileOffset + start - extent.logicalOffset,
        Deno.SeekMode.Start,
      );
      const selected = result.subarray(written, written + count);
      await readAll(file, selected);
      written += count;
      if (written === length) break;
    }
    if (written !== length) throw new BashOutputPersistenceError();
    return result;
  }

  private async markFailed(command: BashOutputCommandRecord): Promise<void> {
    await this.mutex.run(() => {
      command.failed = true;
      command.finalized = true;
      command.streams.clear();
    });
  }
}

export const createBashOutputStore = (): BashOutputStore => new DenoBashOutputStore();

const bashOutputId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObject = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createBashOutputTool = (store: BashOutputStore): Tool => ({
  name: 'bash_output',
  description:
    'Read a saved stdout or stderr window from a prior truncated bash result. Reuse its exact outputId, stream, and nextOffset until complete is true.',
  promptGuidelines: Object.freeze([
    'When bash reports truncated saved output, call bash_output with the exact outputId and stream from that result. Continue with each returned nextOffset instead of rerunning or reshaping the command.',
  ]),
  inputSchema: {
    type: 'object',
    properties: {
      outputId: { type: 'string' },
      stream: { type: 'string', enum: ['stdout', 'stderr'] },
      offset: { type: 'integer', minimum: 0 },
      limit: {
        type: 'integer',
        minimum: BASH_OUTPUT_MIN_WINDOW_BYTES,
        maximum: BASH_OUTPUT_MAX_WINDOW_BYTES,
      },
    },
    required: ['outputId', 'stream'],
    additionalProperties: false,
  },
  async execute(argumentsValue) {
    if (!isObject(argumentsValue)) {
      throw new ToolInputError('invalid bash_output arguments');
    }
    const keys = Object.keys(argumentsValue);
    if (
      keys.some((key) => !['outputId', 'stream', 'offset', 'limit'].includes(key)) ||
      !keys.includes('outputId') || !keys.includes('stream') ||
      typeof argumentsValue.outputId !== 'string' ||
      !bashOutputId.test(argumentsValue.outputId) ||
      (argumentsValue.stream !== 'stdout' &&
        argumentsValue.stream !== 'stderr') ||
      (argumentsValue.offset !== undefined &&
        (typeof argumentsValue.offset !== 'number' ||
          !Number.isSafeInteger(argumentsValue.offset) ||
          argumentsValue.offset < 0)) ||
      (argumentsValue.limit !== undefined &&
        (typeof argumentsValue.limit !== 'number' ||
          !Number.isSafeInteger(argumentsValue.limit) ||
          argumentsValue.limit < BASH_OUTPUT_MIN_WINDOW_BYTES ||
          argumentsValue.limit > BASH_OUTPUT_MAX_WINDOW_BYTES))
    ) throw new ToolInputError('invalid bash_output arguments');
    try {
      return JSON.stringify(
        await store.read(
          argumentsValue.outputId,
          argumentsValue.stream,
          typeof argumentsValue.offset === 'number' ? argumentsValue.offset : 0,
          typeof argumentsValue.limit === 'number'
            ? argumentsValue.limit
            : BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
        ),
      );
    } catch (error) {
      if (error instanceof BashOutputReadError) {
        throw new ToolInputError(error.message);
      }
      throw error;
    }
  },
});

/** The production implementation with smaller limits and lifecycle hooks for focused tests. */
export const createBashOutputStoreForTest = (
  options: BashOutputStoreTestOptions,
): BashOutputStore & { diagnostics(): Promise<BashOutputStoreDiagnostics> } =>
  new DenoBashOutputStore(options);
