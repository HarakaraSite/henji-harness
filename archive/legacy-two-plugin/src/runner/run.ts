import { callBroker } from '../broker/http_broker.ts';
import { error, type HarnessError } from '../domain/errors.ts';
import type { PlanInput } from '../domain/plan.ts';
import { runPluginSession } from './plugin_session.ts';
import { pluginIdentityFromFiles, pluginSourcePaths } from './plugin_identity.ts';
import type { PluginProcessResult } from './plugin_process.ts';
import type { TraceEvent } from './trace.ts';

const options = (denoCommand: string, entrypoint: string) => ({
  denoCommand,
  entrypoint,
  cwd: Deno.cwd(),
  timeoutMs: 45_000,
  maxStdoutBytes: 512 * 1024,
  maxStderrBytes: 256 * 1024,
  maxTotalOutputBytes: 768 * 1024,
});

const pluginFailure = (response: { error?: { code: string; message: string } }): HarnessError =>
  error(
    'plugin_response_failed',
    response.error?.message ?? 'plugin returned a failed response',
    response.error,
  );

export type TraceSink = (event: TraceEvent) => Promise<void> | void;

const tracePlugin = async (
  trace: TraceSink | undefined,
  id: string,
  sourcePaths: Readonly<Record<string, string>>,
  result: PluginProcessResult,
) => {
  if (!trace) return;
  await trace({
    name: 'plugin.session',
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    plugin: await pluginIdentityFromFiles(id, '0.0.1', sourcePaths),
    failureCode: result.failure?.code ??
      (result.response?.ok === false ? result.response.error?.code : undefined),
  });
};

export const runTask = async (
  input: PlanInput,
  apiKey: string,
  denoCommand = Deno.execPath(),
  fetchFn?: typeof fetch,
  trace?: TraceSink,
): Promise<unknown | HarnessError> => {
  const plannerEntrypoint = new URL('../../plugins/task-planner/main.ts', import.meta.url).pathname;
  const plannerSources = pluginSourcePaths('task-planner');
  const adapterEntrypoint =
    new URL('../../plugins/model-adapter/main.ts', import.meta.url).pathname;
  const adapterSources = pluginSourcePaths('model-adapter');
  const planner = await runPluginSession(
    { v: 1, kind: 'request', id: crypto.randomUUID(), method: 'plugin.execute', payload: input },
    options(denoCommand, plannerEntrypoint),
    async (modelRequest) => {
      if (modelRequest.method !== 'host.model.generate') {
        return {
          v: 1,
          kind: 'response',
          id: crypto.randomUUID(),
          replyTo: modelRequest.id,
          ok: false,
          error: { code: 'protocol_violation', message: 'unknown host method' },
        };
      }
      const adapter = await runPluginSession(
        {
          v: 1,
          kind: 'request',
          id: crypto.randomUUID(),
          method: 'plugin.execute',
          payload: modelRequest.payload,
        },
        options(denoCommand, adapterEntrypoint),
        async (brokerRequest) => {
          if (brokerRequest.method !== 'host.broker.call') {
            return {
              v: 1,
              kind: 'response',
              id: crypto.randomUUID(),
              replyTo: brokerRequest.id,
              ok: false,
              error: { code: 'protocol_violation', message: 'unknown host method' },
            };
          }
          const call = brokerRequest.payload as {
            endpointId: string;
            operationId: string;
            body: unknown;
          };
          const result = await callBroker(call, {
            apiKey,
            timeoutMs: 30_000,
            maxRequestBytes: 256 * 1024,
            maxResponseBytes: 1024 * 1024,
            fetchFn,
          });
          return 'code' in result
            ? {
              v: 1,
              kind: 'response',
              id: crypto.randomUUID(),
              replyTo: brokerRequest.id,
              ok: false,
              error: result,
            }
            : {
              v: 1,
              kind: 'response',
              id: crypto.randomUUID(),
              replyTo: brokerRequest.id,
              ok: true,
              payload: result.body,
            };
        },
      );
      await tracePlugin(trace, 'model-adapter', adapterSources, adapter);
      return adapter.failure
        ? {
          v: 1,
          kind: 'response',
          id: crypto.randomUUID(),
          replyTo: modelRequest.id,
          ok: false,
          error: adapter.failure,
        }
        : adapter.response?.ok
        ? {
          v: 1,
          kind: 'response',
          id: crypto.randomUUID(),
          replyTo: modelRequest.id,
          ok: true,
          payload: adapter.response.payload,
        }
        : {
          v: 1,
          kind: 'response',
          id: crypto.randomUUID(),
          replyTo: modelRequest.id,
          ok: false,
          error: adapter.response
            ? pluginFailure(adapter.response)
            : error('plugin_exit', 'adapter failed'),
        };
    },
  );
  await tracePlugin(trace, 'task-planner', plannerSources, planner);
  if (planner.failure) return planner.failure;
  if (!planner.response) return error('plugin_exit', 'planner failed');
  return planner.response.ok ? planner.response.payload : pluginFailure(planner.response);
};
