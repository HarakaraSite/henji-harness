import type { PresentationStartupState } from '../presentation/contract.ts';
import { cellWidth } from './editor_render.ts';
import { escapeTerminalText } from './terminal_text.ts';

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
    '/rename <title> · name the current saved session',
    '/history export · save committed history as Markdown',
    '/recover · restore recoverable input',
    '/exit · exit Henji',
  ]);
};
