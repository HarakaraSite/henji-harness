import { assert, assertEquals } from './test_helpers.ts';
import type { Message, ModelRequest } from '../../v0/agent/contracts.ts';
import {
  checkpointMessage,
  checkpointMessageText,
  findContextCandidate,
  MAX_CHECKPOINT_MESSAGE_WIRE_BYTES,
  MAX_NEXT_DRAFT_BYTES,
  parseSummaryResult,
  projectSemanticContext,
  SEMANTIC_CONTEXT_SYSTEM_PROMPT,
  summaryEnvelope,
  summaryRequest,
} from '../../v0/agent/semantic_context.ts';
import {
  decodeSemanticContextCheckpoint,
  encodeSemanticContextCheckpoint,
  MAX_CONTEXT_CHECKPOINT_FILE_BYTES,
  MAX_CONTEXT_SUMMARY_BYTES,
  type SemanticContextCheckpointV1,
  validateSemanticContextCheckpoint,
} from '../../v0/agent/session_store.ts';
import {
  encodeRequest,
  MAX_MESSAGE_BYTES,
  MAX_REQUEST_BYTES,
  measureModelRequestWire,
} from '../../v0/agent/openrouter_model.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const checkpoint = (summary = 'compact summary'): SemanticContextCheckpointV1 => ({
  contextSchemaVersion: 1,
  sessionId,
  createdAt: '2026-01-01T00:00:00.000Z',
  sourceProfileId: 'profile',
  coveredThroughTurn: 1,
  retainedFromTurn: 2,
  summary,
});
const turns: readonly Message[] = [
  { role: 'user', content: { kind: 'text', text: 'goal' } },
  { role: 'assistant', content: { kind: 'text', text: 'first' } },
  { role: 'user', content: { kind: 'text', text: 'next' } },
  { role: 'assistant', content: { kind: 'text', text: 'second' } },
];

Deno.test('semantic summary framing and checkpoint message are exact and bounded', () => {
  assertEquals(summaryRequest(turns, 1), {
    systemInstruction: SEMANTIC_CONTEXT_SYSTEM_PROMPT,
    transcript: [{ role: 'user', content: { kind: 'text', text: summaryEnvelope(turns, 1) } }],
    tools: [],
  });
  assertEquals(JSON.parse(summaryEnvelope(turns, 1)), {
    schemaVersion: 1,
    operation: 'semantic_context_checkpoint',
    coveredThroughTurn: 1,
    retainedFromTurn: 2,
    turns: [{ turn: 1, messages: turns.slice(0, 2) }],
  });
  assertEquals(
    checkpointMessageText(1, 'compact summary'),
    '[henji-context-checkpoint:v1]\ncovered-through-turn: 1\nretained-from-turn: 2\nsummary:\ncompact summary',
  );
  assertEquals(checkpointMessage(checkpoint()), {
    role: 'user',
    content: { kind: 'text', text: checkpointMessageText(1, 'compact summary') },
  });
  assert(MAX_NEXT_DRAFT_BYTES === 4_096);
  assert(MAX_CHECKPOINT_MESSAGE_WIRE_BYTES === 16_384);
});

Deno.test('summary result and checkpoint codecs fail closed on shape, order, and byte boundaries', () => {
  assertEquals(parseSummaryResult('{"schemaVersion":1,"summary":"ok"}'), 'ok');
  assertEquals(parseSummaryResult('{"summary":"ok","schemaVersion":1}'), undefined);
  assertEquals(parseSummaryResult('```json\n{"schemaVersion":1,"summary":"ok"}\n```'), undefined);
  assertEquals(parseSummaryResult(JSON.stringify({ schemaVersion: 1, summary: 'x\0' })), undefined);
  assertEquals(
    parseSummaryResult(
      JSON.stringify({ schemaVersion: 1, summary: 'x'.repeat(MAX_CONTEXT_SUMMARY_BYTES + 1) }),
    ),
    undefined,
  );

  const bytes = encodeSemanticContextCheckpoint(checkpoint());
  assert(bytes.byteLength < MAX_CONTEXT_CHECKPOINT_FILE_BYTES);
  assertEquals(decodeSemanticContextCheckpoint(bytes), checkpoint());
  assert(validateSemanticContextCheckpoint(checkpoint()));
  const nonCanonical = new TextEncoder().encode(JSON.stringify(checkpoint()));
  let rejected = false;
  try {
    decodeSemanticContextCheckpoint(nonCanonical);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('semantic projection replaces only the covered canonical prefix and retains later messages', () => {
  const request: ModelRequest = { systemInstruction: 'startup', transcript: turns, tools: [] };
  const projected = projectSemanticContext(request, checkpoint());
  assertEquals(projected.systemInstruction, 'startup');
  assertEquals(projected.tools, []);
  assertEquals(projected.transcript.map((message) => message.role), ['user', 'user', 'assistant']);
  assertEquals(projected.transcript[0], checkpointMessage(checkpoint()));
  assertEquals(projected.transcript.slice(1), turns.slice(2));
  assertEquals(request.transcript, turns);
});

Deno.test('candidate search uses the production wire encoder and reserves a worst-case draft', () => {
  const transcript: Message[] = [];
  for (let index = 0; index < 6; index += 1) {
    transcript.push({
      role: 'user',
      content: { kind: 'text', text: `u${index} ${'a'.repeat(8_000)}` },
    });
    transcript.push({
      role: 'assistant',
      content: { kind: 'text', text: `a${index} ${'b'.repeat(8_000)}` },
    });
  }
  const candidate = findContextCandidate(transcript, {
    systemInstruction: 'startup',
    tools: [],
    sourceProfileId: 'profile',
  });
  assert(candidate !== undefined);
  assert(candidate.coveredThroughTurn >= 1 && candidate.coveredThroughTurn <= 5);
  assert(candidate.retainedFromTurn === candidate.coveredThroughTurn + 1);
  assert(candidate.projectedMessagesBytes < candidate.baselineMessagesBytes);
  assert(candidate.projectedMessagesBytes <= MAX_MESSAGE_BYTES);
  assert(measureModelRequestWire(candidate.projected.request).bodyBytes <= MAX_REQUEST_BYTES);
  const draft = transcript.concat({
    role: 'user',
    content: { kind: 'text', text: '\u0001'.repeat(MAX_NEXT_DRAFT_BYTES) },
  });
  assert(draft.at(-1)?.role === 'user');
  assert(encodeRequest({ transcript: [draft.at(-1)!], tools: [] }).messages.length === 1);
});

Deno.test('candidate search refuses N<2 and does not regress an existing boundary', () => {
  const one = [{ role: 'user', content: { kind: 'text', text: 'one' } }, {
    role: 'assistant',
    content: { kind: 'text', text: 'answer' },
  }] as const;
  assertEquals(findContextCandidate(one, { tools: [], sourceProfileId: 'profile' }), undefined);
  const long: Message[] = [];
  for (let index = 0; index < 4; index += 1) {
    long.push({ role: 'user', content: { kind: 'text', text: `u${index} ${'a'.repeat(10_000)}` } });
    long.push({
      role: 'assistant',
      content: { kind: 'text', text: `a${index} ${'b'.repeat(10_000)}` },
    });
  }
  const candidate = findContextCandidate(long, {
    tools: [],
    sourceProfileId: 'profile',
    checkpoint: { ...checkpoint(), coveredThroughTurn: 3, retainedFromTurn: 4 },
  });
  assertEquals(candidate, undefined);
});
