import { assert, assertEquals } from './test_helpers.ts';
import type { Message } from '../../v0/agent/contracts.ts';
import { createAgentResourceSelection } from '../../v0/agent/resource_identity.ts';
import { createAgentResolvedManifest } from '../../v0/agent/resolved_manifest.ts';
import {
  AgentReplayEnvelopeError,
  agentReplayEnvelopePayload,
  createAgentReplayEnvelope,
  validateAgentReplayEnvelope,
  workspaceContentDigest,
} from '../../v0/agent/replay_envelope.ts';
import {
  AgentReplayValueError,
  cloneReplayJsonValue,
  cloneReplayMessage,
  cloneReplayTranscript,
  parseReplayCausalTranscript,
} from '../../v0/agent/replay_value.ts';
import {
  AgentExecutionRecordError,
  agentExecutionRecordRepresentation,
  createAgentExecutionRecorder,
  validateAgentExecutionRecord,
} from '../../v0/agent/execution_record.ts';

const DENO_MODEL = 'model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0';
const DEFAULT_RESOURCES = [
  DENO_MODEL,
  'tool:bash',
  'tool:delegate_to_planner',
  'tool:edit',
  'tool:read',
  'tool:submit_json_result',
  'tool:write',
  'subagent:planner',
] as const;
const encoder = new TextEncoder();

const manifest = async (maxSteps = 8) =>
  await createAgentResolvedManifest(
    maxSteps === 8 ? 'default' : 'default-max-steps-4',
    createAgentResourceSelection(DEFAULT_RESOURCES, maxSteps),
  );

const envelope = async (maxSteps = 8) => {
  const resolved = await manifest(maxSteps);
  const alpha = await workspaceContentDigest(encoder.encode('alpha\n'));
  const beta = await workspaceContentDigest(encoder.encode('beta\n'));
  return await createAgentReplayEnvelope({
    caseId: 'v1.fixed.final',
    task: 'Return OK.',
    workspace: {
      entries: [
        { path: 'AGENTS.md', digest: alpha },
        { path: 'deno.v0.json', digest: beta },
      ],
    },
    modelIdentity: DENO_MODEL,
    budget: {
      maxSteps,
      modelRequests: { parent: maxSteps, planner: 8, aggregate: maxSteps + 8 },
      maxExternalRequests: maxSteps + 8,
      maxWallTimeMicros: 60_000_000,
    },
    initialTranscript: [],
    manifest: resolved,
  });
};

const expectInvalid = async (
  operation: () => unknown | Promise<unknown>,
  marker?: string,
): Promise<void> => {
  let rejected = false;
  try {
    await operation();
  } catch (error) {
    rejected = error instanceof AgentReplayValueError ||
      error instanceof AgentReplayEnvelopeError ||
      error instanceof AgentExecutionRecordError;
    assert(rejected, 'unexpected error class');
    if (error instanceof AgentReplayValueError) {
      assertEquals(error.name, 'AgentReplayValueError');
      assertEquals(error.message, 'invalid replay value');
    } else if (error instanceof AgentReplayEnvelopeError) {
      assertEquals(error.name, 'AgentReplayEnvelopeError');
      assertEquals(error.message, 'invalid agent replay envelope');
    } else if (error instanceof AgentExecutionRecordError) {
      assertEquals(error.name, 'AgentExecutionRecordError');
      assertEquals(error.message, 'invalid agent execution record');
    }
    if (marker !== undefined) {
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : '';
      assert(!detail.includes(marker));
    }
  }
  assert(rejected, 'expected sanitized rejection');
};

Deno.test('replay envelope and workspace identities match fixed schema-v1 known answers', async () => {
  const result = await envelope();
  assertEquals(
    await workspaceContentDigest(encoder.encode('alpha\n')),
    'henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf',
  );
  assertEquals(
    await workspaceContentDigest(encoder.encode('beta\n')),
    'henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4',
  );
  assertEquals(
    new TextDecoder().decode(agentReplayEnvelopePayload(result)),
    '{"schemaVersion":1,"caseId":"v1.fixed.final","task":"Return OK.","workspace":{"entries":[{"path":"AGENTS.md","digest":"henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf"},{"path":"deno.v0.json","digest":"henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4"}]},"modelIdentity":"model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","budget":{"maxSteps":8,"modelRequests":{"parent":8,"planner":8,"aggregate":16},"maxExternalRequests":16,"maxWallTimeMicros":60000000},"initialTranscript":[],"manifest":{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8},"identity":"henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58"}}',
  );
  assertEquals(
    result.identity,
    'henji-agent-replay-envelope:v1:sha256:8779910633ac41ff36b9aec498d80f0c525aac16279c431ef5a8382797f9fa72',
  );
  const restored = await validateAgentReplayEnvelope(JSON.parse(JSON.stringify(result)));
  assertEquals(JSON.stringify(restored), JSON.stringify(result));
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.manifest));
  assert(Object.isFrozen(result.workspace.entries));
});

