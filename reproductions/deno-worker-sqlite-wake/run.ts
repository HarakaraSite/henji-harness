import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutionEventInput,
  HistoryPersistencePort,
  StoredExecutionEvent,
} from "../../v0/agent/history/history_store_contract.ts";
import { SqliteHistoryV6ProductionStore } from "../../v0/agent/history/sqlite_history_v6_production_store.ts";
import { builtinHenjiBaseInstruction } from "../../v0/agent/instructions/base_instruction.ts";
import { builtinProviderDeclarations } from "../../v0/agent/provider/provider_declaration.ts";
import type {
  SemanticContextCheckpointV1,
  StoredSessionRecord,
  WorkerSessionHandle,
} from "../../v0/agent/session/session_store.ts";
import {
  bundledToolDefinitionLoadRequests,
  readDefinitionRevision,
} from "../../v0/agent/worker/worker_definition_revision.ts";
import { WorkerHostSession } from "../../v0/agent/worker/worker_host_session.ts";

const mode = Deno.args[0] ?? "sqlite-real";
if (!["sqlite-real", "memory-real", "sqlite-local", "memory-local"].includes(mode)) {
  throw new Error(
    "usage: deno run ... run.ts [sqlite-real|memory-real|sqlite-local|memory-local]",
  );
}
const historyMode = mode.startsWith("sqlite") ? "sqlite" : "memory";
const providerMode = mode.endsWith("real") ? "real" : "local";

class MemoryHandle implements WorkerSessionHandle {
  readonly id = crypto.randomUUID().toLowerCase();
  record: StoredSessionRecord | undefined;
  checkpoint: SemanticContextCheckpointV1 | undefined;

  commit(record: StoredSessionRecord): void {
    this.record = structuredClone(record);
  }
  rollback(): void {
    this.record = undefined;
  }
  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    this.checkpoint = structuredClone(checkpoint);
  }
  rollbackCheckpoint(): void {
    this.checkpoint = undefined;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const reproductionRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(reproductionRoot));
const scratchRoot = await Deno.makeTempDir({
  prefix: "deno-worker-sqlite-wake-",
});
const configRoot = join(scratchRoot, "config");
const credentialPath = join(configRoot, "henji-harness", "openrouter-api-key");
if (providerMode === "local") {
  await Deno.mkdir(dirname(credentialPath), { recursive: true });
  await Deno.writeTextFile(credentialPath, "synthetic-not-a-secret\n", {
    mode: 0o600,
  });
  Deno.env.set("XDG_CONFIG_HOME", configRoot);
} else {
  Deno.env.set("HENJI_DENO_REPRO_PASSTHROUGH", "1");
}

