type PendingKind = 'editor' | 'active_task' | 'steering' | 'follow_up';
type PendingLifecycle =
  | 'draft'
  | 'active_uncommitted'
  | 'admitted_unconsumed'
  | 'queued_unsubmitted';

interface PendingLaneMetadata {
  readonly kind: PendingKind;
  readonly lifecycle: PendingLifecycle;
  readonly present: boolean;
  readonly byteCount: number;
}

export interface PendingMetadataSnapshot {
  readonly lanes: readonly PendingLaneMetadata[];
}
