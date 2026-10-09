import { type Message } from '../core/contracts.ts';
import { indexSessionHistory, type SessionHistoryIndex } from './session_history.ts';
import { sessionPaths, type SessionRecord } from './session_store.ts';

const encoder = new TextEncoder();
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREATE_ATTEMPTS = 8;

type HistoryExportSessionIdentity =
  | Readonly<{ readonly kind: 'durable'; readonly sessionId: string }>
  | Readonly<{ readonly kind: 'none' }>;

interface HistoryExportRequest {
  readonly transcript: readonly Message[];
  readonly position: Readonly<{
    readonly agent: SessionRecord['agent'];
    readonly committedTurn: number;
    readonly createdAt: string;
    readonly title?: string;
  }>;
  readonly session: HistoryExportSessionIdentity;
  readonly runtime?: Readonly<{
    readonly instructionSource: 'AGENTS.md' | 'AGENTS.MD' | 'none';
    readonly skillNames: readonly string[];
    readonly omittedSkills: number;
    readonly hardSandbox: false;
  }>;
}

interface HistoryExportReceipt {
  readonly path: string;
  readonly throughTurn: number;
}

interface HistoryExporter {
  write(request: HistoryExportRequest): Promise<HistoryExportReceipt>;
}

const longestBacktickRun = (text: string): number => {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    if (character === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
};

const fenced = (text: string, language = ''): string => {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
};

const inlineCode = (text: string): string => {
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(text) + 1));
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
};

const markdownChunks = function* (
  index: SessionHistoryIndex,
  workspaceRoot: string,
  agent: SessionRecord['agent'],
  session: HistoryExportSessionIdentity,
  createdAt: string,
  title: string | undefined,
  runtime: HistoryExportRequest['runtime'],
): Generator<string> {
  const throughTurn = index.turns.at(-1)?.turn ?? 0;
  yield* markdownHeaderChunks(
    workspaceRoot,
    agent,
    session,
    createdAt,
    title,
    runtime,
    throughTurn,
  );
  for (const turn of index.turns) {
    yield* markdownTurnChunks(turn.turn, turn.messages);
  }
};

const markdownHeaderChunks = function* (
  workspaceRoot: string,
  agent: SessionRecord['agent'],
  session: HistoryExportSessionIdentity,
  createdAt: string,
  title: string | undefined,
  runtime: HistoryExportRequest['runtime'],
  throughTurn: number,
): Generator<string> {
  const sessionLabel = session.kind === 'none' ? 'no-session' : session.sessionId;
  yield '# Henji Session History\n\n';
  yield `- Title: ${inlineCode(title ?? 'untitled')}\n`;
  yield `- Created: ${inlineCode(createdAt)}\n`;
  yield `- Session: \`${sessionLabel}\`\n`;
  yield `- Agent: \`${agent}\`\n`;
  yield `- Through turn: ${throughTurn}\n`;
  yield '- Workspace:\n\n';
  yield fenced(workspaceRoot);
  if (runtime !== undefined) {
    yield '\n## Runtime at export\n\n';
    yield `- Context: ${inlineCode(runtime.instructionSource)}\n`;
    const skills = runtime.skillNames.length === 0
      ? 'none'
      : `${runtime.skillNames.join(', ')}${
        runtime.omittedSkills > 0 ? ` (+${runtime.omittedSkills} more)` : ''
      }`;
    yield `- Skills: ${inlineCode(skills)}\n`;
    yield '- Trust: `trusted-local`\n';
    yield `- Hard sandbox: ${runtime.hardSandbox ? 'yes' : 'no'}\n`;
  }
};

const markdownTurnChunks = function* (
  turnNumber: number,
  messages: Iterable<Message>,
): Generator<string> {
  yield `\n## Turn ${turnNumber}\n\n`;
  let offset = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      yield `### ${offset === 0 ? 'user>' : 'steer>'}\n\n`;
      yield fenced(message.content.text);
    } else if (message.role === 'assistant') {
      if ('text' in message.content) {
        yield '### assistant>\n\n';
        yield fenced(message.content.text);
      } else {
        if (message.text !== undefined) {
          yield '### assistant>\n\n';
          yield fenced(message.text);
        }
        for (const call of message.content) {
          yield `### tool> ${call.name}\n\n`;
          yield `- Call: \`${call.callId}\`\n\n`;
          yield fenced(JSON.stringify(call.arguments, null, 2), 'json');
        }
      }
    } else {
      for (const result of message.content) {
        yield `### tool< ${result.name} · ${result.outcome}\n\n`;
        yield `- Call: \`${result.callId}\`\n\n`;
        yield fenced(result.text);
      }
    }
    offset += 1;
  }
};

