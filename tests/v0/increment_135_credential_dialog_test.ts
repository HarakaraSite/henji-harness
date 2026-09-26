/**
 * Increment 135 focused checks for the `/login` credential dialog and its controller routing.
 *
 * Every credential value is a dummy string owned by this test process. The assertions check the
 * boundary the product requires: the renderer, normal editor, and history never receive the dialog
 * value, and a busy `/login` never becomes a task, steering, or follow-up.
 */

import { ControllerOverlay } from '../../v0/tui/controller_overlay.ts';
import { TuiController, type TuiSessionLike } from '../../v0/tui/controller.ts';
import { TuiRenderer, TuiRenderer as RealTuiRenderer } from '../../v0/tui/render.ts';
import { TerminalLifecycle, type TerminalPort } from '../../v0/tui/terminal.ts';
import { PendingInputCore } from '../../v0/tui/pending_input.ts';
import { TuiEditorHistory } from '../../v0/tui/input.ts';
import {
  type CredentialRegistration,
  CredentialRegistrationError,
} from '../../v0/agent/provider/credential_registration.ts';
import type { CredentialAvailability } from '../../v0/agent/provider/model_selection.ts';
import type { ModelSelection } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { PresentationOutcome } from '../../v0/presentation/contract.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

const openAISelection: ModelSelection = {
  provider: 'openai-responses',
  api: 'openai-responses',
  authProfile: 'openai-api-key',
  modelId: 'gpt-5.6',
  effort: 'medium',
};

const outcome = (task: string): PresentationOutcome => ({
  ok: true,
  task,
  outcome: 'final',
  stopReason: 'final',
  finalText: 'done',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

interface SaveCall {
  readonly authProfile: string;
  readonly value: string;
}

class RecordingTerminal implements TerminalPort {
  readonly writes: string[] = [];
  size = { columns: 80, rows: 24 };
  private readonly queued: Uint8Array[] = [];
  private readonly readers: Array<(value: Uint8Array | null) => void> = [];

  stdinIsTerminal(): boolean {
    return true;
  }
  stdoutIsTerminal(): boolean {
    return true;
  }
  consoleSize(): { columns: number; rows: number } {
    return this.size;
  }
  setRaw(): void {}
  read(): Promise<Uint8Array | null> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.readers.push(resolve));
  }
  drainAndCloseInput(): Promise<void> {
    for (const reader of this.readers.splice(0)) reader(null);
    this.queued.splice(0);
    return Promise.resolve();
  }
  write(bytes: Uint8Array): void {
    this.writes.push(new TextDecoder().decode(bytes));
  }
  addSignal(): void {}
  removeSignal(): void {}

  push(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const reader = this.readers.shift();
    if (reader === undefined) this.queued.push(bytes);
    else reader(bytes);
  }
}

class OverlayRecorder {
  readonly rendered: string[] = [];
  readonly statuses: string[] = [];
  clears = 0;
  rows = 24;

  readonly renderer = {
    renderChoicePicker: (lines: readonly string[]) => {
      this.rendered.push([...lines].join('\n'));
    },
    setStatus: (status: string) => {
      this.statuses.push(status);
    },
    clearModal: () => {
      this.clears += 1;
    },
    stateSnapshot: () => ({ terminalSize: { columns: 80, rows: this.rows } }),
  } as unknown as TuiRenderer;

  get lastRender(): string {
    return this.rendered[this.rendered.length - 1] ?? '';
  }

  get lastStatus(): string {
    return this.statuses[this.statuses.length - 1] ?? '';
  }

  allOutput(): string {
    return `${this.rendered.join('\n')}\n${this.statuses.join('\n')}`;
  }
}

const registrationStub = (
  onSave: (authProfile: string, value: string) => void | Promise<void>,
): CredentialRegistration => ({
  targets: () => [
    {
      authProfile: 'openrouter-api-key',
      providers: ['openrouter-chat', 'openrouter-responses'],
    },
    {
      authProfile: 'openai-api-key',
      providers: ['openai-chat', 'openai-responses'],
    },
    {
      authProfile: 'increment135-external-key',
      providers: ['increment135-external'],
    },
  ],
  save: (authProfile, value) => Promise.resolve(onSave(authProfile, value)),
});

/** Open the dialog on one target row; row 1 (`openai-api-key`) is the current selection. */
const openCredentialInput = (
  overlay: ControllerOverlay,
  targetIndex: number,
): void => {
  overlay.openCredentialRegistration();
  const initial = 1;
  for (let step = 0; step < Math.abs(targetIndex - initial); step += 1) {
    overlay.process({ kind: targetIndex > initial ? 'down' : 'up' });
  }
  overlay.process({ kind: 'enter' });
};

