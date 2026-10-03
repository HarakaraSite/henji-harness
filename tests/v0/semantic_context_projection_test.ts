import type { Message, ModelRequest } from '../../v0/agent/core/contracts.ts';
import { runAgent, runAgentTurn } from '../../v0/agent/core/loop.ts';
import { projectSemanticContext } from '../../v0/agent/session/semantic_context.ts';
import type { SemanticContextCheckpointV1 } from '../../v0/agent/session/session_store_contract.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const big = (prefix: string): string => `${prefix}-${'x'.repeat(100_000)}`;

const longTranscript = (turns: number): Message[] => {
  const transcript: Message[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    transcript.push({ role: 'user', content: { kind: 'text', text: `task-${turn}` } });
    transcript.push({
      role: 'assistant',
      content: { kind: 'text', text: big(`answer-${turn}`) },
    });
  }
  return transcript;
};

Deno.test('Worker loop projects checkpoint summary and retained suffix into the next request', async () => {
  const initialTranscript = longTranscript(2);
  const checkpoint: SemanticContextCheckpointV1 = {
    contextSchemaVersion: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-10T00:00:00.000Z',
    sourceProfileId: 'test-profile',
    coveredThroughTurn: 1,
    retainedFromTurn: 2,
    summary: 'semantic first-turn summary',
  };
  let observed: ModelRequest | undefined;
  const outcome = await runAgentTurn(
    'next question',
    initialTranscript,
    {
      generate: (request) => {
        observed = structuredClone(request);
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      projectParentRequest: (request) => projectSemanticContext(request, checkpoint),
    },
  );

  assert(outcome.ok);
  assert(observed !== undefined);
  const projected = JSON.stringify(observed.transcript);
  assert(projected.includes('semantic first-turn summary'));
  assert(projected.includes('task-2'));
  assert(projected.includes('answer-2'));
  assert(projected.includes('next question'));
  assert(!projected.includes('answer-1'));
});

Deno.test('Model steps retain a tool result larger than 64 KiB for the next request', async () => {
  const resultText = big('complete-tool-result');
  const requests: ModelRequest[] = [];
  const outcome = await runAgent(
    'use the large tool',
    {
      generate: (request) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return {
            kind: 'tool_calls' as const,
            calls: [{ callId: 'large-1', name: 'large_tool', arguments: {} }],
          };
        }
        return { kind: 'final' as const, text: 'answer' };
      },
    },
    new Registry([{
      name: 'large_tool',
      description: 'Return one large observed result',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: () => resultText,
    }]),
  );

  assert(outcome.ok);
  assertEquals(requests.length, 2);
  const tool = requests[1].transcript.find((message) => message.role === 'tool');
  assert(tool?.role === 'tool');
  assertEquals(tool.content[0]?.text, resultText);
});
