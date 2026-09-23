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
    boundedPresentationText(copy.provider);
  } else if (kind === 'select_model') {
    boundedPresentationText(copy.provider);
    boundedPresentationText(copy.modelId);
    boundedPresentationText(copy.effort);
  } else if (
    kind !== 'cancel_active' && kind !== 'list_sessions' && kind !== 'new_session' &&
    kind !== 'clear_recall' &&
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