Deno.test('replay value is descriptor-safe, bounded, canonical, and causally strict', async () => {
  const source = { a: [1, { b: 'value' }] };
  const clone = cloneReplayJsonValue(source);
  assertEquals(JSON.stringify(clone), JSON.stringify(source));
  assert(Object.isFrozen(clone));
  assert(Object.isFrozen((clone as readonly unknown[])[1]));
  assertEquals(
    cloneReplayMessage({ role: 'user', content: { kind: 'text', text: '' } }).role,
    'user',
  );
  const completed = [
    { role: 'user' as const, content: { kind: 'text' as const, text: 'task' } },
    {
      role: 'assistant' as const,
      content: [{ kind: 'tool_call' as const, callId: 'c', name: 'read', arguments: {} }],
    },
    {
      role: 'tool' as const,
      content: [{
        kind: 'tool_result' as const,
        callId: 'c',
        name: 'read',
        text: 'ok',
        outcome: 'success' as const,
        terminal: 'json_result' as const,
      }],
    },
  ];
  const transcript = cloneReplayTranscript(completed, { min: 1, maxBytes: 262_144 });
  assertEquals(parseReplayCausalTranscript(transcript), 1);
  await expectInvalid(() => cloneReplayJsonValue(NaN));
  await expectInvalid(() => cloneReplayJsonValue(-0));
  await expectInvalid(() =>
    cloneReplayJsonValue(
      Object.defineProperty({}, 'secret', { get: () => 'leak', enumerable: true }),
    )
  );
  await expectInvalid(() => cloneReplayJsonValue(Object.assign([], { extra: true })));
  await expectInvalid(() =>
    cloneReplayMessage({
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: 'c', name: 'BAD', arguments: {} }],
    })
  );
  assertEquals(cloneReplayJsonValue('x'.repeat(65_534)), 'x'.repeat(65_534));
  await expectInvalid(() => cloneReplayJsonValue('x'.repeat(65_535)));
  assertEquals(cloneReplayJsonValue('\ud83d\ude00'), '😀');
  await expectInvalid(() => cloneReplayJsonValue('\ud83d'));
  await expectInvalid(() => cloneReplayJsonValue('\ude00'));
  const exactNodes = Array.from({ length: 255 }, () => Array(15).fill(null));
  exactNodes.push(Array(14).fill(null));
  assertEquals(
    JSON.stringify(cloneReplayJsonValue(exactNodes)).length,
    JSON.stringify(exactNodes).length,
  );
  await expectInvalid(() =>
    cloneReplayJsonValue([...exactNodes.slice(0, -1), Array(15).fill(null)])
  );
  const callId = '😀'.repeat(32);
  const unicodeMessage = cloneReplayMessage({
    role: 'assistant',
    content: [{ kind: 'tool_call', callId, name: 'read', arguments: {} }],
  });
  assertEquals(
    JSON.stringify(unicodeMessage),
    JSON.stringify({
      role: 'assistant',
      content: [{ kind: 'tool_call', callId, name: 'read', arguments: {} }],
    }),
  );
  await expectInvalid(() =>
    cloneReplayMessage({
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: `${callId}😀`, name: 'read', arguments: {} }],
    })
  );
  assertEquals(
    parseReplayCausalTranscript(cloneReplayTranscript(completed.slice(0, 2), { min: 1 })),
    undefined,
  );
});

Deno.test('envelope field correlation and sanitized malformed shapes fail closed', async () => {
  const base = await envelope();
  const mutate = (changes: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: 1,
    caseId: base.caseId,
    task: base.task,
    workspace: base.workspace,
    modelIdentity: base.modelIdentity,
    budget: base.budget,
    initialTranscript: base.initialTranscript,
    manifest: base.manifest,
    identity: base.identity,
    ...changes,
  });
  for (
    const value of [
      mutate({ caseId: '' }),
      mutate({ task: '' }),
      mutate({ modelIdentity: 'model:fake:other' }),
      mutate({
        workspace: { entries: [{ path: '../secret', digest: base.workspace.entries[0].digest }] },
      }),
      mutate({
        workspace: {
          entries: [{ path: 'b', digest: base.workspace.entries[0].digest }, {
            path: 'a',
            digest: base.workspace.entries[1].digest,
          }],
        },
      }),
      mutate({ budget: { ...base.budget, maxExternalRequests: 17 } }),
      mutate({ identity: base.identity.replace(/.$/, '0') }),
      { ...mutate({}), extra: true },
    ]
  ) await expectInvalid(() => validateAgentReplayEnvelope(value));
  const input = {
    caseId: base.caseId,
    task: base.task,
    workspace: base.workspace,
    modelIdentity: base.modelIdentity,
    budget: base.budget,
    initialTranscript: base.initialTranscript,
    manifest: base.manifest,
  };
  const second = await createAgentReplayEnvelope(input);
  assertEquals(second.identity, base.identity);
  const variant = await envelope(4);
  assert(variant.identity !== base.identity);
});

