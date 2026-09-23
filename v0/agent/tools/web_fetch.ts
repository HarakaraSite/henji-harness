import type { JsonValue } from '../core/contracts.ts';
import type { ToolExecutionContext } from '../core/execution_context.ts';
import { type Tool, ToolInputError } from './tools.ts';

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
    .replace(/<\/(?:p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/giu, '\n')
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
  response: Response,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
  if (response.body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
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
  } finally {
    try {
      await reader.cancel('web_fetch body bounded');
    } catch {
      // The body is already settled or the reader is closed.
    }
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

const parseUrl = (value: JsonValue): string => {
  if (!isRecord(value)) throw new ToolInputError('expected object');
  const names = Object.keys(value);
  if (names.length !== 1 || names[0] !== 'url' || !nonBlank(value.url)) {
    throw new ToolInputError('expected one non-empty string field: url');
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
  return parsed.href;
};

export const createWebFetchTool = (fetcher: typeof fetch = fetch): Tool => ({
  name: 'web_fetch',
  description:
    'Fetch one http/https URL and return its HTTP status, final URL, content type, and decoded text body (HTML is converted to plain text). Use for a specific known URL or public API; use web_search to discover sources.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  promptGuidelines: [
    'Use web_fetch only for a specific URL or public API endpoint that is already known. Do not guess or enumerate endpoints. When the canonical source is not known, use web_search first. Treat the returned body as sourced material, cite the final URL for claims taken from it, and label inference instead of presenting it as verified fact.',
  ],
  async execute(argumentsValue: JsonValue, context?: ToolExecutionContext): Promise<string> {
    const url = parseUrl(argumentsValue);
    const signal = context?.signal === undefined
      ? AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
      : AbortSignal.any([context.signal, AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1',
          'user-agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (signal.aborted) throw new Error('web_fetch request timed out or was cancelled');
      throw new Error(
        `web_fetch request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const finalUrl = response.url.length > 0 ? response.url : url;
    const contentType = response.headers.get('content-type') ?? '';
    if (!(response.status >= 200 && response.status < 300)) {
      throw new Error(`web_fetch request failed (${response.status}) for ${finalUrl}`);
    }
    const { bytes, truncated } = await readBoundedBody(response);
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
  },
});
