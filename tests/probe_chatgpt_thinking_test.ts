import { ok, strictEqual } from 'node:assert';
import { probeRoundTrip } from '../scripts/probe_chatgpt_thinking.ts';
import type { Fact } from '../scripts/spike_chatgpt_sign_in.ts';

Deno.test('thinking probe compares wire replay, provider notes, summaries and adapter output without persisting secrets', async () => {
  for (
    const scenario of [
      { summary: false },
      { summary: true },
      { summary: true, auth: 'api_key' as const, nextTurn: true },
      { summary: true, auth: 'chatgpt' as const, nextTurn: true },
      { summary: true, auth: 'openrouter' as const, nextTurn: true },
      {
        summary: true,
        auth: 'opencode_go' as const,
        nextTurn: true,
        sessionId: 'probe-session',
        requestHeaders: { 'user-agent': 'Henji-Harness', 'x-opencode-session': '{sessionId}' },
      },
    ]
  ) {
    const { summary } = scenario;
    const facts: Fact[] = [];
    let requests = 0;
    const fetcher: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests++;
      strictEqual(body.reasoning.effort, 'high');
      strictEqual(body.reasoning.summary, summary ? 'auto' : undefined);
      strictEqual(body.tools[0].type, scenario.auth === 'opencode_go' ? 'function' : 'namespace');
      if (scenario.auth === 'opencode_go') {
        strictEqual(new Headers(init?.headers).get('x-opencode-session'), 'probe-session');
      }
      const output = requests === 1
        ? [
          {
            type: 'reasoning',
            id: 'rs-probe',
            encrypted_content: 'mock-private-reasoning',
            summary: summary ? [{ type: 'summary_text', text: 'Checking echo.' }] : [],
          },
          {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'I will check echo.' }],
          },
          {
            type: 'function_call',
            name: 'echo',
            namespace: 'henji',
            call_id: 'echo-probe',
            arguments: '{"text":"HENJI_THINKING_PROBE_OK"}',
          },
        ]
        : [
          ...(requests === 2 && scenario.nextTurn
            ? [{
              type: 'reasoning',
              id: 'rs-final',
              encrypted_content: 'mock-final-reasoning',
              summary: [],
            }]
            : []),
          {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'HENJI_THINKING_PROBE_OK' }],
          },
        ];
      if (requests === 2) {
        ok(
          body.input.some((item: Record<string, unknown>) =>
            item.encrypted_content === 'mock-private-reasoning'
          ),
        );
        ok(body.input.some((item: Record<string, unknown>) => item.phase === 'commentary'));
      }
      if (requests === 3) {
        ok(
          body.input.some((item: Record<string, unknown>) =>
            item.encrypted_content === 'mock-final-reasoning'
          ),
        );
        ok(body.input.some((item: Record<string, unknown>) => item.phase === 'final_answer'));
        strictEqual(body.input.at(-1).role, 'user');
      }
      const events = output.map((item, output_index) => ({
        type: 'response.output_item.done',
        output_index,
        item,
      }));
      const frames = [
        ...events,
        {
          type: 'response.completed',
          response: {
            output: scenario.auth === 'api_key'
              ? output.map((item) => Object.fromEntries(Object.entries(item).reverse()))
              : [],
            usage: {
              input_tokens: 32,
              input_tokens_details: { cached_tokens: 16 },
              output_tokens: 12,
              output_tokens_details: { reasoning_tokens: 8 },
            },
          },
        },
      ];
      return Promise.resolve(
        new Response(
          frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    };
    await probeRoundTrip({
      model: 'gpt-5.6-sol',
      accessToken: 'mock-private-access',
      ...scenario,
      fetcher,
      report: (fact) => {
        facts.push(fact);
        return Promise.resolve();
      },
    });
    strictEqual(requests, scenario.nextTurn ? 3 : 2);
    const continuation = facts.find((fact) => fact.kind === 'wire_input' && fact.step === 2);
    strictEqual(continuation?.replayedAllOutputItems, true);
    const adapter = facts.find((fact) => fact.kind === 'adapter_output' && fact.step === 1);
    strictEqual(adapter?.text, 'I will check echo.');
    strictEqual((adapter?.thinking as unknown[]).length, summary ? 1 : 0);
    const provider = facts.find((fact) => fact.kind === 'provider_output' && fact.step === 1);
    strictEqual((provider?.usage as Record<string, unknown>).output_tokens, 12);
    const encoded = JSON.stringify(facts);
    ok(!encoded.includes('mock-private-access'));
    ok(!encoded.includes('mock-private-reasoning'));
    ok(!encoded.includes('mock-final-reasoning'));
    if (scenario.nextTurn) {
      const next = facts.find((fact) => fact.kind === 'wire_input' && fact.step === 3);
      strictEqual(next?.replayedAllOutputItems, true);
      strictEqual(next?.replayedAllAdapterItems, true);
      strictEqual(next?.encryptedReasoningPreservedFromStream, true);
      strictEqual(next?.encryptedItems, 2);
    }
  }
});