Deno.test('Increment 135 lists registration targets once per profile and keeps selection visible', () => {
  const recorder = new OverlayRecorder();
  const overlay = new ControllerOverlay({
    renderer: recorder.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => openAISelection,
    credentialRegistration: registrationStub(() => {}),
    fail: () => Promise.resolve(),
  });
  overlay.openCredentialRegistration();
  assert(
    recorder.lastRender.includes(
      'openrouter-api-key · openrouter-chat, openrouter-responses',
    ),
  );
  assert(recorder.lastRender.includes('openai-api-key · openai-chat, openai-responses'));
  assert(
    recorder.lastRender.includes('increment135-external-key · increment135-external'),
  );
  assertEquals(
    recorder.lastRender.split('\n').filter((line) => line.includes('openai-api-key ·')).length,
    1,
  );
  assert(recorder.lastRender.split('\n')[2].startsWith('> openai-api-key'));

  const small = new OverlayRecorder();
  small.rows = 12;
  const manyTargets: CredentialRegistration = {
    targets: () =>
      Array.from({ length: 20 }, (_, index) => ({
        authProfile: `increment135-row-${index}`,
        providers: [`increment135-p-${index}`],
      })),
    save: () => Promise.resolve(),
  };
  const windowed = new ControllerOverlay({
    renderer: small.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => openAISelection,
    credentialRegistration: manyTargets,
    fail: () => Promise.resolve(),
  });
  windowed.openCredentialRegistration();
  for (let step = 0; step < 19; step += 1) windowed.process({ kind: 'down' });
  assert(small.lastRender.includes('> increment135-row-19'));
  assert(small.lastRender.includes('of 20'));
  for (let step = 0; step < 19; step += 1) windowed.process({ kind: 'up' });
  assert(small.lastRender.includes('> increment135-row-0'));
});

Deno.test('Increment 135 masks dialog input and mutates only the private dialog state', () => {
  const recorder = new OverlayRecorder();
  const saves: SaveCall[] = [];
  const overlay = new ControllerOverlay({
    renderer: recorder.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => openAISelection,
    credentialRegistration: registrationStub((authProfile, value) => {
      saves.push({ authProfile, value });
    }),
    fail: () => Promise.resolve(),
  });
  openCredentialInput(overlay, 1);
  assert(recorder.lastRender.includes('credential input · openai-api-key'));
  overlay.process({ kind: 'printable', text: 'dummy-', codePoint: 100 });
  overlay.process({ kind: 'paste', text: 'secret-value' });
  assert(recorder.lastRender.includes(`key> ${'*'.repeat(18)}`));
  assert(!recorder.allOutput().includes('dummy-'));
  assert(!recorder.allOutput().includes('secret-value'));
  overlay.process({ kind: 'backspace' });
  assert(recorder.lastRender.includes(`key> ${'*'.repeat(17)}`));
  overlay.process({ kind: 'ctrl_u' });
  assert(recorder.lastRender.includes('key> '));
  assert(!recorder.lastRender.includes('key> *'));
  assertEquals(saves, []);
});

Deno.test('Increment 135 discards dialog input on Esc, Ctrl-C, and Ctrl-D without saving', () => {
  for (
    const close of [{ kind: 'escape' }, { kind: 'ctrl_c' }, { kind: 'ctrl_d' }] as const
  ) {
    const recorder = new OverlayRecorder();
    const saves: SaveCall[] = [];
    const overlay = new ControllerOverlay({
      renderer: recorder.renderer,
      dispatch: () => ({ kind: 'accepted' }),
      setSession: () => {},
      idleAllowed: () => true,
      isIdle: () => true,
      readyStatus: () => 'ready',
      modelSelection: () => openAISelection,
      credentialRegistration: registrationStub((authProfile, value) => {
        saves.push({ authProfile, value });
      }),
      fail: () => Promise.resolve(),
    });
    openCredentialInput(overlay, 0);
    overlay.process({ kind: 'printable', text: 'dummy-discard', codePoint: 100 });
    overlay.process(close);
    assertEquals(overlay.isOpen, false);
    assertEquals(recorder.clears, 1);
    assertEquals(recorder.lastStatus, 'ready');
    assertEquals(saves, []);
    assert(!recorder.allOutput().includes('dummy-discard'));
  }
});

