import { CORPUS_PATH, loadTaskCorpus } from '../../v0/corpus/task_corpus.ts';
import { runLiveCorpusEval } from '../../v0/eval/live_corpus_runner.ts';
import {
  serializeLiveCorpusEvalReportV2,
  validateLiveCorpusEvalReportV2,
} from '../../v0/eval/live_corpus_report_v2.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const tool = (index: number, name: string, args: Record<string, unknown>) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{
    id: `call-${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }],
});

const responses = [
  tool(1, 'character_count', { text: 'Henji 🐣' }),
  tool(2, 'submit_json_result', { json: '{"count":7}' }),
  tool(3, 'count_json_array_items', { json: '[["a","b"],{"x":1},false,null]' }),
  tool(4, 'submit_json_result', { json: '{"count":4}' }),
  { role: 'assistant', content: 'MiXeD 123 !' },
  tool(6, 'list_json_object_keys', { path: 'deno.v0.json', objectKey: 'fmt' }),
  tool(7, 'submit_json_result', { json: '["lineWidth","semiColons","singleQuote"]' }),
  tool(8, 'list_json_object_keys', { path: 'deno.v0.json', objectKey: 'fmt' }),
  tool(9, 'count_json_array_items', { json: '["lineWidth","semiColons","singleQuote"]' }),
  tool(10, 'submit_json_result', { json: '{"count":3}' }),
  tool(11, 'uppercase_text', { text: 'Henji harness' }),
  { role: 'assistant', content: 'HENJI HARNESS' },
];

const response = (message: unknown): Response =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const runSixCases = async (firstMessage?: Record<string, unknown>) => {
  let fetchStarts = 0;
  const fetcher: typeof fetch = () => {
    const index = fetchStarts++;
    if (index >= responses.length) throw new Error('unexpected extra fetch');
    return Promise.resolve(response(index === 0 && firstMessage ? firstMessage : responses[index]));
  };
  const report = await runLiveCorpusEval('sentinel', { credential: 'test-only', fetcher });
  assertEquals(fetchStarts, 12);
  assertEquals(report.completion.status, 'completed');
  assertEquals(report.counts, {
    total: 6,
    completed: 6,
    passed: 6,
    failed: 0,
    errors: 0,
    notRun: 0,
  });
  assertEquals(report.externalRequests, 12);
  return report;
};

Deno.test('live corpus returns an HTTP case report after one 503 fetch', async () => {
  let fetchStarts = 0;
  const fetcher: typeof fetch = () => {
    fetchStarts += 1;
    return Promise.resolve(new Response('unavailable', { status: 503 }));
  };
  const report = await runLiveCorpusEval('sentinel', { credential: 'test-only', fetcher });
  assertEquals(fetchStarts, 1);
  assertEquals(report.externalRequests, 1);
  assertEquals(report.completion.status, 'aborted');
  assertEquals(report.completion.abortCode, 'provider_http_error');
  assertEquals(report.results[0], {
    taskId: 'v1.character-count.henji-chick.explicit',
    status: 'error',
    errorCode: 'provider_http_error',
    externalRequests: 1,
  });
  assertEquals(report.results.slice(1).map((result) => result.status), Array(5).fill('not_run'));
  const corpus = await loadTaskCorpus(CORPUS_PATH, Deno.readTextFile);
  const serialized = serializeLiveCorpusEvalReportV2(report, corpus);
  assertEquals(validateLiveCorpusEvalReportV2(JSON.parse(serialized), corpus), report);
});

Deno.test('live corpus completes all six cases with production tools', async () => {
  await runSixCases();
});

Deno.test('live corpus scores reasoning state without changing the result', async () => {
  const expected = await runSixCases();
  const actual = await runSixCases({
    ...responses[0],
    reasoning_details: [{ type: 'reasoning.text', text: 'counting' }],
  });
  assertEquals(actual, expected);
});

Deno.test('live corpus scores assistant text before a tool call', async () => {
  const expected = await runSixCases();
  const actual = await runSixCases({ ...responses[0], content: 'Counting now.' });
  assertEquals(actual, expected);
});
