/** Explicitly approved live probe only: two Exa calls, no parent model calls or retries. */
import {
  ParentTurnExecutionContext,
  TurnRequestBudget,
} from '../v0/agent/core/execution_context.ts';
import { emptySkillCatalog } from '../v0/agent/definitions/skills.ts';
import { ProviderEvidenceRecorder } from '../v0/agent/provider/provider_evidence.ts';
import { createBashOutputStore } from '../v0/agent/tools/bash_output.ts';
import { Registry } from '../v0/agent/tools/tools.ts';
import type { WebSearchRequest } from '../v0/agent/tools/web_search.ts';
import { resolveWorkspace } from '../v0/agent/tools/work_tool_workspace.ts';
import webSearchDefinition from '../v0/agent/worker/worker_builtin_web_search_tool.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../v0/agent/worker/worker_physical_io.ts';

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
  const workspace = await resolveWorkspace();
  const counter = createWorkerRequestCounter();
  const physicalIo = createProductionPhysicalIo(counter);
  const component = webSearchDefinition({
    workspace,
    skillCatalog: emptySkillCatalog(),
    physicalIo,
  });
  const bashOutputStore = createBashOutputStore();
  const registry = new Registry([component.materialize({
    workspace,
    workTools: {},
    bashOutputStore,
  })]);
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
  try {
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
  } finally {
    await bashOutputStore.close();
  }
}
