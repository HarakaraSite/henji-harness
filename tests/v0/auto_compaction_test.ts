import { AgentSession } from '../../v0/agent/session/session.ts';
import type { Message, ModelRequest, ModelResult } from '../../v0/agent/core/contracts.ts';
import type { SemanticContextCheckpointV1 } from '../../v0/agent/session/session_store.ts';
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

const longRecord = (turns: number) => {
  const transcript: Message[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    transcript.push({ role: 'user', content: { kind: 'text', text: `task-${turn}` } });
    transcript.push({
      role: 'assistant',
      content: { kind: 'text', text: big(`answer-${turn}`) },
    });
  }
  return {
    schemaVersion: 1 as const,
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspaceRoot: '/workspace',
    agent: 'default' as const,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    nextTurn: turns + 1,
    transcript,
  };
};

const installed: SemanticContextCheckpointV1[] = [];

const persistence = () => ({
  record: undefined,
  commit: () => {},
  rollback: () => {},
  installCheckpoint: (checkpoint: SemanticContextCheckpointV1) => {
    installed.push(checkpoint);
  },
  close: () => {},
});

const summaryResult = (): ModelResult => ({
  kind: 'final' as const,
  text: '{"schemaVersion":1,"summary":"condensed history"}',
});

Deno.test('Long sessions start without automatic compaction and retain explicit compaction', async () => {
  installed.length = 0;
  let summaryCalls = 0;
  let turnCalls = 0;
  const session = new AgentSession(
    {
      generate: () => {
        turnCalls += 1;
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: longRecord(2),
      persistence: persistence(),
      summarizeContext: () => {
        summaryCalls += 1;
        return summaryResult();
      },
      sourceProfileId: 'test-profile',
    },
  );
  const outcome = await session.submit('next question');
  assert(outcome.ok);
  assertEquals(summaryCalls, 0);
  assertEquals(turnCalls, 1);
  assertEquals(installed.length, 0);
  assertEquals(session.consumeAutoCompactionNotice(), null);

  const explicit = await session.compactContext();
  assertEquals(explicit.kind, 'installed');
  assertEquals(summaryCalls, 1);
  assertEquals(installed.length, 1);
});

Deno.test('A configured summarizer failure cannot block submit while automation is stopped', async () => {
  installed.length = 0;
  let turnCalls = 0;
  const before = longRecord(2);
  const session = new AgentSession(
    {
      generate: () => {
        turnCalls += 1;
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: before,
      persistence: persistence(),
      summarizeContext: () => {
        throw new Error('summary boom');
      },
      sourceProfileId: 'test-profile',
    },
  );
  const outcome = await session.submit('next question');
  assert(outcome.ok);
  assertEquals(turnCalls, 1);
  assertEquals(installed.length, 0);
  assertEquals(session.transcriptSnapshot().length, before.transcript.length + 2);
  assertEquals(session.consumeAutoCompactionNotice(), null);
});

Deno.test('An existing semantic checkpoint still projects summary and exact suffix', async () => {
  const initial = longRecord(2);
  const checkpoint: SemanticContextCheckpointV1 = {
    contextSchemaVersion: 1,
    sessionId: initial.sessionId,
    createdAt: '2026-09-10T00:00:00.000Z',
    sourceProfileId: 'test-profile',
    coveredThroughTurn: 1,
    retainedFromTurn: 2,
    summary: 'semantic first-turn summary',
  };
  let observed: ModelRequest | undefined;
  const session = new AgentSession(
    {
      generate: (request) => {
        observed = structuredClone(request);
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([]),
    {
      initialRecord: initial,
      persistence: { ...persistence(), checkpoint },
      sourceProfileId: 'test-profile',
    },
  );
  assert((await session.submit('next question')).ok);
  assert(observed !== undefined);
  const projected = JSON.stringify(observed.transcript);
  assert(projected.includes('semantic first-turn summary'));
  assert(projected.includes('task-2'));
  assert(projected.includes('answer-2'));
  assert(projected.includes('next question'));
  assert(!projected.includes('answer-1'));
});

Deno.test('Model steps retain a tool result larger than the former 64 KiB trigger', async () => {
  const resultText = big('complete-tool-result');
  const requests: ModelRequest[] = [];
  const session = new AgentSession(
    {
      generate: (request) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return {
            kind: 'tool_calls' as const,
            calls: [{ callId: 'large-1', name: 'large_tool', arguments: {} }],
          };
        }
        return { kind: 'final', text: 'answer' };
      },
    },
    new Registry([{
      name: 'large_tool',
      description: 'Return one large observed result',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: () => resultText,
    }]),
  );
  const outcome = await session.submit('use the large tool');
  assert(outcome.ok);
  assertEquals(requests.length, 2);
  const tool = requests[1].transcript.find((message) => message.role === 'tool');
  assert(tool?.role === 'tool');
  assertEquals(tool.content[0]?.text, resultText);
  assert(!JSON.stringify(requests[1]).includes('[older tool result omitted for context]'));
});
