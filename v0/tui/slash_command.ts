export type SlashCommand =
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
    description: 'ヘルプ',
    usage: '/help',
  }),
  Object.freeze({
    text: '/login',
    command: 'login',
    description: '認証情報登録',
    usage: '/login',
  }),
  Object.freeze({
    text: '/new',
    command: 'new',
    description: '新規Session',
    usage: '/new',
  }),
  Object.freeze({
    text: '/sessions',
    command: 'sessions',
    description: 'Session一覧',
    usage: '/sessions',
    shortcut: 'F1',
  }),
  Object.freeze({
    text: '/view',
    command: 'view',
    description: 'Session閲覧',
    usage: '/view ID',
    shortcut: 'Enter（Session picker）',
  }),
  Object.freeze({
    text: '/resume',
    command: 'resume',
    description: 'Session再開',
    usage: '/resume [ID|latest]',
    shortcut: 'R（Session picker）',
  }),
  Object.freeze({
    text: '/context',
    command: 'context',
    description: 'context確認',
    usage: '/context',
  }),
  Object.freeze({
    text: '/rename',
    command: 'rename',
    description: 'Session改名',
    usage: '/rename TEXT',
  }),
  Object.freeze({
    text: '/provider',
    command: 'provider',
    description: 'provider選択',
    usage: '/provider',
  }),
  Object.freeze({
    text: '/model',
    command: 'model',
    description: 'model選択',
    usage: '/model',
  }),
  Object.freeze({
    text: '/effort',
    command: 'effort',
    description: 'effort選択',
    usage: '/effort',
  }),
  Object.freeze({
    text: '/recall',
    command: 'recall',
    description: '過去実行の参照準備',
    usage: '/recall [ID|latest|clear]',
  }),
  Object.freeze({
    text: '/detach',
    command: 'detach',
    description: 'TUI切り離し',
    usage: '/detach',
    shortcut: 'Ctrl-D',
  }),
  Object.freeze({
    text: '/quit',
    command: 'quit',
    description: 'Core終了',
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
    ['新規タスク送信', 'Enter（入力待ち）'],
    ['実行中への追加指示', 'F3（実行中）'],
    ['次タスクの予約', 'F2（実行中）'],
    ['実行キャンセル', 'Esc（最新表示・実行中）'],
    ['入力欄クリア', 'Ctrl-C（通常入力）'],
    ['改行', 'Alt-Enter。区別可能なShift／Ctrl-Enterも受信'],
    ['コマンドピッカー', '入力先頭の /'],
    ['コマンド補完', 'Tab。picker内Enterは選択候補を補完'],
    ['会話スクロール', 'PageUp／PageDown'],
    ['最新表示へ戻る', 'Esc（履歴閲覧中）'],
    ['入力履歴の前後移動', '↑／↓（入力待ち、行移動を優先）'],
    ['一文字左／右', '←／→'],
    ['一行上／下', '↑／↓'],
    ['行頭／行末', 'Home／End'],
    ['直前の文字削除', 'Backspace'],
    ['picker内の選択移動', '↑／↓。Session pickerでは←／→も使う'],
    ['picker内の選択確定', 'Enter'],
    ['picker・補助画面を閉じる', 'Esc'],
    ['modelのお気に入り切替', 'Tab（model picker）'],
    ['model検索語の末尾削除', 'Backspace（model picker）'],
    ['認証入力の保存', 'Enter（masked入力）'],
    ['認証入力の末尾削除', 'Backspace（masked入力）'],
    ['認証入力の全消去', 'Ctrl-U（masked入力）'],
  ] as const,
);

export const slashCommandHelpLines = (): readonly string[] => [
  '操作 │ スラッシュコマンド │ ショートカット',
  ...SLASH_COMMANDS.map((definition) =>
    `${definition.description} │ ${definition.usage} │ ${definition.shortcut ?? '対応なし'}`
  ),
  ...SHORTCUT_ONLY_OPERATIONS.map(([description, key]) => `${description} │ 対応なし │ ${key}`),
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

/** `/login` takes no arguments; a mistaken argument is answered without echoing it back. */
export const loginHasArguments = (text: string): boolean => /^\/login\s/u.test(text.trim());

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
