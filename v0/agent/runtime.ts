import { type LoopOutcome } from './contracts.ts';
import { discoverAgentInstructions, type InstructionFileSystem } from './agent_instructions.ts';
import { runAgent, runAgentTurn } from './loop.ts';
import { AgentSession } from './session.ts';
import { type AgentEventSink } from './events.ts';
import { type Model } from './contracts.ts';
import { Registry } from './tools.ts';
import { OpenRouterAgentModel } from './openrouter_model.ts';
import { createPlannerRegistry, createProductionRegistry } from './registries.ts';
import { resolveWorkspace, type WorkToolSeams } from './work_tools.ts';
import { discoverSkills, type SkillFileSystem } from './skills.ts';
import {
  DEFAULT_AGENT_MAX_STEPS,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from './agent_definition.ts';
import { type BuiltinAgentSelection, DEFAULT_AGENT_SELECTION } from './agent_catalog.ts';
import {
  createTurnExecutionContext,
  type ParentTurnExecutionContext,
} from './execution_context.ts';
import type { PlannerDelegationHandler } from './planner_delegation.ts';
import {
  CancellationCleanupError,
  isCancellationCleanupError,
  isTurnCancelledError,
  TurnCancelledError,
} from './cancellation.ts';
import { type TurnCancellation } from './cancellation.ts';

/** The normal runtime has one fixed finite model-request bound. */
export const MAX_STEPS = DEFAULT_AGENT_MAX_STEPS;

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
  /** Direct-test-only materialization counters; production leaves these unset. */
  readonly onModelMaterialized?: (definition: ResolvedAgentDefinition) => void;
  readonly onRegistryMaterialized?: (definition: ResolvedAgentDefinition) => void;
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
  readonly maxSteps: number;
  readonly requestCount: () => number;
  readonly createTurnExecutionContext: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellation,
  ) => ParentTurnExecutionContext;
}

const materializationFailure = (value: never): never => {
  throw new Error(`unsupported runtime composition kind: ${String(value)}`);
};

const materializeModel = (
  definition: ResolvedAgentDefinition,
  fetcher: typeof fetch,
  seam: RuntimeTestSeam,
): Model => {
  seam.onModelMaterialized?.(definition);
  switch (definition.model.provider) {
    case 'openrouter':
      return new OpenRouterAgentModel({
        profile: definition.model.profile,
        fetcher,
        credential: seam.credential,
        credentialSource: seam.credentialSource,
      });
    default:
      return materializationFailure(definition.model.provider);
  }
};

const materializeRegistry = (
  definition: ResolvedAgentDefinition,
  seam: RuntimeTestSeam,
  plannerDelegation: PlannerDelegationHandler | undefined,
): Registry => {
  seam.onRegistryMaterialized?.(definition);
  switch (definition.registry.kind) {
    case 'production': {
      if (plannerDelegation === undefined) {
        throw new Error('production registry requires planner delegation handler');
      }
      return createProductionRegistry(
        definition.registry.workspace,
        seam.workTools ?? {},
        definition.registry.skillCatalog,
        plannerDelegation,
      );
    }
    case 'planner':
      return createPlannerRegistry(
        definition.registry.workspace,
        definition.registry.skillCatalog,
      );
    default:
      return materializationFailure(definition.registry);
  }
};

const childFailure = (task: string): LoopOutcome => ({
  ok: false,
  task,
  outcome: 'contract_failure',
  stopReason: 'contract_failure',
  error: 'planner delegation failed',
  steps: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

/**
 * Resolve the normal runtime once.  Keeping this operation separate from execution makes the
 * multi-turn TUI use exactly the same workspace, instruction, skills, registry, and lazy model
 * wiring as agent:run.
 */
export const createRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
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
  const definition = selection.definition({
    workspace,
    agentInstructions,
    skillCatalog,
  });
  const model = materializeModel(definition, fetcher, seam);
  const plannerDelegation: PlannerDelegationHandler | undefined =
    definition.registry.kind === 'production'
      ? async (task, childContext) => {
        const beforeRequests = requestCount;
        try {
          // The planner Definition and its registry/model are materialized only after the
          // parent tool has synchronously admitted this child.
          const childDefinition = plannerAgentDefinition({
            workspace,
            agentInstructions,
            skillCatalog,
          });
          const childModel = materializeModel(childDefinition, fetcher, seam);
          const childRegistry = materializeRegistry(childDefinition, seam, undefined);
          const outcome = await runAgentTurn(
            task,
            [],
            childModel,
            childRegistry,
            {
              maxSteps: childDefinition.maxSteps,
              systemInstruction: childDefinition.systemInstruction,
              executionContext: childContext,
              signal: childContext.signal,
              cancellation: childContext.cancellation,
              ownsCancellation: false,
            },
          );
          if (outcome.stopReason === 'cancelled') throw new TurnCancelledError();
          if (childContext.cancellation?.state === 'cleanup_failed') {
            throw new CancellationCleanupError();
          }
          return { outcome, externalRequests: requestCount - beforeRequests };
        } catch (error) {
          if (isTurnCancelledError(error) || isCancellationCleanupError(error)) throw error;
          return {
            outcome: childFailure(task),
            externalRequests: requestCount - beforeRequests,
          };
        }
      }
      : undefined;
  const registry = materializeRegistry(definition, seam, plannerDelegation);
  return {
    model,
    registry,
    systemInstruction: definition.systemInstruction,
    maxSteps: definition.maxSteps,
    requestCount: () => requestCount,
    createTurnExecutionContext: (turn, signal, cancellation) =>
      createTurnExecutionContext(turn, signal, cancellation),
  };
};

/** Create one in-memory sequential session from one fixed composition. */
export const createRuntimeSession = async (
  eventSink: AgentEventSink,
  seam: RuntimeTestSeam = {},
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
): Promise<{ readonly session: AgentSession; readonly requestCount: () => number }> => {
  const composition = await createRuntimeComposition(seam, selection);
  return {
    session: new AgentSession(composition.model, composition.registry, {
      maxSteps: composition.maxSteps,
      systemInstruction: composition.systemInstruction,
      eventSink,
      createTurnExecutionContext: composition.createTurnExecutionContext,
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
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
): Promise<RuntimeRun> => {
  const composition = await createRuntimeComposition(seam, selection);
  const outcome = await runAgent(task, composition.model, composition.registry, {
    maxSteps: composition.maxSteps,
    systemInstruction: composition.systemInstruction,
    executionContext: composition.createTurnExecutionContext(1),
  });
  return { outcome, requestCount: composition.requestCount() };
};
