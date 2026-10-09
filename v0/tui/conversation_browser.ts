import type { ConversationSnapshot } from '../api/contract.ts';
import type {
  ConversationContentChunk,
  ConversationContentLocator,
  ConversationEntity,
} from '../conversation/model.ts';

export interface ConversationBrowseState {
  readonly page: ConversationSnapshot;
  readonly selected: number;
  readonly openedCut: number;
  readonly detail?: ConversationContentChunk;
}

export const browseEntries = (page: ConversationSnapshot): readonly ConversationEntity[] =>
  page.order.flatMap((id) => {
    const entity = page.entities[id];
    return entity === undefined || entity.kind === 'request' ? [] : [entity];
  });

const body = (entity: ConversationEntity): string => {
  switch (entity.kind) {
    case 'execution':
      return `${entity.execution.outcome} · ${entity.execution.task}`;
    case 'message':
      return `${entity.role}> ${entity.text}`;
    case 'thinking':
      return `thinking> ${entity.text}`;
    case 'tool':
      return `${entity.name}> ${entity.result?.text ?? JSON.stringify(entity.arguments)}`;
    case 'steering':
      return `steer> ${entity.text}`;
    case 'request':
      return '';
  }
};

export const browseDetailLocator = (
  state: ConversationBrowseState,
): ConversationContentLocator | undefined => {
  const entity = browseEntries(state.page)[state.selected];
  if (entity === undefined) return undefined;
  const details =
    (entity as ConversationEntity & { details?: readonly ConversationContentLocator[] }).details;
  return details?.find((value) => value.field === 'tool_result') ?? details?.[0];
};

export const browseLines = (
  state: ConversationBrowseState,
  latestCut: number,
  visibleEntries = 20,
): readonly string[] => {
  const unseen = Math.max(0, latestCut - state.openedCut);
  if (state.detail !== undefined) {
    const chunk = state.detail;
    return [
      `本文 · ${chunk.locator.field} · bytes ${chunk.offset}–${chunk.nextOffset}/${chunk.totalBytes}`,
      'PageUp/PageDown 本文chunkの前後 · ↑↓ chunk内スクロール · Esc 会話ページへ',
      '',
      ...chunk.text.split('\n'),
    ];
  }
  return [
    `会話 · ${state.page.sessionId} · execution ${state.page.page.lowerExecutionOrder ?? '–'}–${
      state.page.page.upperExecutionOrder ?? '–'
    }${unseen > 0 ? ` · 新しい更新 ${unseen}` : ''}`,
    'PageUp/PageDown 前後ページ · ↑↓ 項目選択 · Enter 本文 · Esc 最新表示へ',
    '',
    ...browseEntries(state.page).slice(
      Math.max(0, state.selected - Math.floor(visibleEntries / 2)),
      Math.max(0, state.selected - Math.floor(visibleEntries / 2)) + visibleEntries,
    ).map((entity, localIndex) =>
      `${
        localIndex + Math.max(0, state.selected - Math.floor(visibleEntries / 2)) === state.selected
          ? '▶'
          : ' '
      } ${body(entity).replaceAll('\n', ' ').slice(0, 180)}`
    ),
  ];
};

export const browseSelectedBody = (state: ConversationBrowseState): readonly string[] => {
  const entity = browseEntries(state.page)[state.selected];
  return entity === undefined ? [] : body(entity).split('\n');
};
