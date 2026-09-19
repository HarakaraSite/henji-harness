import type { PresentationPosition, PresentationStartupState } from '../presentation/contract.ts';
import { cellWidth } from './editor_render.ts';
import { escapeTerminalText, localTimestampText } from './terminal_text.ts';

export const orientationSession = (state: PresentationStartupState): string => {
  switch (state.sessionMode.kind) {
    case 'new':
      return 'new (autosave)';
    case 'continue':
      return 'continue newest';
    case 'exact':
      return 'exact session';
    case 'none':
      return 'no session';
  }
};

const fitCells = (value: string, columns: number): string => {
  const limit = Math.max(1, columns);
  let used = 0;
  let result = '';
  for (const character of value) {
    const width = cellWidth(character);
    if (used + width > limit) break;
    result += character;
    used += width;
  }
  if (result === value) return result + ' '.repeat(Math.max(0, limit - used));
  const marker = '…';
  while (result.length > 0 && used + cellWidth(marker) > limit) {
    const points = [...result];
    const removed = points.pop()!;
    result = points.join('');
    used -= cellWidth(removed);
  }
  return result + marker + ' '.repeat(Math.max(0, limit - used - cellWidth(marker)));
};

const textCells = (value: string): number =>
  [...value].reduce((total, character) => total + cellWidth(character), 0);

const fitSuffixCells = (value: string, columns: number): string => {
  const limit = Math.max(1, columns);
  if (textCells(value) <= limit) return value;
  const marker = '…';
  let used = cellWidth(marker);
  const suffix: string[] = [];
  for (const character of [...value].reverse()) {
    const width = cellWidth(character);
    if (used + width > limit) break;
    suffix.push(character);
    used += width;
  }
  return marker + suffix.reverse().join('');
};

const HEADER_LABEL_COLUMNS = 'base instruction:'.length + 1;

/** Wrap one header value, preferring `, ` boundaries so skill lists stay readable. */
const wrapHeaderValue = (value: string, width: number): string[] => {
  if (textCells(value) <= width) return [value];
  const chunks = value.split(', ');
  const lines: string[] = [];
  let line = '';
  for (const chunk of chunks) {
    const candidate = line.length === 0 ? chunk : `${line}, ${chunk}`;
    if (textCells(candidate) <= width) {
      line = candidate;
    } else if (line.length === 0) {
      lines.push(fitCells(chunk, width));
    } else {
      lines.push(line);
      line = chunk;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length === 0 ? [''] : lines;
};

const headerContentLines = (
  label: string,
  value: string,
  inside: number,
): string[] => {
  const valueWidth = Math.max(1, inside - HEADER_LABEL_COLUMNS - 1);
  return wrapHeaderValue(value, valueWidth).map((line, index) => {
    const prefix = index === 0
      ? ` ${label.padEnd(HEADER_LABEL_COLUMNS)}`
      : ' '.repeat(HEADER_LABEL_COLUMNS + 1);
    return `│${fitCells(`${prefix}${line}`, inside)}│`;
  });
};

const sessionIdentity = (
  state: PresentationStartupState,
  position: PresentationPosition,
): string => {
  if (state.sessionMode.kind === 'none') return orientationSession(state);
  const id = position.sessionId?.slice(0, 8);
  return id === undefined ? orientationSession(state) : `${orientationSession(state)} · ${id}`;
};

/** Render the responsive, transcript-independent session orientation block. */
export const startupHeaderLines = (
  state: PresentationStartupState,
  position: PresentationPosition,
  columns = 80,
  rows = 24,
): readonly string[] => {
  const width = Math.max(8, Math.min(160, columns));
  const title = escapeTerminalText(position.title ?? 'untitled');
  const productVersion = escapeTerminalText(state.productVersion);
  const created = localTimestampText(position.createdAt);
  const identity = escapeTerminalText(sessionIdentity(state, position));
  const workspace = escapeTerminalText(state.workspace);
  if (width < 64 || rows < 16) {
    const identityPrefix = `${identity} · `;
    const compactWorkspace = fitSuffixCells(
      workspace,
      Math.max(1, width - textCells(identityPrefix)),
    );
    return Object.freeze([
      fitCells(`Henji Harness v${productVersion} · ${created} · ${title}`, width),
      fitCells(`${identityPrefix}${compactWorkspace}`, width),
    ]);
  }

  const inside = width - 2;
  const content = (label: string, value: string): string =>
    headerContentLines(label, value, inside)[0];
  const heading = `─ Henji Harness v${productVersion} `;
  const top = `╭${heading}${'─'.repeat(Math.max(0, inside - textCells(heading)))}╮`;
  const skills = state.skills.names.length === 0
    ? 'none'
    : `${state.skills.names.map((name) => escapeTerminalText(name)).join(', ')}${
      state.skills.omitted > 0 ? ` (+${state.skills.omitted} more)` : ''
    }`;
  const baseInstruction = state.baseInstruction === undefined ? [] : headerContentLines(
    'base instruction:',
    `${
      escapeTerminalText(state.baseInstruction.resourceId)
    } · ${state.baseInstruction.selectionSource} · ${
      state.baseInstruction.revisionDigest.slice(0, 8)
    }`,
    inside,
  );
  return Object.freeze([
    top,
    content('session:', `${created} · ${title}`),
    content('', identity),
    content('workspace:', workspace),
    content('agent:', escapeTerminalText(state.agentId)),
    ...baseInstruction,
    content('context:', state.instructions.loaded ? state.instructions.source : 'none'),
    ...headerContentLines('skills:', skills, inside),
    content('runtime:', `trusted-local · ${state.trust.hardSandbox ? '' : 'no '}hard sandbox`),
    `╰${'─'.repeat(inside)}╯`,
  ]);
};

/**
 * The F1 overlay is a short task-oriented reference, not a runtime metadata report. Dynamic
 * values are limited to the already-sanitized startup projection and the committed position.
 */
export const startupHelpLines = (
  _state: PresentationStartupState,
  _columns = 80,
  _committedTurn = 0,
  _rows = 24,
): readonly string[] => {
  return Object.freeze([
    'Henji help · F1/Esc return',
    '/provider · select the root provider and its default model',
    '/model · search and select the root model',
    '/effort · select effort for the current root model',
    '/new · start a new saved session',
    '/sessions · resume a saved session',
    '/rename <title> · name the current saved session',
    '/history · inspect canonical and non-canonical execution history',
    '/history export · save committed history as Markdown',
    '/history export all · save exact durable Session history as JSONL',
    '/recover · restore recoverable input',
    '/recall [execution-id] · use a stopped execution for the next task',
    '/exit · exit Henji',
  ]);
};
