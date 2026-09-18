import { createWebFetchTool, MAX_WEB_FETCH_BYTES } from '../../v0/agent/tools/web_fetch.ts';
import { type Tool, ToolInputError } from '../../v0/agent/tools/tools.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};

const run = async (tool: Tool, url: string): Promise<string> => {
  const result = await tool.execute({ url });
  if (typeof result === 'string') return result;
  return result.kind === 'continue' ? result.text : '';
};

const failure = async (tool: Tool, url: string): Promise<unknown> => {
  try {
    await tool.execute({ url });
    return undefined;
  } catch (error) {
    return error;
  }
};

const fetched = (
  body: string,
  init: { status?: number; contentType?: string; url?: string } = {},
): typeof fetch =>
() =>
  Promise.resolve(
    Object.defineProperty(
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.contentType ?? 'text/plain; charset=utf-8' },
      }),
      'url',
      { value: init.url ?? 'https://example.com/final' },
    ),
  );

Deno.test('Increment 70 web_fetch returns metadata and extracted HTML text', async () => {
  const tool = createWebFetchTool(fetched(
    '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Title</h1><p>Hello <b>world</b> &amp; friends</p></body></html>',
    { contentType: 'text/html; charset=utf-8', url: 'https://example.com/page' },
  ));
  const output = await run(tool, 'https://example.com');
  assert(output.includes('URL: https://example.com/page'));
  assert(output.includes('Status: 200'));
  assert(output.includes('Content-Type: text/html; charset=utf-8'));
  assert(output.includes('truncated: false'));
  assert(output.includes('Title'));
  assert(output.includes('Hello world & friends'));
  assert(!output.includes('<h1>'));
  assert(!output.includes('alert(1)'));
  assert(!output.includes('color:red'));
});

Deno.test('Increment 70 web_fetch returns metadata only for non-textual content', async () => {
  const tool = createWebFetchTool(fetched('binarydata', {
    contentType: 'application/octet-stream',
  }));
  const output = await run(tool, 'https://example.com/blob');
  assert(output.includes('Content-Type: application/octet-stream'));
  assert(!output.includes('binarydata'));
});

Deno.test('Increment 70 web_fetch truncates an oversized body', async () => {
  const big = 'x'.repeat(MAX_WEB_FETCH_BYTES + 10_000);
  const tool = createWebFetchTool(fetched(big));
  const output = await run(tool, 'https://example.com/big');
  assert(output.includes('truncated: true'));
  assert(output.includes('[body truncated]'));
});

Deno.test('Increment 70 web_fetch fails on http errors and invalid input', async () => {
  const failing = createWebFetchTool(fetched('nope', { status: 404 }));
  const httpError = await failure(failing, 'https://example.com/missing');
  assert(httpError instanceof Error);
  assert((httpError as Error).message.includes('404'));

  const tool = createWebFetchTool(fetched('ok'));
  for (const bad of ['not a url', 'ftp://example.com/file', '']) {
    const error = await failure(tool, bad);
    assert(error instanceof ToolInputError);
  }
});
