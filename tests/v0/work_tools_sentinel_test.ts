import {
  EXPECTED_RESULT,
  runSentinel,
  TOOL_ORDER,
} from '../../v0/agent/validation/work_tools_sentinel.ts';
import { parseChildReport } from '../../v0/agent/validation/work_tools_sentinel_launcher.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const calls = [
  { path: 'work/item.txt', content: 'alpha\n' },
  { path: 'work/item.txt' },
  { path: 'work/item.txt', edits: [{ oldText: 'alpha\n', newText: 'beta\n' }] },
  {
    command:
      'test "$(cat work/item.txt)" = beta && printf \'verified:%s\' "$(wc -c < work/item.txt)"',
    timeoutMs: 5000,
  },
  { json: JSON.stringify(EXPECTED_RESULT) },
] as const;

const toolResponse = (index: number): string => {
  const id = `work-tools-${index + 1}`;
  return JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name: TOOL_ORDER[index], arguments: JSON.stringify(calls[index]) },
        }],
      },
    }],
  });
};

const inTemporaryWorkspace = async (test: (workspaceRoot: string) => Promise<void>) => {
  const workspaceRoot = await Deno.makeTempDir({ prefix: 'work-tools-sentinel-test-' });
  try {
    await test(workspaceRoot);
  } finally {
    await Deno.remove(workspaceRoot, { recursive: true });
  }
};

Deno.test('work-tools sentinel completes five real tools with five fetch starts', async () => {
  await inTemporaryWorkspace(async (workspaceRoot) => {
    let fetchStarts = 0;
    const fetcher: typeof fetch = () => {
      const index = fetchStarts++;
      return Promise.resolve(
        new Response(toolResponse(index), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const result = await runSentinel({ workspaceRoot, credential: 'test-only', fetcher });
    assertEquals(fetchStarts, 5);
    assertEquals(result.externalRequests, 5);
    assertEquals(result.report.ok, true);
    assertEquals(result.report.toolOrder, TOOL_ORDER);
    assertEquals(parseChildReport(`${JSON.stringify(result.report)}\n`), result.report);
  });
});

Deno.test('work-tools sentinel blocks HTTP 503 retry before a second fetch starts', async () => {
  await inTemporaryWorkspace(async (workspaceRoot) => {
    let fetchStarts = 0;
    const fetcher: typeof fetch = () => {
      fetchStarts += 1;
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    };
    const result = await runSentinel({ workspaceRoot, credential: 'test-only', fetcher });
    assertEquals(fetchStarts, 1);
    assertEquals(result.externalRequests, 1);
    assertEquals(result.report.ok, false);
    if (result.report.ok) throw new Error('expected provider failure');
    assertEquals(result.report.code, 'provider_failure');
    assertEquals(result.report.modelRequests, 1);
    assertEquals(result.report.externalRequests, 1);
    assertEquals(parseChildReport(`${JSON.stringify(result.report)}\n`), result.report);
  });
});
