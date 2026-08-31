import { assert, assertEquals } from './test_helpers.ts';
import {
  displayWorkspaceLabel,
  MAX_RUNTIME_DISPLAY_STATE_BYTES,
  MAX_WORKSPACE_DISPLAY_BYTES,
  projectRuntimeDisplayState,
} from '../../v0/agent/startup_orientation.ts';
import {
  renderStartupOrientationText,
  startupOrientationLines,
  TuiRenderer,
} from '../../v0/tui/render.ts';
import { type RuntimeDisplayState } from '../../v0/agent/startup_orientation.ts';
import { type TerminalPort } from '../../v0/tui/terminal.ts';

const encoder = new TextEncoder();

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
  size = { columns: 80, rows: 24 };
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
    return Promise.resolve(null);
  }
  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }
  write(bytes: Uint8Array): void {
    this.writes.push(new TextDecoder().decode(bytes));
  }
  addSignal(): void {}
  removeSignal(): void {}
}

const display = (
  overrides: Partial<{
    workspaceRoot: string;
    agentId: 'default' | 'planner';
    profileId: string;
    sessionMode: 'new' | 'continue' | 'session' | 'none';
    instructionSource: 'AGENTS.md' | 'AGENTS.MD' | 'none';
    skillNames: readonly string[];
  }> = {},
): RuntimeDisplayState =>
  projectRuntimeDisplayState({
    workspaceRoot: '/home/masat.guest/src/henji-harness',
    agentId: 'default',
    profileId: 'offline-profile',
    sessionMode: 'new',
    instructionSource: 'none',
    skillNames: [],
    ...overrides,
  });

Deno.test('display state projects exact default and planner trust/mode summaries', () => {
  const defaultState = display({
    instructionSource: 'AGENTS.md',
    skillNames: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
  });
  assertEquals(defaultState.workspace, '…/src/henji-harness');
  assertEquals(defaultState.agentId, 'default');
  assertEquals(defaultState.model, { provider: 'openrouter', profileId: 'offline-profile' });
  assertEquals(defaultState.sessionMode, { kind: 'new' });
  assertEquals(defaultState.instructions, { loaded: true, source: 'AGENTS.md' });
  assertEquals(defaultState.skills, {
    count: 6,
    names: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
    omitted: 1,
  });
  assertEquals(defaultState.trust, {
    hardSandbox: false,
    osUserTools: ['bash', 'edit', 'write'],
  });
  assertEquals(defaultState.credentialVerification, 'before_each_provider_request');

  const planner = display({
    agentId: 'planner',
    sessionMode: 'session',
    instructionSource: 'AGENTS.MD',
  });
  assertEquals(planner.sessionMode, { kind: 'exact' });
  assertEquals(planner.instructions, { loaded: true, source: 'AGENTS.MD' });
  assertEquals(planner.trust, { hardSandbox: false, osUserTools: [] });
});

Deno.test('display state is defensively snapshotted and recursively frozen', () => {
  const names = ['one', 'two'];
  const state = display({ skillNames: names });
  names[0] = 'changed';
  names.push('three');
  assertEquals(state.skills.names, ['one', 'two']);
  assert(Object.isFrozen(state));
  assert(Object.isFrozen(state.model));
  assert(Object.isFrozen(state.sessionMode));
  assert(Object.isFrozen(state.instructions));
  assert(Object.isFrozen(state.skills));
  assert(Object.isFrozen(state.skills.names));
  assert(Object.isFrozen(state.trust));
  assert(Object.isFrozen(state.trust.osUserTools));
  assert(!JSON.stringify(state).includes('changed'));
});

Deno.test('workspace projection keeps root, trailing components, and a valid UTF-8 bound', () => {
  assertEquals(displayWorkspaceLabel('/'), '/');
  assertEquals(displayWorkspaceLabel('/workspace'), '/workspace');
  assertEquals(displayWorkspaceLabel('/a/b/c'), '…/b/c');
  const boundary = displayWorkspaceLabel(`/${'x'.repeat(100)}/tail`);
  assert(encoder.encode(boundary).byteLength <= MAX_WORKSPACE_DISPLAY_BYTES);
  assert(boundary.startsWith('…'));
  assert(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(boundary)) === boundary);
  assertEquals(displayWorkspaceLabel('/ok\ninvalid'), 'workspace');
  assertEquals(displayWorkspaceLabel('/ok\u202einvalid'), 'workspace');
  const multibyte = displayWorkspaceLabel(`/${'界'.repeat(80)}/tail`);
  assert(encoder.encode(multibyte).byteLength <= MAX_WORKSPACE_DISPLAY_BYTES);
  assert(multibyte.startsWith('…'));
  assertEquals(displayWorkspaceLabel('/bad\u0000path'), 'workspace');
});

