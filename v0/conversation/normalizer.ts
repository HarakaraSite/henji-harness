import {
  type ConversationContentLocator,
  type ConversationContentReference,
  type ConversationEntity,
  type ConversationExecutionMetadata,
  type ConversationObservation,
  type ConversationPosition,
  conversationRequestIdentity,
  type ConversationRequestKey,
  type ConversationRequestReference,
  type ConversationState,
  type ConversationValue,
} from './model.ts';

type ConversationFact =
  | Readonly<{ kind: 'upsert'; entity: ConversationEntity }>
  | Readonly<{ kind: 'remove'; id: string }>
  | Readonly<{
    kind: 'context_notice';
    executionId: string;
    eventOrdinal: number;
    notice: 'trimmed' | 'history_partial' | 'history_omitted' | 'exceeded';
    text: string;
  }>
  | Readonly<{
    kind: 'settle_execution';
    executionId: string;
    eventOrdinal: number;
    settledAt?: string;
    terminalSemanticOccurrenceId?: string;
    outcome: ConversationExecutionMetadata['outcome'];
    readonly stopReason?: string;
    readonly diagnostic?: Readonly<{ code: string; stage: string }>;
    adoption: ConversationExecutionMetadata['adoption'];
    committedRevision?: number;
  }>;

interface DeclaredToolReference {
  readonly id: string;
  readonly declarationOccurrenceId: string;
  readonly declarationIndex: number;
  readonly requestKey: ConversationRequestKey;
  readonly callId: string;
}

export interface ConversationNormalizer {
  readonly requestStartOrdinals: Map<string, number>;
  readonly latestRequestByStep: Map<string, ConversationRequestKey>;
  readonly openToolsByRequestCall: Map<string, string[]>;
  readonly openToolsByLogicalCall: Map<string, string[]>;
  readonly openToolsByRequestIndex: Map<string, string[]>;
  readonly openToolsByLogicalIndex: Map<string, string[]>;
  readonly declaredToolsByRequestCall: Map<string, DeclaredToolReference[]>;
  readonly declaredToolsByLogicalCall: Map<string, DeclaredToolReference[]>;
  readonly declaredToolsByRequestIndex: Map<string, DeclaredToolReference[]>;
  readonly declaredToolsByLogicalIndex: Map<string, DeclaredToolReference[]>;
  readonly toolOriginsById: Map<string, {
    requestKey: ConversationRequestKey;
    position: ConversationPosition;
    callIndex?: number;
    callId: string;
    name: string;
    arguments: ConversationValue;
    details?: readonly ConversationContentLocator[];
  }>;
  readonly executionOrders: Map<string, number>;
}

export const createConversationNormalizer = (): ConversationNormalizer => ({
  requestStartOrdinals: new Map(),
  latestRequestByStep: new Map(),
  openToolsByRequestCall: new Map(),
  openToolsByLogicalCall: new Map(),
  openToolsByRequestIndex: new Map(),
  openToolsByLogicalIndex: new Map(),
  declaredToolsByRequestCall: new Map(),
  declaredToolsByLogicalCall: new Map(),
  declaredToolsByRequestIndex: new Map(),
  declaredToolsByLogicalIndex: new Map(),
  toolOriginsById: new Map(),
  executionOrders: new Map(),
});

const encoded = (value: string): string => encodeURIComponent(value);

const executionEntityId = (executionId: string): string => `execution/${encoded(executionId)}`;
const taskMessageId = (executionId: string): string => `message/task/${encoded(executionId)}`;
const requestEntityId = (key: ConversationRequestKey): string =>
  `request/${encoded(conversationRequestIdentity(key))}`;
const assistantEntityId = (key: ConversationRequestKey): string =>
  `message/assistant/${encoded(conversationRequestIdentity(key))}`;
const thinkingEntityId = (
  key: ConversationRequestKey,
  kind: 'text' | 'summary',
): string => `thinking/${encoded(conversationRequestIdentity(key))}/${kind}`;
const requestStepIdentity = (executionId: string, modelStep: number): string =>
  JSON.stringify([executionId, modelStep]);
