export type SlashCommand =
  | 'help'
  | 'new'
  | 'sessions'
  | 'rename'
  | 'provider'
  | 'model'
  | 'effort'
  | 'history_export'
  | 'recover'
  | 'exit';

export interface SlashCommandDefinition {
  readonly text: string;
  readonly command: SlashCommand;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = Object.freeze([
  Object.freeze({ text: '/help', command: 'help' }),
  Object.freeze({ text: '/new', command: 'new' }),
  Object.freeze({ text: '/sessions', command: 'sessions' }),
  Object.freeze({ text: '/rename', command: 'rename' }),
  Object.freeze({ text: '/provider', command: 'provider' }),
  Object.freeze({ text: '/model', command: 'model' }),
  Object.freeze({ text: '/effort', command: 'effort' }),
  Object.freeze({ text: '/history export', command: 'history_export' }),
  Object.freeze({ text: '/recover', command: 'recover' }),
  Object.freeze({ text: '/exit', command: 'exit' }),
]);

export const slashCommandCandidates = (text: string): readonly string[] => {
  if (!text.startsWith('/')) return Object.freeze([]);
  return Object.freeze(
    SLASH_COMMANDS.filter((definition) => definition.text.startsWith(text)).map((definition) =>
      definition.text
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
  return SLASH_COMMANDS.find((definition) => definition.text === trimmed)?.command ?? 'unknown';
};

export const renameTitleOf = (text: string): string | null => {
  const trimmed = text.trim();
  if (!/^\/rename(?:\s|$)/u.test(trimmed)) return null;
  return trimmed.slice('/rename'.length).replaceAll('\r\n', ' ')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim();
};
