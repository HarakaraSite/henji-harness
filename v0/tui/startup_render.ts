import {
  PresentationDeliveryError,
  type PresentationHistoryPage,
  type PresentationStartupState,
} from '../presentation/contract.ts';
import { cellWidth } from './editor_render.ts';
import { encoder, escapeTerminalText, truncateText } from './terminal_text.ts';

/** Pure history modal projection shared by rendering and its byte admission checks. */
export const historyPageText = (page: PresentationHistoryPage): string => {
  const lines = [
    `history ${page.sessionId === undefined ? 'none' : escapeTerminalText(page.sessionId)} · ${
      page.agent === undefined ? 'default' : escapeTerminalText(page.agent)
    } · turn ${page.turn}/${page.totalTurns} · page ${page.page + 1}/${page.pageCount} · read-only`,
    'Up/Down page · Home oldest · End latest · Esc return',
  ];
  for (const entry of page.entries) {
    lines.push(
      `${entry.role} [t${entry.turn}] ${escapeTerminalText(entry.text)}`,
    );
  }
  if (page.omitted) lines.push('history> page content bounded');
  return truncateText(`${lines.map((line) => `${line}\n`).join('')}`, 32 * 1024)
    .text;
};

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

const orientationInstruction = (state: PresentationStartupState): string =>
  state.instructions.loaded ? `./${state.instructions.source}` : 'none';

const orientationSkills = (state: PresentationStartupState): string => {
  const names = state.skills.names.length === 0 ? 'none' : state.skills.names.join(', ');
  return `${state.skills.count}: ${names}${
    state.skills.omitted > 0 ? ` (+${state.skills.omitted} more)` : ''
  }`;
};

const orientationTrust = (state: PresentationStartupState): string =>
  state.agentId === 'default'
    ? 'NO HARD SANDBOX; bash/edit/write run with your OS-user access'
    : 'NO HARD SANDBOX; planner has no bash/edit/write';

/** Build the exact twelve logical startup lines without consulting runtime objects. */
export const startupOrientationLines = (
  state: PresentationStartupState,
  workspace = state.workspace,
): readonly string[] => [
  'Henji Harness',
  `workspace> ${escapeTerminalText(workspace)}`,
  `agent> ${escapeTerminalText(state.agentId)}`,
  `model> ${escapeTerminalText(state.model.provider)} / ${
    escapeTerminalText(state.model.modelId)
  } / effort ${escapeTerminalText(state.model.effort)}`,
  `session> ${orientationSession(state)}`,
  `instructions> ${orientationInstruction(state)}`,
  `skills> ${orientationSkills(state)}`,
  'credential> file presence checked at startup; value verified before each provider request',
  `trust> ${orientationTrust(state)}`,
  'keys> Enter submit · Alt+Return newline · arrows/Home/End move · Ctrl-W delete',
  'keys> Up/Down history · Tab path',
  'keys> idle Ctrl-C clear · Ctrl-D exit · busy Esc cancel · Ctrl-C twice discard/exit',
];

export const clippedWorkspace = (value: string, columns: number): string => {
  const escaped = escapeTerminalText(value);
  const prefixWidth = [...'workspace> '].reduce(
    (total, character) => total + cellWidth(character),
    0,
  );
  const available = Math.max(1, columns - prefixWidth);
  let used = 0;
  const suffix: string[] = [];
  for (const character of [...escaped].reverse()) {
    const width = cellWidth(character);
    if (used + width > Math.max(1, available - 1)) break;
    suffix.push(character);
    used += width;
  }
  const result = suffix.reverse().join('');
  return result === escaped ? result : `…${result}`;
};

/** Render one bounded orientation block; all dynamic values pass through terminal escaping. */
export const renderStartupOrientationText = (
  state: PresentationStartupState,
  columns = 80,
): string => {
  const validColumns = Number.isSafeInteger(columns) && columns > 0
    ? Math.min(160, Math.max(8, columns))
    : 80;
  const lines = startupOrientationLines(
    state,
    clippedWorkspace(state.workspace, validColumns),
  );
  const output = `${lines.join('\n')}\n`;
  if (encoder.encode(output).byteLength > 2_048) {
    throw new PresentationDeliveryError();
  }
  return output;
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
    '/sessions · resume a saved session',
    '/history export · save committed history as Markdown',
    '/recover · restore recoverable input',
    '/exit · exit Henji',
  ]);
};