const requestIndexIdentity = (
  key: ConversationRequestKey,
  callIndex: number,
): string => JSON.stringify([conversationRequestIdentity(key), callIndex]);
const requestCallIdentity = (
  key: ConversationRequestKey,
  callId: string,
): string => JSON.stringify([conversationRequestIdentity(key), callId]);
const logicalCallIdentity = (
  key: ConversationRequestKey,
  callId: string,
): string => JSON.stringify([key.executionId, key.lane ?? null, key.modelStep, callId]);
const requestLogicalIndexIdentity = (
  key: ConversationRequestKey,
  callId: string,
  callIndex: number,
): string =>
  JSON.stringify([
    key.executionId,
    key.lane ?? null,
    key.modelStep,
    callId,
    callIndex,
  ]);

const position = (
  executionOrder: number,
  requestOrder: number,
  phase: number,
  eventOrdinal: number,
  itemOrdinal = eventOrdinal,
): ConversationPosition => ({
  executionOrder,
  requestOrder,
  phase,
  eventOrdinal,
  itemOrdinal,
});

const detailsForEntity = (
  entityId: string,
  details: readonly ConversationContentReference[] | undefined,
): readonly ConversationContentLocator[] | undefined =>
  details === undefined || details.length === 0
    ? undefined
    : details.map((detail) => ({ ...detail, entityId }));

const executionOrder = (
  normalizer: ConversationNormalizer,
  executionId: string,
): number => normalizer.executionOrders.get(executionId) ?? 0;

const compatible = (
  prior: ConversationRequestKey,
  reference: ConversationRequestReference,
): boolean =>
  (reference.lane === undefined || prior.lane === reference.lane) &&
  (reference.requestOrdinal === undefined ||
    prior.requestOrdinal === reference.requestOrdinal);

const resolveRequest = (
  normalizer: ConversationNormalizer,
  executionId: string,
  reference: ConversationRequestReference,
  inheritMissingAttribution = true,
): ConversationRequestKey => {
  const prior = inheritMissingAttribution
    ? normalizer.latestRequestByStep.get(
      requestStepIdentity(executionId, reference.modelStep),
    )
    : undefined;
  const inherited = prior !== undefined && compatible(prior, reference) ? prior : undefined;
  return {
    executionId,
    ...(reference.lane ?? inherited?.lane) === undefined
      ? {}
      : { lane: reference.lane ?? inherited!.lane },
    modelStep: reference.modelStep,
    ...(reference.requestOrdinal ?? inherited?.requestOrdinal) === undefined ? {} : {
      requestOrdinal: reference.requestOrdinal ?? inherited!.requestOrdinal,
    },
  };
};

const requestOrder = (
  normalizer: ConversationNormalizer,
  key: ConversationRequestKey,
  eventOrdinal: number,
): number =>
  normalizer.requestStartOrdinals.get(conversationRequestIdentity(key)) ??
    eventOrdinal;

const normalizedRequest = (
  normalizer: ConversationNormalizer,
  executionId: string,
  reference: ConversationRequestReference,
  inheritMissingAttribution = true,
): ConversationRequestKey => {
  return resolveRequest(
    normalizer,
    executionId,
    reference,
    inheritMissingAttribution,
  );
};

const removeLast = (values: string[] | undefined, value: string): void => {
  if (values === undefined) return;
  const index = values.lastIndexOf(value);
  if (index >= 0) values.splice(index, 1);
};

const resolveTool = (
  normalizer: ConversationNormalizer,
  request: ConversationRequestKey,
  callId: string,
  callIndex?: number,
): string | undefined =>
  callIndex === undefined
    ? normalizer.openToolsByRequestCall.get(
      requestCallIdentity(request, callId),
    )?.at(-1) ??
      normalizer.openToolsByLogicalCall.get(
        logicalCallIdentity(request, callId),
      )?.at(-1)
    : normalizer.openToolsByRequestIndex.get(
      requestIndexIdentity(request, callIndex),
    )?.at(-1) ??
      normalizer.openToolsByLogicalIndex.get(
        requestLogicalIndexIdentity(request, callId, callIndex),
      )?.at(-1);

const takeDeclaration = (
  index: Map<string, DeclaredToolReference[]>,
  identity: string,
): DeclaredToolReference | undefined => index.get(identity)?.shift();