Deno.test('projection retains only bounded summaries and stays within canonical state bytes', () => {
  const state = display({
    profileId: 'p'.repeat(10_000),
    skillNames: Array.from({ length: 24 }, (_, index) => `skill-${index}`),
  });
  assert(encoder.encode(JSON.stringify(state)).byteLength <= MAX_RUNTIME_DISPLAY_STATE_BYTES);
  assert(state.skills.names.length <= 5);
  assertEquals(state.skills.count, 24);
  assertEquals(state.skills.omitted, 19);
  assert(!JSON.stringify(state).includes('offline-dummy-credential'));
  assert(!JSON.stringify(state).includes('private skill body'));
});

Deno.test('skill summary keeps lexical first-five names and omitted count at every bound', () => {
  for (const count of [0, 2, 5, 6, 24]) {
    const state = display({
      skillNames: Array.from({ length: count }, (_, index) => `skill-${index}`),
    });
    assertEquals(state.skills.count, count);
    assertEquals(
      state.skills.names,
      Array.from({ length: Math.min(5, count) }, (_, index) => `skill-${index}`),
    );
    assertEquals(state.skills.omitted, Math.max(0, count - 5));
  }
});

Deno.test('orientation has the exact twelve lines and fixed current-action help', () => {
  const state = display({
    instructionSource: 'AGENTS.md',
    skillNames: ['alpha', 'beta'],
  });
  assertEquals(startupOrientationLines(state), [
    'Henji Harness',
    'workspace> …/src/henji-harness',
    'agent> default',
    'model> openrouter / offline-profile',
    'session> new (autosave)',
    'instructions> ./AGENTS.md',
    'skills> 2: alpha, beta',
    'credential> verified immediately before each provider request; not checked at startup',
    'trust> NO HARD SANDBOX; bash/edit/write run with your OS-user access',
    'keys> Enter submit · busy Enter steer · busy Alt+Enter follow-up',
    'keys> busy Esc cancel · busy Ctrl-C cancel+exit',
    'keys> idle Ctrl-C twice within 500 ms exit · empty Ctrl-D exit',
  ]);
  const text = renderStartupOrientationText(state, 80);
  assertEquals(text.split('\n').length - 1, 12);
  assert(
    text.includes(
      'credential> verified immediately before each provider request; not checked at startup',
    ),
  );
  assert(text.includes('busy Alt+Enter follow-up'));
  assert(text.includes('busy Ctrl-C cancel+exit'));
  assert(text.includes('idle Ctrl-C twice within 500 ms exit'));
  assert(!text.includes('session picker'));
  assert(!text.includes('multiline'));
  assert(!text.includes('credential value'));
});

Deno.test('orientation renders planner, narrow, invalid-size, and escaped dynamic values bounded', () => {
  const state = display({
    agentId: 'planner',
    workspaceRoot: '/home/secret\tproject',
    profileId: 'profile\u202e',
    sessionMode: 'none',
    skillNames: ['one\nname'],
  });
  const narrow = renderStartupOrientationText(state, 8);
  assertEquals(narrow.split('\n').length - 1, 12);
  assert(narrow.includes('session> no session'));
  assert(narrow.includes('trust> NO HARD SANDBOX; planner has no bash/edit/write'));
  assert(!narrow.includes('\t'));
  assert(!narrow.includes('\u202e'));
  assert(encoder.encode(narrow).byteLength <= 2_048);
  const invalidSize = renderStartupOrientationText(state, Number.NaN);
  assertEquals(invalidSize.split('\n').length - 1, 12);
});

Deno.test('renderer writes orientation before any prompt and uses one static block', () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.renderStartupOrientation(display());
  const output = terminal.writes.join('');
  assert(output.startsWith('Henji Harness\nworkspace>'));
  assertEquals(output.split('\n').length - 1, 12);
});
