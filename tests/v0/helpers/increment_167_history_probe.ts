import { createCoreService } from '../../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../../v0/agent/http/server.ts';
import { builtinProviderDeclarations } from '../../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../../v0/api/client.ts';

const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const message = (text: string) => ({
  type: 'message',
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

export const waitForHistory = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for history probe');
};

/** Real Core/Worker/SQLite/HTTP with a controlled localhost Responses endpoint. */
export const createHistoryProbe = async (root: string) => {
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${root}/config/henji-harness`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${workspaceRoot}/sample.txt`, 'HISTORY_SAMPLE');
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'localhost-test-key', {
    mode: 0o600,
  });
  const inputs: unknown[] = [];
  let holdFinal = false;
  let thinkingOnly = false;
  let releaseFinal: (() => void) | undefined;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.json();
      inputs.push(body.input);
      const index = inputs.length;
      const output = index % 2 === 1
        ? [
          {
            type: 'reasoning',
            id: `reasoning-${index}`,
            summary: [{ type: 'summary_text', text: `THOUGHT ${index}` }],
          },
          message(`NOTE ${index}`),
          {
            type: 'function_call',
            id: `function-${index}`,
            status: 'completed',
            call_id: 'reused-provider-id',
            name: 'read',
            arguments: '{"path":"sample.txt"}',
          },
        ]
        : [message(`RESULT ${index / 2}`)];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (holdFinal && index % 2 === 0) {
              controller.enqueue(
                frame(
                  thinkingOnly
                    ? { type: 'response.reasoning_summary_text.delta', delta: 'STOPPED_THOUGHT' }
                    : { type: 'response.output_text.delta', delta: 'CANCELLED_PARTIAL' },
                ),
              );
              releaseFinal = () => {
                try {
                  controller.close();
                } catch { /* Request may already have been cancelled. */ }
              };
              return;
            }
            if (index % 2 === 1) {
              controller.enqueue(
                frame({ type: 'response.reasoning_summary_text.delta', delta: `THOUGHT ${index}` }),
              );
            }
            controller.enqueue(frame({
              type: 'response.completed',
              response: {
                id: `response-${index}`,
                status: 'completed',
                output,
              },
            }));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  const options = {
    workspaceRoot,
    configRoot,
    stateRoot: `${root}/state/henji-harness/v1`,
    dataRoot: `${root}/data/henji-harness`,
    physicalIoMode: 'production' as const,
    providerDeclarations: builtinProviderDeclarations().map((entry) =>
      entry.providerId === 'openrouter-responses'
        ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
        : entry
    ),
  };
  let core = await createCoreService(options);
  let server = await startCoreServer(core);
  let client = new HenjiApiClient(server.url);
  const opened = await client.sessionOpen({
    commandId: crypto.randomUUID(),
    selection: { kind: 'new' },
    activation: {
      agent: 'default',
      rootProvider: 'openrouter-responses',
      maxSteps: 3,
      providerTimeoutMs: 30_000,
    },
  });
  if (opened.kind !== 'accepted') throw new Error(`session open ${opened.kind}`);
  const sessionId = opened.value.snapshot.session.id;
  return {
    get client() {
      return client;
    },
    get url() {
      return server.url;
    },
    sessionId,
    inputs,
    hold(value: boolean, withoutText = false) {
      holdFinal = value;
      thinkingOnly = withoutText;
    },
    async restart() {
      releaseFinal?.();
      releaseFinal = undefined;
      await server.shutdown();
      await core.close();
      core = await createCoreService(options);
      server = await startCoreServer(core);
      client = new HenjiApiClient(server.url);
      const reopened = await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'exact', sessionId },
      });
      if (reopened.kind !== 'accepted') throw new Error(`resume ${reopened.kind}`);
      return reopened.value.snapshot;
    },
    async close() {
      releaseFinal?.();
      await server.shutdown();
      await core.close();
      await provider.shutdown();
    },
  };
};