const removeDeclaration = (
  index: Map<string, DeclaredToolReference[]>,
  identity: string,
  id: string,
): void => {
  const values = index.get(identity);
  if (values === undefined) return;
  const position = values.findIndex((value) => value.id === id);
  if (position >= 0) values.splice(position, 1);
};

const removeDeclaredTool = (
  normalizer: ConversationNormalizer,
  declaration: DeclaredToolReference,
): void => {
  removeDeclaration(
    normalizer.declaredToolsByRequestCall,
    requestCallIdentity(declaration.requestKey, declaration.callId),
    declaration.id,
  );
  removeDeclaration(
    normalizer.declaredToolsByLogicalCall,
    logicalCallIdentity(declaration.requestKey, declaration.callId),
    declaration.id,
  );
  removeDeclaration(
    normalizer.declaredToolsByRequestIndex,
    requestIndexIdentity(declaration.requestKey, declaration.declarationIndex),
    declaration.id,
  );
  removeDeclaration(
    normalizer.declaredToolsByLogicalIndex,
    requestLogicalIndexIdentity(
      declaration.requestKey,
      declaration.callId,
      declaration.declarationIndex,
    ),
    declaration.id,
  );
};

const messagePosition = (
  normalizer: ConversationNormalizer,
  key: ConversationRequestKey,
  eventOrdinal: number,
  phase: number,
): ConversationPosition =>
  position(
    executionOrder(normalizer, key.executionId),
    requestOrder(normalizer, key, eventOrdinal),
    phase,
    eventOrdinal,
  );

const assistantMessage = (
  executionId: string,
  turn: number,
  version: number,
  key: ConversationRequestKey,
  text: string,
  complete: boolean,
  pos: ConversationPosition,
  semanticOccurrenceId?: string,
  details?: readonly ConversationContentReference[],
): ConversationFact => ({
  kind: 'upsert',
  entity: {
    kind: 'message',
    id: assistantEntityId(key),
    executionId,
    turn,
    version,
    position: pos,
    role: 'assistant',
    text,
    complete,
    requestKey: key,
    ...(semanticOccurrenceId === undefined ? {} : { semanticOccurrenceId }),
    ...(detailsForEntity(assistantEntityId(key), details) === undefined ? {} : {
      details: detailsForEntity(assistantEntityId(key), details),
    }),
  },
});

