import { type LoopOutcome } from './contracts.ts';
import {
  composeSystemInstruction,
  discoverAgentInstructions,
  type InstructionFileSystem,
} from './agent_instructions.ts';
import { runAgent } from './loop.ts';
import { AgentSession } from './session.ts';
import { type AgentEventSink } from './events.ts';
import { type Model } from './contracts.ts';
import { Registry } from './tools.ts';
import { OpenRouterAgentModel } from './openrouter_model.ts';
import { createProductionRegistry } from './registries.ts';
import { resolveWorkspace, type WorkToolSeams } from './work_tools.ts';
import { discoverSkills, type SkillFileSystem } from './skills.ts';

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
  /** Direct-test-only workspace injection; production has no workspace option. */
  readonly workspaceRoot?: string;
  /** Direct-test-only instruction discovery filesystem injection. */
  readonly instructionFileSystem?: InstructionFileSystem;
  /** Direct-test-only skill discovery filesystem injection. */
  readonly skillFileSystem?: SkillFileSystem;
  /** Direct-test-only local mutation hook. */
  readonly workTools?: WorkToolSeams;
}

export interface RuntimeRun {
  readonly outcome: LoopOutcome;
  /** Number of times the model adapter started an external fetch. */
  readonly requestCount: number;
}

/** The fixed normal-runtime wiring shared by one-shot CLI and the TUI. */
export interface RuntimeComposition {
  readonly model: Model;
  readonly registry: Registry;
  readonly systemInstruction?: string;
  readonly requestCount: () => number;
}

/**
 * Resolve the normal runtime once.  Keeping this operation separate from execution makes the
 * multi-turn TUI use exactly the same workspace, instruction, skills, registry, and lazy model
 * wiring as agent:run.
 */
export const createRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
): Promise<RuntimeComposition> => {
  let requestCount = 0;
  const delegate = seam.fetcher ?? fetch;
  const fetcher: typeof fetch = (input, init) => {
    requestCount += 1;
    return delegate(input, init);
  };

  const workspace = await resolveWorkspace(seam.workspaceRoot);
  const agentInstructions = await discoverAgentInstructions(
    workspace.root,
    seam.instructionFileSystem,
  );
  const skillCatalog = await discoverSkills(workspace.root, seam.skillFileSystem);
  const systemInstruction = composeSystemInstruction(agentInstructions, skillCatalog.manifest);
  const registry = createProductionRegistry(workspace, seam.workTools, skillCatalog);
  const model = new OpenRouterAgentModel({
    fetcher,
    credential: seam.credential,
    credentialSource: seam.credentialSource,
  });
  return {
    model,
    registry,
    systemInstruction,
    requestCount: () => requestCount,
  };
};

/** Create one in-memory sequential session from one fixed composition. */
export const createRuntimeSession = async (
  eventSink: AgentEventSink,
  seam: RuntimeTestSeam = {},
): Promise<{ readonly session: AgentSession; readonly requestCount: () => number }> => {
  const composition = await createRuntimeComposition(seam);
  return {
    session: new AgentSession(composition.model, composition.registry, {
      maxSteps: MAX_STEPS,
      systemInstruction: composition.systemInstruction,
      eventSink,
    }),
    requestCount: composition.requestCount,
  };
};

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
  const composition = await createRuntimeComposition(seam);
  const outcome = await runAgent(task, composition.model, composition.registry, {
    maxSteps: MAX_STEPS,
    systemInstruction: composition.systemInstruction,
  });
  return { outcome, requestCount: composition.requestCount() };
};
