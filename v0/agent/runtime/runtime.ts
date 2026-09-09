import { type LoopOutcome } from '../core/contracts.ts';
import {
  type AgentInstructionSource,
  discoverAgentInstructionSnapshot,
  type InstructionFileSystem,
} from '../definitions/agent_instructions.ts';
import { runAgent, runAgentTurn } from '../core/loop.ts';
import { AgentSession, type SessionPersistence } from '../session/session.ts';
import { type SessionRecord } from '../session/session_store.ts';
import { type AgentEventSink } from '../core/events.ts';
import { type Model } from '../core/contracts.ts';
import { Registry } from '../tools/tools.ts';
import {
  type CredentialSource,
  OpenRouterAgentModel,
  type OpenRouterResponseMode,
} from '../provider/openrouter_model.ts';
import { createDeclaredRegistry } from '../tools/registries.ts';
import { resolveWorkspace, type Workspace, type WorkToolSeams } from '../tools/work_tools.ts';
import { discoverSkills, type SkillCatalog, type SkillFileSystem } from '../definitions/skills.ts';
import {
  type AgentDefinition,
  DEFAULT_AGENT_MAX_STEPS,
  plannerAgentDefinition,
  type ResolvedAgentDefinition,
} from '../definitions/agent_definition.ts';
import {
  type AgentDefinitionAdmission,
  type BuiltinAgentId,
  DEFAULT_AGENT_SELECTION,
} from '../definitions/agent_catalog.ts';
import {
  type AgentResourceSelection,
  validateResolvedAgentResources,
} from '../definitions/resource_identity.ts';
import {
  createTurnExecutionContext,
  type ParentTurnExecutionContext,
} from '../core/execution_context.ts';
import { type FailureDiagnosticOwner } from '../session/failure_diagnostic.ts';
import { type FailureDiagnosticPersister } from '../session/failure_diagnostic.ts';
import {
  ProviderEvidenceRecorder,
  type ProviderEvidenceStore,
} from '../provider/provider_evidence.ts';
import {
  isPlannerDelegationFailureError,
  PlannerDelegationFailureError,
  type PlannerDelegationHandler,
} from '../tools/planner_delegation.ts';
import {
  CancellationCleanupError,
  isCancellationCleanupError,
  isTurnCancelledError,
  TurnCancelledError,
} from '../core/cancellation.ts';
import { type TurnCancellation } from '../core/cancellation.ts';
import {
  type AgentResolvedManifestV1,
  type AgentResolvedManifestValidationTopology,
  createAgentResolvedManifestFromDefinition,
  validateAgentResolvedManifest,
  validateAgentResolvedManifestCorrelation,
} from '../definitions/resolved_manifest.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplaySessionMode,
  type RuntimeDisplayState,
} from './startup_orientation.ts';
import { OpenRouterSonarWebSearchBackend, type WebSearchBackend } from '../tools/web_search.ts';
import { resolveBuiltinDefinitionInstruction } from '../instructions/compose.ts';

/** The direct evaluation runtime has one fixed finite model-request bound. */
export const MAX_STEPS = DEFAULT_AGENT_MAX_STEPS;

/** The only local file exposed through the direct evaluation runtime's JSON tool. */
export const FIXED_JSON_PATH = 'deno.v0.json';

/**
 * Offline-only seams for direct tests, corpus evaluation, and sentinels. Production CLI and TUI
 * turns use the Host/Worker route instead of `runRuntime`.
 */
export interface RuntimeTestSeam {
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  /** Offline-only override for unchanged JSON sentinel/compatibility consumers. */
  readonly responseMode?: OpenRouterResponseMode;
  /** Direct-test-only workspace injection; production has no workspace option. */
  readonly workspaceRoot?: string;
  /** Direct-test-only resolved workspace injection for permission-free composition tests. */
  readonly workspace?: Workspace;
  /** Direct-test-only instruction discovery filesystem injection. */
  readonly instructionFileSystem?: InstructionFileSystem;
  /** Direct-test-only skill discovery filesystem injection. */
  readonly skillFileSystem?: SkillFileSystem;
  /** Direct-test-only local mutation hook. */
  readonly workTools?: WorkToolSeams;
  /** Direct-test-only search backend; production constructs the fixed Sonar backend. */
  readonly webSearchBackend?: WebSearchBackend;
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
  /** Direct-test/host seam for retained provider exchange evidence. */
  readonly providerEvidenceStore?: ProviderEvidenceStore;
}

