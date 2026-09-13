import { createHash } from 'node:crypto';
import { sessionPaths } from '../session/session_store_paths.ts';
import type { HumanHistoryReadPort } from './human_history.ts';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREATE_ATTEMPTS = 8;
const encoder = new TextEncoder();

export interface HumanHistoryExportReceipt {
  readonly path: string;
  readonly sessionId: string;
  readonly stateRevision: number;
  readonly tailExecutionId?: string;
  readonly executionCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface HumanHistoryExporter {
  write(sessionId: string): Promise<HumanHistoryExportReceipt>;
}

export interface DenoHumanHistoryExporterOptions {
  readonly uuid?: () => string;
}

const writeBytes = async (file: Deno.FsFile, bytes: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = await file.write(bytes.subarray(offset));
    if (count <= 0) throw new Error('history export failed');
    offset += count;
  }
};

/** Unique-file streaming writer for the durable Session JSONL projection. */
export class DenoHumanHistoryExporter implements HumanHistoryExporter {
  private readonly uuid: () => string;

  constructor(
    private readonly stateRoot: string,
    private readonly workspaceRoot: string,
    private readonly reader: HumanHistoryReadPort,
    options: DenoHumanHistoryExporterOptions = {},
  ) {
    this.uuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
  }

  async write(sessionId: string): Promise<HumanHistoryExportReceipt> {
    if (!SESSION_ID.test(sessionId)) throw new Error('history export failed');
    const paths = await sessionPaths(this.stateRoot, this.workspaceRoot);
    await Deno.mkdir(paths.historyExports, { recursive: true, mode: 0o700 });
    let path: string | undefined;
    let file: Deno.FsFile | undefined;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const uuid = this.uuid().toLowerCase();
      if (!SESSION_ID.test(uuid)) throw new Error('history export failed');
      const candidate = `${paths.historyExports}/${sessionId}-full-${uuid}.jsonl`;
      try {
        file = await Deno.open(candidate, { createNew: true, write: true, mode: 0o600 });
        path = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw new Error('history export failed');
      }
    }
    if (file === undefined || path === undefined) throw new Error('history export failed');
    let complete = false;
    let byteLength = 0;
    let executionCount = 0;
    let stateRevision: number | undefined;
    let tailExecutionId: string | undefined;
    const hash = createHash('sha256');
    try {
      for (const record of this.reader.streamHumanHistoryExport(sessionId)) {
        if (record.kind === 'header') {
          const header = record.value as {
            readonly stateRevision?: unknown;
            readonly tail?: { readonly executionId?: unknown } | null;
          };
          if (!Number.isSafeInteger(header.stateRevision)) throw new Error('history export failed');
          stateRevision = Number(header.stateRevision);
          if (typeof header.tail?.executionId === 'string') {
            tailExecutionId = header.tail.executionId;
          }
        }
        if (record.kind === 'execution') executionCount += 1;
        const bytes = encoder.encode(`${JSON.stringify(record)}\n`);
        await writeBytes(file, bytes);
        hash.update(bytes);
        byteLength += bytes.byteLength;
      }
      if (stateRevision === undefined) throw new Error('history export failed');
      await file.sync();
      complete = true;
    } catch {
      throw new Error('history export failed');
    } finally {
      file.close();
      if (!complete) {
        try {
          await Deno.remove(path);
        } catch {
          // The primary export failure remains authoritative.
        }
      }
    }
    return Object.freeze({
      path,
      sessionId,
      stateRevision,
      ...(tailExecutionId === undefined ? {} : { tailExecutionId }),
      executionCount,
      byteLength,
      sha256: hash.digest('hex'),
    });
  }
}
