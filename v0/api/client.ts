import {
  decodeCatalogReadResult,
  decodeCommandResult,
  decodeCommandState,
  decodeContextReadResult,
  decodeCoreCommandValue,
  decodeCoreReadView,
  decodeCoreShutdownValue,
  decodeCredentialPresenceReadResult,
  decodeCredentialRegisterResult,
  decodeExecutionReadResult,
  decodeFollowUpReadResult,
  decodeHistoryReadResult,
  decodePathReadResult,
  decodeRecallValue,
  decodeSelectionChangeValue,
  decodeSessionRenameValue,
  decodeSessionsListResult,
  decodeSessionSnapshot,
  decodeSessionStreamFrame,
} from './codec.ts';
import type {
  CatalogReadInput,
  CatalogReadResult,
  CommandResult,
  CommandState,
  ContextReadResult,
  CoreCommandValue,
  CoreReadView,
  CoreShutdownInput,
  CoreShutdownValue,
  CredentialPresenceReadResult,
  CredentialRegisterInput,
  CredentialRegisterResult,
  ExecutionCancelInput,
  ExecutionCancelValue,
  ExecutionReadResult,
  FollowUpQueueInput,
  FollowUpQueueValue,
  FollowUpReadResult,
  HistoryReadInput,
  HistoryReadResult,
  PathReadResult,
  RecallInput,
  RecallValue,
  SelectionChangeInput,
  SelectionChangeValue,
  SessionOpenInput,
  SessionOpenResult,
  SessionRenameInput,
  SessionRenameValue,
  SessionsListResult,
  SessionSnapshot,
  SessionStreamFrame,
  SteeringSubmitInput,
  SteeringSubmitValue,
  TaskSubmitInput,
  TaskSubmitValue,
} from './contract.ts';

export class HenjiApiError extends Error {
  constructor(
    readonly status: number,
    message = 'HTTP API request failed',
  ) {
    super(message);
    this.name = 'HenjiApiError';
  }
}

const jsonOrApiError = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const value: unknown = await response.json();
      if (typeof value === 'object' && value !== null && 'error' in value) {
        const error = (value as { error?: unknown }).error;
        if (typeof error === 'object' && error !== null && 'message' in error) {
          const detail = (error as { message?: unknown }).message;
          if (typeof detail === 'string') message = detail;
        }
      }
    } catch {
      // Keep the status as the useful transport detail when no JSON error was supplied.
    }
    throw new HenjiApiError(response.status, message);
  }
  try {
    return await response.json();
  } catch {
    throw new HenjiApiError(response.status, 'HTTP API returned invalid JSON');
  }
};

const encodePath = (value: string): string => encodeURIComponent(value);

/** Browser-compatible HTTP and SSE client for the public `/api/v1` contract. */
export class HenjiApiClient {
  readonly baseUrl: string;

