/**
 * Increment 132 measurement probe: M1 (TUI per-op cost under large logs) and M2 (SSE -> loop
 * accepted live snapshots over a paced stream). Results are recorded in
 * docs/increments/increment-132.md. Run:
 * `deno task --config deno.v0.json agent:increment-132-measure [m1|m2|all]`
 */
import { TuiRenderer } from '../v0/tui/tui_renderer.ts';
import type { TerminalPort } from '../v0/tui/terminal.ts';
import type { ConversationEntity } from '../v0/conversation/model.ts';
import { initialSessionClientState } from '../v0/api/reducer.ts';
import type { SessionSnapshot } from '../v0/api/contract.ts';
import { SnapshotConversationProjector } from '../v0/tui/snapshot_presentation.ts';
import {
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../v0/agent/provider/openrouter_model.ts';
import { runAgentTurn } from '../v0/agent/core/loop.ts';
import { Registry } from '../v0/agent/tools/tools.ts';
import type { AgentEvent } from '../v0/agent/core/events.ts';
import type {
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../v0/agent/core/contracts.ts';

const stats = (samples: number[]): Record<string, number> => {
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    avgMs: +(sum / sorted.length).toFixed(3),
    p50Ms: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    maxMs: +sorted[sorted.length - 1].toFixed(3),
  };
};

const time = (fn: () => void, renderer?: TuiRenderer): number => {
  const start = performance.now();
  fn();
  renderer?.flushRender();
  return performance.now() - start;
};

const makeTerminal = (): { terminal: TerminalPort; writtenBytes: () => number } => {
  let written = 0;
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns: 120, rows: 40 }),
    setRaw: () => {},
    read: () => Promise.resolve(null),
    drainAndCloseInput: () => Promise.resolve(),
    write: (bytes: Uint8Array) => {
      written += bytes.byteLength;
    },
    addSignal: () => {},
    removeSignal: () => {},
  };
  return { terminal, writtenBytes: () => written };
};

const entitySet = (
  entries: number,
  fatTail: number,
  fatBytes: number,
): { entities: Record<string, ConversationEntity>; order: string[] } => {
  const entities: Record<string, ConversationEntity> = {};
  const order: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    const body = index >= entries - fatTail
      ? `${index}:${'d'.repeat(fatBytes)}`
      : `${index}:${'c'.repeat(180)}`;
    const turn = Math.floor(index / 2) + 1;
    const executionId = `benchmark-execution-${turn}`;
    const id = `benchmark-message-${index}`;
    entities[id] = {
      kind: 'message',
      id,
      executionId,
      turn,
      version: 0,
      position: {
        executionOrder: turn - 1,
        requestOrder: index % 2 === 0 ? -1 : 1,
        phase: index % 2 === 0 ? -1 : 1,
        eventOrdinal: 0,
        itemOrdinal: index % 2,
      },
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: body,
      complete: true,
    };
    order.push(id);
  }
  return { entities, order };
};

const projectEntities = (
  renderer: TuiRenderer,
  entities: Readonly<Record<string, ConversationEntity>>,
  order: readonly string[],
): void => {
  const sessionId = 'benchmark-session';
  const snapshot: SessionSnapshot = {
    schemaVersion: 2,
    cursor: { coreEpoch: 'benchmark', sessionId, revision: 1 },
    session: {
      id: sessionId,
      canonicalSessionId: sessionId,
      persistence: 'persistent',
      position: {
        sessionId,
        createdAt: '2026-10-03T00:00:00.000Z',
        agent: 'default',
        committedTurn: order.length / 2,
        messageCount: order.length,
      },
      selection: { provider: 'benchmark', modelId: 'benchmark', effort: 'medium' },
      startup: {
        status: 'evaluated',
        productVersion: 'benchmark',
        workspace: '/tmp/benchmark',
        agentId: 'default',
        model: {
          provider: 'benchmark',
          profileId: 'benchmark',
          modelId: 'benchmark',
          effort: 'medium',
        },
        sessionMode: { kind: 'continue' },
        instructions: { loaded: false, source: 'none' },
        skills: { count: 0, names: [], omitted: 0 },
        trust: { hardSandbox: false, osUserTools: [] },
        credentialVerification: 'before_each_provider_request',
      },
    },
    runtime: {
      active: false,
      activeSessionId: sessionId,
      phase: 'idle',
      execution: null,
      operations: [],
    },
    conversation: {
      schemaVersion: 2,
      sessionId,
      cut: 1,
      storeRevision: 1,
      entities,
      order,
    },
    pending: { kind: 'core-owned', followUps: [] },
    credentialAvailability: { status: 'unknown' },
    context: {},
  };
  const update = new SnapshotConversationProjector().project(
    initialSessionClientState(snapshot),
    'benchmark',
  );
  renderer.setKeyedConversationStore(update.store);
};

