/** Explicitly approved live probe only: two Exa calls, no parent model calls or retries. */
import {
  ParentTurnExecutionContext,
  TurnRequestBudget,
} from '../v0/agent/core/execution_context.ts';
import type { JsonValue } from '../v0/agent/core/contracts.ts';
import { ProviderEvidenceRecorder } from '../v0/agent/provider/provider_evidence.ts';
import { Registry } from '../v0/agent/tools/tools.ts';
import type { ToolFactoryInput } from '../v0/agent/tool_api.ts';
import webSearchFactory from '../external-tools/web_search/main.ts';
import { resolveRuntimePaths } from '../v0/agent/runtime/runtime_paths.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../v0/agent/worker/worker_physical_io.ts';

type WebSearchRequest = { readonly [key: string]: JsonValue; readonly query: string };

const requests: readonly WebSearchRequest[] = [
  {
    query: 'Deno official documentation filesystem read and write permissions',
    type: 'auto',
    numResults: 3,
    includeDomains: ['docs.deno.com'],
  },
  {
    query: 'Deno documentation Deno.open createNew filesystem permissions',
    type: 'deep',
    numResults: 2,
    includeDomains: ['docs.deno.com'],
    additionalQueries: ['Deno.open createNew API reference'],
    objective: 'Find documented file creation and filesystem permission behavior.',
    contents: { text: { maxCharacters: 1500 }, highlights: true },
    outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  },
];

if (import.meta.main) {
  const outputRoot = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-increment-172-exa-' });
  const counter = createWorkerRequestCounter();
  const physicalIo = createProductionPhysicalIo(counter, {
    credentialRoot: resolveRuntimePaths().credentialRoot,
  });
  const registry = new Registry([webSearchFactory({
    requestProvider: physicalIo.requestProvider!,
  } as unknown as ToolFactoryInput)]);
  const evidence = new ProviderEvidenceRecorder();
  const execution = new ParentTurnExecutionContext(
    1,
    new TurnRequestBudget({ parent: 1, aggregate: 1 }),
    undefined,
    undefined,
    undefined,
    counter.count,
    counter.count,
    evidence,
  );
  const results = [];
  for (const [index, request] of requests.entries()) {
    const result = await registry.dispatch({
      callId: `exa-probe-${index + 1}`,
      name: 'web_search',
      arguments: request,
    }, { modelExecution: execution, modelStep: index + 1 });
    results.push({ arguments: request, result: result.content });
  }
  await Deno.writeTextFile(
    `${outputRoot}/tool-results.json`,
    JSON.stringify(results, null, 2),
    { createNew: true, mode: 0o600 },
  );
  await Deno.writeTextFile(
    `${outputRoot}/request-facts.json`,
    JSON.stringify(evidence.snapshot(), null, 2),
    { createNew: true, mode: 0o600 },
  );
  console.log(JSON.stringify({
    outputRoot,
    physicalRequests: counter.count(),
    modelRequests: execution.snapshot(),
    outcomes: results.map(({ result }) => result.outcome),
  }));
  if (results.some(({ result }) => result.outcome !== 'success')) Deno.exitCode = 1;
}