export interface RuntimeRun {
  readonly outcome: LoopOutcome;
  /** Number of times the model adapter started an external fetch. */
  readonly requestCount: number;
}

/** Fixed direct-runtime wiring retained for offline evaluation and compatibility checks. */
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
    runtimeProviderRequestCount?: () => number,
    providerEvidence?: ProviderEvidenceRecorder,
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
  workspace: Workspace,
  skillCatalog: SkillCatalog,
  webSearchBackend?: WebSearchBackend,
): Registry => {
  seam.onRegistryMaterialized?.(definition);
  return createDeclaredRegistry(definition.capabilities, {
    workspace,
    skillCatalog,
    workTools: seam.workTools,
    plannerDelegation,
    webSearchBackend,
  });
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
  readonly topology: AgentResolvedManifestValidationTopology;
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
  definition: ResolvedAgentDefinition,
  topology: AgentResolvedManifestValidationTopology,
): Promise<AgentResolvedManifestV1> => {
  const factory = seam.resolvedManifestFactory ?? seam.manifestFactory;
  const candidate = factory === undefined
    ? await createAgentResolvedManifestFromDefinition(definitionId, definition, topology)
    : await factory(role, definitionId, selection);
  const manifest = await validateAgentResolvedManifest(candidate, topology);
  validateAgentResolvedManifestCorrelation(manifest, definitionId, selection);
  return manifest;
};

