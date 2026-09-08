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
  } else if (kind === 'select_model') {
    boundedPresentationText(copy.modelId);
    boundedPresentationText(copy.effort);
  } else if (kind === 'history_page') {
    if (
      !Number.isSafeInteger(copy.page) || copy.page < 0 ||
      !Number.isSafeInteger(copy.turn)
    ) {
      throw new PresentationDeliveryError();
    }
  } else if (
    kind !== 'cancel_active' && kind !== 'list_sessions' &&
    kind !== 'history_export' &&
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
