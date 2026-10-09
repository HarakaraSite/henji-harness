type SlashCommand =
  | 'help'
  | 'login'
  | 'new'
  | 'sessions'
  | 'view'
  | 'resume'
  | 'context'
  | 'rename'
  | 'provider'
  | 'model'
  | 'effort'
  | 'recall'
  | 'quit'
  | 'detach';

export interface SlashCommandDefinition {
  readonly text: string;
  readonly command: SlashCommand;
  readonly description: string;
  readonly usage: string;
  readonly shortcut?: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = Object.freeze([
  Object.freeze({
    text: '/help',
    command: 'help',
    description: 'Show help',
    usage: '/help',
  }),
  Object.freeze({
    text: '/login',
    command: 'login',
    description: 'Register credentials',
    usage: '/login',
  }),
  Object.freeze({
    text: '/new',
    command: 'new',
    description: 'Create session',
    usage: '/new',
  }),
  Object.freeze({
    text: '/sessions',
    command: 'sessions',
    description: 'List sessions',
    usage: '/sessions',
    shortcut: 'F4',
  }),
  Object.freeze({
    text: '/view',
    command: 'view',
    description: 'View session',
    usage: '/view [ID]',
    shortcut: 'Enter (Session picker)',
  }),
  Object.freeze({
    text: '/resume',
    command: 'resume',
    description: 'Resume session',
    usage: '/resume [ID|latest]',
    shortcut: 'R (Session picker)',
  }),
  Object.freeze({
    text: '/context',
    command: 'context',
    description: 'Inspect context',
    usage: '/context',
  }),
  Object.freeze({
    text: '/rename',
    command: 'rename',
    description: 'Rename session',
    usage: '/rename TEXT',
  }),
  Object.freeze({
    text: '/provider',
    command: 'provider',
    description: 'Select provider',
    usage: '/provider',
  }),
  Object.freeze({
    text: '/model',
    command: 'model',
    description: 'Select model',
    usage: '/model',
  }),
  Object.freeze({
    text: '/effort',
    command: 'effort',
    description: 'Select effort',
    usage: '/effort',
  }),
  Object.freeze({
    text: '/recall',
    command: 'recall',
    description: 'Prepare recall',
    usage: '/recall [ID|latest|clear]',
  }),
  Object.freeze({
    text: '/detach',
    command: 'detach',
    description: 'Detach TUI',
    usage: '/detach',
    shortcut: 'Ctrl-D',
  }),
  Object.freeze({
    text: '/quit',
    command: 'quit',
    description: 'Stop Core',
    usage: '/quit',
    shortcut: 'Ctrl-Q',
  }),
]);

/** Command-name editing opens the picker; argument input belongs to the editor. */
export const slashPickerCandidates = (
  text: string,
  cursorScalar = [...text].length,
): readonly SlashCommandDefinition[] | undefined => {
  const token = /^\/[^\s]*/u.exec(text)?.[0];
  if (token === undefined || cursorScalar > [...token].length) return undefined;
  return SLASH_COMMANDS.filter((definition) => definition.text.startsWith(token));
};

export const SHORTCUT_ONLY_OPERATIONS = Object.freeze(
  [
    ['Submit task', 'Enter (idle)'],
    ['Cancel execution', 'F1 (running)'],
    ['Queue next task', 'F2 (running)'],
    ['Steer execution', 'F3 (running)'],
    ['Clear input', 'Ctrl-C (normal input)'],
    ['Newline', 'Alt-Enter; Shift/Ctrl-Enter when distinguishable'],
    ['Open command picker', 'Leading /'],
    ['Complete command', 'Tab; Enter completes the selected command'],
    ['Browse, search and copy conversation', 'Terminal scrollback; tmux copy-mode'],
    ['Move cursor left/right', '←/→'],
    ['Move up/down', '↑/↓'],
    ['Line start/end', 'Home/End'],
    ['Delete previous character', 'Backspace'],
    ['Move picker selection', '↑/↓; ←/→ for Session picker'],
    ['Confirm picker selection', 'Enter'],
    ['Close picker or panel', 'Esc'],
    ['Toggle model favorite', 'Tab (model picker)'],
    ['Delete model search character', 'Backspace (model picker)'],
    ['Save credentials', 'Enter (masked input)'],
    ['Delete credential character', 'Backspace (masked input)'],
    ['Clear credential input', 'Ctrl-U (masked input)'],
  ] as const,
);

export const slashCommandHelpLines = (): readonly string[] => [
  'Operation │ Slash command │ Shortcut',
  ...SLASH_COMMANDS.map((definition) =>
    `${definition.description} │ ${definition.usage} │ ${definition.shortcut ?? 'none'}`
  ),
  ...SHORTCUT_ONLY_OPERATIONS.map(([description, key]) => `${description} │ none │ ${key}`),
];

export const slashCommandCandidates = (text: string): readonly string[] => {
  if (!text.startsWith('/') || text.length < 2) return Object.freeze([]);
  return Object.freeze(
    SLASH_COMMANDS.filter((definition) => definition.text.startsWith(text)).map(
      (definition) => definition.text,
    ),
  );
};

/** Exact-match built-in slash parse; args and unknown names are 'unknown', plain tasks are null. */
export const slashCommandOf = (
  text: string,
): SlashCommand | 'unknown' | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  if (/^\/rename(?:\s|$)/u.test(trimmed)) return 'rename';
  if (/^\/recall(?:\s|$)/u.test(trimmed)) return 'recall';
  if (/^\/login(?:\s|$)/u.test(trimmed)) return 'login';
  return SLASH_COMMANDS.find((definition) => definition.text === trimmed)
    ?.command ?? 'unknown';
};

/** Missing means latest; null means that an explicit execution ID/prefix is invalid. */
export const recallExecutionIdOf = (
  text: string,
): string | undefined | null => {
  const trimmed = text.trim();
  if (!/^\/recall(?:\s|$)/u.test(trimmed)) return null;
  const reference = trimmed.slice('/recall'.length).trim();
  if (reference.length === 0) return undefined;
  const normalized = reference.toLowerCase();
  if (normalized.length < 8 || normalized.length > 36) return null;
  const hyphens = new Set([8, 13, 18, 23]);
  for (let index = 0; index < normalized.length; index += 1) {
    const scalar = normalized[index];
    if (hyphens.has(index)) {
      if (scalar !== '-') return null;
    } else if (!/[0-9a-f]/u.test(scalar)) return null;
  }
  if (normalized.length > 14 && normalized[14] !== '4') return null;
  if (normalized.length > 19 && !/[89ab]/u.test(normalized[19])) return null;
  return normalized;
};

export const renameTitleOf = (text: string): string | null => {
  const trimmed = text.trim();
  if (!/^\/rename(?:\s|$)/u.test(trimmed)) return null;
  return trimmed.slice('/rename'.length).replaceAll('\r\n', ' ')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim();
};
