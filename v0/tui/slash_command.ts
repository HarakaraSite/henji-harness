export type SlashCommand =
  | 'help'
  | 'sessions'
  | 'model'
  | 'effort'
  | 'history_export'
  | 'recover'
  | 'exit';

/** Exact-match built-in slash parse; args and unknown names are 'unknown', plain tasks are null. */
export const slashCommandOf = (
  text: string,
): SlashCommand | 'unknown' | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed === '/history export') return 'history_export';
  if (
    trimmed === '/help' || trimmed === '/sessions' || trimmed === '/model' ||
    trimmed === '/effort' || trimmed === '/recover' || trimmed === '/exit'
  ) {
    return trimmed.slice(1) as SlashCommand;
  }
  return 'unknown';
};
