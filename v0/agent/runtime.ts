import { type LoopOutcome } from './contracts.ts';
import {
  type AgentInstructionSource,
  discoverAgentInstructionSnapshot,
  type InstructionFileSystem,
} from './agent_instructions.ts';
import { runAgent, runAgentTurn } from './loop.ts';
import { AgentSession, type SessionPersistence } from './session.ts';
import { type SessionRecord } from './session_store.ts';
import { type AgentEventSink } from './events.ts';
import { type Model } from './contracts.ts';
import { Registry } from './tools.ts';
import {
  type CredentialSource,
  OpenRouterAgentModel,
  type OpenRouterResponseMode,
} from './openrouter_model.ts';
import { createPlannerRegistry, createProductionRegistry } from './registries.ts';
import { resolveWorkspace, type Workspace, type WorkToolSeams } from './work_tools.ts';
import { discoverSkills, type SkillCatalog, type SkillFileSystem } from './skills.ts';
import {
  type AgentDefinition,
  DEFAULT_AGENT_MAX_STEPS,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from './agent_definition.ts';
import {
  type BuiltinAgentId,
  type BuiltinAgentSelection,
  DEFAULT_AGENT_SELECTION,
} from './agent_catalog.ts';
import {
  type AgentResourceSelection,
  validateResolvedAgentResources,
} from './resource_identity.ts';
import {
  createTurnExecutionContext,
  type ParentTurnExecutionContext,
} from './execution_context.ts';
import { type FailureDiagnosticOwner } from './failure_diagnostic.ts';
import { type FailureDiagnosticPersister } from './failure_diagnostic.ts';
import type { PlannerDelegationHandler } from './planner_delegation.ts';
import {
  CancellationCleanupError,
  isCancellationCleanupError,
  isTurnCancelledError,
  TurnCancelledError,
} from './cancellation.ts';
import { type TurnCancellation } from './cancellation.ts';
import {
  type AgentResolvedManifestV1,
  createAgentResolvedManifest,
  validateAgentResolvedManifest,
  validateAgentResolvedManifestCorrelation,
} from './resolved_manifest.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplaySessionMode,
  type RuntimeDisplayState,
} from './startup_orientation.ts';

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
  readonly credentialSource?: CredentialSource;
  /** Offline-only override for unchanged JSON sentinel/compatibility consumers. */
  readonly responseMode?: OpenRouterResponseMode;
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
  readonly onRegistryMaterialized?: (
    definition: ResolvedAgentDefinition,
  ) => void;
  /** Direct-test-only planner Definition replacement; production always uses the fixed Definition. */
  readonly plannerDefinition?: AgentDefinition;
  /** Direct-test-only observer called after selection validation and before materialization. */
  readonly onResourceSelectionValidated?: (
    role: 'parent' | 'planner',
    selection: AgentResourceSelection,
  ) => void;
  /** Direct-test-only manifest construction override; production always uses the built-in codec. */
  readonly resolvedManifestFactory?: (
    role: 'parent' | 'planner',
    definitionId: BuiltinAgentId,
    selection: AgentResourceSelection,
  ) =>
    | AgentResolvedManifestV1
    | unknown
    | Promise<AgentResolvedManifestV1 | unknown>;
  /** Alias retained for direct test readability; production leaves both seams unset. */
  readonly manifestFactory?: RuntimeTestSeam['resolvedManifestFactory'];
  /** Direct-test-only observer after manifest validation and before materialization. */
  readonly onResolvedManifestValidated?: (
    role: 'parent' | 'planner',
    manifest: AgentResolvedManifestV1,
  ) => void;
  /** Direct-test-only observer proving the display state is projected exactly once. */
  readonly onDisplayStateProjected?: (state: RuntimeDisplayState) => void;
  /** Direct-test/host seam for turn-scoped diagnostic persistence. */
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
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
  /** The single immutable projection shared by CLI/TUI runtime consumers. */
  readonly displayState: RuntimeDisplayState;
  readonly resourceSelection: AgentResourceSelection;
  readonly requestCount: () => number;
  readonly createTurnExecutionContext: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellation,
    diagnosticOwner?: FailureDiagnosticOwner,
    providerRequestCount?: () => number,
  ) => ParentTurnExecutionContext;
}