Deno.test('envelope identity validation never coerces hostile values and owns its snapshot', async () => {
  const base = await envelope();
  const marker = 'credential-secret-marker';
  let toStringCalls = 0;
  let toJsonCalls = 0;
  const hostile = {
    toString: () => {
      toStringCalls += 1;
      return marker;
    },
    toJSON: () => {
      toJsonCalls += 1;
      return marker;
    },
  };
  await expectInvalid(() =>
    validateAgentReplayEnvelope({
      ...base,
      workspace: { entries: [{ path: 'AGENTS.md', digest: hostile as unknown as string }] },
    }), marker);
  await expectInvalid(
    () => validateAgentReplayEnvelope({ ...base, identity: hostile as unknown as string }),
    marker,
  );
  assertEquals(toStringCalls, 0);
  assertEquals(toJsonCalls, 0);

  const alpha = base.workspace.entries[0].digest;
  const beta = base.workspace.entries[1].digest;
  const workspace = {
    entries: [
      { path: 'AGENTS.md', digest: alpha },
      { path: 'deno.v0.json', digest: beta },
    ],
  };
  const source = {
    caseId: base.caseId,
    task: base.task,
    workspace,
    modelIdentity: base.modelIdentity,
    budget: base.budget,
    initialTranscript: base.initialTranscript,
    manifest: base.manifest,
  };
  const result = await createAgentReplayEnvelope(source);
  const beforePayload = new TextDecoder().decode(agentReplayEnvelopePayload(result));
  workspace.entries[0].digest = beta;
  workspace.entries.push({ path: 'late.txt', digest: alpha });
  source.task = marker;
  assertEquals(new TextDecoder().decode(agentReplayEnvelopePayload(result)), beforePayload);
  assertEquals(result.identity, base.identity);
});

Deno.test('envelope snapshots primitive identities before delayed manifest validation', async () => {
  const base = await envelope();
  const alpha = base.workspace.entries[0].digest;
  const beta = base.workspace.entries[1].digest;
  const input = (modelIdentity: string) => ({
    caseId: base.caseId,
    task: base.task,
    workspace: {
      entries: [
        { path: 'AGENTS.md', digest: alpha },
        { path: 'deno.v0.json', digest: beta },
      ],
    },
    modelIdentity,
    budget: {
      maxSteps: base.budget.maxSteps,
      modelRequests: { ...base.budget.modelRequests },
      maxExternalRequests: base.budget.maxExternalRequests,
      maxWallTimeMicros: base.budget.maxWallTimeMicros,
    },
    initialTranscript: [],
    manifest: base.manifest,
  });

  const constructorValidToInvalid = input(base.modelIdentity);
  const constructorValidPromise = createAgentReplayEnvelope(constructorValidToInvalid);
  constructorValidToInvalid.modelIdentity = 'model:fake:mutated';
  assertEquals((await constructorValidPromise).identity, base.identity);

  const constructorInvalidToValid = input('model:fake:mutated');
  const constructorInvalidPromise = createAgentReplayEnvelope(constructorInvalidToValid);
  constructorInvalidToValid.modelIdentity = base.modelIdentity;
  await expectInvalid(() => constructorInvalidPromise);

  const validatorValidToInvalid = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const validatorValidPromise = validateAgentReplayEnvelope(validatorValidToInvalid);
  validatorValidToInvalid.identity = base.identity.replace(/.$/, '0');
  assertEquals((await validatorValidPromise).identity, base.identity);

  const validatorInvalidToValid = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  validatorInvalidToValid.identity = base.identity.replace(/.$/, '0');
  const validatorInvalidPromise = validateAgentReplayEnvelope(validatorInvalidToValid);
  validatorInvalidToValid.identity = base.identity;
  await expectInvalid(() => validatorInvalidPromise);
});

