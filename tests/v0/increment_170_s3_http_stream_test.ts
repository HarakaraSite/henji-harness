import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { reduceSessionStreamFrame, type SessionClientState } from '../../v0/api/reducer.ts';

const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for production Session stream');
};

Deno.test('Increment 170 production HTTP subscribers and live reconnect continue one Data cut through terminal and next task', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-http-stream-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });
  let requests = 0;
  let finishFirst = () => {};
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      const ordinal = ++requests;
      const text = ordinal === 1 ? 'FIRST_PARTIAL_FINISHED' : 'NEXT_FINISHED';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              frame({
                type: 'response.output_text.delta',
                delta: ordinal === 1 ? 'FIRST_PARTIAL' : text,
              }),
            );
            const finish = () => {
              if (ordinal === 1) {
                controller.enqueue(
                  frame({ type: 'response.output_text.delta', delta: '_FINISHED' }),
                );
              }
              controller.enqueue(frame({
                type: 'response.completed',
                response: {
                  id: crypto.randomUUID(),
                  output: [{
                    type: 'message',
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text, annotations: [] }],
                  }],
                },
              }));
              controller.close();
            };
            if (ordinal === 1) finishFirst = finish;
            else finish();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
      : entry
  );
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  const streams: {
    stop: AbortController;
    done: Promise<void>;
    state?: SessionClientState;
    cuts: number[];
  }[] = [];
  try {
    core = await createCoreService({
      workspaceRoot,
      configRoot,
      stateRoot: `${environment.XDG_STATE_HOME}/henji-harness/v1`,
      dataRoot: `${environment.XDG_DATA_HOME}/henji-harness`,
      physicalIoMode: 'production',
      agent: 'default',
      rootMaxSteps: 2,
      initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
      providerDeclarations: declarations,
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    strictEqual(opened.kind, 'accepted');
    if (opened.kind !== 'accepted') throw new Error('Session open rejected');
    const sessionId = opened.value.sessionId;
    const connect = () => {
      const stream: typeof streams[number] = {
        stop: new AbortController(),
        done: Promise.resolve(),
        cuts: [],
      };
      stream.done = (async () => {
        try {
          for await (
            const update of client.sessionSubscribe(sessionId, { signal: stream.stop.signal })
          ) {
            stream.state = reduceSessionStreamFrame(stream.state, update);
            if (update.kind === 'session.update' && update.conversationDelta !== undefined) {
              stream.cuts.push(update.conversationDelta.cut);
            }
          }
        } catch (error) {
          if (!stream.stop.signal.aborted) throw error;
        }
      })();
      // Retain stream errors for the awaited join, including errors during task submission.
      void stream.done.catch(() => {});
      streams.push(stream);
      return stream;
    };
    const first = connect();
    await waitFor(() => first.state !== undefined);
    const submit = async (text: string) => {
      const result = await client.taskSubmit(sessionId, { commandId: crypto.randomUUID(), text });
      strictEqual(result.kind, 'accepted');
      if (result.kind !== 'accepted') throw new Error('task rejected');
      return result.value.executionId;
    };
    const firstExecution = await submit('first');
    const hasText = (stream: typeof streams[number], text: string) =>
      Object.values(stream.state?.snapshot.conversation.entities ?? {}).some((entity) =>
        entity.kind === 'message' && entity.text === text
      );
    await waitFor(() => hasText(first, 'FIRST_PARTIAL'));
    const reconnected = connect();
    await waitFor(() => hasText(reconnected, 'FIRST_PARTIAL'));
    finishFirst();
    await waitFor(async () =>
      (await client.executionRead(firstExecution)).execution.processSettlement === 'complete'
    );
    const nextExecution = await submit('next');
    await waitFor(async () =>
      (await client.executionRead(nextExecution)).execution.processSettlement === 'complete'
    );
    const saved = await client.sessionRead(sessionId);
    await waitFor(() =>
      streams.every((stream) =>
        stream.state?.snapshot.conversation.cut === saved.conversation.cut &&
        stream.state.snapshot.runtime.execution?.processSettlement === 'complete'
      )
    );
    for (const stream of streams) {
      deepStrictEqual(stream.state!.snapshot.conversation, saved.conversation);
      ok(hasText(stream, 'FIRST_PARTIAL_FINISHED'));
      ok(hasText(stream, 'NEXT_FINISHED'));
      strictEqual(new Set(stream.cuts).size, stream.cuts.length);
      for (let index = 1; index < stream.cuts.length; index++) {
        strictEqual(stream.cuts[index], stream.cuts[index - 1] + 1);
      }
    }
    strictEqual(requests, 2);
  } finally {
    for (const stream of streams) stream.stop.abort();
    await Promise.all(streams.map((stream) => stream.done));
    await server?.shutdown();
    await core?.close();
    await provider.shutdown();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
