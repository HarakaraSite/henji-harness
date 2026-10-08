import type {
  Message,
  ModelRequest,
  ModelResult,
  ProviderState,
} from '../../v0/agent/core/contracts.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import { projectSemanticContext } from '../../v0/agent/session/semantic_context.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import {
  projectRecalledExecutionContext,
  type RecalledExecutionContextV1,
  recalledExecutionProjectionText,
} from '../../v0/agent/worker/recalled_execution_context.ts';

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

const providerState = (): ProviderState => ({
  provider: 'openai-responses',
  model: 'test-model',
  replayItems: [{
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'retained reasoning' }],
  }],
});

const retainedTurn = (): Message[] => [{
  role: 'user',
  content: { kind: 'text', text: 'retained task' },
}, {
  role: 'assistant',
  content: { kind: 'text', text: 'retained answer' },
  providerState: providerState(),
}];

const recalled: RecalledExecutionContextV1 = {
  schemaVersion: 1,
  sourceExecutionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionId: '11111111-1111-4111-8111-111111111111',
  turn: 1,
  settlement: 'uncommitted',
  stopReason: 'cancelled',
  task: 'stopped task',
  evidence: 'unavailable',
  observations: [],
  effectCommitRelation: 'not_transactional',
  automaticReplay: false,
};

for (const projected of [false, true]) {
  Deno.test(
    `Increment 214 ${
      projected ? 'checkpoint and recall' : 'ordinary'
    } model requests keep content and independent nested values`,
    async () => {
      const retained = retainedTurn();
      const committed: Message[] = projected
        ? [{ role: 'user', content: { kind: 'text', text: 'covered task' } }, {
          role: 'assistant',
          content: { kind: 'text', text: 'covered answer' },
        }, ...retained]
        : retained;
      const committedBefore = JSON.stringify(committed);
      const schema = {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            properties: { values: { type: 'array', items: { type: 'integer' } } },
          },
        },
      };
      const registry = new Registry([{
        name: 'nested_tool',
        fileAccess: 'none',
        description: 'Return a result for the supplied values',
        inputSchema: schema,
        execute: (argumentsValue) => {
          assertEquals(argumentsValue, { payload: { values: [1, 2] } });
          return 'complete tool result';
        },
      }]);
      const definitionsBefore = JSON.stringify(registry.definitions());
      const task: Message = { role: 'user', content: { kind: 'text', text: 'current task' } };
      const expected: Message[] = projected
        ? [
          {
            role: 'user',
            content: {
              kind: 'text',
              text:
                '[henji-context-checkpoint:v1]\ncovered-through-turn: 1\nretained-from-turn: 2\nsummary:\ncovered summary',
            },
          },
          ...retainedTurn(),
          {
            role: 'user',
            content: { kind: 'text', text: recalledExecutionProjectionText(recalled) },
          },
          task,
        ]
        : [...retainedTurn(), task];
      // Keep the actual received objects so later mutation/append cannot hide behind a clone.
      const requests: ModelRequest[] = [];
      const requestLengths: number[] = [];
      const outcome = await runAgentTurn(
        'current task',
        committed,
        {
          generate(request): ModelResult {
            requests.push(request);
            requestLengths.push(request.transcript.length);
            assertEquals(request, {
              systemInstruction: 'exact system instruction',
              transcript: expected,
              tools: registry.definitions(),
            });

            const retainedAssistant = request.transcript[projected ? 2 : 1];
            assert(retainedAssistant.role === 'assistant');
            const state = retainedAssistant.providerState as unknown as {
              replayItems: { summary: { text: string }[] }[];
            };
            state.replayItems[0].summary[0].text = 'changed by model';
            const receivedSchema = request.tools[0].inputSchema as typeof schema;
            receivedSchema.properties.payload.properties.values.items.type = 'string';
            const receivedTask = request.transcript[projected ? 4 : 2];
            assert(receivedTask.role === 'user');
            (receivedTask.content as { text: string }).text = 'changed task';
            if (requests.length > 1) {
              const assistant = request.transcript[expected.length - 2];
              assert(assistant.role === 'assistant' && Array.isArray(assistant.content));
              const argumentsValue = assistant.content[0].arguments as {
                payload: { values: number[] };
              };
              argumentsValue.payload.values.push(99);
            }

            if (requests.length === 3) return { kind: 'final', text: 'final answer' };
            const call = {
              callId: `call-${requests.length}`,
              name: 'nested_tool',
              arguments: { payload: { values: [1, 2] } },
            };
            expected.push({
              role: 'assistant',
              content: [{ kind: 'tool_call', ...call }],
              providerState: providerState(),
            }, {
              role: 'tool',
              content: [{
                kind: 'tool_result',
                callId: call.callId,
                name: call.name,
                text: 'complete tool result',
                outcome: 'success',
              }],
            });
            return { kind: 'tool_calls', calls: [call], providerState: providerState() };
          },
        },
        registry,
        {
          systemInstruction: 'exact system instruction',
          maxSteps: 3,
          ...(projected
            ? {
              projectParentRequest: (request: ModelRequest) =>
                projectRecalledExecutionContext(
                  projectSemanticContext(request, {
                    contextSchemaVersion: 1,
                    sessionId: recalled.sessionId,
                    createdAt: '2026-10-08T00:00:00.000Z',
                    sourceProfileId: 'test-profile',
                    coveredThroughTurn: 1,
                    retainedFromTurn: 2,
                    summary: 'covered summary',
                  }),
                  recalled,
                  3,
                ),
            }
            : {}),
        },
      );

      assert(outcome.ok, outcome.error);
      assertEquals(requests.length, 3);
      assertEquals(requests.map((request) => request.transcript.length), requestLengths);
      assertEquals(JSON.stringify(committed), committedBefore);
      assertEquals(JSON.stringify(registry.definitions()), definitionsBefore);
      assertEquals(outcome.transcript.slice(0, committed.length), committed);
      assert(!JSON.stringify(outcome.transcript).includes('changed'));
      assert(!JSON.stringify(outcome.transcript).includes('[henji-context-checkpoint:v1]'));
      assert(!JSON.stringify(outcome.transcript).includes('[henji-recalled-execution:v1]'));
      const calls = outcome.transcript.filter((message) =>
        message.role === 'assistant' && Array.isArray(message.content)
      );
      assertEquals(calls.length, 2);
      for (const message of calls) {
        assert(message.role === 'assistant' && Array.isArray(message.content));
        assertEquals(message.content[0].arguments, { payload: { values: [1, 2] } });
      }
    },
  );
}
