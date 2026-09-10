import {
  type DataValue,
  parseWorkerHostCommand,
  type WorkerCorrelation,
  type WorkerHostCommand,
  type WorkerModuleRevisionRequest,
  type WorkerRuntimeEvent,
  type WorkerToHostMessage,
} from './worker_protocol.ts';
import {
  type ExecutableAgentDefinition,
  finalizeRootAgentComposition,
} from '../worker_agent_api.ts';
import { WorkerGeneration, type WorkerGenerationPort } from './worker_runtime.ts';
import {
  createProductionPhysicalIo,
  createProviderFreePhysicalIo,
  createWorkerRequestCounter,
} from './worker_physical_io.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { discoverAgentInstructionSnapshot } from '../definitions/agent_instructions.ts';
import { discoverSkills } from '../definitions/skills.ts';
import type { Model } from '../core/contracts.ts';
import {
  type ModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../provider/openrouter_model_catalog.ts';
import { isModelSelection } from '../provider/model_catalog.ts';

type WorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => boolean | void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (message: WorkerToHostMessage) => void;
  close: () => void;
};

const scope = globalThis as unknown as WorkerScope;
let eventSequence = 0;
let activeCorrelation: WorkerCorrelation | undefined;
let generation: WorkerGeneration | undefined;

type PendingAcknowledgement = {
  readonly correlation: WorkerCorrelation;
  readonly finish: (accepted: boolean) => void;
};

const acknowledgements = new Map<string, PendingAcknowledgement>();

const post = (message: WorkerToHostMessage): void => scope.postMessage(message);

const runtimeEvent = (
  correlation: WorkerCorrelation,
  event: WorkerRuntimeEvent,
): void => {
  eventSequence += 1;
  post({ kind: 'runtime_event', correlation, sequence: eventSequence, event });
};