export interface RuntimeSessionComposition {
  readonly session: AgentSession;
  readonly requestCount: () => number;
  readonly displayState: RuntimeDisplayState;
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
        responseMode: seam.responseMode ?? 'sse',
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
        throw new Error(
          'production registry requires planner delegation handler',
        );
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

/** Internal prepare-phase state; no manifest is retained after the test observer runs. */
export interface PreparedRuntimeComposition {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly instructionSource?: AgentInstructionSource;
  readonly skillCatalog: SkillCatalog;
  readonly definition: ResolvedAgentDefinition;
  readonly resourceSelection: AgentResourceSelection;
  readonly selectionId: BuiltinAgentId;
  readonly seam: RuntimeTestSeam;
  readonly fetcher: typeof fetch;
  readonly requestCount: () => number;
  readonly displayState: RuntimeDisplayState;
}

const prepareResolvedManifest = async (
  role: 'parent' | 'planner',
  definitionId: BuiltinAgentId,
  selection: AgentResourceSelection,
  seam: RuntimeTestSeam,
): Promise<AgentResolvedManifestV1> => {
  const factory = seam.resolvedManifestFactory ?? seam.manifestFactory;
  const candidate = factory === undefined
    ? await createAgentResolvedManifest(definitionId, selection)
    : await factory(role, definitionId, selection);
  const manifest = await validateAgentResolvedManifest(candidate);
  validateAgentResolvedManifestCorrelation(manifest, definitionId, selection);
  return manifest;
};

/** Resolve startup inputs and validate the selected Definition before materialization. */
export const prepareRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
  sessionMode: RuntimeDisplaySessionMode = 'none',
): Promise<PreparedRuntimeComposition> => {
  let requestCount = 0;
  const delegate = seam.fetcher ?? fetch;
  const fetcher: typeof fetch = (input, init) => {
    requestCount += 1;
    return delegate(input, init);
  };
  const workspace = await resolveWorkspace(seam.workspaceRoot);
  const instructionSnapshot = await discoverAgentInstructionSnapshot(
    workspace.root,
    seam.instructionFileSystem,
  );
  const agentInstructions = instructionSnapshot?.formatted;
  const skillCatalog = await discoverSkills(
    workspace.root,
    seam.skillFileSystem,
  );
  const definition = selection.definition({
    workspace,
    agentInstructions,
    skillCatalog,
  });
  const role: 'parent' | 'planner' = selection.id === 'planner' ? 'planner' : 'parent';
  const resourceSelection = validateResolvedAgentResources(
    definition,
    selection.id,
  );
  seam.onResourceSelectionValidated?.(role, resourceSelection);
  const manifest = await prepareResolvedManifest(
    role,
    selection.id,
    resourceSelection,
    seam,
  );
  seam.onResolvedManifestValidated?.(role, manifest);
  const displayState = projectRuntimeDisplayState({
    workspaceRoot: workspace.root,
    agentId: selection.id,
    profileId: definition.model.profile.id,
    sessionMode,
    instructionSource: instructionSnapshot?.source,
    skillNames: skillCatalog.skills.map((skill) => skill.name),
  });
  seam.onDisplayStateProjected?.(displayState);
  return {
    workspace,
    agentInstructions,
    instructionSource: instructionSnapshot?.source,
    skillCatalog,
    definition,
    resourceSelection,
    selectionId: selection.id,
    seam,
    fetcher,
    requestCount: () => requestCount,
    displayState,
  };
};

