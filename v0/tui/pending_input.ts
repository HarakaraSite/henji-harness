import { type EditorSnapshot } from './input.ts';

const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export type PendingKind = 'editor' | 'active_task' | 'steering' | 'follow_up';
export type PendingLifecycle =
  | 'draft'
  | 'active_uncommitted'
  | 'admitted_unconsumed'
  | 'queued_unsubmitted';

export interface PendingLaneMetadata {
  readonly kind: PendingKind;
  readonly lifecycle: PendingLifecycle;
  readonly present: boolean;
  readonly byteCount: number;
}

export interface PendingMetadataSnapshot {
  readonly lanes: readonly PendingLaneMetadata[];
}

export type SteeringReservationResult = 'reserved' | 'refused';

/**
 * Fixed-lane owner for text admitted by the TUI. There are deliberately no arrays of pending
 * input, replacement operations, or priority scheduling here: every lane can hold one value.
 * The editor remains the owner of the current draft and contributes metadata through snapshot().
 */
export class PendingInputCore {
  private activeTask: string | null = null;
  private steering: string | null = null;
  private steeringReservation: string | null = null;
  private steeringConsumed = false;
  private followUp: string | null = null;

  /** Admit the ordinary task before clearing the editor. */
  admitTask(text: string): boolean {
    if (!validText(text) || this.activeTask !== null) {
      return false;
    }
    this.activeTask = text;
    return true;
  }

  /** Mark an admitted task as committed; committed tasks are never recoverable. */
  commitTask(): boolean {
    if (this.activeTask === null) return false;
    this.activeTask = null;
    return true;
  }

  /** Clear the uncommitted active task after settlement without a recovery lane. */
  clearActiveTask(): void {
    this.activeTask = null;
  }

  /** Reserve steering text while the controller performs the synchronous session admission. */
  reserveSteering(text: string): SteeringReservationResult {
    if (
      !validText(text) || this.steering !== null || this.steeringReservation !== null
    ) return 'refused';
    this.steeringReservation = text;
    return 'reserved';
  }

  commitSteeringReservation(): boolean {
    if (this.steeringReservation === null || this.steering !== null) return false;
    this.steering = this.steeringReservation;
    this.steeringReservation = null;
    this.steeringConsumed = false;
    return true;
  }

  rollbackSteeringReservation(): boolean {
    if (this.steeringReservation === null) return false;
    this.steeringReservation = null;
    return true;
  }

  /** A consumed steering event is an irreversible boundary, even if its rendering fails later. */
  markSteeringConsumed(): boolean {
    if (this.steering === null || this.steeringConsumed) return false;
    this.steeringConsumed = true;
    this.steering = null;
    return true;
  }

  /** Clear admitted but unconsumed steering without a recovery lane. */
  clearSteering(): void {
    this.steering = null;
    this.steeringReservation = null;
    this.steeringConsumed = false;
  }

  /** Queue the single ordinary follow-up while the parent is busy. */
  queueFollowUp(text: string): boolean {
    if (!validText(text) || this.followUp !== null) return false;
    this.followUp = text;
    return true;
  }

  clearFollowUp(): boolean {
    if (this.followUp === null) return false;
    this.followUp = null;
    return true;
  }

  /** Detach follow-up text before starting the automatic turn. */
  takeFollowUpAsTask(): string | null {
    if (this.followUp === null || this.activeTask !== null) return null;
    const text = this.followUp;
    this.followUp = null;
    this.activeTask = text;
    return text;
  }

  clearAll(): void {
    this.activeTask = null;
    this.steering = null;
    this.steeringReservation = null;
    this.steeringConsumed = false;
    this.followUp = null;
  }

  get hasActiveTask(): boolean {
    return this.activeTask !== null;
  }
  get hasSteering(): boolean {
    return this.steering !== null || this.steeringReservation !== null;
  }
  get hasFollowUp(): boolean {
    return this.followUp !== null;
  }

  /** Return only immutable, secret-free lane metadata. */
  snapshot(editor: EditorSnapshot | string = ''): PendingMetadataSnapshot {
    const editorText = typeof editor === 'string' ? editor : editor.text;
    const editorBytes = encoder.encode(editorText).byteLength;
    const lanes: PendingLaneMetadata[] = [
      lane('editor', 'draft', editorText.length > 0, editorBytes),
      lane('active_task', 'active_uncommitted', this.activeTask !== null, bytes(this.activeTask)),
      lane('steering', 'admitted_unconsumed', this.steering !== null, bytes(this.steering)),
      lane('follow_up', 'queued_unsubmitted', this.followUp !== null, bytes(this.followUp)),
    ];
    return Object.freeze({
      lanes: Object.freeze(lanes),
    });
  }
}

const bytes = (text: string | null): number => text === null ? 0 : encoder.encode(text).byteLength;
const validText = (text: string): boolean => {
  if (
    typeof text !== 'string' || text.length === 0 || text.trim().length === 0 || text.includes('\0')
  ) return false;
  if (bytes(text) > MAX_BYTES) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const lane = (
  kind: PendingKind,
  lifecycle: PendingLifecycle,
  present: boolean,
  byteCount: number,
): PendingLaneMetadata =>
  Object.freeze({
    kind,
    lifecycle,
    present,
    byteCount: Math.max(0, Math.min(MAX_BYTES, byteCount)),
  });
