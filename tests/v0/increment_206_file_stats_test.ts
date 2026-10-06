import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createDataClient } from '../../v0/agent/data/client.ts';
import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { activateRepositoryExternalToolBindings } from './helpers/external_web_tools.ts';

Deno.test('increment 206 file stats and selection guidelines reach the production Worker path', async () => {
  const base = await Deno.makeTempDir({ prefix: 'henji-i206-stats-' });
  const workspaceRoot = `${base}/workspace`;
  const configRoot = `${base}/config`;
  const stateRoot = `${base}/state`;
  await Deno.mkdir(`${workspaceRoot}/nested`, { recursive: true });
  const contents = new Map([
    ['empty.txt', ''],
    ['nested/unicode.txt', '日本語\u3000次\r\nlast'],
    ['plain.txt', 'alpha beta\nlast'],
    ['stream.txt', 'a'.repeat(65535) + '日本語\u3000b\n'],
  ]);
  for (const [path, content] of contents) {
    await Deno.writeTextFile(`${workspaceRoot}/${path}`, content);
  }
  await activateRepositoryExternalToolBindings(configRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  let session: WorkerHostSession | undefined;
  try {
    const descriptor = await data.openSession({
      persistence: 'none',
      agent: 'default',
      agentChoice: {},
    });
    session = await WorkerHostSession.open({
      data,
      descriptor,
      workspaceRoot,
      configRoot,
      credentialRoot: `${stateRoot}/credentials`,
      agentChoice: {},
      physicalIoMode: 'provider-free',
    });
    const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const outcome = await session!.submit(
        `bash-tool-call:${JSON.stringify({ name: 'search', arguments: args })}`,
      );
      ok(outcome.ok, JSON.stringify(outcome));
      return JSON.parse(outcome.finalText!);
    };
    // Compare actual file results with wc, including a final partial line and a UTF-8 chunk boundary.
    const expected: Record<string, unknown>[] = [];
    for (const path of contents.keys()) {
      const reference = await new Deno.Command('wc', {
        args: ['-l', '-w', '-c', '--', `${workspaceRoot}/${path}`],
        env: { LC_ALL: 'C.UTF-8' },
      }).output();
      ok(reference.success);
      const [lines, words, bytes] = new TextDecoder().decode(reference.stdout).trim()
        .split(/\s+/).slice(0, 3).map(Number);
      const record = { path, lines, words, bytes };
      expected.push(record);
      const result = await call({ mode: 'stats', path });
      strictEqual(result.total, 1);
      deepStrictEqual(result.records, [record]);
    }
    const first = await call({ mode: 'stats', glob: '*.txt', limit: 2 });
    strictEqual(first.total, 4);
    deepStrictEqual(first.records, expected.slice(0, 2));
    strictEqual(first.hasMore, true);
    strictEqual(first.nextOffset, 2);
    const second = await call({ mode: 'stats', glob: '*.txt', limit: 2, offset: first.nextOffset });
    deepStrictEqual(second.records, expected.slice(2));
    strictEqual(second.hasMore, false);
    strictEqual(second.nextOffset, null);
    const scoped = await call({ mode: 'stats', path: 'nested', glob: '*.txt' });
    strictEqual(scoped.total, 1);
    deepStrictEqual(scoped.records, [expected[1]]);

    const readback = await session.submit('return active tool guidelines');
    ok(readback.ok);
    const instruction = readback.finalText ?? '';
    ok(instruction.includes('Use search instead of bash ls, find, grep, rg, or wc'));
    ok(instruction.includes('stats for file line, word, and byte counts'));
    ok(instruction.includes('Read total from paths for the number of files'));
    ok(
      instruction.includes(
        'Use git_inspect for supported workspace Git status, diff, log, and show',
      ),
    );
    ok(instruction.includes('staged:true for git diff --cached'));
    ok(instruction.includes('stat:true for git diff --stat'));
  } finally {
    try {
      await session?.close();
    } finally {
      await data.close();
      await Deno.remove(base, { recursive: true });
    }
  }
});