const withDigestQuery = (specifier: string, digest: string): string =>
  `${specifier}${specifier.includes('?') ? '&' : '?'}sha256=${digest}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const moduleProbe = (
  moduleNamespace: Record<string, unknown>,
): string | undefined =>
  typeof moduleNamespace.workerProbe === 'string' ? moduleNamespace.workerProbe : undefined;

const acknowledgementKey = (
  kind: 'commit' | 'checkpoint',
  correlation: WorkerCorrelation,
): string =>
  `${kind}:${correlation.session}:${correlation.workerGeneration}:${correlation.command}`;

const sameCorrelation = (
  left: WorkerCorrelation,
  right: WorkerCorrelation,
): boolean =>
  left.session === right.session &&
  left.instanceCorrelation === right.instanceCorrelation &&
  left.workerGeneration === right.workerGeneration &&
  left.baseStateRevision === right.baseStateRevision &&
  left.command === right.command;

const digestHex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const loadVerifiedModule = async (
  correlation: WorkerCorrelation,
  request: WorkerModuleRevisionRequest,
): Promise<{
  readonly entrySha256: string;
  readonly sourceBytes: number;
  readonly probe?: string;
  readonly definition?: ExecutableAgentDefinition;
}> => {
  let source: Uint8Array;
  try {
    source = await Deno.readFile(new URL(request.canonicalSpecifier));
  } catch (error) {
    throw new Error(
      `module pre-read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const digest = await digestHex(source);
  runtimeEvent(correlation, {
    kind: 'module_pre_read',
    sourceBytes: source.byteLength,
    entrySha256: digest,
  });
  if (
    source.byteLength !== request.sourceBytes || digest !== request.entrySha256
  ) {
    throw new Error('module pre-read identity did not match the Host revision');
  }

  runtimeEvent(correlation, {
    kind: 'module_import_start',
    specifier: request.canonicalSpecifier,
  });
  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = await import(
      withDigestQuery(request.canonicalSpecifier, digest)
    ) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `module import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof moduleNamespace.default !== 'function') {
    throw new Error('module default export must be a function');
  }
  runtimeEvent(correlation, {
    kind: 'module_imported',
    specifier: request.canonicalSpecifier,
  });
  return {
    entrySha256: digest,
    sourceBytes: source.byteLength,
    probe: moduleProbe(moduleNamespace),
    definition: moduleNamespace.default as ExecutableAgentDefinition,
  };
};

const waitForAcknowledgement = (
  kind: 'commit' | 'checkpoint',
  correlation: WorkerCorrelation,
  signal: AbortSignal,
): Promise<boolean> => {
  const key = acknowledgementKey(kind, correlation);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      acknowledgements.delete(key);
      signal.removeEventListener('abort', onAbort);
      resolve(accepted);
    };
    const onAbort = (): void => finish(false);
    acknowledgements.set(key, { correlation, finish });
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const makeGenerationPort = (): WorkerGenerationPort => ({
  runtimeEvent: (correlation, event) =>
    runtimeEvent(correlation, {
      kind: 'agent_event',
      event,
    }),
  effectObservation: (correlation, effect) => {
    eventSequence += 1;
    post({
      kind: 'effect_observation',
      correlation,
      sequence: eventSequence,
      effect,
    });
  },
  checkpointProposal: async (correlation, proposal, signal) => {
    post(proposal);
    return await waitForAcknowledgement('checkpoint', correlation, signal);
  },
  commitProposal: async (correlation, proposal, signal) => {
    post(proposal);
    return await waitForAcknowledgement('commit', correlation, signal);
  },
  turnFailed: (correlation, outcome, providerEvidence) =>
    post({
      kind: 'turn_failed',
      correlation,
      outcome,
      ...(providerEvidence === undefined ? {} : { providerEvidence }),
      ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    }),
});

const createGeneration = async (
  correlation: WorkerCorrelation,
  module: Awaited<ReturnType<typeof loadVerifiedModule>>,
  workspaceRoot: string,
  physicalIoMode: 'provider-free' | 'production',
  rootMaxSteps?: number,
  providerTimeoutMs?: number,
  initialTranscript: readonly import('../core/contracts.ts').Message[] = [],
  nextTurn = 1,
  checkpoint?: import('../session/session_store.ts').SemanticContextCheckpointV1,
  initialModelSelection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION,
  rootRole: 'parent' | 'planner' = 'parent',
): Promise<WorkerGeneration> => {
  if (module.definition === undefined) {
    throw new Error('Worker Definition is unavailable');
  }
  const workspace = await resolveWorkspace(workspaceRoot);
  const instructionSnapshot = await discoverAgentInstructionSnapshot(
    workspace.root,
  );
  const skillCatalog = await discoverSkills(workspace.root);
  const requestCounter = createWorkerRequestCounter();
  const physicalIo = physicalIoMode === 'production'
    ? createProductionPhysicalIo(requestCounter, { providerTimeoutMs })
    : createProviderFreePhysicalIo();
  let rootModel = physicalIo.createModel(rootRole, initialModelSelection);
  const rootRouter: Model = {
    get measureRequestWire() {
      return rootModel.measureRequestWire;
    },
    generate: (request, options) => rootModel.generate(request, options),
  };
  const routedPhysicalIo = {
    ...physicalIo,
    createModel: (
      role: 'parent' | 'planner',
      selection?: ModelSelection,
    ): Model => role === rootRole ? rootRouter : physicalIo.createModel('planner', selection),
  };
  const returnedComposition = module.definition({
    workspace,
    agentInstructions: instructionSnapshot?.formatted,
    skillCatalog,
    physicalIo: routedPhysicalIo,
  });
  if (returnedComposition === undefined || typeof returnedComposition !== 'object') {
    throw new Error('Worker Definition did not return a composition');
  }
  const composition = finalizeRootAgentComposition(
    returnedComposition,
    rootMaxSteps,
  );
  return new WorkerGeneration(
    composition,
    correlation.session,
    makeGenerationPort(),
    initialTranscript,
    nextTurn,
    checkpoint,
    requestCounter,
    initialModelSelection,
    (selection) => {
      rootModel = physicalIo.createModel(rootRole, selection);
    },
    physicalIo.credentialAvailability,
  );
};

const handlePermission = async (
  command: Extract<WorkerHostCommand, { kind: 'permission' }>,
): Promise<void> => {
  let read: 'allowed' | 'denied' = 'denied';
  let environment: 'allowed' | 'denied' = 'denied';
  try {
    await Deno.readTextFile(new URL(command.readSpecifier));
    read = 'allowed';
  } catch {
    read = 'denied';
  }
  try {
    Deno.env.get(command.envKey);
    environment = 'allowed';
  } catch {
    environment = 'denied';
  }
  runtimeEvent(command.correlation, { kind: 'permission', read, environment });
};

const mutateClone = (payload: DataValue): DataValue => {
  if (isRecord(payload) && !Array.isArray(payload)) {
    (payload as Record<string, DataValue>).workerMutated = true;
  }
  return payload;
};

const handle = async (command: WorkerHostCommand): Promise<void> => {
  activeCorrelation = command.correlation;
  switch (command.kind) {
    case 'start': {
      let module: Awaited<ReturnType<typeof loadVerifiedModule>> | undefined;
      if (command.module !== undefined) {
        try {
          module = await loadVerifiedModule(
            command.correlation,
            command.module,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stage = message.startsWith('module pre-read')
            ? 'module_pre_read'
            : message.startsWith('module import')
            ? 'module_import'
            : 'module_validation';
          post({
            kind: 'worker_error',
            correlation: command.correlation,
            stage,
            message,
          });
          return;
        }
      }
      let workerGeneration: WorkerGeneration | undefined;
      if (
        command.module !== undefined && command.workspaceRoot !== undefined &&
        module !== undefined
      ) {
        try {
          workerGeneration = await createGeneration(
            command.correlation,
            module,
            command.workspaceRoot,
            command.physicalIoMode ?? 'provider-free',
            command.rootMaxSteps,
            command.providerTimeoutMs,
            command.initialTranscript,
            command.nextTurn,
            command.checkpoint,
            command.modelSelection,
            command.rootRole,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          post({
            kind: 'worker_error',
            correlation: command.correlation,
            stage: 'composition',
            message,
          });
          return;
        }
      }
      generation = workerGeneration;
      const credentialAvailability = await workerGeneration?.rootCredentialAvailability();
      post({
        kind: 'ready',
        correlation: command.correlation,
        ...(command.module === undefined || module === undefined ? {} : {
          module: {
            canonicalSpecifier: command.module.canonicalSpecifier,
            entrySha256: module.entrySha256,
            sourceBytes: module.sourceBytes,
            defaultExport: 'function' as const,
            ...(module.probe === undefined ? {} : { probe: module.probe }),
          },
        }),
        ...(workerGeneration === undefined ? {} : { manifest: workerGeneration.manifest }),
        ...(credentialAvailability === undefined ? {} : { credentialAvailability }),
      });
      return;
    }
    case 'select_model': {
      const accepted = generation !== undefined &&
        isModelSelection(command.selection) &&
        generation.selectRootModel(command.selection);
      const credentialAvailability = accepted
        ? await generation?.rootCredentialAvailability()
        : undefined;
      post({
        kind: 'model_selected',
        correlation: command.correlation,
        accepted,
        ...(accepted && generation !== undefined ? { manifest: generation.manifest } : {}),
        ...(credentialAvailability === undefined ? {} : { credentialAvailability }),
      });
      return;
    }
    case 'turn':
      if (generation === undefined) {
        post({
          kind: 'worker_error',
          correlation: command.correlation,
          stage: 'worker_command',
          message: 'Worker generation is not started',
        });
        return;
      }
      await generation.runTurn(command.correlation, command.task);
      return;
    case 'steer':
      generation?.steerActiveTurn(command.text);
      return;
    case 'cancel':
      generation?.cancelActiveTurn();
      return;
    case 'ordered':
      runtimeEvent(command.correlation, {
        kind: 'ordered',
        sequence: command.sequence,
      });
      return;
    case 'echo':
      runtimeEvent(command.correlation, {
        kind: 'echo',
        payload: mutateClone(command.payload),
      });
      return;
    case 'large_transfer':
      runtimeEvent(command.correlation, {
        kind: 'large_transfer',
        byteLength: new TextEncoder().encode(command.payload).byteLength,
        payload: command.payload,
      });
      return;
    case 'permission':
      await handlePermission(command);
      return;
    case 'worker_error':
      runtimeEvent(command.correlation, {
        kind: 'worker_error_observed',
        message: 'worker-originated command error',
      });
      post({
        kind: 'worker_error',
        correlation: command.correlation,
        stage: 'worker_command',
        message: 'worker-originated command error',
      });
      return;
    case 'uncaught_error':
      queueMicrotask(() => {
        throw new Error(
          `uncaught Worker probe for ${command.correlation.command}`,
        );
      });
      return;
    case 'commit_acknowledgement': {
      const key = acknowledgementKey('commit', command.correlation);
      const acknowledgement = acknowledgements.get(key);
      if (
        acknowledgement !== undefined &&
        sameCorrelation(acknowledgement.correlation, command.correlation)
      ) {
        acknowledgement.finish(command.accepted);
      }
      return;
    }
    case 'checkpoint_acknowledgement': {
      const key = acknowledgementKey('checkpoint', command.correlation);
      const acknowledgement = acknowledgements.get(key);
      if (
        acknowledgement !== undefined &&
        sameCorrelation(acknowledgement.correlation, command.correlation)
      ) {
        acknowledgement.finish(command.accepted);
      }
      return;
    }
    case 'close':
      post({ kind: 'closed', correlation: command.correlation });
      scope.close();
      return;
  }
};

scope.onmessage = (event: MessageEvent<unknown>): void => {
  const command = parseWorkerHostCommand(event.data);
  if (command === undefined) {
    post({
      kind: 'worker_error',
      stage: 'worker_command',
      message: 'unknown Worker command',
    });
    return;
  }
  void handle(command);
};

scope.onerror = (event: ErrorEvent): boolean => {
  post({
    kind: 'worker_error',
    ...(activeCorrelation === undefined ? {} : { correlation: activeCorrelation }),
    stage: 'uncaught',
    message: event.message || 'uncaught Worker error',
  });
  return true;
};