const m1 = (): void => {
  const report: Record<string, unknown> = {};
  const cases: readonly (readonly [number, number, number])[] = [
    [1_000, 0, 0],
    [10_000, 0, 0],
    [30_000, 0, 0],
    [1_000, 48, 8_192],
  ];
  for (const [entries, fatTail, fatBytes] of cases) {
    const { terminal, writtenBytes } = makeTerminal();
    const renderer = new TuiRenderer(terminal, { setTimeout: () => 0, clearTimeout: () => {} });
    const conversation = entitySet(entries, fatTail, fatBytes);
    projectEntities(renderer, conversation.entities, conversation.order);
    renderer.flushRender();
    const measure = (fn: () => void): number => time(fn, renderer);
    const liveText = `streaming body\n${'line of streamed text\n'.repeat(20)}`;
    const progressSamples: number[] = [];
    const editorSamples: number[] = [];
    for (let round = 0; round < 30; round += 1) {
      progressSamples.push(measure(() =>
        renderer.eventSink({
          kind: 'assistant_progress',
          turn: 99,
          text: `${liveText}${'x'.repeat(round * 100)}`,
        })
      ));
      editorSamples.push(measure(() => renderer.setEditor(`typed ${round}`)));
    }
    report[`entries=${entries},fatTail=${fatTail},fatBytes=${fatBytes}`] = {
      progressEvent: stats(progressSamples),
      keystroke: stats(editorSamples),
      frameBytes: writtenBytes(),
    };
    renderer.renderFrame();
    renderer.close();
  }
  const { terminal } = makeTerminal();
  const renderer = new TuiRenderer(terminal, { setTimeout: () => 0, clearTimeout: () => {} });
  const conversation = entitySet(1_000, 0, 0);
  projectEntities(renderer, conversation.entities, conversation.order);
  renderer.flushRender();
  const measure = (fn: () => void): number => time(fn, renderer);
  const growth: Record<string, unknown> = {};
  for (const size of [1_000, 10_000, 50_000, 100_000]) {
    const samples: number[] = [];
    const text = 'y'.repeat(size);
    for (let round = 0; round < 10; round += 1) {
      samples.push(
        measure(() => renderer.eventSink({ kind: 'assistant_progress', turn: 99, text })),
      );
    }
    growth[`liveText=${size}`] = stats(samples);
  }
  renderer.close();
  report['streamingLiveTextGrowth'] = growth;
  console.log(JSON.stringify({ m1: report }, null, 2));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const m2Case = async (
  label: string,
  deltaChars: number,
  gapMs: number,
): Promise<void> => {
  const lineCount = 30;
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `stream-line-${String(index).padStart(3, '0')}-${'ab'.repeat(10)}\n`,
  );
  const full = lines.join('');
  const deltas: string[] = [];
  for (let index = 0; index < full.length; index += deltaChars) {
    deltas.push(full.slice(index, index + deltaChars));
  }
  const frames = deltas.map((delta, index) =>
    `data: ${
      JSON.stringify({
        id: 'gen-m2',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: delta },
          finish_reason: index === deltas.length - 1 ? 'stop' : null,
        }],
      })
    }\n\n`
  );
  frames.push(
    `data: ${
      JSON.stringify({
        id: 'gen-m2',
        choices: [{
          index: 0,
          delta: { content: '', role: 'assistant' },
          finish_reason: 'stop',
          native_finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          cost: 0.01,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      })
    }\n\n`,
    'data: [DONE]\n\n',
  );
  const encoder = new TextEncoder();
  let frameIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (frameIndex >= frames.length) {
        controller.close();
        return;
      }
      await sleep(gapMs);
      controller.enqueue(encoder.encode(frames[frameIndex]));
      frameIndex += 1;
    },
  });
  const profile: OpenRouterAgentProfile = {
    id: 'm2-profile',
    model: 'test/model',
    origin: 'https://openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    secretEnv: 'HENJI_TEST_KEY',
    maxCompletionTokens: 128,
    stream: false,
  };
  const raw = new OpenRouterAgentModel({
    profile,
    responseMode: 'sse',
    credential: 'dummy',
    fetcher: () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
      ),
  });
  let transportReports = 0;
  const reportSnapshots: string[] = [];
  const events: AgentEvent[] = [];
  const model = {
    generate: (
      request: ModelRequest,
      options?: ModelGenerateOptions,
    ): Promise<ModelResult> =>
      raw.generate(
        request,
        options === undefined ? undefined : {
          ...options,
          reportAssistantProgress: (snapshot: string) => {
            transportReports += 1;
            reportSnapshots.push(snapshot);
            options.reportAssistantProgress?.(snapshot);
          },
        },
      ),
  };
  const start = performance.now();
  const outcome = await runAgentTurn('m2 task', [], model, new Registry([]), {
    maxSteps: 1,
    eventSink: (event) => events.push(event),
  });
  const wallMs = performance.now() - start;
  const snapshots = events
    .filter((event): event is Extract<AgentEvent, { kind: 'assistant_progress' }> =>
      event.kind === 'assistant_progress'
    )
    .map((event) => event.text);
  // The old rule accepted only the first 256 reports per request, then froze live updates.
  const oldFreezeAt = reportSnapshots[Math.min(256, reportSnapshots.length) - 1] ?? '';
  console.log(JSON.stringify(
    {
      [label]: {
        ok: outcome.ok,
        totalChars: full.length,
        deltaChars,
        gapMs,
        transportReports,
        acceptedSnapshots: snapshots.length,
        lastSnapshotChars: snapshots.at(-1)?.length ?? 0,
        coveragePct: +((snapshots.at(-1)?.length ?? 0) / full.length * 100).toFixed(1),
        oldRuleFreezeCoveragePct: +(oldFreezeAt.length / full.length * 100).toFixed(1),
        oldRuleFrozeBeforeEnd: transportReports > 256,
        wallMs: +wallMs.toFixed(0),
      },
    },
    null,
    2,
  ));
};

const m2 = async (): Promise<void> => {
  await m2Case('m2_lineDeltas_50ms', 37, 50);
  await m2Case('m2_tokenDeltas_10ms', 3, 10);
};

const which = Deno.args[0] ?? 'all';
if (which === 'm1' || which === 'all') m1();
if (which === 'm2' || which === 'all') await m2();
