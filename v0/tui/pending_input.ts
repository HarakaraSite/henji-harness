import { type EditorSnapshot } from './input.ts';

const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export type PendingKind = 'editor' | 'active_task' | 'steering' | 'follow_up';
export type PendingLifecycle =
  | 'draft'
  | 'active_uncommitted'
  | 'admitted_unconsumed'
  | 'queued_unsubmitted'
  | 'recoverable';

export interface PendingLaneMetadata {
  readonly kind: PendingKind;
  readonly lifecycle: PendingLifecycle;
  readonly present: boolean;
  readonly byteCount: number;
}

export interface PendingMetadataSnapshot {
  readonly lanes: readonly PendingLaneMetadata[];
  readonly recoveryCount: number;
}

export type RecoveryKind = Exclude<PendingKind, 'editor'>;

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
  private recoveryActiveTask: string | null = null;
  private recoverySteering: string | null = null;
  private recoveryFollowUp: string | null = null;
  private sideEffectWarning = false;

  /** Admit the ordinary task before clearing the editor. */
  admitTask(text: string): boolean {
    if (!validText(text) || this.activeTask !== null || this.recoveryActiveTask !== null) {
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

  /** Move an uncommitted active task to its one recovery slot. */
  recoverTask(toolCallCount = 0): boolean {
    if (this.activeTask === null || this.recoveryActiveTask !== null) return false;
    this.recoveryActiveTask = this.activeTask;
    this.activeTask = null;
    if (toolCallCount > 0) this.sideEffectWarning = true;
    return true;
  }

  /** Reserve steering text while the controller performs the synchronous session admission. */
  reserveSteering(text: string): SteeringReservationResult {
    if (
      !validText(text) || this.steering !== null || this.steeringReservation !== null ||
      this.recoverySteering !== null
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

  /** Move admitted but unconsumed steering to recovery after a recoverable settlement. */
  recoverSteering(): boolean {
    if (
      this.steeringReservation !== null || this.steering === null || this.steeringConsumed ||
      this.recoverySteering !== null
    ) return false;
    this.recoverySteering = this.steering;
    this.steering = null;
    return true;
  }

  /** Queue the single ordinary follow-up while the parent is busy. */
  queueFollowUp(text: string): boolean {
    if (!validText(text) || this.followUp !== null || this.recoveryFollowUp !== null) return false;
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

  /** Return all unconsumed lanes to fixed recovery slots after a recoverable outcome. */
  recoverAfterSettlement(toolCallCount = 0): boolean {
    if (this.activeTask !== null && !this.recoverTask(toolCallCount)) return false;
    if (this.steering !== null && !this.recoverSteering()) return false;
    if (this.followUp !== null) {
      if (this.recoveryFollowUp !== null) return false;
      this.recoveryFollowUp = this.followUp;
      this.followUp = null;
    }
    return true;
  }

  /** Recover one item at a time in deterministic active → steering → follow-up order. */
  popRecovery(): { readonly kind: RecoveryKind; readonly text: string } | null {
    if (this.recoveryActiveTask !== null) {
      const text = this.recoveryActiveTask;
      this.recoveryActiveTask = null;
      return { kind: 'active_task', text };
    }
    if (this.recoverySteering !== null) {
      const text = this.recoverySteering;
      this.recoverySteering = null;
      return { kind: 'steering', text };
    }
    if (this.recoveryFollowUp !== null) {
      const text = this.recoveryFollowUp;
      this.recoveryFollowUp = null;
      return { kind: 'follow_up', text };
    }
    return null;
  }

  clearAll(): void {
    this.activeTask = null;
    this.steering = null;
    this.steeringReservation = null;
    this.steeringConsumed = false;
    this.followUp = null;
    this.recoveryActiveTask = null;
    this.recoverySteering = null;
    this.recoveryFollowUp = null;
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
  get hasRecovery(): boolean {
    return this.recoveryActiveTask !== null || this.recoverySteering !== null ||
      this.recoveryFollowUp !== null;
  }
  get hasSideEffectWarning(): boolean {
    return this.sideEffectWarning;
  }
  clearSideEffectWarning(): void {
    this.sideEffectWarning = false;
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
    const recovery: PendingLaneMetadata[] = [
      lane(
        'active_task',
        'recoverable',
        this.recoveryActiveTask !== null,
        bytes(this.recoveryActiveTask),
      ),
      lane('steering', 'recoverable', this.recoverySteering !== null, bytes(this.recoverySteering)),
      lane(
        'follow_up',
        'recoverable',
        this.recoveryFollowUp !== null,
        bytes(this.recoveryFollowUp),
      ),
    ];
    return Object.freeze({
      lanes: Object.freeze([...lanes, ...recovery]),
      recoveryCount: recovery.filter((item) => item.present).length,
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
