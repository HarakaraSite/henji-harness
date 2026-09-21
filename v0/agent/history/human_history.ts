import type { JsonValue, Message } from '../core/contracts.ts';
import type { ContextRequestPurpose, ExecutionContextRelation } from './context_attribution.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type {
  StoredExecutionEffect,
  StoredExecutionEvent,
  StoredExecutionRow,
} from './history_store_contract.ts';

export const HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const HUMAN_HISTORY_PAGE_EXECUTIONS = 6;
export const HUMAN_HISTORY_DETAIL_SCALARS = 16_384;

export interface HumanHistoryCursorV1 {
  readonly schemaVersion: 1;
  readonly turn: number;
  readonly createdAt: string;
  readonly executionId: string;
}

export interface HumanHistoryEntryV1 {
  readonly id: string;
  readonly executionId: string;
  readonly turn: number;
  readonly attempt: number;
  readonly kind:
    | 'execution'
    | 'task'
    | 'user'
    | 'steer'
    | 'assistant'
    | 'tool'
    | 'projection'
    | 'context'
    | 'request'
    | 'evidence'
    | 'diagnostic'
    | 'artifact';
  readonly label: string;
  readonly text: string;
  readonly detailId: string;
  /** Full semantic source text used by the read port; Surfaces receive only `text`. */
  readonly searchText: string;
}

export interface HumanHistoryPageV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly entries: readonly HumanHistoryEntryV1[];
  readonly executionCount: number;
  readonly olderCursor?: string;
  readonly newerCursor?: string;
  readonly atOldest: boolean;
  readonly atNewest: boolean;
  readonly projection?: Readonly<{
    readonly version: 1;
    readonly state: 'current' | 'stale';
    readonly pendingSources: number;
    readonly staleReason?: 'pending';
  }>;
}

export interface HumanHistoryDetailChunkV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly detailId: string;
  readonly title: string;
  readonly text: string;
  readonly scalarOffset: number;
  readonly scalarLength: number;
  readonly totalScalars: number;
  readonly previousOffset?: number;
  readonly nextOffset?: number;
}

export interface HumanHistorySearchHitV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly query: string;
  readonly entryId: string;
  readonly detailId: string;
  readonly sourceScalarOffset: number;
  readonly detail?: HumanHistoryDetailChunkV1;
  readonly detailMatchScalarOffset?: number;
  readonly wrapped: boolean;
  readonly page: HumanHistoryPageV1;
}

export interface HumanHistoryPageRequest {
  readonly sessionId: string;
  readonly direction: 'latest' | 'oldest' | 'older' | 'newer';
  readonly cursor?: string;
  readonly executionLimit?: number;
}

export interface HumanHistorySearchRequest {
  readonly sessionId: string;
  readonly query: string;
  readonly direction: 'next' | 'previous';
  readonly fromEntryId?: string;
  readonly fromSourceScalarOffset?: number;
}

export interface HumanHistoryExportRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly identity: string;
  readonly value: JsonValue;
}

/** Read-only Host port. It is deliberately separate from the execution writer contract. */
export interface HumanHistoryReadPort {
  readHumanHistoryPage(request: HumanHistoryPageRequest): HumanHistoryPageV1;
  readHumanHistoryDetail(
    sessionId: string,
    detailId: string,
    scalarOffset?: number,
  ): HumanHistoryDetailChunkV1;
  searchHumanHistory(
    request: HumanHistorySearchRequest,
  ): HumanHistorySearchHitV1 | undefined;
  streamHumanHistoryExport(
    sessionId: string,
  ): Iterable<HumanHistoryExportRecordV1>;
}