  constructor(url: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('Henji API URL must use HTTP or HTTPS');
    }
    this.baseUrl = `${parsed.href.replace(/\/+$/u, '')}/api/v1`;
  }

  async coreRead(signal?: AbortSignal): Promise<CoreReadView> {
    return decodeCoreReadView(
      await jsonOrApiError(await this.fetcher(`${this.baseUrl}/core`, { signal })),
    );
  }

  async coreShutdown(
    input: CoreShutdownInput,
  ): Promise<CommandResult<CoreShutdownValue>> {
    return decodeCommandResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/core/shutdown`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
      decodeCoreShutdownValue,
    );
  }

  /** Wait for the accepted shutdown to finish draining and close its listener. */
  async waitUntilCoreStopped(coreEpoch: string, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        const current = await this.coreRead(signal);
        if (current.coreEpoch !== coreEpoch) return;
      } catch (error) {
        if (!(error instanceof HenjiApiError) || error.status === 404) return;
        if (error.status !== 503) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async sessionRead(sessionId: string): Promise<SessionSnapshot> {
    return decodeSessionSnapshot(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/sessions/${encodePath(sessionId)}`),
      ),
    );
  }

  async sessionsList(): Promise<SessionsListResult> {
    return decodeSessionsListResult(
      await jsonOrApiError(await this.fetcher(`${this.baseUrl}/sessions`)),
    );
  }

  async catalogRead(input: CatalogReadInput): Promise<CatalogReadResult> {
    const query = new URLSearchParams({ kind: input.kind });
    if (input.kind === 'models' || input.kind === 'efforts') {
      query.set('provider', input.provider);
    }
    if (input.kind === 'efforts') query.set('modelId', input.modelId);
    return decodeCatalogReadResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/catalogs?${query}`),
      ),
    );
  }

  async selectionChange(
    sessionId: string,
    input: SelectionChangeInput,
  ): Promise<CommandResult<SelectionChangeValue>> {
    return decodeCommandResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/sessions/${encodePath(sessionId)}/selection`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          },
        ),
      ),
      decodeSelectionChangeValue,
    );
  }

  async credentialPresenceRead(): Promise<CredentialPresenceReadResult> {
    return decodeCredentialPresenceReadResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/credentials/presence`),
      ),
    );
  }

  async credentialRegister(
    input: CredentialRegisterInput,
  ): Promise<CredentialRegisterResult> {
    return decodeCredentialRegisterResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/credentials/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    );
  }

  async pathRead(prefix?: string): Promise<PathReadResult> {
    const query = new URLSearchParams();
    if (prefix !== undefined) query.set('prefix', prefix);
    const suffix = query.size === 0 ? '' : `?${query}`;
    return decodePathReadResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/workspace/paths${suffix}`),
      ),
    );
  }

  async historyRead(input: HistoryReadInput): Promise<HistoryReadResult> {
    const query = new URLSearchParams();
    query.set('view', input.view);
    if (input.sessionRef !== undefined) query.set('session', input.sessionRef);
    if (input.latest === true) query.set('latest', 'true');
    return decodeHistoryReadResult(
      await jsonOrApiError(
        await this.fetcher(`${this.baseUrl}/history?${query}`),
      ),
    );
  }

  async sessionOpen(input: SessionOpenInput): Promise<SessionOpenResult> {
    const value = await jsonOrApiError(
      await this.fetcher(`${this.baseUrl}/sessions/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    return decodeCommandResult(value, (item) => {
      if (typeof item !== 'object' || item === null || !('snapshot' in item)) {
        throw new TypeError('invalid session open result');
      }
      return {
        snapshot: decodeSessionSnapshot(
          (item as { snapshot: unknown }).snapshot,
        ),
      };
    });
  }

  async sessionRename(
    sessionId: string,
    input: SessionRenameInput,
  ): Promise<CommandResult<SessionRenameValue>> {
    return decodeCommandResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/sessions/${encodePath(sessionId)}/title`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          },
        ),
      ),
      decodeSessionRenameValue,
    );
  }

  async recall(
    sessionId: string,
    input: RecallInput,
  ): Promise<CommandResult<RecallValue>> {
    return decodeCommandResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/sessions/${encodePath(sessionId)}/recall`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          },
        ),
      ),
      decodeRecallValue,
    );
  }

  async contextRead(sessionId: string): Promise<ContextReadResult> {
    return decodeContextReadResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/sessions/${encodePath(sessionId)}/context`,
        ),
      ),
    );
  }

  async taskSubmit(
    sessionId: string,
    input: TaskSubmitInput,
  ): Promise<CommandResult<TaskSubmitValue>> {
    const value = await jsonOrApiError(
      await this.fetcher(
        `${this.baseUrl}/sessions/${encodePath(sessionId)}/tasks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    );
    return decodeCommandResult(value, (item) => {
      if (
        typeof item !== 'object' || item === null ||
        typeof (item as { executionId?: unknown }).executionId !== 'string'
      ) {
        throw new TypeError('invalid task submit result');
      }
      return { executionId: (item as { executionId: string }).executionId };
    });
  }

  async executionCancel(
    sessionId: string,
    executionId: string,
    input: ExecutionCancelInput,
  ): Promise<CommandResult<ExecutionCancelValue>> {
    const value = await jsonOrApiError(
      await this.fetcher(
        `${this.baseUrl}/sessions/${encodePath(sessionId)}/executions/${
          encodePath(executionId)
        }/cancel`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    );
    return decodeCommandResult(value, (item) => {
      if (
        typeof item !== 'object' || item === null ||
        typeof (item as { executionId?: unknown }).executionId !== 'string' ||
        !['requested', 'already_requested', 'idle'].includes(
          String((item as { result?: unknown }).result),
        )
      ) throw new TypeError('invalid execution cancel result');
      return {
        executionId: (item as { executionId: string }).executionId,
        result: (item as { result: ExecutionCancelValue['result'] }).result,
      };
    });
  }

  async steeringSubmit(
    sessionId: string,
    executionId: string,
    input: SteeringSubmitInput,
  ): Promise<CommandResult<SteeringSubmitValue>> {
    const value = await jsonOrApiError(
      await this.fetcher(
        `${this.baseUrl}/sessions/${encodePath(sessionId)}/executions/${
          encodePath(executionId)
        }/steering`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    );
    return decodeCommandResult(value, (item) => {
      if (
        typeof item !== 'object' || item === null ||
        typeof (item as { executionId?: unknown }).executionId !== 'string'
      ) throw new TypeError('invalid steering submit result');
      return { executionId: (item as { executionId: string }).executionId };
    });
  }

  async followUpQueue(
    sessionId: string,
    input: FollowUpQueueInput,
  ): Promise<CommandResult<FollowUpQueueValue>> {
    const value = await jsonOrApiError(
      await this.fetcher(
        `${this.baseUrl}/sessions/${encodePath(sessionId)}/follow-up`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    );
    return decodeCommandResult(value, (item) => {
      if (
        typeof item !== 'object' || item === null ||
        typeof (item as { queueId?: unknown }).queueId !== 'string'
      ) throw new TypeError('invalid follow-up queue result');
      return { queueId: (item as { queueId: string }).queueId };
    });
  }

  async followUpRead(
    sessionId: string,
    queueId: string,
  ): Promise<FollowUpReadResult> {
    return decodeFollowUpReadResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/sessions/${encodePath(sessionId)}/follow-up/${encodePath(queueId)}`,
        ),
      ),
    );
  }

  async commandRead(
    commandId: string,
  ): Promise<CommandState<CoreCommandValue>> {
    const value = await jsonOrApiError(
      await this.fetcher(`${this.baseUrl}/commands/${encodePath(commandId)}`),
    );
    return decodeCommandState(value, decodeCoreCommandValue);
  }

  async executionRead(executionId: string): Promise<ExecutionReadResult> {
    return decodeExecutionReadResult(
      await jsonOrApiError(
        await this.fetcher(
          `${this.baseUrl}/executions/${encodePath(executionId)}`,
        ),
      ),
    );
  }

  async *sessionSubscribe(
    sessionId: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): AsyncGenerator<SessionStreamFrame> {
    const response = await this.fetcher(
      `${this.baseUrl}/sessions/${encodePath(sessionId)}/events`,
      {
        headers: { accept: 'text/event-stream' },
        signal: options.signal,
      },
    );
    if (!response.ok) {
      await jsonOrApiError(response);
      throw new HenjiApiError(response.status);
    }
    if (response.body === null) {
      throw new HenjiApiError(response.status, 'SSE body is missing');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const parseFrame = (chunk: string): SessionStreamFrame | undefined => {
      const data: string[] = [];
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''));
        }
      }
      if (data.length === 0) return undefined;
      try {
        return decodeSessionStreamFrame(JSON.parse(data.join('\n')));
      } catch (error) {
        if (error instanceof HenjiApiError) throw error;
        throw new HenjiApiError(
          response.status,
          'HTTP API returned an invalid SSE frame',
        );
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        let boundary = buffered.search(/\r?\n\r?\n/u);
        while (boundary >= 0) {
          const separator = buffered.match(/\r?\n\r?\n/u)!;
          const chunk = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + separator[0].length);
          const frame = parseFrame(chunk);
          if (frame !== undefined) yield frame;
          boundary = buffered.search(/\r?\n\r?\n/u);
        }
        if (done) {
          const frame = parseFrame(buffered);
          if (frame !== undefined) yield frame;
          break;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The body may already be closed after a normal stream end.
      }
      reader.releaseLock();
    }
  }
}