/** Normalize provider- and history-adapter observations into keyed current-value facts. */
const normalizeConversationObservation = (
  normalizer: ConversationNormalizer,
  observation: ConversationObservation,
): readonly ConversationFact[] => {
  if (observation.kind === 'execution') {
    normalizer.executionOrders.set(
      observation.execution.executionId,
      observation.executionOrder,
    );
    const pos = position(observation.executionOrder, -1, -2, -1, -1);
    return [
      {
        kind: 'upsert',
        entity: {
          kind: 'execution',
          id: executionEntityId(observation.execution.executionId),
          executionId: observation.execution.executionId,
          version: 0,
          position: pos,
          execution: observation.execution,
        },
      },
      {
        kind: 'upsert',
        entity: {
          kind: 'message',
          id: taskMessageId(observation.execution.executionId),
          executionId: observation.execution.executionId,
          turn: observation.execution.turn,
          version: 0,
          position: position(observation.executionOrder, -1, -1, 0, 0),
          role: 'user',
          text: observation.execution.task,
          complete: true,
          ...(detailsForEntity(
              taskMessageId(observation.execution.executionId),
              observation.taskDetails,
            ) === undefined
            ? {}
            : {
              details: detailsForEntity(
                taskMessageId(observation.execution.executionId),
                observation.taskDetails,
              ),
            }),
        },
      },
    ];
  }

  if (observation.kind === 'execution_settled') {
    return [{
      kind: 'settle_execution',
      executionId: observation.executionId,
      eventOrdinal: observation.eventOrdinal,
      ...(observation.settledAt === undefined ? {} : { settledAt: observation.settledAt }),
      ...(observation.terminalSemanticOccurrenceId === undefined ? {} : {
        terminalSemanticOccurrenceId: observation.terminalSemanticOccurrenceId,
      }),
      outcome: observation.outcome,
      ...(observation.stopReason === undefined ? {} : { stopReason: observation.stopReason }),
      ...(observation.diagnostic === undefined ? {} : { diagnostic: observation.diagnostic }),
      adoption: observation.adoption,
      ...(observation.committedRevision === undefined
        ? {}
        : { committedRevision: observation.committedRevision }),
    }];
  }

  if (observation.kind === 'context_notice') {
    return [{
      kind: 'context_notice',
      executionId: observation.executionId,
      eventOrdinal: observation.eventOrdinal,
      notice: observation.notice,
      text: observation.text,
    }];
  }

  if (observation.kind === 'request_start') {
    const key = resolveRequest(
      normalizer,
      observation.executionId,
      observation.request,
    );
    const identity = conversationRequestIdentity(key);
    normalizer.requestStartOrdinals.set(identity, observation.eventOrdinal);
    normalizer.latestRequestByStep.set(
      requestStepIdentity(observation.executionId, key.modelStep),
      key,
    );
    const pos = position(
      executionOrder(normalizer, observation.executionId),
      observation.eventOrdinal,
      -1,
      observation.eventOrdinal,
    );
    return [{
      kind: 'upsert',
      entity: {
        kind: 'request',
        id: requestEntityId(key),
        executionId: observation.executionId,
        requestKey: key,
        turn: observation.turn,
        version: observation.eventOrdinal,
        position: pos,
        ...(observation.attribution === undefined ? {} : {
          attribution: observation.attribution,
        }),
      },
    }];
  }

  if (observation.kind === 'assistant_progress') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
      false,
    );
    return [assistantMessage(
      observation.executionId,
      observation.turn,
      observation.eventOrdinal,
      key,
      observation.text,
      false,
      messagePosition(
        normalizer,
        key,
        observation.firstEventOrdinal ?? observation.eventOrdinal,
        1,
      ),
      observation.semanticOccurrenceId,
      observation.details,
    )];
  }

  if (observation.kind === 'model_result') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
      false,
    );
    const facts: ConversationFact[] = [
      observation.text === undefined
        ? { kind: 'remove', id: assistantEntityId(key) }
        : assistantMessage(
          observation.executionId,
          observation.turn,
          observation.eventOrdinal,
          key,
          observation.text,
          true,
          messagePosition(
            normalizer,
            key,
            observation.firstEventOrdinal ?? observation.eventOrdinal,
            1,
          ),
          observation.semanticOccurrenceId,
          observation.details,
        ),
    ];
    if (observation.semanticOccurrenceId !== undefined) {
      for (
        const [declarationIndex, call] of (observation.declaredCalls ?? [])
          .entries()
      ) {
        const id = `tool/declared/${encoded(observation.semanticOccurrenceId)}/${declarationIndex}`;
        const declaration = {
          id,
          declarationOccurrenceId: observation.semanticOccurrenceId,
          declarationIndex,
          requestKey: key,
          callId: call.callId,
        };
        const requestIndex = requestIndexIdentity(key, declarationIndex);
        const declarations = normalizer.declaredToolsByRequestIndex.get(requestIndex) ?? [];
        declarations.push(declaration);
        normalizer.declaredToolsByRequestIndex.set(requestIndex, declarations);
        const logicalIndex = requestLogicalIndexIdentity(
          key,
          call.callId,
          declarationIndex,
        );
        const declarationsByLogicalIndex = normalizer.declaredToolsByLogicalIndex.get(
          logicalIndex,
        ) ?? [];
        declarationsByLogicalIndex.push(declaration);
        normalizer.declaredToolsByLogicalIndex.set(
          logicalIndex,
          declarationsByLogicalIndex,
        );
        const requestCall = requestCallIdentity(key, call.callId);
        const declarationsByCall = normalizer.declaredToolsByRequestCall.get(requestCall) ?? [];
        declarationsByCall.push(declaration);
        normalizer.declaredToolsByRequestCall.set(
          requestCall,
          declarationsByCall,
        );
        const logicalCall = logicalCallIdentity(key, call.callId);
        const declarationsByLogicalCall = normalizer.declaredToolsByLogicalCall.get(logicalCall) ??
          [];
        declarationsByLogicalCall.push(declaration);
        normalizer.declaredToolsByLogicalCall.set(
          logicalCall,
          declarationsByLogicalCall,
        );
        const callPosition = messagePosition(
          normalizer,
          key,
          observation.eventOrdinal,
          2,
        );
        const position = {
          executionOrder: callPosition.executionOrder,
          requestOrder: callPosition.requestOrder,
          phase: callPosition.phase,
          eventOrdinal: callPosition.eventOrdinal,
          itemOrdinal: declarationIndex,
        };
        normalizer.toolOriginsById.set(id, {
          requestKey: key,
          position,
          callIndex: declarationIndex,
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          details: detailsForEntity(id, call.details),
        });
        facts.push({
          kind: 'upsert',
          entity: {
            kind: 'tool',
            id,
            declarationOccurrenceId: observation.semanticOccurrenceId,
            declarationIndex,
            started: false,
            executionId: observation.executionId,
            turn: observation.turn,
            callIndex: declarationIndex,
            requestKey: key,
            version: observation.eventOrdinal,
            position,
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
            ...(detailsForEntity(id, call.details) === undefined ? {} : {
              details: detailsForEntity(id, call.details),
            }),
          },
        });
      }
    }
    return facts;
  }

  if (observation.kind === 'thinking') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
    );
    return [{
      kind: 'upsert',
      entity: {
        kind: 'thinking',
        id: thinkingEntityId(key, observation.thinkingKind),
        executionId: observation.executionId,
        turn: observation.turn,
        requestKey: key,
        thinkingKind: observation.thinkingKind,
        version: observation.eventOrdinal,
        position: messagePosition(normalizer, key, observation.eventOrdinal, 0),
        text: observation.text,
        complete: observation.complete,
        ...(detailsForEntity(
            thinkingEntityId(key, observation.thinkingKind),
            observation.details,
          ) === undefined
          ? {}
          : {
            details: detailsForEntity(
              thinkingEntityId(key, observation.thinkingKind),
              observation.details,
            ),
          }),
      },
    }];
  }

  if (observation.kind === 'tool_call') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
      false,
    );
    const requestIndex = observation.callIndex === undefined
      ? undefined
      : requestIndexIdentity(key, observation.callIndex);
    const logicalIndex = observation.callIndex === undefined
      ? undefined
      : requestLogicalIndexIdentity(
        key,
        observation.callId,
        observation.callIndex,
      );
    const requestCall = requestCallIdentity(key, observation.callId);
    const logicalCall = logicalCallIdentity(key, observation.callId);
    const declaration = observation.callIndex === undefined
      ? takeDeclaration(normalizer.declaredToolsByRequestCall, requestCall) ??
        takeDeclaration(normalizer.declaredToolsByLogicalCall, logicalCall)
      : takeDeclaration(
        normalizer.declaredToolsByRequestIndex,
        requestIndex!,
      ) ??
        takeDeclaration(normalizer.declaredToolsByLogicalIndex, logicalIndex!);
    if (declaration !== undefined) removeDeclaredTool(normalizer, declaration);
    const id = declaration?.id ??
      `tool/${encoded(observation.semanticOccurrenceId)}`;
    const callIndex = observation.callIndex ?? declaration?.declarationIndex;
    const origin = normalizer.toolOriginsById.get(id) ?? {
      requestKey: key,
      position: messagePosition(normalizer, key, observation.eventOrdinal, 2),
      ...(callIndex === undefined ? {} : { callIndex }),
      callId: observation.callId,
      name: observation.name,
      arguments: observation.arguments,
      ...(observation.details === undefined ? {} : {
        details: detailsForEntity(id, observation.details),
      }),
    };
    normalizer.toolOriginsById.set(id, origin);
    if (origin.callIndex !== undefined) {
      const indexIdentity = requestIndexIdentity(
        origin.requestKey,
        origin.callIndex,
      );
      const openByRequest = normalizer.openToolsByRequestIndex.get(indexIdentity) ?? [];
      openByRequest.push(id);
      normalizer.openToolsByRequestIndex.set(indexIdentity, openByRequest);
      const logicalIndexIdentity = requestLogicalIndexIdentity(
        origin.requestKey,
        origin.callId,
        origin.callIndex,
      );
      const openByLogicalIndex = normalizer.openToolsByLogicalIndex.get(logicalIndexIdentity) ?? [];
      openByLogicalIndex.push(id);
      normalizer.openToolsByLogicalIndex.set(
        logicalIndexIdentity,
        openByLogicalIndex,
      );
    }
    const originRequestCall = requestCallIdentity(
      origin.requestKey,
      origin.callId,
    );
    const openByCall = normalizer.openToolsByRequestCall.get(originRequestCall) ?? [];
    openByCall.push(id);
    normalizer.openToolsByRequestCall.set(originRequestCall, openByCall);
    const originLogicalCall = logicalCallIdentity(
      origin.requestKey,
      origin.callId,
    );
    const openByLogicalCall = normalizer.openToolsByLogicalCall.get(originLogicalCall) ?? [];
    openByLogicalCall.push(id);
    normalizer.openToolsByLogicalCall.set(originLogicalCall, openByLogicalCall);
    return [{
      kind: 'upsert',
      entity: {
        kind: 'tool',
        id,
        semanticOccurrenceId: observation.semanticOccurrenceId,
        ...(declaration === undefined ? {} : {
          declarationOccurrenceId: declaration.declarationOccurrenceId,
          declarationIndex: declaration.declarationIndex,
        }),
        started: true,
        executionId: observation.executionId,
        turn: observation.turn,
        ...(origin.callIndex === undefined ? {} : { callIndex: origin.callIndex }),
        requestKey: origin.requestKey,
        version: observation.eventOrdinal,
        position: origin.position,
        callId: origin.callId,
        name: origin.name,
        arguments: origin.arguments,
        ...(origin.details === undefined ? {} : { details: origin.details }),
      },
    }];
  }

  if (observation.kind === 'tool_progress') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
      false,
    );
    const id = resolveTool(
      normalizer,
      key,
      observation.callId,
      observation.callIndex,
    );
    if (id === undefined) return [];
    const origin = normalizer.toolOriginsById.get(id) ?? {
      requestKey: key,
      position: messagePosition(normalizer, key, observation.eventOrdinal, 2),
      callId: observation.callId,
      name: '',
      arguments: null,
    };
    return [{
      kind: 'upsert',
      entity: {
        kind: 'tool',
        id,
        started: true,
        executionId: observation.executionId,
        turn: observation.turn,
        ...(origin.callIndex === undefined ? {} : { callIndex: origin.callIndex }),
        requestKey: origin.requestKey,
        version: observation.eventOrdinal,
        position: origin.position,
        callId: origin.callId,
        name: origin.name,
        arguments: origin.arguments,
        progress: observation.text,
        ...(origin.details === undefined ? {} : { details: origin.details }),
      },
    }];
  }

  if (observation.kind === 'tool_result') {
    const key = normalizedRequest(
      normalizer,
      observation.executionId,
      observation.request,
      false,
    );
    const id = resolveTool(
      normalizer,
      key,
      observation.result.callId,
      observation.callIndex,
    );
    if (id === undefined) return [];
    const origin = normalizer.toolOriginsById.get(id) ?? {
      requestKey: key,
      position: messagePosition(normalizer, key, observation.eventOrdinal, 2),
      ...(observation.callIndex === undefined ? {} : { callIndex: observation.callIndex }),
      callId: observation.result.callId,
      name: observation.result.name,
      arguments: null,
      ...(observation.details === undefined ? {} : {
        details: detailsForEntity(id, observation.details),
      }),
    };
    if (origin.callIndex !== undefined) {
      removeLast(
        normalizer.openToolsByRequestIndex.get(
          requestIndexIdentity(origin.requestKey, origin.callIndex),
        ),
        id,
      );
      removeLast(
        normalizer.openToolsByLogicalIndex.get(
          requestLogicalIndexIdentity(
            origin.requestKey,
            origin.callId,
            origin.callIndex,
          ),
        ),
        id,
      );
    }
    removeLast(
      normalizer.openToolsByRequestCall.get(
        requestCallIdentity(origin.requestKey, origin.callId),
      ),
      id,
    );
    removeLast(
      normalizer.openToolsByLogicalCall.get(
        logicalCallIdentity(origin.requestKey, origin.callId),
      ),
      id,
    );
    return [{
      kind: 'upsert',
      entity: {
        kind: 'tool',
        id,
        started: true,
        executionId: observation.executionId,
        turn: observation.turn,
        ...(origin.callIndex === undefined ? {} : { callIndex: origin.callIndex }),
        requestKey: origin.requestKey,
        version: observation.eventOrdinal,
        position: origin.position,
        callId: origin.callId,
        name: origin.name,
        arguments: origin.arguments,
        result: {
          text: observation.result.text,
          outcome: observation.result.outcome,
          ...(observation.result.terminal === undefined ? {} : {
            terminal: observation.result.terminal,
          }),
        },
        ...((origin.details === undefined || origin.details.length === 0) &&
            (observation.details === undefined ||
              observation.details.length === 0)
          ? {}
          : {
            details: [
              ...(origin.details ?? []),
              ...(detailsForEntity(id, observation.details) ?? []),
            ],
          }),
      },
    }];
  }

  if (observation.kind === 'steering_operation') {
    const order = executionOrder(normalizer, observation.executionId);
    return [{
      kind: 'upsert',
      entity: {
        kind: 'steering',
        id: `steering/${encoded(observation.executionId)}/${observation.eventOrdinal}`,
        executionId: observation.executionId,
        version: observation.eventOrdinal,
        position: position(
          order,
          observation.eventOrdinal,
          0,
          observation.eventOrdinal,
        ),
        status: observation.status,
        text: observation.text,
        ...(detailsForEntity(
            `steering/${encoded(observation.executionId)}/${observation.eventOrdinal}`,
            observation.details,
          ) === undefined
          ? {}
          : {
            details: detailsForEntity(
              `steering/${encoded(observation.executionId)}/${observation.eventOrdinal}`,
              observation.details,
            ),
          }),
      },
    }];
  }

  if (observation.kind === 'steering_applied') {
    const order = executionOrder(normalizer, observation.executionId);
    return [{
      kind: 'upsert',
      entity: {
        kind: 'message',
        id: `message/applied/${encoded(observation.semanticOccurrenceId)}`,
        executionId: observation.executionId,
        turn: observation.turn,
        version: observation.eventOrdinal,
        position: position(
          order,
          observation.eventOrdinal,
          0,
          observation.eventOrdinal,
        ),
        role: 'user',
        text: observation.text,
        complete: true,
        semanticOccurrenceId: observation.semanticOccurrenceId,
        ...(detailsForEntity(
            `message/applied/${encoded(observation.semanticOccurrenceId)}`,
            observation.details,
          ) === undefined
          ? {}
          : {
            details: detailsForEntity(
              `message/applied/${encoded(observation.semanticOccurrenceId)}`,
              observation.details,
            ),
          }),
      },
    }];
  }

  const exhaustive: never = observation;
  return exhaustive;
};