export interface HumanHistoryProjectionInput {
  readonly execution: StoredExecutionRow;
  readonly attempt: number;
  readonly canonicalMessages: readonly {
    readonly ordinal: number;
    readonly message: Message;
  }[];
  readonly events: readonly StoredExecutionEvent[];
  readonly effects: readonly StoredExecutionEffect[];
  readonly projection?: Readonly<{
    readonly kind: string;
    readonly sourceExecutionId: string;
    readonly text: string;
    readonly status: string;
  }>;
  readonly context: readonly ExecutionContextRelation[];
  readonly requests: readonly {
    readonly requestOrdinal: number;
    readonly lane: 'parent' | 'planner';
    readonly purpose: ContextRequestPurpose;
    readonly modelStep: number;
    readonly modelSelection?: ModelSelection;
  }[];
  readonly evidenceIds: readonly string[];
  readonly diagnosticIds: readonly string[];
  readonly artifactIds: readonly string[];
}

const preview = (text: string, maximum = 320): string => {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const scalars = [...normalized];
  return scalars.length <= maximum ? normalized : `${scalars.slice(0, maximum).join('')}…`;
};

const jsonText = (value: unknown): string => JSON.stringify(value);

const entry = (
  execution: StoredExecutionRow,
  attempt: number,
  kind: HumanHistoryEntryV1['kind'],
  id: string,
  label: string,
  text: string,
  detailId = id,
): HumanHistoryEntryV1 =>
  Object.freeze({
    id,
    executionId: execution.executionId,
    turn: execution.turn,
    attempt,
    kind,
    label,
    text: preview(text),
    detailId,
    searchText: text,
  });

