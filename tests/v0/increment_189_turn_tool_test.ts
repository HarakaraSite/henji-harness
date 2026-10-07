import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ContextModelRequestDelta } from '../../v0/agent/history/context_attribution.ts';
import { HOOK_API_CONTRACT } from '../../v0/agent/hook_api.ts';
import type { Model, ModelRequest, ModelResult, ToolCall } from '../../v0/agent/core/contracts.ts';
import { defineInstructionComponent } from '../../v0/agent/instructions/component.ts';
import {
  type ProviderEvidenceObservation,
  validateProviderEvidenceObservation,
} from '../../v0/agent/provider/provider_evidence.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type {
  WorkerCommitProposalMessage,
  WorkerCorrelation,
} from '../../v0/agent/worker/worker_protocol.ts';
import { loadWorkerHooks } from '../../v0/hooks/hook_loader.ts';

const makeCorrelation = (command: string): WorkerCorrelation => ({
  session: '11111111-1111-4111-8111-111111111189',
  instanceCorrelation: 'increment-189-turn-tool-instance',
  workerGeneration: 'increment-189-turn-tool-generation',
  baseStateRevision: 1,
  command,
});

Deno.test('Increment 189 applies turn and tool hooks through WorkerGeneration', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-turn-tool-' });
  const hookDirectory = `${root}/hooks`;
  const hookPath = `${hookDirectory}/transform.ts`;
  const observerPath = `${hookDirectory}/observe.ts`;
  const failurePath = `${hookDirectory}/after-failure.ts`;
  const actualPath = `${root}/written-by-hook.txt`;
  const modelPath = `${root}/requested-by-model.txt`;
  try {
    await Deno.mkdir(hookDirectory, { recursive: true });
    await Deno.writeTextFile(
      hookPath,
      `export default () => ({
  runtime_start: () => ({ context: ['startup hook context'] }),
  before_turn: ({ task }) => ({ context: ['turn hook context: ' + task] }),
  before_tool: ({ toolName, arguments: args, context }) => {
    if (!context.systemInstruction.includes('turn hook context:')) {
      throw new Error('current turn context was not available to before_tool');
    }
    if (toolName !== 'write_marker') return;
    return { arguments: { ...args, contents: 'written by before_tool' } };
  },
  after_tool: ({ result }) => {
    return { text: 'after_tool: ' + result.text };
  },
});
`,
    );
    await Deno.writeTextFile(
      observerPath,
      `export default () => ({
  before_turn: ({ task, context }) => {
    if (!context.systemInstruction.includes('turn hook context: ' + task)) {
      throw new Error('earlier before_turn contribution was not applied');
    }
    if (task === 'second task' && context.systemInstruction.includes('first task')) {
      throw new Error('before_turn context accumulated from the previous turn');
    }
    return { context: ['second hook context: ' + task] };
  },
  before_tool: ({ toolName, arguments: args }) => {
    if (toolName !== 'write_marker') return;
    if (args.contents !== 'written by before_tool') {
      throw new Error('earlier before_tool arguments were not applied');
    }
    return { arguments: { ...args, target: ${JSON.stringify(actualPath)} } };
  },
});
`,
    );
    await Deno.writeTextFile(
      failurePath,
      `export default () => ({
  after_tool: ({ result }) => {
    if (result.outcome === 'error') throw new Error('after processing failed');
  },
});
`,
    );
    const loaded = await loadWorkerHooks([
      { name: 'transform', path: hookPath, contract: HOOK_API_CONTRACT },
      { name: 'observe', path: observerPath, contract: HOOK_API_CONTRACT },
      { name: 'after-failure', path: failurePath, contract: HOOK_API_CONTRACT },
    ], { workspace: { root }, workTools: {} });
    deepStrictEqual(loaded.rejections, []);

    const requests: ModelRequest[] = [];
    const calls: ToolCall[] = [
      {
        callId: 'write-1',
        name: 'write_marker',
        arguments: { target: modelPath, contents: 'requested by model' },
      },
      { callId: 'fail-1', name: 'fail', arguments: {} },
      { callId: 'terminal-1', name: 'submit_json_result', arguments: { answer: 1 } },
    ];
    const model: Model = {
      generate(request: ModelRequest): ModelResult {
        requests.push(structuredClone(request));
        const index = requests.length;
        if (index === 1) return { kind: 'tool_calls', calls: [calls[0]] };
        if (index === 2) return { kind: 'tool_calls', calls: [calls[1]] };
        if (index === 3) return { kind: 'final', text: 'first turn completed' };
        if (index === 4) return { kind: 'final', text: 'second turn completed' };
        if (index === 5) return { kind: 'tool_calls', calls: [calls[2]] };
        throw new Error(`unexpected model request ${index}`);
      },
    };
    const registry = new Registry([{
      name: 'write_marker',
      fileAccess: 'read-write' as const,
      description: 'write a marker file',
      inputSchema: {},
      execute: async (argumentsValue) => {
        const args = argumentsValue as { readonly target: string; readonly contents: string };
        await Deno.writeTextFile(args.target, args.contents);
        return `wrote ${args.target}: ${args.contents}`;
      },
    }, {
      name: 'fail',
      fileAccess: 'none' as const,
      description: 'return a tool execution error',
      inputSchema: {},
      execute: () => {
        throw new Error('expected tool failure');
      },
    }, {
      name: 'submit_json_result',
      fileAccess: 'none' as const,
      description: 'finish with a JSON result',
      inputSchema: {},
      terminal: true,
      execute: () => ({
        kind: 'terminate',
        text: 'original terminal result body',
        finalText: '{"answer":"original"}',
        terminalKind: 'json_result',
      }),
    }]);
    const composition = {
      role: 'parent',
      model,
      registry,
      maxSteps: 4,
      systemInstruction: 'base instruction',
      instructionComponents: [
        defineInstructionComponent('instruction:test-base', 'base instruction'),
      ],
      manifest: {
        role: 'parent',
        maxSteps: 4,
        profileId: 'increment-189-turn-tool',
        resources: ['tool:write_marker', 'tool:fail', 'tool:submit_json_result'],
      },
      resolved: {
        model: { profile: { id: 'increment-189-turn-tool' } },
        systemInstruction: 'base instruction',
        capabilities: { instructions: ['instruction:test-base'] },
        resourceSelection: {
          resources: ['instruction:test-base'],
          maxSteps: 4,
        },
      },
    } as unknown as WorkerAgentComposition;

    const observations: ProviderEvidenceObservation[] = [];
    const contextDeltas: ContextModelRequestDelta[] = [];
    const proposals: WorkerCommitProposalMessage[] = [];
    let sequence = 0;
    const port: WorkerGenerationPort = {
      runtimeEvent: () => ++sequence,
      effectObservation: () => ++sequence,
      providerObservation: (_correlation, observation) => {
        observations.push(structuredClone(observation));
        return ++sequence;
      },
      contextObservation: (_correlation, delta) => {
        contextDeltas.push(structuredClone(delta));
        return ++sequence;
      },
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: (_correlation, proposal) => {
        proposals.push(structuredClone(proposal));
        return Promise.resolve(true);
      },
      turnFailed: (_correlation, outcome) => {
        throw new Error(`unexpected turn failure: ${outcome.error ?? outcome.stopReason}`);
      },
    };
    const generation = new WorkerGeneration(
      composition,
      '11111111-1111-4111-8111-111111111189',
      port,
      [],
      1,
      undefined,
      undefined,
      ROOT_DEFAULT_MODEL_SELECTION,
      () => {},
      () => Promise.resolve('unknown'),
      { skillNames: [] },
      undefined,
      1,
      undefined,
      loaded.accepted,
      {
        component: 'agent',
        agentName: 'root',
        role: 'root',
        workspaceRoot: root,
        sessionId: '11111111-1111-4111-8111-111111111189',
        workerGeneration: 'increment-189-turn-tool-generation',
      },
    );
    await generation.start();
    await generation.runTurn(
      makeCorrelation('first-turn'),
      'first task',
      undefined,
      undefined,
      undefined,
      false,
      'execution-first',
    );
    await generation.runTurn(
      makeCorrelation('second-turn'),
      'second task',
      undefined,
      undefined,
      undefined,
      false,
      'execution-second',
    );
    await generation.runTurn(
      makeCorrelation('terminal-turn'),
      'terminal task',
      undefined,
      undefined,
      undefined,
      false,
      'execution-terminal',
    );

    strictEqual(await Deno.readTextFile(actualPath), 'written by before_tool');
    const firstTurnRequests = requests.slice(0, 3);
    ok(
      firstTurnRequests.every((request) =>
        request.systemInstruction?.includes('base instruction') &&
        request.systemInstruction.includes('startup hook context') &&
        request.systemInstruction.includes('turn hook context: first task') &&
        request.systemInstruction.includes('second hook context: first task')
      ),
    );
    const secondTurnRequest = requests[3];
    ok(secondTurnRequest.systemInstruction?.includes('base instruction'));
    ok(secondTurnRequest.systemInstruction?.includes('startup hook context'));
    ok(secondTurnRequest.systemInstruction?.includes('turn hook context: second task'));
    ok(secondTurnRequest.systemInstruction?.includes('second hook context: second task'));
    ok(!secondTurnRequest.systemInstruction?.includes('first task'));

    const originalAssistant = firstTurnRequests[1].transcript.find((message) =>
      message.role === 'assistant' && Array.isArray(message.content) &&
      message.content.some((content) => content.callId === 'write-1')
    );
    ok(originalAssistant?.role === 'assistant' && Array.isArray(originalAssistant.content));
    deepStrictEqual(originalAssistant.content[0].arguments, {
      target: modelPath,
      contents: 'requested by model',
    });
    const firstToolResult = firstTurnRequests[1].transcript.find((message) =>
      message.role === 'tool' && message.content.some((content) => content.callId === 'write-1')
    );
    ok(firstToolResult?.role === 'tool');
    const processedResult = firstToolResult.content[0];
    ok(processedResult.text.startsWith('after_tool: wrote '));
    ok(processedResult.text.includes(
      `[Input used by tool after before_tool processing: ${
        JSON.stringify({
          target: actualPath,
          contents: 'written by before_tool',
        })
      }]`,
    ));
    ok(
      requests[2].transcript.some((message) =>
        message.role === 'tool' &&
        message.content.some((content) =>
          content.callId === 'fail-1' && content.outcome === 'error' &&
          content.text.includes('after_tool: tool execution error: expected tool failure') &&
          content.text.includes('after_tool hook after-failure')
        )
      ),
    );

    const runtimeEvents = observations.flatMap((observation) =>
      observation.kind === 'runtime_event' ? [observation.event] : []
    );
    ok(observations.every(validateProviderEvidenceObservation));
    const writeCall = runtimeEvents.find((event) =>
      event.kind === 'tool_call' && event.call.callId === 'write-1'
    );
    ok(writeCall?.kind === 'tool_call');
    deepStrictEqual(writeCall.call.arguments, {
      target: modelPath,
      contents: 'requested by model',
    });
    deepStrictEqual(writeCall.hookEffect?.effectiveArguments, {
      target: actualPath,
      contents: 'written by before_tool',
    });
    deepStrictEqual(writeCall.hookEffect?.argumentHooks?.map((hook) => hook.name), [
      'transform',
      'observe',
    ]);
    const writeResult = runtimeEvents.find((event) =>
      event.kind === 'tool_result' && event.result.callId === 'write-1'
    );
    ok(writeResult?.kind === 'tool_result');
    strictEqual(
      writeResult.hookEffect?.originalText,
      `wrote ${actualPath}: written by before_tool`,
    );
    strictEqual(writeResult.result.text, processedResult.text);
    const failedResult = runtimeEvents.find((event) =>
      event.kind === 'tool_result' && event.result.callId === 'fail-1'
    );
    ok(failedResult?.kind === 'tool_result');
    strictEqual(failedResult.result.outcome, 'error');
    strictEqual(failedResult.hookEffect?.failure?.name, 'after-failure');
    strictEqual(failedResult.hookEffect?.failure?.phase, 'after_tool');

    const firstSystem = contextDeltas[0].occurrences.find((occurrence) =>
      occurrence.kind === 'system'
    );
    ok(firstSystem);
    const turnHookSources = firstSystem.sourceRelations.filter((source) =>
      source.logicalIdentity?.includes('before-turn-hook')
    );
    deepStrictEqual(turnHookSources.map((source) => source.logicalIdentity), [
      'instruction:before-turn-hook-1',
      'instruction:before-turn-hook-2',
    ]);
    ok(turnHookSources[0].sourceLocator?.includes('transform'));
    ok(turnHookSources[1].sourceLocator?.includes('observe'));

    const terminalProposal = proposals.find((proposal) =>
      proposal.correlation.command === 'terminal-turn'
    );
    strictEqual(terminalProposal?.outcome?.finalText, '{"answer":"original"}');
    strictEqual(terminalProposal?.outcome?.terminalKind, 'json_result');
    const terminalResult = runtimeEvents.find((event) =>
      event.kind === 'tool_result' && event.result.callId === 'terminal-1'
    );
    ok(terminalResult?.kind === 'tool_result');
    strictEqual(terminalResult.result.text, 'after_tool: original terminal result body');
    strictEqual(
      'terminal' in terminalResult.result ? terminalResult.result.terminal : undefined,
      'json_result',
    );
    strictEqual(terminalProposal?.outcome?.finalText, '{"answer":"original"}');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 before_tool failure becomes a tool error without dispatch', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-before-tool-fail-' });
  const target = `${root}/must-not-exist.txt`;
  try {
    await Deno.writeTextFile(
      `${root}/reject-call.ts`,
      `export default () => ({ before_tool: () => { throw new Error('before tool rejected'); } });`,
    );
    const registered = await loadWorkerHooks([{
      name: 'reject-call',
      path: `${root}/reject-call.ts`,
      contract: HOOK_API_CONTRACT,
    }], { workspace: { root }, workTools: {} });
    deepStrictEqual(registered.rejections, []);

    let modelRequest = 0;
    const model: Model = {
      generate: () => {
        modelRequest += 1;
        return modelRequest === 1
          ? {
            kind: 'tool_calls',
            calls: [{ callId: 'blocked-write', name: 'write_marker', arguments: { target } }],
          }
          : { kind: 'final', text: 'tool failure was reported' };
      },
    };
    const registry = new Registry([{
      name: 'write_marker',
      fileAccess: 'read-write' as const,
      description: 'write a file',
      inputSchema: {},
      execute: async (args) => {
        const path = (args as { readonly target: string }).target;
        await Deno.writeTextFile(path, 'must not run');
        return 'written';
      },
    }]);
    let proposal: WorkerCommitProposalMessage | undefined;
    let sequence = 0;
    const port: WorkerGenerationPort = {
      runtimeEvent: () => ++sequence,
      effectObservation: () => ++sequence,
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: (_correlation, value) => {
        proposal = structuredClone(value);
        return Promise.resolve(true);
      },
      turnFailed: (_correlation, outcome) => {
        throw new Error(`unexpected turn failure: ${outcome.error ?? outcome.stopReason}`);
      },
    };
    const composition = {
      role: 'parent',
      model,
      registry,
      maxSteps: 2,
      manifest: { role: 'parent', maxSteps: 2, profileId: 'i189-before-tool-fail', resources: [] },
      resolved: { model: { profile: { id: 'i189-before-tool-fail' } } },
    } as unknown as WorkerAgentComposition;
    const generation = new WorkerGeneration(
      composition,
      '11111111-1111-4111-8111-111111111189',
      port,
      [],
      1,
      undefined,
      undefined,
      ROOT_DEFAULT_MODEL_SELECTION,
      () => {},
      () => Promise.resolve('unknown'),
      { skillNames: [] },
      undefined,
      1,
      undefined,
      registered.accepted,
      {
        component: 'agent',
        agentName: 'root',
        role: 'root',
        workspaceRoot: root,
        sessionId: '11111111-1111-4111-8111-111111111189',
        workerGeneration: 'increment-189-before-tool-fail-generation',
      },
    );
    await generation.start();
    await generation.runTurn(
      makeCorrelation('before-tool-failure'),
      'write a file',
      undefined,
      undefined,
      undefined,
      false,
      'execution-before-tool-failure',
    );

    const result = proposal?.transcript.flatMap((message) =>
      message.role === 'tool' ? message.content : []
    ).find((entry) => entry.callId === 'blocked-write');
    ok(result);
    strictEqual(result.outcome, 'error');
    ok(result.text.includes('before_tool hook reject-call'));
    ok(result.text.includes('before tool rejected'));
    let exists = true;
    try {
      await Deno.stat(target);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) exists = false;
      else throw error;
    }
    strictEqual(exists, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 before_turn failure settles the turn before model execution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-before-turn-fail-' });
  const hookPath = `${root}/fail-turn.ts`;
  try {
    await Deno.writeTextFile(
      hookPath,
      `export default () => ({ before_turn: () => { throw new Error('turn hook rejected'); } });`,
    );
    const loaded = await loadWorkerHooks([{
      name: 'fail-turn',
      path: hookPath,
      contract: HOOK_API_CONTRACT,
    }], { workspace: { root }, workTools: {} });
    deepStrictEqual(loaded.rejections, []);

    let modelCalls = 0;
    let failure: import('../../v0/agent/core/contracts.ts').LoopOutcome | undefined;
    const model: Model = {
      generate: () => {
        modelCalls += 1;
        return { kind: 'final', text: 'must not run' };
      },
    };
    const registry = new Registry([]);
    const composition = {
      role: 'parent',
      model,
      registry,
      maxSteps: 1,
      manifest: { role: 'parent', maxSteps: 1, profileId: 'i189-before-turn-fail', resources: [] },
      resolved: { model: { profile: { id: 'i189-before-turn-fail' } } },
    } as unknown as WorkerAgentComposition;
    let sequence = 0;
    const port: WorkerGenerationPort = {
      runtimeEvent: () => ++sequence,
      effectObservation: () => ++sequence,
      checkpointProposal: () => Promise.resolve(false),
      commitProposal: () => Promise.reject(new Error('unexpected commit')),
      turnFailed: (_correlation, outcome) => {
        failure = structuredClone(outcome);
      },
    };
    const generation = new WorkerGeneration(
      composition,
      '11111111-1111-4111-8111-111111111189',
      port,
      [],
      1,
      undefined,
      undefined,
      ROOT_DEFAULT_MODEL_SELECTION,
      () => {},
      () => Promise.resolve('unknown'),
      { skillNames: [] },
      undefined,
      1,
      undefined,
      loaded.accepted,
      {
        component: 'agent',
        agentName: 'root',
        role: 'root',
        workspaceRoot: root,
        sessionId: '11111111-1111-4111-8111-111111111189',
        workerGeneration: 'increment-189-before-turn-fail-generation',
      },
    );
    await generation.start();
    await generation.runTurn(
      makeCorrelation('before-turn-failure'),
      'rejected task',
      undefined,
      undefined,
      undefined,
      false,
      'execution-before-turn-failure',
    );

    strictEqual(modelCalls, 0);
    strictEqual(failure?.stopReason, 'contract_failure');
    ok(failure?.error?.includes('before_turn hook fail-turn'));
    ok(failure?.error?.includes('turn hook rejected'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
