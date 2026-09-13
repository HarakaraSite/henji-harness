export type SlashCommand =
  | 'help'
  | 'new'
  | 'sessions'
  | 'rename'
  | 'provider'
  | 'model'
  | 'effort'
  | 'history'
  | 'history_export'
  | 'history_export_all'
  | 'recover'
  | 'recall'
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
  Object.freeze({ text: '/history', command: 'history' }),
  Object.freeze({ text: '/history export', command: 'history_export' }),
  Object.freeze({ text: '/history export all', command: 'history_export_all' }),
  Object.freeze({ text: '/recover', command: 'recover' }),
  Object.freeze({ text: '/recall', command: 'recall' }),
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
  if (/^\/recall(?:\s|$)/u.test(trimmed)) return 'recall';
  return SLASH_COMMANDS.find((definition) => definition.text === trimmed)?.command ?? 'unknown';
};

/** Missing means latest; null means that an explicit execution ID/prefix is invalid. */
export const recallExecutionIdOf = (text: string): string | undefined | null => {
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