/** Render a canonical transcript one stored turn at a time. */
export function* renderHistoryMarkdownTurns(
  request: Readonly<{
    readonly agent: SessionRecord['agent'];
    readonly sessionId: string;
    readonly createdAt: string;
    readonly title: string | undefined;
    readonly committedTurn: number;
    readonly turns: Iterable<Readonly<{ turn: number; messages: Iterable<Message> }>>;
  }>,
  workspaceRoot: string,
): Generator<string> {
  if (!SESSION_ID.test(request.sessionId)) throw new Error('history export failed');
  yield* markdownHeaderChunks(
    workspaceRoot,
    request.agent,
    { kind: 'durable', sessionId: request.sessionId },
    request.createdAt,
    request.title,
    undefined,
    request.committedTurn,
  );
  let expectedTurn = 1;
  for (const turn of request.turns) {
    if (turn.turn !== expectedTurn) throw new Error('history export failed');
    yield* markdownTurnChunks(turn.turn, turn.messages);
    expectedTurn += 1;
  }
  if (expectedTurn - 1 !== request.committedTurn) {
    throw new Error('history export failed');
  }
}

const writeBytes = async (file: Deno.FsFile, bytes: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = await file.write(bytes.subarray(offset));
    if (count <= 0) throw new Error('history export failed');
    offset += count;
  }
};

interface PreparedExport {
  readonly index: SessionHistoryIndex;
  readonly session: HistoryExportSessionIdentity;
  readonly agent: SessionRecord['agent'];
  readonly throughTurn: number;
  readonly createdAt: string;
  readonly title?: string;
  readonly runtime?: HistoryExportRequest['runtime'];
}

const prepareExport = (request: HistoryExportRequest): PreparedExport => {
  const index = request.transcript.length === 0
    ? Object.freeze({
      turns: Object.freeze([]),
      messageCount: 0,
      turnCount: 0,
    })
    : indexSessionHistory(request.transcript);
  if (index === undefined) throw new Error('history export failed');
  const throughTurn = index.turns.at(-1)?.turn ?? 0;
  if (throughTurn !== request.position.committedTurn) {
    throw new Error('history export failed');
  }
  if (
    request.session.kind === 'durable' &&
    !SESSION_ID.test(request.session.sessionId)
  ) throw new Error('history export failed');
  return Object.freeze({
    index,
    session: request.session.kind === 'none'
      ? Object.freeze({ kind: 'none' as const })
      : Object.freeze({ kind: 'durable' as const, sessionId: request.session.sessionId }),
    agent: request.position.agent,
    throughTurn,
    createdAt: request.position.createdAt,
    ...(request.position.title === undefined ? {} : { title: request.position.title }),
    ...(request.runtime === undefined ? {} : { runtime: structuredClone(request.runtime) }),
  });
};

/** Render the committed canonical transcript as a Markdown snapshot without file I/O. */
export const renderHistoryMarkdown = (
  request: HistoryExportRequest,
  workspaceRoot: string,
): string => {
  const prepared = prepareExport(request);
  return [...markdownChunks(
    prepared.index,
    workspaceRoot,
    prepared.agent,
    prepared.session,
    prepared.createdAt,
    prepared.title,
    prepared.runtime,
  )].join('');
};

interface DenoHistoryExporterOptions {
  readonly uuid?: () => string;
}

/** Workspace-partitioned Host writer for complete committed history snapshots. */
export class DenoHistoryExporter implements HistoryExporter {
  private readonly uuid: () => string;

  constructor(
    private readonly stateRoot: string,
    private readonly workspaceRoot: string,
    options: DenoHistoryExporterOptions = {},
  ) {
    this.uuid = options.uuid ?? (() => crypto.randomUUID().toLowerCase());
  }

  async write(request: HistoryExportRequest): Promise<HistoryExportReceipt> {
    // This synchronous preparation clones and validates the committed turns before the first I/O.
    const prepared = prepareExport(request);
    const paths = await sessionPaths(this.stateRoot, this.workspaceRoot);
    await Deno.mkdir(paths.historyExports, { recursive: true, mode: 0o700 });
    const identity = prepared.session.kind === 'none' ? 'no-session' : prepared.session.sessionId;
    let path: string | undefined;
    let file: Deno.FsFile | undefined;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const uuid = this.uuid().toLowerCase();
      if (!SESSION_ID.test(uuid)) throw new Error('history export failed');
      const candidate = `${paths.historyExports}/${identity}-through-turn-${
        String(prepared.throughTurn).padStart(6, '0')
      }-${uuid}.md`;
      try {
        file = await Deno.open(candidate, {
          createNew: true,
          write: true,
          mode: 0o600,
        });
        path = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw new Error('history export failed');
        }
      }
    }
    if (file === undefined || path === undefined) throw new Error('history export failed');
    let complete = false;
    try {
      for (
        const chunk of markdownChunks(
          prepared.index,
          this.workspaceRoot,
          prepared.agent,
          prepared.session,
          prepared.createdAt,
          prepared.title,
          prepared.runtime,
        )
      ) {
        await writeBytes(file, encoder.encode(chunk));
      }
      await file.sync();
      complete = true;
    } catch {
      throw new Error('history export failed');
    } finally {
      file.close();
      if (!complete) {
        try {
          await Deno.remove(path);
        } catch {
          // The failed export remains failed even if a partial file cannot be removed.
        }
      }
    }
    return Object.freeze({ path, throughTurn: prepared.throughTurn });
  }
}
