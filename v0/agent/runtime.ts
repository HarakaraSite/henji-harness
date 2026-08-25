import { type LoopOutcome } from './contracts.ts';
import { runAgent } from './loop.ts';
import { OpenRouterAgentModel } from './openrouter_model.ts';
import {
  createCharacterCountTool,
  createFixtureTool,
  createJsonArrayCountTool,
  createJsonObjectKeysTool,
  Registry,
} from './tools.ts';

/** The normal runtime has one fixed finite model-request bound. */
export const MAX_STEPS = 8;

/** The only local file exposed through the normal runtime's JSON tool. */
export const FIXED_JSON_PATH = 'deno.v0.json';

/**
 * Offline-only seams for direct tests. The production CLI calls `runRuntime`
 * without options, which resolves the fixed profile, host fetch, and host
 * credential source inside the existing adapter.
 */
export interface RuntimeTestSeam {
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: () => string | undefined;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export interface RuntimeRun {
  readonly outcome: LoopOutcome;
  /** Number of times the model adapter started an external fetch. */
  readonly requestCount: number;
}

/** Construct the fixed four-tool registry for one invocation. */
export const createRuntimeRegistry = (
  readFile?: (path: string) => Promise<Uint8Array>,
): Registry =>
  new Registry([
    createCharacterCountTool(),
    createJsonArrayCountTool(),
    createJsonObjectKeysTool({ allowedPath: FIXED_JSON_PATH, readFile }),
    createFixtureTool(),
  ]);

/**
 * Run one normal single-shot agent invocation.
 *
 * The model and registry are constructed once per call, and the existing
 * provider-neutral loop is called once with the fixed eight-step bound. The
 * fetch wrapper is intentionally local so offline tests can observe starts
 * without changing the shared provider adapter or making a second attempt.
 */
export const runRuntime = async (
  task: string,
  seam: RuntimeTestSeam = {},
): Promise<RuntimeRun> => {
  let requestCount = 0;
  const delegate = seam.fetcher ?? fetch;
  const fetcher: typeof fetch = (input, init) => {
    requestCount += 1;
    return delegate(input, init);
  };

  const registry = createRuntimeRegistry(seam.readFile);
  const model = new OpenRouterAgentModel({
    fetcher,
    credential: seam.credential,
    credentialSource: seam.credentialSource,
  });
  const outcome = await runAgent(task, model, registry, {
    maxSteps: MAX_STEPS,
  });
  return { outcome, requestCount };
};
