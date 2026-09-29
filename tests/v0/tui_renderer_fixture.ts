import { TuiRenderer, type TuiRendererOptions } from '../../v0/tui/tui_renderer.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';

/** Existing layout/event tests drive frames explicitly; scheduler behavior has its own tests. */
export class ImmediateTuiRenderer extends TuiRenderer {
  constructor(terminal: TerminalPort, options: TuiRendererOptions = {}) {
    super(terminal, { setTimeout: () => 0, clearTimeout: () => {}, ...options });
  }

  override redraw(): void {
    super.redraw();
    this.flushRender();
  }
}
