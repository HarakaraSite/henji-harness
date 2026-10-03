import type { JsonValue } from '../core/contracts.ts';
import { TurnCancelledError } from '../core/cancellation.ts';
import type { ToolExecutionContext } from '../core/execution_context.ts';
import type { Workspace } from './work_tool_contract.ts';
import { type Tool, ToolInputError } from './tools.ts';
import { resolveWebDownloadTarget } from './web_download.ts';

export const MAX_WEB_FETCH_BYTES = 1_048_576;
export const WEB_FETCH_TIMEOUT_MS = 30_000;

const USER_AGENT = 'henji/0.2.1';

const TEXTUAL_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isTextualContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();
  return TEXTUAL_CONTENT_TYPES.some((prefix) => normalized.startsWith(prefix)) ||
    normalized.includes('+json') || normalized.includes('+xml');
};

const decodeEntities = (value: string): string =>
  value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

const htmlToText = (html: string): string => {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ');
  text = text
    .replace(
      /<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/giu,
      '\n',
    )
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/gu, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
};

const readBoundedBody = async (
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  if (reader === undefined) {
    return { bytes: new Uint8Array(), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    const remaining = MAX_WEB_FETCH_BYTES - total;
    if (item.value.byteLength > remaining) {
      chunks.push(item.value.subarray(0, Math.max(0, remaining)));
      truncated = true;
      break;
    }
    chunks.push(item.value);
    total += item.value.byteLength;
  }
  const bytes = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

interface WebFetchArguments {
  readonly url: string;
  readonly saveTo?: string;
}

const parseArguments = (value: JsonValue): WebFetchArguments => {
  if (!isRecord(value)) throw new ToolInputError('expected object');
  const names = Object.keys(value);
  if (
    !names.includes('url') ||
    names.some((name) => name !== 'url' && name !== 'save_to') ||
    !nonBlank(value.url) || (names.length !== 1 && names.length !== 2)
  ) {
    throw new ToolInputError('expected url and optional save_to fields');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new ToolInputError('url must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError('url must use http or https');
  }
  if ('save_to' in value && !nonBlank(value.save_to)) {
    throw new ToolInputError('save_to must be a non-empty string');
  }
  return {
    url: parsed.href,
    ...('save_to' in value ? { saveTo: value.save_to as string } : {}),
  };
};

export interface WebFetchOptions {
  readonly workspace?: Workspace;
}

const writeDownloadedBody = async (
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  path: string,
  signal: AbortSignal,
  userSignal?: AbortSignal,
): Promise<number> => {
  throwIfFetchAborted(signal, userSignal);
  const file = await Deno.open(path, {
    write: true,
    createNew: true,
  });
  let total = 0;
  try {
    for (;;) {
      throwIfFetchAborted(signal, userSignal);
      const item = await reader?.read() ?? { done: true, value: undefined };
      throwIfFetchAborted(signal, userSignal);
      if (item.done) break;
      const chunk = item.value;
      let offset = 0;
      while (offset < chunk.byteLength) {
        throwIfFetchAborted(signal, userSignal);
        const written = await file.write(chunk.subarray(offset));
        if (written <= 0) throw new Error('web_fetch download write failed');
        offset += written;
      }
      total += chunk.byteLength;
    }
    throwIfFetchAborted(signal, userSignal);
    await file.sync();
    throwIfFetchAborted(signal, userSignal);
    return total;
  } finally {
    file.close();
  }
};

const throwIfFetchAborted = (
  signal: AbortSignal,
  userSignal?: AbortSignal,
): void => {
  if (!signal.aborted) return;
  if (userSignal?.aborted) throw new TurnCancelledError();
  throw new Error('web_fetch request timed out or was cancelled');
};

export const createWebFetchTool = (
  fetcher: typeof fetch = fetch,
  options: WebFetchOptions = {},
): Tool => ({
  name: 'web_fetch',
  description:
    'Fetch one http/https URL and return its HTTP status, final URL, content type, and decoded text body (HTML is converted to plain text). Set save_to to download the original response bytes to the Session workspace or /tmp.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      save_to: { type: 'string' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  promptGuidelines: [
    'Use web_fetch only for a specific URL or public API endpoint that is already known. Do not guess or enumerate endpoints. When the canonical source is not known, use web_search first. Treat the returned body as sourced material, cite the final URL for claims taken from it, and label inference instead of presenting it as verified fact.',
    'When save_to fails because the destination already exists, choose another save_to path and retry.',
  ],
  async execute(
    argumentsValue: JsonValue,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const { url, saveTo } = parseArguments(argumentsValue);
    const downloadTarget = saveTo === undefined
      ? undefined
      : await resolveWebDownloadTarget(saveTo, options.workspace);
    const signal = context?.signal === undefined
      ? AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
      : AbortSignal.any([
        context.signal,
        AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
      ]);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          accept: downloadTarget === undefined
            ? 'text/*, application/json, application/xml;q=0.9, */*;q=0.1'
            : '*/*',
          'user-agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error(
          downloadTarget === undefined
            ? 'web_fetch request timed out or was cancelled'
            : `web_fetch download failed for ${downloadTarget.path}: request timed out or was cancelled`,
        );
      }
      throw new Error(
        downloadTarget === undefined
          ? `web_fetch request failed: ${error instanceof Error ? error.message : String(error)}`
          : `web_fetch download failed for ${downloadTarget.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    // Own the body from acquisition through status checks, decoding, and result construction.
    const reader = response.body?.getReader();
    try {
      const finalUrl = response.url.length > 0 ? response.url : url;
      const contentType = response.headers.get('content-type') ?? '';
      if (!(response.status >= 200 && response.status < 300)) {
        throw new Error(
          downloadTarget === undefined
            ? `web_fetch request failed (${response.status}) for ${finalUrl}`
            : `web_fetch download failed for ${downloadTarget.path} (${response.status}) for ${finalUrl}`,
        );
      }
      if (downloadTarget !== undefined) {
        try {
          await Deno.mkdir(downloadTarget.parent, { recursive: true });
        } catch (error) {
          throw new Error(
            `web_fetch download failed for ${downloadTarget.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
        const cancelReader = () => {
          void reader?.cancel(signal.reason).catch(() => {});
        };
        signal.addEventListener('abort', cancelReader, { once: true });
        try {
          let byteCount: number;
          try {
            byteCount = await writeDownloadedBody(
              reader,
              downloadTarget.path,
              signal,
              context?.signal,
            );
          } catch (error) {
            if (error instanceof TurnCancelledError) throw error;
            throw new Error(
              `web_fetch download failed for ${downloadTarget.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          return [
            `Saved: ${downloadTarget.path}`,
            `URL: ${finalUrl}`,
            `Status: ${response.status}`,
            `Content-Type: ${contentType.length > 0 ? contentType : 'unknown'}`,
            `Bytes: ${byteCount}`,
          ].join('\n');
        } finally {
          signal.removeEventListener('abort', cancelReader);
        }
      }
      const { bytes, truncated } = await readBoundedBody(reader);
      const textual = isTextualContentType(contentType);
      const raw = textual ? new TextDecoder('utf-8').decode(bytes) : '';
      const body = contentType.toLowerCase().includes('text/html') ? htmlToText(raw) : raw;
      const meta = [
        `URL: ${finalUrl}`,
        `Status: ${response.status}`,
        `Content-Type: ${contentType.length > 0 ? contentType : 'unknown'}`,
        `truncated: ${truncated}`,
      ].join('\n');
      if (!textual) return meta;
      return `${meta}\n\n${body}${truncated ? '\n\n[body truncated]' : ''}`;
    } finally {
      if (reader !== undefined) {
        try {
          await reader.cancel('web_fetch finished');
        } catch {
          // A fully consumed or aborted body is already settled.
        } finally {
          reader.releaseLock();
        }
      }
    }
  },
});