const eventValue = (
  event: StoredExecutionEvent,
): Record<string, unknown> | undefined => {
  if (
    typeof event.payload !== 'object' || event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  const providerObservation = payload.kind === 'provider_observation' &&
      typeof payload.observation === 'object' && payload.observation !== null &&
      !Array.isArray(payload.observation)
    ? payload.observation as Record<string, unknown>
    : undefined;
  const envelope = providerObservation?.kind === 'runtime_event' &&
      typeof providerObservation.event === 'object' &&
      providerObservation.event !== null &&
      !Array.isArray(providerObservation.event)
    ? providerObservation.event as Record<string, unknown>
    : payload.kind === 'runtime_event' &&
        typeof payload.event === 'object' && payload.event !== null &&
        !Array.isArray(payload.event)
    ? payload.event as Record<string, unknown>
    : payload;
  if (
    envelope.kind === 'agent_event' && typeof envelope.event === 'object' &&
    envelope.event !== null && !Array.isArray(envelope.event)
  ) return envelope.event as Record<string, unknown>;
  return typeof envelope.kind === 'string' ? envelope : undefined;
};

const messageEntry = (
  execution: StoredExecutionRow,
  attempt: number,
  ordinal: number,
  message: Message,
): readonly HumanHistoryEntryV1[] => {
  const id = `message:${execution.executionId}:${ordinal}`;
  if (message.role === 'user') {
    return [entry(
      execution,
      attempt,
      ordinal === 0 ? 'user' : 'steer',
      id,
      ordinal === 0 ? 'user>' : 'steer>',
      message.content.text,
    )];
  }
  if (message.role === 'assistant') {
    if ('text' in message.content) {
      return [
        entry(
          execution,
          attempt,
          'assistant',
          id,
          'assistant>',
          message.content.text,
        ),
      ];
    }
    const output: HumanHistoryEntryV1[] = [];
    if (message.text !== undefined) {
      output.push(
        entry(
          execution,
          attempt,
          'assistant',
          `${id}:text`,
          'assistant~',
          message.text,
        ),
      );
    }
    for (let index = 0; index < message.content.length; index += 1) {
      const call = message.content[index];
      output.push(entry(
        execution,
        attempt,
        'tool',
        `${id}:call:${index}`,
        `tool> ${call.name}`,
        `${call.name} ${jsonText(call.arguments)}`,
      ));
    }
    return output;
  }
  return message.content.map((result, index) =>
    entry(
      execution,
      attempt,
      'tool',
      `${id}:result:${index}`,
      `tool< ${result.name} · ${result.outcome}`,
      `${result.name} ${result.outcome} ${result.text}`,
    )
  );
};

const semanticEventEntries = (
  execution: StoredExecutionRow,
  attempt: number,
  events: readonly StoredExecutionEvent[],
): readonly HumanHistoryEntryV1[] => {
  const output: HumanHistoryEntryV1[] = [];
  const latestProgress = new Map<string, HumanHistoryEntryV1>();
  for (const stored of events) {
    const value = eventValue(stored);
    if (value === undefined || typeof value.kind !== 'string') continue;
    const id = `event:${execution.executionId}:${stored.ordinal}`;
    if (
      (value.kind === 'user_message' || value.kind === 'steering_message') &&
      typeof value.message === 'object' && value.message !== null
    ) {
      const message = value.message as {
        readonly content?: { readonly text?: unknown };
      };
      if (typeof message.content?.text === 'string') {
        output.push(entry(
          execution,
          attempt,
          value.kind === 'user_message' ? 'user' : 'steer',
          id,
          value.kind === 'user_message' ? 'user>' : 'steer>',
          message.content.text,
        ));
      }
    } else if (
      value.kind === 'assistant_message' ||
      value.kind === 'assistant_progress' ||
      value.kind === 'model_result'
    ) {
      const result = value.kind === 'model_result' &&
          typeof value.result === 'object' && value.result !== null &&
          !Array.isArray(value.result)
        ? value.result as Record<string, unknown>
        : undefined;
      const messageText = value.kind === 'assistant_progress'
        ? value.text
        : value.kind === 'model_result'
        ? result?.text
        : typeof value.message === 'object' && value.message !== null
        ? ((value.message as {
          readonly text?: unknown;
          readonly content?: unknown;
        }).text ??
          ((value.message as { readonly content?: { readonly text?: unknown } })
            .content?.text))
        : undefined;
      if (typeof messageText === 'string') {
        const projected = entry(
          execution,
          attempt,
          'assistant',
          id,
          value.kind === 'assistant_progress' ? 'assistant~ partial' : 'assistant>',
          messageText,
        );
        if (value.kind === 'assistant_progress') {
          latestProgress.set('assistant', projected);
        } else {
          latestProgress.delete('assistant');
          output.push(projected);
        }
      }
    } else if (
      value.kind === 'tool_call' && typeof value.call === 'object' &&
      value.call !== null
    ) {
      const call = value.call as {
        readonly callId?: unknown;
        readonly name?: unknown;
        readonly arguments?: unknown;
      };
      const name = typeof call.name === 'string' ? call.name : 'unknown';
      output.push(entry(
        execution,
        attempt,
        'tool',
        id,
        `tool> ${name}`,
        `${name} ${jsonText(call.arguments)} call ${String(call.callId ?? '')}`,
      ));
    } else if (value.kind === 'tool_progress') {
      const callId = String(value.callId ?? stored.ordinal);
      const name = typeof value.name === 'string' ? value.name : 'unknown';
      const text = typeof value.text === 'string' ? value.text : '';
      latestProgress.set(
        `tool:${callId}`,
        entry(
          execution,
          attempt,
          'tool',
          id,
          `tool~ ${name}`,
          `${name} ${text} call ${callId}`,
        ),
      );
    } else if (
      value.kind === 'tool_result' && typeof value.result === 'object' &&
      value.result !== null
    ) {
      const result = value.result as {
        readonly callId?: unknown;
        readonly name?: unknown;
        readonly outcome?: unknown;
        readonly text?: unknown;
      };
      const name = typeof result.name === 'string' ? result.name : 'unknown';
      const callId = String(result.callId ?? stored.ordinal);
      latestProgress.delete(`tool:${callId}`);
      output.push(entry(
        execution,
        attempt,
        'tool',
        id,
        `tool< ${name} · ${String(result.outcome ?? 'unknown')}`,
        `${name} ${String(result.outcome ?? 'unknown')} ${
          String(result.text ?? '')
        } call ${callId}`,
      ));
    }
  }
  output.push(...latestProgress.values());
  return output;
};

/** Pure Host projection. Canonical message ownership and non-canonical journal ownership stay explicit. */
export const projectHumanHistoryExecution = (
  input: HumanHistoryProjectionInput,
): readonly HumanHistoryEntryV1[] => {
  const { execution, attempt } = input;
  const output: HumanHistoryEntryV1[] = [entry(
    execution,
    attempt,
    'execution',
    `execution:${execution.executionId}`,
    `turn ${execution.turn} · attempt ${attempt}`,
    `${execution.lifecycle} ${execution.outcome} ${execution.adoption} · ${execution.executionId}`,
  )];
  if (execution.adoption === 'canonical') {
    for (const message of input.canonicalMessages) {
      output.push(
        ...messageEntry(execution, attempt, message.ordinal, message.message),
      );
    }
  } else {
    output.push(entry(
      execution,
      attempt,
      'task',
      `task:${execution.executionId}`,
      'task>',
      execution.task,
    ));
    output.push(...semanticEventEntries(execution, attempt, input.events));
  }
  for (const effect of input.effects) {
    output.push(entry(
      execution,
      attempt,
      'tool',
      `effect:${execution.executionId}:${effect.callId}`,
      `effect ${effect.name}`,
      `${effect.status} ${effect.resultOutcome ?? ''} call ${effect.callId}`,
    ));
  }
  if (input.projection !== undefined) {
    output.push(entry(
      execution,
      attempt,
      'projection',
      `projection:${execution.executionId}`,
      input.projection.kind,
      `${input.projection.status} source ${input.projection.sourceExecutionId} ${input.projection.text}`,
    ));
  }
  for (const relation of input.context) {
    output.push(entry(
      execution,
      attempt,
      'context',
      `context:${execution.executionId}:${relation.ordinal}`,
      `${relation.stage} ${relation.resourceKind}`,
      [
        relation.logicalIdentity,
        relation.sourceLocator,
        relation.contentDigest,
        relation.lane,
        relation.requestOrdinal === undefined ? undefined : `request ${relation.requestOrdinal}`,
      ].filter((value) => value !== undefined).join(' · '),
    ));
  }
  for (const request of input.requests) {
    output.push(entry(
      execution,
      attempt,
      'request',
      `request:${execution.executionId}:${request.requestOrdinal}`,
      `request ${request.requestOrdinal}`,
      `${request.lane} · ${request.purpose} · step ${request.modelStep} · ${
        jsonText(request.modelSelection ?? '')
      }`,
    ));
  }
  for (const id of input.evidenceIds) {
    output.push(
      entry(
        execution,
        attempt,
        'evidence',
        `evidence:${execution.executionId}:${id}`,
        'evidence',
        id,
      ),
    );
  }
  for (const id of input.diagnosticIds) {
    output.push(
      entry(
        execution,
        attempt,
        'diagnostic',
        `diagnostic:${execution.executionId}:${id}`,
        'diagnostic',
        id,
      ),
    );
  }
  for (const id of input.artifactIds) {
    output.push(
      entry(
        execution,
        attempt,
        'artifact',
        `artifact:${execution.executionId}:${id}`,
        'artifact',
        id,
      ),
    );
  }
  return Object.freeze(output);
};

export const chunkHumanHistoryDetail = (
  sessionId: string,
  detailId: string,
  title: string,
  text: string,
  scalarOffset = 0,
): HumanHistoryDetailChunkV1 => {
  const scalars = [...text];
  const offset = Math.max(0, Math.min(scalars.length, scalarOffset));
  const chunk = scalars.slice(offset, offset + HUMAN_HISTORY_DETAIL_SCALARS)
    .join('');
  return Object.freeze({
    schemaVersion: HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION,
    sessionId,
    detailId,
    title,
    text: chunk,
    scalarOffset: offset,
    scalarLength: [...chunk].length,
    totalScalars: scalars.length,
    ...(offset === 0 ? {} : {
      previousOffset: Math.max(0, offset - HUMAN_HISTORY_DETAIL_SCALARS),
    }),
    ...(offset + HUMAN_HISTORY_DETAIL_SCALARS >= scalars.length ? {} : {
      nextOffset: offset + HUMAN_HISTORY_DETAIL_SCALARS,
    }),
  });
};