let listen: ((endpoint: string) => void) | undefined;
const listening = new Promise<string>((resolve) => {
  listen = resolve;
});
const server = Deno.serve(
  {
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => listen?.(`http://127.0.0.1:${port}`),
  },
  async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/sonar") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({
        id: "synthetic-sonar",
        model: "perplexity/sonar",
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "The official Deno documentation is available.[1]",
            annotations: [{
              type: "url_citation",
              url_citation: {
                url: "https://docs.deno.com/",
                title: "Deno Docs",
                start_index: 0,
                end_index: 0,
              },
            }],
          },
        }],
      });
    }
    const rootDelayMs = Number(
      Deno.env.get("HENJI_DENO_REPRO_ROOT_DELAY_MS") ?? "20",
    );
    await new Promise((resolve) => setTimeout(resolve, rootDelayMs));
    const first = path.endsWith("/1");
    const finishReason = first ? "tool_calls" : "stop";
    const id = first ? "synthetic-tool" : "synthetic-final";
    const payload = first
      ? {
        id,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "synthetic-search-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({
                  query: "official Deno documentation",
                }),
              },
            }],
          },
          finish_reason: finishReason,
        }],
      }
      : {
        id,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "synthetic final answer" },
          finish_reason: finishReason,
        }],
      };
    const usage = {
      id,
      choices: [{
        index: 0,
        delta: { content: "", role: "assistant" },
        finish_reason: finishReason,
        native_finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cost: 0.001,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    };
    return new Response(
      `data: ${JSON.stringify(payload)}\n\ndata: ${
        JSON.stringify(usage)
      }\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  },
);
Deno.env.set("HENJI_DENO_REPRO_ENDPOINT", await listening);

const sqlite = new SqliteHistoryV6ProductionStore(
  join(scratchRoot, "state"),
  repositoryRoot,
);
await sqlite.initialize();
let memoryOrdinal = 0;
const memoryEvent = (input: ExecutionEventInput): StoredExecutionEvent => ({
  ...input,
  ordinal: ++memoryOrdinal,
  observedAt: input.observedAt ?? new Date().toISOString(),
  payload: structuredClone(input.payload) as never,
});

const history = new Proxy(sqlite, {
  get(target, property) {
    if (property === "appendExactRequestObservation") return () => {};
    if (property === "appendExecutionEvents") {
      return (inputs: readonly ExecutionEventInput[]) => {
        const nonProvider = inputs.filter((input) => {
          const payload = input.payload as unknown as {
            readonly kind?: string;
          };
          return !input.kind.startsWith("provider_") &&
            payload.kind !== "provider_observation";
        });
        if (historyMode === "memory" || nonProvider.length === 0) {
          return inputs.map(memoryEvent);
        }
        const started = performance.now();
        const stored = target.appendExecutionEvents(nonProvider);
        console.log(JSON.stringify({
          event: "sqlite_append_returned",
          elapsedMs: performance.now() - started,
          inputCount: nonProvider.length,
          inputBytes: JSON.stringify(nonProvider).length,
          kinds: nonProvider.map((input) => input.kind),
        }));
        return stored;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as unknown as HistoryPersistencePort;

const modulePath = join(reproductionRoot, "synthetic_definition.ts");
const host = await WorkerHostSession.open({
  handle: new MemoryHandle(),
  workspaceRoot: repositoryRoot,
  agent: "default",
  definition: await readDefinitionRevision(modulePath, "builtin", "default"),
  modulePath,
  physicalIoMode: "production",
  toolDefinitions: await bundledToolDefinitionLoadRequests(),
  providerDeclarations: builtinProviderDeclarations(),
  baseInstruction: builtinHenjiBaseInstruction(),
  historyPersistence: history,
  cancelSettlementGraceMs: 500,
  auxiliaryStageGapMs: 3_000,
});

const submitted = host.submit(
  "Use web_search exactly once to find the official Deno documentation, then report the result.",
);
const result = await Promise.race([
  submitted.then((outcome) => ({ kind: "outcome" as const, outcome })),
  new Promise<{ kind: "timeout" }>((resolve) =>
    setTimeout(() => resolve({ kind: "timeout" }), 5_000)
  ),
]);

if (result.kind === "timeout") {
  console.log(JSON.stringify({
    result: historyMode === "sqlite" ? "reproduced" : "control_timeout",
    detail: historyMode === "sqlite"
      ? "Worker made no observable progress for 5 seconds after synchronous SQLite append"
      : "memory control did not settle within 5 seconds",
  }));
  host.cancelActiveTurn();
  await submitted;
} else {
  const reproduced = historyMode === "sqlite" && !result.outcome.ok &&
    host.requestCount() === 1;
  console.log(JSON.stringify({
    result: reproduced ? "reproduced" : "completed",
    ok: result.outcome.ok,
    stopReason: result.outcome.stopReason,
    ...("error" in result.outcome ? { error: result.outcome.error } : {}),
    ...(result.outcome.diagnostic === undefined ? {} : {
      diagnostic: {
        stage: result.outcome.diagnostic.stage,
        code: result.outcome.diagnostic.code,
      },
    }),
    requestCount: host.requestCount(),
  }));
}
await host.close();
await server.shutdown();