Deno.test('Increment 135 saves once from the dialog and keeps same-read input out of the editor', async () => {
  const recorder = new OverlayRecorder();
  const saves: SaveCall[] = [];
  let releaseSave: (() => void) | undefined;
  const overlay = new ControllerOverlay({
    renderer: recorder.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready · credential missing: openai-responses',
    modelSelection: () => openAISelection,
    credentialRegistration: registrationStub((authProfile, value) => {
      saves.push({ authProfile, value });
      return new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    }),
    refreshCredentialAvailability: () => {},
    fail: () => Promise.resolve(),
  });
  openCredentialInput(overlay, 1);
  overlay.process({ kind: 'printable', text: 'dummy-save', codePoint: 100 });
  overlay.process({ kind: 'enter' });
  overlay.process({ kind: 'printable', text: 'leaked', codePoint: 108 });
  overlay.process({ kind: 'enter' });
  await waitFor(() => saves.length === 1);
  assertEquals(saves.length, 1);
  assertEquals(saves[0], { authProfile: 'openai-api-key', value: 'dummy-save' });
  assert(recorder.lastRender.includes('saving credential · openai-api-key'));
  assert(!recorder.allOutput().includes('dummy-save'));
  assert(!recorder.allOutput().includes('leaked'));
  assert(releaseSave !== undefined);
  releaseSave();
  await waitFor(() => recorder.lastStatus.includes('credential saved: openai-api-key'));
  // The saved message must follow the ready-status segments: the production footer renders
  // from the `ready` segment onward and would drop a message placed before it.
  assertEquals(
    recorder.lastStatus,
    'ready · credential missing: openai-responses · credential saved: openai-api-key',
  );
  assertEquals(saves.length, 1);
  assertEquals(recorder.clears, 1);
  assertEquals(overlay.isOpen, false);
});

Deno.test('Increment 135 distinguishes an incomplete display refresh from a failed save', async () => {
  const recorder = new OverlayRecorder();
  const overlay = new ControllerOverlay({
    renderer: recorder.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => openAISelection,
    credentialRegistration: registrationStub(() => {}),
    refreshCredentialAvailability: () => {
      throw new Error('refresh failed');
    },
    fail: () => Promise.resolve(),
  });
  openCredentialInput(overlay, 1);
  overlay.process({ kind: 'printable', text: 'dummy-refresh', codePoint: 100 });
  overlay.process({ kind: 'enter' });
  await waitFor(() => recorder.lastStatus.includes('credential saved: openai-api-key'));
  assertEquals(
    recorder.lastStatus,
    'credential saved: openai-api-key · display refresh incomplete',
  );
  assert(!recorder.allOutput().includes('dummy-refresh'));
});

Deno.test('Increment 135 reports a value-free reason and keeps the dialog open for retry', async () => {
  const recorder = new OverlayRecorder();
  const attempts: string[] = [];
  let failing = true;
  const overlay = new ControllerOverlay({
    renderer: recorder.renderer,
    dispatch: () => ({ kind: 'accepted' }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => openAISelection,
    credentialRegistration: registrationStub((_authProfile, value) => {
      attempts.push(value);
      if (failing) {
        throw new CredentialRegistrationError(
          'credential_registration_write_failed',
        );
      }
    }),
    refreshCredentialAvailability: () => {},
    fail: () => Promise.resolve(),
  });
  openCredentialInput(overlay, 1);
  overlay.process({ kind: 'printable', text: 'dummy-retry', codePoint: 100 });
  overlay.process({ kind: 'enter' });
  await waitFor(() =>
    attempts.length === 1 && recorder.lastRender.includes('credential write failed')
  );
  assert(!recorder.allOutput().includes('dummy-retry'));
  assert(recorder.lastRender.includes(`key> ${'*'.repeat(11)}`));
  failing = false;
  overlay.process({ kind: 'enter' });
  await waitFor(() => recorder.lastStatus.includes('credential saved: openai-api-key'));
  assertEquals(attempts, ['dummy-retry', 'dummy-retry']);
});

Deno.test('Increment 135 answers busy /login and /login arguments without queuing them', async () => {
  const terminal = new RecordingTerminal();
  const renderer = new RealTuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const steered: string[] = [];
  const saves: SaveCall[] = [];
  let releaseTurn: (() => void) | undefined;
  const session: TuiSessionLike = {
    submit: (task) => {
      submitted.push(task);
      return new Promise<PresentationOutcome>((resolve) => {
        releaseTurn = () => resolve(outcome(task));
      });
    },
    steerActiveTurn: (text) => {
      steered.push(text);
      return 'accepted';
    },
    cancelActiveTurn: () => 'requested',
    modelSelectionSnapshot: () => openAISelection,
    credentialAvailabilitySnapshot: (): CredentialAvailability => ({
      authProfile: 'openai-api-key',
      status: 'missing',
    }),
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    history: new TuiEditorHistory(),
    credentialRegistration: registrationStub((authProfile, value) => {
      saves.push({ authProfile, value });
    }),
  });
  const run = controller.run();
  await waitFor(() => renderer.stateSnapshot().status.includes('credential missing'));

  terminal.push('some task\r');
  await waitFor(() => submitted.length === 1);

  terminal.push('/login\x1b\r');
  await waitFor(() =>
    renderer.stateSnapshot().status.includes('/login registers credentials when idle')
  );
  assertEquals(submitted, ['some task']);
  assertEquals(steered, []);
  assertEquals(saves, []);

  terminal.push('/login\r');
  await waitFor(() =>
    renderer.stateSnapshot().status.includes('/login registers credentials when idle')
  );
  assertEquals(submitted, ['some task']);
  assertEquals(steered, []);
  assertEquals(saves, []);

  assert(releaseTurn !== undefined);
  releaseTurn();
  await waitFor(() => renderer.stateSnapshot().status.includes('credential missing'));

  terminal.push('\x15');
  await waitFor(() => controller.editor.text === '');
  terminal.push('/login accidental-argument\r');
  await waitFor(() => renderer.stateSnapshot().status.includes('usage: /login'));
  assert(!renderer.stateSnapshot().status.includes('accidental-argument'));
  assertEquals(saves, []);
  assertEquals(submitted, ['some task']);

  terminal.push('\x04');
  await run;
});