const withToolRelations = (
  state: ConversationState,
  entity: ConversationEntity,
): ConversationEntity => {
  if (
    entity.kind !== 'message' || entity.role !== 'assistant' ||
    entity.requestKey === undefined
  ) {
    return entity;
  }
  const ids = state.toolsByRequest.get(
    conversationRequestIdentity(entity.requestKey),
  );
  return ids === undefined || ids.length === 0 ? entity : { ...entity, toolIds: [...ids] };
};

const applyFact = (
  state: ConversationState,
  fact: ConversationFact,
): readonly import('./model.ts').ConversationChange[] => {
  if (fact.kind === 'remove') {
    if (!state.entities.delete(fact.id)) return [];
    state.order.delete(fact.id);
    return [{ kind: 'remove', id: fact.id }, {
      kind: 'order',
      action: 'remove',
      id: fact.id,
    }];
  }
  if (fact.kind === 'context_notice') {
    const id = executionEntityId(fact.executionId);
    const current = state.entities.get(id);
    if (current === undefined || current.kind !== 'execution') return [];
    const notices = current.execution.contextNotices ?? [];
    if (notices.some((notice) => notice.notice === fact.notice)) return [];
    const entity: ConversationEntity = {
      ...current,
      version: Math.max(current.version, fact.eventOrdinal),
      execution: {
        ...current.execution,
        contextNotices: [...notices, { notice: fact.notice, text: fact.text }],
      },
    };
    state.entities.set(id, entity);
    return [{ kind: 'upsert', entity }];
  }
  if (fact.kind === 'settle_execution') {
    const id = executionEntityId(fact.executionId);
    const current = state.entities.get(id);
    if (
      current === undefined || current.kind !== 'execution' ||
      fact.eventOrdinal < current.version
    ) {
      return [];
    }
    const execution = {
      ...current.execution,
      lifecycle: 'settled' as const,
      outcome: fact.outcome,
      ...(fact.stopReason === undefined ? {} : { stopReason: fact.stopReason }),
      ...(fact.diagnostic === undefined ? {} : { diagnostic: fact.diagnostic }),
      adoption: fact.adoption,
      ...(fact.settledAt === undefined ? {} : { settledAt: fact.settledAt }),
      ...(fact.terminalSemanticOccurrenceId === undefined ? {} : {
        terminalSemanticOccurrenceId: fact.terminalSemanticOccurrenceId,
      }),
      ...(fact.committedRevision === undefined
        ? {}
        : { committedRevision: fact.committedRevision }),
    };
    const entity: ConversationEntity = {
      ...current,
      execution,
      version: fact.eventOrdinal,
    };
    state.entities.set(id, entity);
    return [{ kind: 'upsert', entity }];
  }

  const proposed = fact.entity;
  const priorTool = proposed.kind === 'tool' ? state.entities.get(proposed.id) : undefined;
  const next = proposed.kind === 'tool' && priorTool?.kind === 'tool'
    ? {
      ...priorTool,
      ...proposed,
      name: proposed.name.length === 0 ? priorTool.name : proposed.name,
      arguments: proposed.arguments === null ? priorTool.arguments : proposed.arguments,
      ...(proposed.progress === undefined && priorTool.progress !== undefined
        ? { progress: priorTool.progress }
        : {}),
    }
    : proposed.kind === 'tool'
    ? proposed
    : withToolRelations(state, proposed);
  const current = state.entities.get(next.id);
  if (current !== undefined && current.version > next.version) return [];
  const entity = current === undefined
    ? next
    : { ...next, position: current.position } as ConversationEntity;

  let relatedAssistant: ConversationEntity | undefined;
  if (entity.kind === 'tool') {
    const identity = conversationRequestIdentity(entity.requestKey);
    const related = state.toolsByRequest.get(identity) ?? [];
    if (!related.includes(entity.id)) related.push(entity.id);
    state.toolsByRequest.set(identity, related);
    const assistantId = assistantEntityId(entity.requestKey);
    const assistant = state.entities.get(assistantId);
    if (assistant?.kind === 'message' && assistant.role === 'assistant') {
      const toolIds = assistant.toolIds ?? [];
      const toolOccurrenceIds = assistant.toolOccurrenceIds ?? [];
      const hasEntityId = toolIds.includes(entity.id);
      const hasOccurrenceId = entity.semanticOccurrenceId === undefined ||
        toolOccurrenceIds.includes(entity.semanticOccurrenceId);
      if (!hasEntityId || !hasOccurrenceId) {
        const nextAssistant: ConversationEntity = {
          ...assistant,
          toolIds: hasEntityId ? toolIds : [...toolIds, entity.id],
          ...(entity.semanticOccurrenceId === undefined || hasOccurrenceId ? {} : {
            toolOccurrenceIds: [
              ...toolOccurrenceIds,
              entity.semanticOccurrenceId,
            ],
          }),
        };
        state.entities.set(assistantId, nextAssistant);
        relatedAssistant = nextAssistant;
      }
    }
  }

  const isNew = current === undefined;
  state.entities.set(entity.id, entity);
  if (isNew) state.order.set(entity.id, entity.position);
  const changes: import('./model.ts').ConversationChange[] = [{
    kind: 'upsert',
    entity,
  }];
  if (isNew) {
    changes.push({
      kind: 'order',
      action: 'insert',
      id: entity.id,
      position: entity.position,
    });
  }
  if (relatedAssistant !== undefined) {
    changes.push({ kind: 'upsert', entity: relatedAssistant });
  }
  return changes;
};

export const applyObservation = (
  state: ConversationState,
  normalizer: ConversationNormalizer,
  observation: ConversationObservation,
): readonly import('./model.ts').ConversationChange[] => {
  const changes: import('./model.ts').ConversationChange[] = [];
  for (
    const fact of normalizeConversationObservation(normalizer, observation)
  ) {
    changes.push(...applyFact(state, fact));
  }
  return changes;
};

export const conversationJson = (value: unknown): ConversationValue => value as ConversationValue;
