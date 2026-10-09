import { deepStrictEqual, strictEqual } from 'node:assert';

Deno.test('Increment 140 history CLI resolves target and view through the connected core', async () => {
  const requests: unknown[] = [];
  const sessionId = '14000000-0000-4000-8000-000000000001';
  const text = '# Henji Session History\n\nremote workspace result\n';
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      session: url.searchParams.get('session'),
      view: url.searchParams.get('view'),
      latest: url.searchParams.get('latest'),
    });
    return new Response(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-henji-session-id': sessionId,
        'x-henji-history-view': 'canonical',
      },
    });
  });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--no-prompt',
        '--cached-only',
        '--allow-net=127.0.0.1',
        '--config',
        new URL('../../deno.v0.json', import.meta.url).pathname,
        new URL('../../v0/agent/cli/henji_cli.ts', import.meta.url).pathname,
        'history',
        '--connect',
        `http://127.0.0.1:${server.addr.port}`,
        '--session',
        sessionId.slice(0, 8),
        '--view',
        'canonical',
      ],
      cwd: '/tmp',
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const decoder = new TextDecoder();
    strictEqual(output.code, 0, decoder.decode(output.stderr));
    strictEqual(decoder.decode(output.stdout), text);
    strictEqual(decoder.decode(output.stderr), `# session ${sessionId}\n`);
    deepStrictEqual(requests, [{
      path: '/api/v1/history',
      session: '14000000',
      view: 'canonical',
      latest: null,
    }]);
  } finally {
    await server.shutdown();
  }
});