/** Materialize an already-prepared composition without evaluating its Definition again. */
export const materializePreparedRuntimeComposition = (
  prepared: PreparedRuntimeComposition,
): RuntimeComposition => {
  const { definition, seam, fetcher, requestCount } = prepared;
  const plannerDelegation: PlannerDelegationHandler | undefined =
    definition.registry.kind === 'production'
      ? async (task, childContext) => {
        const beforeRequests = requestCount();
        try {
          const childDefinition = (seam.plannerDefinition ?? plannerAgentDefinition)({
            workspace: prepared.workspace,
            agentInstructions: prepared.agentInstructions,
            skillCatalog: prepared.skillCatalog,
          });
          const childResourceSelection = validateResolvedAgentResources(
            childDefinition,
            'planner',
          );
          seam.onResourceSelectionValidated?.(
            'planner',
            childResourceSelection,
          );
          const childManifest = await prepareResolvedManifest(
            'planner',
            'planner',
            childResourceSelection,
            seam,
          );
          seam.onResolvedManifestValidated?.('planner', childManifest);
          const childModel = materializeModel(childDefinition, fetcher, seam);
          const childRegistry = materializeRegistry(
            childDefinition,
            seam,
            undefined,
          );
          const outcome = await runAgentTurn(
            task,
            [],
            childModel,
            childRegistry,
            {
              maxSteps: childResourceSelection.parameters.maxSteps,
              systemInstruction: childDefinition.systemInstruction,
              executionContext: childContext,
              signal: childContext.signal,
              cancellation: childContext.cancellation,
              ownsCancellation: false,
              diagnosticOwner: childContext.diagnosticOwner,
            },
          );
          await childContext.persistDiagnostic();
          if (outcome.stopReason === 'cancelled') {
            throw new TurnCancelledError();
          }
          if (childContext.cancellation?.state === 'cleanup_failed') {
            throw new CancellationCleanupError();
          }
          return { outcome, externalRequests: requestCount() - beforeRequests };
        } catch (error) {
          if (
            isTurnCancelledError(error) || isCancellationCleanupError(error)
          ) throw error;
          return {
            outcome: childFailure(task),
            externalRequests: requestCount() - beforeRequests,
          };
        }
      }
      : undefined;
  const model = materializeModel(definition, fetcher, seam);
  const registry = materializeRegistry(definition, seam, plannerDelegation);
  return {
    model,
    registry,
    systemInstruction: definition.systemInstruction,
    displayState: prepared.displayState,
    resourceSelection: prepared.resourceSelection,
    requestCount,
    createTurnExecutionContext: (
      turn,
      signal,
      cancellation,
      diagnosticOwner,
      providerRequestCount,
    ) =>
      createTurnExecutionContext(
        turn,
        signal,
        cancellation,
        diagnosticOwner,
        providerRequestCount ?? requestCount,
      ),
  };
};

/** Compatibility wrapper used by normal CLI and ephemeral TUI. */
export const createRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
): Promise<RuntimeComposition> =>
  materializePreparedRuntimeComposition(
    await prepareRuntimeComposition(seam, selection),
  );

/** Create a session from a previously prepared composition after persistent record checks. */
export const createRuntimeSessionFromPrepared = (
  eventSink: AgentEventSink,
  prepared: PreparedRuntimeComposition,
  sessionOptions: {
    readonly persistence?: SessionPersistence;
    readonly initialRecord?: SessionRecord;
  } = {},
): RuntimeSessionComposition => {
  const composition = materializePreparedRuntimeComposition(prepared);
  return {
    session: new AgentSession(composition.model, composition.registry, {
      agent: prepared.selectionId,
      maxSteps: composition.resourceSelection.parameters.maxSteps,
      systemInstruction: composition.systemInstruction,
      eventSink,
      createTurnExecutionContext: composition.createTurnExecutionContext,
      diagnosticPersistence: prepared.seam.diagnosticPersistence,
      providerRequestCount: composition.requestCount,
      persistence: sessionOptions.persistence,
      initialRecord: sessionOptions.initialRecord,
      summarizeContext: (request, signal) => composition.model.generate(request, { signal }),
      sourceProfileId: prepared.definition.model.profile.id,
    }),
    requestCount: composition.requestCount,
    displayState: composition.displayState,
  };
};

/** Create one in-memory sequential session from one fixed composition. */
export const createRuntimeSession = async (
  eventSink: AgentEventSink,
  seam: RuntimeTestSeam = {},
  selection: BuiltinAgentSelection = DEFAULT_AGENT_SELECTION,
  sessionOptions: {
    readonly persistence?: SessionPersistence;
    readonly initialRecord?: SessionRecord;
  } = {},
): Promise<
  RuntimeSessionComposition
> =>
  createRuntimeSessionFromPrepared(
    eventSink,
    await prepareRuntimeComposition(seam, selection),
    sessionOptions,
  );

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
  const outcome = await runAgent(
    task,
    composition.model,
    composition.registry,
    {
      maxSteps: composition.resourceSelection.parameters.maxSteps,
      systemInstruction: composition.systemInstruction,
      executionContext: composition.createTurnExecutionContext(1),
    },
  );
  return { outcome, requestCount: composition.requestCount() };
};