Deno.test('envelope constructor and validator share strict malformed Unicode rejection', async () => {
  const base = await envelope();
  const alpha = base.workspace.entries[0].digest;
  const beta = base.workspace.entries[1].digest;
  const malformed = ['\ud83d', '\ude00', '\ud83dA', 'A\ude00', '\ud83d\ud83d', '\ude00\ud83d'];
  const input = (task: string, path: string) => ({
    caseId: base.caseId,
    task,
    workspace: {
      entries: [
        { path, digest: alpha },
        { path: 'deno.v0.json', digest: beta },
      ],
    },
    modelIdentity: base.modelIdentity,
    budget: {
      maxSteps: base.budget.maxSteps,
      modelRequests: { ...base.budget.modelRequests },
      maxExternalRequests: base.budget.maxExternalRequests,
      maxWallTimeMicros: base.budget.maxWallTimeMicros,
    },
    initialTranscript: [],
    manifest: base.manifest,
  });
  for (const text of malformed) {
    await expectInvalid(() => createAgentReplayEnvelope(input(text, 'AGENTS.md')));
    await expectInvalid(() => createAgentReplayEnvelope(input(base.task, `AGENTS${text}.md`)));

    const invalidTask = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    invalidTask.task = text;
    await expectInvalid(() => validateAgentReplayEnvelope(invalidTask));
    const invalidPath = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const entries = (invalidPath.workspace as Record<string, unknown>).entries as Array<
      Record<string, unknown>
    >;
    entries[0].path = `AGENTS${text}.md`;
    await expectInvalid(() => validateAgentReplayEnvelope(invalidPath));
  }
});

const finalTranscript = [
  { role: 'user' as const, content: { kind: 'text' as const, text: 'Return OK.' } },
  { role: 'assistant' as const, content: { kind: 'text' as const, text: 'OK' } },
];
const taskOnly = [{
  role: 'user' as const,
  content: { kind: 'text' as const, text: 'Return OK.' },
}];

Deno.test('poisoned recorder produces the fixed final record and rejects reuse', async () => {
  const fixedEnvelope = await envelope();
  let clockReads = 0;
  const recorder = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 1,
    clock: () => (++clockReads === 1 ? 1000 : 2250),
  });
  recorder.recordModelCall({ role: 'parent', resultKind: 'final' });
  const record = recorder.finish({
    outcome: { ok: true, stopReason: 'final', committed: true, terminalKind: 'none' },
    externalRequests: 1,
    transcript: finalTranscript,
  });
  assertEquals(clockReads, 2);
  assertEquals(
    new TextDecoder().decode(agentExecutionRecordRepresentation(record, fixedEnvelope)),
    '{"schemaVersion":1,"runOrdinal":1,"envelopeIdentity":"henji-agent-replay-envelope:v1:sha256:8779910633ac41ff36b9aec498d80f0c525aac16279c431ef5a8382797f9fa72","manifestIdentity":"henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58","durationMicros":1250,"outcome":{"ok":true,"stopReason":"final","committed":true,"terminalKind":"none"},"usage":{"steps":1,"modelRequests":{"parent":1,"planner":0,"aggregate":1},"externalRequests":1,"toolCalls":{"parent":0,"planner":0,"aggregate":0},"toolResults":{"parent":0,"planner":0,"aggregate":0},"providerTokenUsage":"unsupported","cost":"unsupported"},"modelCalls":[{"ordinal":1,"role":"parent","roleOrdinal":1,"resultKind":"final"}],"toolCalls":[],"toolResults":[],"transcript":[{"role":"user","content":{"kind":"text","text":"Return OK."}},{"role":"assistant","content":{"kind":"text","text":"OK"}}]}',
  );
  assert(Object.isFrozen(record));
  let rejected = false;
  try {
    recorder.finish({
      outcome: { ok: true, stopReason: 'final', committed: true, terminalKind: 'none' },
      externalRequests: 1,
      transcript: finalTranscript,
    });
  } catch (error) {
    rejected = error instanceof AgentExecutionRecordError;
  }
  assert(rejected);
  assertEquals(validateAgentExecutionRecord(record, fixedEnvelope).durationMicros, 1250);
});