/** Resolve startup inputs and validate the selected Definition before materialization. */
export const prepareRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
  selection: AgentDefinitionAdmission = DEFAULT_AGENT_SELECTION,
  sessionMode: RuntimeDisplaySessionMode = 'none',
): Promise<PreparedRuntimeComposition> => {
  let requestCount = 0;
  const delegate = seam.fetcher ?? fetch;
  const fetcher: typeof fetch = (input, init) => {
    requestCount += 1;
    return delegate(input, init);
  };
  const workspace = seam.workspace ?? await resolveWorkspace(seam.workspaceRoot);
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
  const topology: AgentResolvedManifestValidationTopology = 'topology' in selection
    ? selection.topology
    : 'builtin';
  const role: 'parent' | 'planner' = selection.id === 'planner' ? 'planner' : 'parent';
  const resourceSelection = validateResolvedAgentResources(
    definition,
    topology === 'builtin' ? selection.id : undefined,
  );
  seam.onResourceSelectionValidated?.(role, resourceSelection);
  const manifest = await prepareResolvedManifest(
    role,
    selection.id,
    resourceSelection,
    seam,
    definition,
    topology,
  );
  seam.onResolvedManifestValidated?.(role, manifest);
  const displayState = projectRuntimeDisplayState({
    workspaceRoot: workspace.root,
    agentId: selection.id,
    profileId: definition.model.profile.id,
    modelId: definition.model.profile.model,
    effort: definition.model.profile.reasoningEffort ?? 'auto',
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
    topology,
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
  const webSearchBackend = seam.webSearchBackend ?? new OpenRouterSonarWebSearchBackend({
    fetcher,
    credential: seam.credential,
    credentialSource: seam.credentialSource,
  });
  const hasPlannerSubagent = definition.capabilities.subagents.some((resource) =>
    `${resource}` === 'subagent:planner'
  );
  const plannerDelegation: PlannerDelegationHandler | undefined = hasPlannerSubagent
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
          childDefinition,
          'builtin',
        );
        seam.onResolvedManifestValidated?.('planner', childManifest);
        const childModel = materializeModel(childDefinition, fetcher, seam);
        const childRegistry = materializeRegistry(
          childDefinition,
          seam,
          undefined,
          prepared.workspace,
          prepared.skillCatalog,
          undefined,
        );
        const childSystemInstruction = resolveBuiltinDefinitionInstruction(
          'planner',
          prepared.workspace.root,
          prepared.agentInstructions,
          prepared.skillCatalog,
          childRegistry.promptGuidelines(),
        ).systemInstruction;
        const outcome = await runAgentTurn(
          task,
          [],
          childModel,
          childRegistry,
          {
            maxSteps: childResourceSelection.parameters.maxSteps,
            systemInstruction: childSystemInstruction,
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
        if (!outcome.ok) {
          throw new PlannerDelegationFailureError('planner_failed', outcome.diagnostic);
        }
        return { outcome, externalRequests: requestCount() - beforeRequests };
      } catch (error) {
        if (
          isTurnCancelledError(error) || isCancellationCleanupError(error) ||
          isPlannerDelegationFailureError(error)
        ) throw error;
        return {
          outcome: childFailure(task),
          externalRequests: requestCount() - beforeRequests,
        };
      }
    }
    : undefined;
  const model = materializeModel(definition, fetcher, seam);
  const registry = materializeRegistry(
    definition,
    seam,
    plannerDelegation,
    prepared.workspace,
    prepared.skillCatalog,
    webSearchBackend,
  );
  const systemInstruction = prepared.topology === 'builtin'
    ? resolveBuiltinDefinitionInstruction(
      prepared.selectionId === 'planner' ? 'planner' : 'default',
      prepared.workspace.root,
      prepared.agentInstructions,
      prepared.skillCatalog,
      registry.promptGuidelines(),
    ).systemInstruction
    : definition.systemInstruction;
  return {
    model,
    registry,
    systemInstruction,
    displayState: prepared.displayState,
    resourceSelection: prepared.resourceSelection,
    requestCount,
    createTurnExecutionContext: (
      turn,
      signal,
      cancellation,
      diagnosticOwner,
      providerRequestCount,
      runtimeProviderRequestCount,
      providerEvidence,
    ) =>
      createTurnExecutionContext(
        turn,
        signal,
        cancellation,
        diagnosticOwner,
        providerRequestCount ?? requestCount,
        runtimeProviderRequestCount ?? requestCount,
        providerEvidence,
        {
          parent: prepared.resourceSelection.parameters.maxSteps,
          child: DEFAULT_AGENT_MAX_STEPS,
          aggregate: Math.min(
            Number.MAX_SAFE_INTEGER,
            prepared.resourceSelection.parameters.maxSteps + DEFAULT_AGENT_MAX_STEPS,
          ),
        },
      ),
  };
};

/** Compatibility wrapper used by normal CLI and ephemeral TUI. */
export const createRuntimeComposition = async (
  seam: RuntimeTestSeam = {},
  selection: AgentDefinitionAdmission = DEFAULT_AGENT_SELECTION,
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
      providerEvidenceStore: prepared.seam.providerEvidenceStore,
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
  selection: AgentDefinitionAdmission = DEFAULT_AGENT_SELECTION,
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
 * Run one direct single-shot evaluation invocation outside the production Host/Worker path.
 *
 * The model and registry are constructed once per call, and the existing
 * provider-neutral loop is called once with the selected Definition's finite step bound. The
 * fetch wrapper is intentionally local so offline tests can observe starts
 * without changing the shared provider adapter or making a second attempt.
 */
export const runRuntime = async (
  task: string,
  seam: RuntimeTestSeam = {},
  selection: AgentDefinitionAdmission = DEFAULT_AGENT_SELECTION,
): Promise<RuntimeRun> => {
  const composition = await createRuntimeComposition(seam, selection);
  const evidence = seam.providerEvidenceStore === undefined
    ? undefined
    : new ProviderEvidenceRecorder(
      crypto.randomUUID().toLowerCase(),
      1,
      new Date().toISOString(),
      seam.providerEvidenceStore,
    );
  const outcome = await runAgent(
    task,
    composition.model,
    composition.registry,
    {
      maxSteps: composition.resourceSelection.parameters.maxSteps,
      systemInstruction: composition.systemInstruction,
      executionContext: composition.createTurnExecutionContext(
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        evidence,
      ),
    },
  );
  if (evidence !== undefined) {
    evidence.finalize({ outcome });
    try {
      await evidence.persist();
    } catch {
      // Evidence durability must not replace an otherwise valid provider/parser outcome.
    }
    return {
      outcome: {
        ...outcome,
        providerEvidenceId: evidence.evidenceId,
        providerEvidenceDurability: evidence.durability,
        ...(evidence.persistenceErrorCode === undefined ? {} : {
          providerEvidencePersistenceError: evidence.persistenceErrorCode,
        }),
      },
      requestCount: composition.requestCount(),
    };
  }
  return { outcome, requestCount: composition.requestCount() };
};
