import type { InputEvent } from './input.ts';
import { TuiEditor, TuiEditorHistory } from './input.ts';
import type { PendingInputCore } from './pending_input.ts';
import type { WorkspacePathIndex } from './file_reference.ts';
import type { TuiRenderer } from './render.ts';

/** Owns editable text, input history, path completion, and recovery presentation. */
export class ControllerEditor {
  readonly editor = new TuiEditor();

  constructor(
    private readonly renderer: TuiRenderer,
    private readonly pending: PendingInputCore | undefined,
    private readonly history: TuiEditorHistory,
    private readonly pathIndex: WorkspacePathIndex | undefined,
    private readonly modern: boolean,
  ) {}

  render(): void {
    const snapshot = this.editor.snapshot();
    if (!this.modern) {
      this.renderer.setEditor(snapshot.text);
      return;
    }
    const renderer = this.renderer as TuiRenderer & {
      setEditorSnapshot?: (value: typeof snapshot) => void;
    };
    if (renderer.setEditorSnapshot !== undefined) {
      renderer.setEditorSnapshot(snapshot);
    } else renderer.setEditor(snapshot.text);
    const withMetadata = this.renderer as TuiRenderer & {
      setPendingMetadata?: (
        value: ReturnType<PendingInputCore['snapshot']> | undefined,
      ) => void;
    };
    withMetadata.setPendingMetadata?.(this.pending?.snapshot(snapshot));
  }

  apply(event: InputEvent): void {
    let changed = false;
    let textMutation = false;
    switch (event.kind) {
      case 'printable':
        changed = this.editor.insert(event.text);
        textMutation = true;
        break;
      case 'paste':
        changed = this.editor.paste(event.text);
        textMutation = true;
        break;
      case 'backspace':
        changed = this.editor.backspace();
        textMutation = true;
        break;
      case 'ctrl_o':
        this.renderer.setStatus(
          'newline is Alt+Return (Shift/Ctrl+Return where sent)',
        );
        break;
      case 'ctrl_w':
        changed = this.editor.deleteWordBackward();
        textMutation = true;
        break;
      case 'ctrl_a':
        changed = this.editor.home();
        break;
      case 'ctrl_e':
        changed = this.editor.end();
        break;
      case 'ctrl_b':
        changed = this.editor.moveLeft();
        break;
      case 'ctrl_f':
        changed = this.editor.moveRight();
        break;
      case 'ctrl_u':
        changed = this.editor.deleteToLineStart();
        textMutation = true;
        break;
      case 'ctrl_k':
        changed = this.editor.deleteToLineEnd();
        textMutation = true;
        break;
      case 'alt_b':
        changed = this.editor.moveWordLeft();
        break;
      case 'alt_f':
        changed = this.editor.moveWordRight();
        break;
      case 'alt_d':
        changed = this.editor.deleteWordForward();
        textMutation = true;
        break;
      case 'newline':
      case 'alt_enter':
        changed = this.editor.insert('\n');
        textMutation = true;
        break;
      case 'left':
        changed = this.editor.moveLeft();
        break;
      case 'right':
        changed = this.editor.moveRight();
        break;
      case 'up':
        changed = this.editor.moveUp();
        break;
      case 'down':
        changed = this.editor.moveDown();
        break;
      case 'home':
        changed = this.editor.home();
        break;
      case 'end':
        changed = this.editor.end();
        break;
      default:
        return;
    }
    if (changed) {
      if (textMutation) this.history.resetNavigation();
      this.render();
    } else if (
      event.kind === 'paste' || event.kind === 'printable' ||
      event.kind === 'newline' || event.kind === 'alt_enter'
    ) {
      this.renderer.setStatus(
        event.kind === 'paste' ? 'paste exceeds 64 KiB' : 'input too long',
      );
    }
  }

  walkHistory(direction: 'up' | 'down'): boolean {
    if (direction === 'down') {
      if (!this.history.navigating) return false;
      const snapshot = this.history.next();
      if (snapshot === null) this.renderer.setStatus('history boundary');
      else {
        this.editor.setSnapshot(snapshot);
        this.render();
      }
      return true;
    }
    if (
      !this.history.navigating && this.editor.text.length > 0 &&
      this.editor.moveUp()
    ) {
      this.render();
      return true;
    }
    const snapshot = this.history.previous(this.editor.snapshot());
    if (snapshot === null) {
      if (this.editor.text.length === 0) {
        this.renderer.setStatus('history empty');
      }
      return true;
    }
    this.editor.setSnapshot(snapshot);
    this.render();
    return true;
  }

  completePath(): void {
    if (this.pathIndex === undefined) {
      this.renderer.setStatus('path index unavailable');
      return;
    }
    const text = this.editor.text;
    let start = this.editor.cursorScalar;
    const points = [...text];
    while (start > 0 && !/[ \t\n]/u.test(points[start - 1])) start -= 1;
    const fragment = points.slice(start, this.editor.cursorScalar).join('');
    const result = this.pathIndex.completePath(fragment);
    if (result.kind === 'inserted') {
      points.splice(start, this.editor.cursorScalar - start, ...[
        ...result.text,
      ]);
      const candidate = points.join('');
      const cursor = start + [...result.text].length;
      if (
        !this.editor.setSnapshot({
          text: candidate,
          cursorScalar: cursor,
          byteLength: new TextEncoder().encode(candidate).byteLength,
        })
      ) this.renderer.setStatus('path replacement too long');
      else {
        this.history.resetNavigation();
        this.render();
      }
    } else if (result.kind === 'ambiguous') {
      this.renderer.setStatus(`path match ambiguous (${result.count})`);
    } else if (result.kind === 'incomplete') {
      this.renderer.setStatus('path index unavailable');
    } else this.renderer.setStatus('no path match');
  }

  recover(): void {
    if (this.editor.text.length > 0 || this.pending === undefined) {
      this.renderer.setStatus('recovery requires empty editor');
      return;
    }
    const item = this.pending.popRecovery();
    if (item === null) {
      this.renderer.setStatus('no recoverable input');
      return;
    }
    if (
      !this.editor.setSnapshot({
        text: item.text,
        cursorScalar: [...item.text].length,
        byteLength: new TextEncoder().encode(item.text).byteLength,
      })
    ) {
      this.renderer.setStatus('recovery unavailable');
      return;
    }
    this.history.resetNavigation();
    this.render();
    if (this.pending.hasSideEffectWarning) {
      this.renderer.setStatus(
        'tools may have changed the workspace; inspect before resubmitting',
      );
    } else this.renderer.setStatus('recovered input; edit or resubmit');
  }

  resetHistory(): void {
    this.history.resetNavigation();
  }

  record(text: string): void {
    this.history.record(text);
  }
}