Deno.test('Increment 135 completes the dialog flow through the production controller without leaking the value', async () => {
  const terminal = new RecordingTerminal();
  const renderer = new RealTuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const saves: SaveCall[] = [];
  let releaseSave: (() => void) | undefined;
  let availability: CredentialAvailability = {
    authProfile: 'openai-api-key',
    status: 'missing',
  };
  const session: TuiSessionLike = {
    submit: (task) => Promise.resolve(outcome(task)),
    modelSelectionSnapshot: () => openAISelection,
    credentialAvailabilitySnapshot: () => availability,
    refreshCredentialAvailability: () => {
      availability = { authProfile: 'openai-api-key', status: 'present' };
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    history: new TuiEditorHistory(),
    credentialRegistration: registrationStub((authProfile, value) => {
      saves.push({ authProfile, value });
      return new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    }),
  });
  const run = controller.run();
  await waitFor(() => renderer.stateSnapshot().status.includes('credential missing'));

  terminal.push('/login\r');
  await waitFor(() =>
    JSON.stringify(renderer.stateSnapshot().overlay).includes('credential registration')
  );
  terminal.push('\r');
  await waitFor(() =>
    JSON.stringify(renderer.stateSnapshot().overlay).includes('credential input')
  );
  terminal.push('dummy-secret-value\rleaked');
  await waitFor(() => saves.length === 1);
  assertEquals(saves[0], {
    authProfile: 'openai-api-key',
    value: 'dummy-secret-value',
  });
  assertEquals(controller.editor.text, '');
  assert(!terminal.writes.join('').includes('dummy-secret-value'));
  assert(!terminal.writes.join('').includes('leaked'));
  assert(releaseSave !== undefined);
  releaseSave();
  await waitFor(() => renderer.stateSnapshot().status.includes('credential saved: openai-api-key'));
  assert(!renderer.stateSnapshot().status.includes('credential missing'));
  assert(!terminal.writes.join('').includes('dummy-secret-value'));

  terminal.push('\x04');
  await run;
});

Deno.test('Increment 135 keeps the current missing notice when another profile is registered', async () => {
  const terminal = new RecordingTerminal();
  const renderer = new RealTuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const saves: SaveCall[] = [];
  const session: TuiSessionLike = {
    submit: (task) => Promise.resolve(outcome(task)),
    modelSelectionSnapshot: () => openAISelection,
    credentialAvailabilitySnapshot: (): CredentialAvailability => ({
      authProfile: 'openai-api-key',
      status: 'missing',
    }),
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    history: new TuiEditorHistory(),
    credentialRegistration: registrationStub((authProfile, value) => {
      saves.push({ authProfile, value });
    }),
  });
  const run = controller.run();
  await waitFor(() => renderer.stateSnapshot().status.includes('credential missing'));

  terminal.push('/login\r');
  await waitFor(() =>
    JSON.stringify(renderer.stateSnapshot().overlay).includes('credential registration')
  );
  terminal.push('\x1b[A');
  await waitFor(() =>
    JSON.stringify(renderer.stateSnapshot().overlay).includes('openrouter-api-key')
  );
  terminal.push('\r');
  await waitFor(() =>
    JSON.stringify(renderer.stateSnapshot().overlay).includes('credential input')
  );
  terminal.push('dummy-other-profile\r');
  await waitFor(() => saves.length === 1);
  assertEquals(saves[0], {
    authProfile: 'openrouter-api-key',
    value: 'dummy-other-profile',
  });
  await waitFor(() =>
    renderer.stateSnapshot().status.includes('credential saved: openrouter-api-key')
  );
  assert(renderer.stateSnapshot().status.includes('credential missing: openai-responses'));
  assert(!terminal.writes.join('').includes('dummy-other-profile'));

  terminal.push('\x04');
  await run;
});