Deno.test('recorder correlates terminal tool observations, planner counts, and partial cancellation prefixes', async () => {
  const fixedEnvelope = await envelope();
  const terminalTranscript = [
    { role: 'user' as const, content: { kind: 'text' as const, text: 'Return OK.' } },
    {
      role: 'assistant' as const,
      content: [{
        kind: 'tool_call' as const,
        callId: 'submit',
        name: 'submit_json_result',
        arguments: { value: 'OK' },
      }],
    },
    {
      role: 'tool' as const,
      content: [{
        kind: 'tool_result' as const,
        callId: 'submit',
        name: 'submit_json_result',
        text: 'OK',
        outcome: 'success' as const,
        terminal: 'json_result' as const,
      }],
    },
  ];
  const terminal = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 2,
    clock: () => 1,
  });
  terminal.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  terminal.recordToolCall({
    role: 'parent',
    callId: 'submit',
    name: 'submit_json_result',
    arguments: { value: 'OK' },
  });
  terminal.recordToolResult({
    role: 'parent',
    callId: 'submit',
    name: 'submit_json_result',
    outcome: 'success',
    terminal: 'json_result',
    result: { value: 'OK' },
  });
  const terminalRecord = terminal.finish({
    outcome: {
      ok: true,
      stopReason: 'tool_terminal',
      committed: true,
      terminalKind: 'json_result',
    },
    externalRequests: 1,
    transcript: terminalTranscript,
  });
  assertEquals(terminalRecord.usage.toolResults.aggregate, 1);

  const partial = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 3,
    clock: () => 1,
  });
  partial.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  partial.recordToolCall({ role: 'parent', callId: 'one', name: 'read', arguments: {} });
  partial.recordToolCall({ role: 'parent', callId: 'two', name: 'read', arguments: {} });
  partial.recordToolResult({
    role: 'parent',
    callId: 'one',
    name: 'read',
    outcome: 'success',
    result: { text: 'ok' },
  });
  const partialRecord = partial.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: [
      { role: 'user', content: { kind: 'text', text: 'Return OK.' } },
      {
        role: 'assistant',
        content: [
          { kind: 'tool_call', callId: 'one', name: 'read', arguments: {} },
          { kind: 'tool_call', callId: 'two', name: 'read', arguments: {} },
        ],
      },
    ],
  });
  assertEquals(partialRecord.toolCalls.length, 2);
  assertEquals(partialRecord.toolResults.length, 1);
  assertEquals(partialRecord.usage.steps, 1);
});

Deno.test('recorder rejects malformed and duplicate results immediately and poisons for reuse', async () => {
  const fixedEnvelope = await envelope();
  const malformed = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 4,
    clock: () => 1,
  });
  malformed.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  malformed.recordToolCall({ role: 'parent', callId: 'one', name: 'read', arguments: {} });
  malformed.recordToolResult({
    role: 'parent',
    callId: 'one',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  await expectInvalid(() =>
    malformed.recordToolResult({
      role: 'parent',
      callId: 'one',
      name: 'read',
      outcome: 'success',
      result: {},
    })
  );
  await expectInvalid(() => malformed.recordModelCall({ role: 'parent', resultKind: 'final' }));
  await expectInvalid(() =>
    malformed.finish({
      outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
      externalRequests: 1,
      transcript: [
        { role: 'user', content: { kind: 'text', text: 'Return OK.' } },
        {
          role: 'assistant',
          content: [{ kind: 'tool_call', callId: 'one', name: 'read', arguments: {} }],
        },
      ],
    })
  );

  const invalidField = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 5,
    clock: () => 1,
  });
  invalidField.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  invalidField.recordToolCall({ role: 'parent', callId: 'bad', name: 'read', arguments: {} });
  await expectInvalid(() =>
    invalidField.recordToolResult({
      role: 'parent',
      callId: 'bad',
      name: 'read',
      outcome: 'not-an-outcome' as 'success',
      result: {},
    })
  );
  await expectInvalid(() =>
    invalidField.recordToolResult({
      role: 'parent',
      callId: 'bad',
      name: 'read',
      outcome: 'success',
      terminal: 'json_result',
      result: {},
    })
  );

  const bounded = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 6,
    clock: () => 1,
  });
  for (let model = 0; model < 16; model += 1) {
    bounded.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
    for (let call = 0; call < 32; call += 1) {
      bounded.recordToolCall({
        role: 'parent',
        callId: `call-${model}-${call}`,
        name: 'read',
        arguments: {},
      });
    }
  }
  for (let result = 0; result < 512; result += 1) {
    bounded.recordToolResult({
      role: 'parent',
      callOrdinal: result + 1,
      callId: `call-${Math.floor(result / 32)}-${result % 32}`,
      name: 'read',
      outcome: 'success',
      result: {},
    });
  }
  await expectInvalid(() =>
    bounded.recordToolResult({
      role: 'parent',
      callOrdinal: 1,
      callId: 'call-0-0',
      name: 'read',
      outcome: 'success',
      result: {},
    })
  );
  await expectInvalid(() =>
    bounded.recordToolCall({
      role: 'parent',
      callId: 'late',
      name: 'read',
      arguments: {},
    })
  );
});

