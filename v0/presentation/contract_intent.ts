import type { PresentationIntent } from './contract_types.ts';
import { PresentationDeliveryError } from './contract_failure.ts';
import { boundedPresentationText, snapshotPresentation } from './contract_value.ts';

export const presentationIntent = (
  intent: PresentationIntent,
): PresentationIntent => {
  const copy = snapshotPresentation(intent);
  if (copy === null || typeof copy !== 'object' || !('kind' in copy)) {
    throw new PresentationDeliveryError();
  }
  const kind = copy.kind;
  if (
    kind === 'ordinary_submit' || kind === 'steering_submit' ||
    kind === 'follow_up_queue'
  ) {
    boundedPresentationText(copy.text);
  } else if (kind === 'exit') {
    if (copy.code !== 0 && copy.code !== 129 && copy.code !== 143) {
      throw new PresentationDeliveryError();
    }
  } else if (kind === 'resume_session') {
    boundedPresentationText(copy.id);
  } else if (kind === 'recall_execution') {
    if (copy.id !== undefined) boundedPresentationText(copy.id);
  } else if (kind === 'rename_session') {
    boundedPresentationText(copy.title);
  } else if (kind === 'select_provider') {
    if (copy.provider !== 'openrouter' && copy.provider !== 'openai') {
      throw new PresentationDeliveryError();
    }
  } else if (kind === 'select_model') {
    if (copy.provider !== 'openrouter' && copy.provider !== 'openai') {
      throw new PresentationDeliveryError();
    }
    boundedPresentationText(copy.modelId);
    boundedPresentationText(copy.effort);
  } else if (kind === 'history_page') {
    if (
      !Number.isSafeInteger(copy.page) || copy.page < 0 ||
      !Number.isSafeInteger(copy.turn)
    ) {
      throw new PresentationDeliveryError();
    }
  } else if (kind === 'human_history_page') {
    if (!['oldest', 'older', 'newer', 'latest'].includes(copy.direction)) {
      throw new PresentationDeliveryError();
    }
    if (copy.cursor !== undefined) boundedPresentationText(copy.cursor);
  } else if (kind === 'human_history_detail') {
    boundedPresentationText(copy.detailId);
    if (
      copy.scalarOffset !== undefined &&
      (!Number.isSafeInteger(copy.scalarOffset) || copy.scalarOffset < 0)
    ) throw new PresentationDeliveryError();
  } else if (kind === 'human_history_search') {
    boundedPresentationText(copy.query);
    if (copy.direction !== 'next' && copy.direction !== 'previous') {
      throw new PresentationDeliveryError();
    }
    if (copy.fromEntryId !== undefined) boundedPresentationText(copy.fromEntryId);
    if (
      copy.fromSourceScalarOffset !== undefined &&
      (!Number.isSafeInteger(copy.fromSourceScalarOffset) || copy.fromSourceScalarOffset < 0)
    ) throw new PresentationDeliveryError();
  } else if (
    kind !== 'cancel_active' && kind !== 'list_sessions' && kind !== 'new_session' &&
    kind !== 'history_export' && kind !== 'history_export_all' &&
    kind !== 'human_history_open' && kind !== 'clear_recall' &&
    kind !== 'dismiss_overlay' &&
    kind !== 'compaction'
  ) {
    throw new PresentationDeliveryError();
  }
  if (
    kind === 'compaction' &&
    !['preview', 'confirm', 'cancel'].includes(copy.action)
  ) {
    throw new PresentationDeliveryError();
  }
  return copy;
};