Deno.test('records all stop families, zero-observation outcomes, and planner interleaving', async () => {
  const fixedEnvelope = await envelope();
  const cancelled = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 7,
    clock: () => 1,
  });
  const cancelledRecord = cancelled.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 0,
    transcript: taskOnly,
  });
  assertEquals(cancelledRecord.usage.steps, 0);

  const failed = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 8,
    clock: () => 1,
  });
  failed.recordModelCall({ role: 'parent', resultKind: 'error' });
  const failedRecord = failed.finish({
    outcome: { ok: false, stopReason: 'contract_failure', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: taskOnly,
  });
  assertEquals(failedRecord.modelCalls[0].resultKind, 'error');

  const dispatchCancelled = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 9,
    clock: () => 1,
  });
  dispatchCancelled.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  dispatchCancelled.recordToolCall({ role: 'parent', callId: 'one', name: 'read', arguments: {} });
  dispatchCancelled.recordToolCall({ role: 'parent', callId: 'two', name: 'read', arguments: {} });
  const dispatchCancelledRecord = dispatchCancelled.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: [
      ...taskOnly,
      {
        role: 'assistant',
        content: [
          { kind: 'tool_call', callId: 'one', name: 'read', arguments: {} },
          { kind: 'tool_call', callId: 'two', name: 'read', arguments: {} },
        ],
      },
    ],
  });
  assertEquals(dispatchCancelledRecord.toolCalls.length, 2);
  assertEquals(dispatchCancelledRecord.toolResults.length, 0);

  const terminalCancelled = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 11,
    clock: () => 1,
  });
  terminalCancelled.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  terminalCancelled.recordToolCall({
    role: 'parent',
    callId: 'submit',
    name: 'submit_json_result',
    arguments: { value: 'OK' },
  });
  terminalCancelled.recordToolResult({
    role: 'parent',
    callId: 'submit',
    name: 'submit_json_result',
    outcome: 'success',
    terminal: 'json_result',
    result: { value: 'OK' },
  });
  const terminalCancelledRecord = terminalCancelled.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: [
      ...taskOnly,
      {
        role: 'assistant',
        content: [{
          kind: 'tool_call',
          callId: 'submit',
          name: 'submit_json_result',
          arguments: { value: 'OK' },
        }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'submit',
          name: 'submit_json_result',
          text: 'OK',
          outcome: 'success',
          terminal: 'json_result',
        }],
      },
    ],
  });
  assertEquals(terminalCancelledRecord.outcome.terminalKind, 'none');
  const terminalFailure = {
    ...terminalCancelledRecord,
    outcome: {
      ok: false,
      stopReason: 'contract_failure' as const,
      committed: false,
      terminalKind: 'none' as const,
    },
  };
  assertEquals(
    validateAgentExecutionRecord(terminalFailure, fixedEnvelope).outcome.stopReason,
    'contract_failure',
  );

  const max = createAgentExecutionRecorder({
    envelope: await envelope(4),
    runOrdinal: 12,
    clock: () => 1,
  });
  const maxTranscript: Message[] = [...taskOnly];
  for (let step = 0; step < 4; step += 1) {
    max.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
    max.recordToolCall({ role: 'parent', callId: `max-${step}`, name: 'read', arguments: {} });
    max.recordToolResult({
      role: 'parent',
      callId: `max-${step}`,
      name: 'read',
      outcome: 'success',
      result: {},
    });
    maxTranscript.push({
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: `max-${step}`, name: 'read', arguments: {} }],
    });
    maxTranscript.push({
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: `max-${step}`,
        name: 'read',
        text: 'ok',
        outcome: 'success',
      }],
    });
  }
  const maxRecord = max.finish({
    outcome: { ok: false, stopReason: 'max_steps', committed: false, terminalKind: 'none' },
    externalRequests: 4,
    transcript: maxTranscript,
  });
  assertEquals(maxRecord.usage.steps, 4);

  const interleaved = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 13,
    clock: () => 1,
  });
  interleaved.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  interleaved.recordModelCall({ role: 'planner', resultKind: 'tool_calls' });
  interleaved.recordModelCall({ role: 'parent', resultKind: 'final' });
  interleaved.recordToolCall({ role: 'parent', callId: 'parent', name: 'read', arguments: {} });
  interleaved.recordToolCall({
    role: 'planner',
    modelCallOrdinal: 2,
    callId: 'planner',
    name: 'read',
    arguments: {},
  });
  interleaved.recordToolResult({
    role: 'planner',
    callOrdinal: 2,
    callId: 'planner',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  interleaved.recordToolResult({
    role: 'parent',
    callOrdinal: 1,
    callId: 'parent',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  const interleavedRecord = interleaved.finish({
    outcome: { ok: true, stopReason: 'final', committed: false, terminalKind: 'none' },
    externalRequests: 3,
    transcript: [
      ...taskOnly,
      {
        role: 'assistant',
        content: [{ kind: 'tool_call', callId: 'parent', name: 'read', arguments: {} }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'parent',
          name: 'read',
          text: 'ok',
          outcome: 'success',
        }],
      },
      { role: 'assistant', content: { kind: 'text', text: 'OK' } },
    ],
  });
  assertEquals(interleavedRecord.usage.modelRequests, { parent: 2, planner: 1, aggregate: 3 });
  assertEquals(interleavedRecord.toolResults.map((result) => result.callOrdinal), [2, 1]);
});

Deno.test('recorder rejects non-prefix dispatch/result order and wall-clock overflow', async () => {
  const fixedEnvelope = await envelope();
  const partial = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 14,
    clock: () => 1,
  });
  partial.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  partial.recordToolCall({ role: 'parent', callId: 'one', name: 'read', arguments: {} });
  partial.recordToolCall({ role: 'parent', callId: 'two', name: 'read', arguments: {} });
  partial.recordToolResult({
    role: 'parent',
    callId: 'one',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  const valid = partial.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: [
      ...taskOnly,
      {
        role: 'assistant',
        content: [
          { kind: 'tool_call', callId: 'one', name: 'read', arguments: {} },
          { kind: 'tool_call', callId: 'two', name: 'read', arguments: {} },
        ],
      },
    ],
  });
  const nonPrefix = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  const calls = nonPrefix.toolCalls as Array<Record<string, unknown>>;
  const first = { ...calls[0] };
  calls[0] = { ...calls[1], ordinal: 1, roleOrdinal: 1 };
  calls[1] = { ...first, ordinal: 2, roleOrdinal: 2 };
  const results = nonPrefix.toolResults as Array<Record<string, unknown>>;
  results[0].callId = 'two';
  await expectInvalid(() => validateAgentExecutionRecord(nonPrefix, fixedEnvelope));

  const reorderedRecorder = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 15,
    clock: () => 1,
  });
  reorderedRecorder.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
  reorderedRecorder.recordToolCall({ role: 'parent', callId: 'one', name: 'read', arguments: {} });
  reorderedRecorder.recordToolCall({ role: 'parent', callId: 'two', name: 'read', arguments: {} });
  reorderedRecorder.recordToolResult({
    role: 'parent',
    callOrdinal: 1,
    callId: 'one',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  reorderedRecorder.recordToolResult({
    role: 'parent',
    callOrdinal: 2,
    callId: 'two',
    name: 'read',
    outcome: 'success',
    result: {},
  });
  const reordered = JSON.parse(JSON.stringify(reorderedRecorder.finish({
    outcome: { ok: false, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
    externalRequests: 1,
    transcript: [
      ...taskOnly,
      {
        role: 'assistant',
        content: [
          { kind: 'tool_call', callId: 'one', name: 'read', arguments: {} },
          { kind: 'tool_call', callId: 'two', name: 'read', arguments: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { kind: 'tool_result', callId: 'one', name: 'read', text: 'ok', outcome: 'success' },
          { kind: 'tool_result', callId: 'two', name: 'read', text: 'ok', outcome: 'success' },
        ],
      },
    ],
  }))) as Record<string, unknown>;
  const reorderedResults = reordered.toolResults as Array<Record<string, unknown>>;
  const firstResult = { ...reorderedResults[0] };
  reorderedResults[0] = { ...reorderedResults[1], ordinal: 1, roleOrdinal: 1 };
  reorderedResults[1] = { ...firstResult, ordinal: 2, roleOrdinal: 2 };
  await expectInvalid(() => validateAgentExecutionRecord(reordered, fixedEnvelope));

  const wall = createAgentExecutionRecorder({
    envelope: fixedEnvelope,
    runOrdinal: 17,
    clock: (() => {
      let reads = 0;
      return () => ++reads === 1 ? 1 : 60_000_002;
    })(),
  });
  await expectInvalid(() =>
    wall.finish({
      outcome: {
        ok: false,
        stopReason: 'contract_failure',
        committed: false,
        terminalKind: 'none',
      },
      externalRequests: 0,
      transcript: taskOnly,
    })
  );
});

Deno.test('record identity is envelope/run ordinal, never duration, and unsupported usage cannot be fabricated', async () => {
  const fixedEnvelope = await envelope();
  const make = (start: number, end: number) => {
    const recorder = createAgentExecutionRecorder({
      envelope: fixedEnvelope,
      runOrdinal: 10,
      clock: () => start === end ? start : (++reads === 1 ? start : end),
    });
    recorder.recordModelCall({ role: 'parent', resultKind: 'final' });
    return recorder.finish({
      outcome: { ok: true, stopReason: 'final', committed: false, terminalKind: 'none' },
      externalRequests: 1,
      transcript: finalTranscript,
    });
  };
  let reads = 0;
  const zero = make(10, 10);
  reads = 0;
  const delayed = make(10, 20);
  assertEquals(zero.envelopeIdentity, delayed.envelopeIdentity);
  assert(zero.durationMicros !== delayed.durationMicros);
  assert(!Object.hasOwn(zero, 'identity'));
  const malformed = JSON.parse(JSON.stringify(zero)) as Record<string, unknown>;
  malformed.usage = { ...(malformed.usage as Record<string, unknown>), providerTokenUsage: 0 };
  await expectInvalid(() => validateAgentExecutionRecord(malformed, fixedEnvelope));
});

Deno.test('record validator rejects semantic stop, ordinal, bound, shape, and leakage mutations', async () => {
  const fixedEnvelope = await envelope();
  const makeFinalRecord = (runOrdinal: number) => {
    const recorder = createAgentExecutionRecorder({
      envelope: fixedEnvelope,
      runOrdinal,
      clock: () => 1,
    });
    recorder.recordModelCall({ role: 'parent', resultKind: 'final' });
    return recorder.finish({
      outcome: { ok: true, stopReason: 'final', committed: false, terminalKind: 'none' },
      externalRequests: 1,
      transcript: finalTranscript,
    });
  };
  const valid = makeFinalRecord(18);
  const mutate = (changes: Record<string, unknown>): Record<string, unknown> => ({
    ...JSON.parse(JSON.stringify(valid)),
    ...changes,
  });
  for (
    const [index, outcome] of [
      { ok: false, stopReason: 'final', committed: false, terminalKind: 'none' },
      { ok: true, stopReason: 'cancelled', committed: false, terminalKind: 'none' },
      { ok: false, stopReason: 'contract_failure', committed: true, terminalKind: 'none' },
      { ok: true, stopReason: 'final', committed: false, terminalKind: 'json_result' },
    ].entries()
  ) {
    const candidate = JSON.parse(JSON.stringify(makeFinalRecord(19 + index))) as Record<
      string,
      unknown
    >;
    candidate.outcome = outcome;
    await expectInvalid(() => validateAgentExecutionRecord(candidate, fixedEnvelope));
  }
  await expectInvalid(() =>
    validateAgentExecutionRecord(
      mutate({
        modelCalls: [{ ordinal: 2, role: 'parent', roleOrdinal: 1, resultKind: 'final' }],
      }),
      fixedEnvelope,
    )
  );
  await expectInvalid(() =>
    validateAgentExecutionRecord(mutate({ durationMicros: NaN }), fixedEnvelope)
  );
  await expectInvalid(() =>
    validateAgentExecutionRecord(
      mutate({
        transcript: [
          { role: 'user', content: { kind: 'text', text: 'secret-provider-marker' } },
          { role: 'assistant', content: { kind: 'text', text: 'OK' } },
        ],
      }),
      fixedEnvelope,
    ), 'secret-provider-marker');
  await expectInvalid(() =>
    validateAgentExecutionRecord({
      ...mutate({}),
      providerResponse: 'secret-provider-marker',
    }, fixedEnvelope), 'secret-provider-marker');

  const makeTerminalRecord = (runOrdinal: number) => {
    const recorder = createAgentExecutionRecorder({
      envelope: fixedEnvelope,
      runOrdinal,
      clock: () => 1,
    });
    recorder.recordModelCall({ role: 'parent', resultKind: 'tool_calls' });
    recorder.recordToolCall({
      role: 'parent',
      callId: 'submit',
      name: 'submit_json_result',
      arguments: { value: 'OK' },
    });
    recorder.recordToolResult({
      role: 'parent',
      callId: 'submit',
      name: 'submit_json_result',
      outcome: 'success',
      terminal: 'json_result',
      result: { value: 'OK' },
    });
    return recorder.finish({
      outcome: {
        ok: true,
        stopReason: 'tool_terminal',
        committed: true,
        terminalKind: 'json_result',
      },
      externalRequests: 1,
      transcript: [
        ...taskOnly,
        {
          role: 'assistant',
          content: [{
            kind: 'tool_call',
            callId: 'submit',
            name: 'submit_json_result',
            arguments: { value: 'OK' },
          }],
        },
        {
          role: 'tool',
          content: [{
            kind: 'tool_result',
            callId: 'submit',
            name: 'submit_json_result',
            text: 'OK',
            outcome: 'success',
            terminal: 'json_result',
          }],
        },
      ],
    });
  };
  const terminalMutation = JSON.parse(JSON.stringify(makeTerminalRecord(23))) as Record<
    string,
    unknown
  >;
  (terminalMutation.toolResults as Array<Record<string, unknown>>)[0].terminal = 'none';
  await expectInvalid(() => validateAgentExecutionRecord(terminalMutation, fixedEnvelope));

  const referenceMutation = JSON.parse(JSON.stringify(makeTerminalRecord(24))) as Record<
    string,
    unknown
  >;
  (referenceMutation.toolResults as Array<Record<string, unknown>>)[0].callOrdinal = 99;
  await expectInvalid(() => validateAgentExecutionRecord(referenceMutation, fixedEnvelope));

  const valueMutation = JSON.parse(JSON.stringify(makeTerminalRecord(25))) as Record<
    string,
    unknown
  >;
  (valueMutation.toolResults as Array<Record<string, unknown>>)[0].result = NaN;
  await expectInvalid(() => validateAgentExecutionRecord(valueMutation, fixedEnvelope));
});
