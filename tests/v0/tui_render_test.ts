import { assert, assertEquals } from './test_helpers.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';
import { escapeTerminalText, TuiRenderer } from '../../v0/tui/render.ts';
import { type TerminalPort } from '../../v0/tui/terminal.ts';

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
  size = { columns: 20, rows: 4 };
  stdinIsTerminal() {
    return true;
  }
  stdoutIsTerminal() {
    return true;
  }
  consoleSize() {
    return this.size;
  }
  setRaw() {}
  read() {
    return Promise.resolve(null);
  }
  drainAndCloseInput() {
    return Promise.resolve();
  }
  write(bytes: Uint8Array) {
    this.writes.push(new TextDecoder().decode(bytes));
  }
  addSignal() {}
  removeSignal() {}
  text() {
    return this.writes.join('');
  }
}

Deno.test('central terminal escaping neutralizes control and bidi markers', () => {
  assertEquals(
    escapeTerminalText('ok\x1b[31m\x07\x7f\u0085\r\n\t\u202e'),
    'ok\\u{001B}[31m\\u{0007}\\u{007F}\\u{0085}\\u{000D}\n⇥\\u{202E}',
  );
  assertEquals(escapeTerminalText('line\nnext', { editor: true }), 'line↵next');
});

Deno.test('renderer maps completed events once without alternate screen', () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const events: AgentEvent[] = [
    { kind: 'turn_start', turn: 1 },
    {
      kind: 'user_message',
      turn: 1,
      message: { role: 'user', content: { kind: 'text', text: 'task' } },
    },
    {
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text: 'answer' } },
    },
    { kind: 'tool_call', turn: 1, call: { callId: '1', name: 'read', arguments: {} } },
    {
      kind: 'tool_result',
      turn: 1,
      result: {
        kind: 'tool_result',
        callId: '1',
        name: 'read',
        text: 'result',
        outcome: 'success',
      },
    },
    { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
  ];
  for (const event of events) renderer.eventSink(event);
  const text = terminal.text();
  assert(text.includes('user> task\n'));
  assert(text.includes('assistant> answer\n'));
  assert(text.includes('tool> read\n'));
  assert(text.includes('tool< read success> result\n'));
  assert(!text.includes('\x1b[?1049h'));
  assert(!text.includes('\x1b[?1049l'));
});

Deno.test('tool-terminal final event does not duplicate the assistant final', () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: {
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: '1', name: 'submit_json_result', arguments: {} }],
    },
  });
  renderer.eventSink({
    kind: 'tool_call',
    turn: 1,
    call: { callId: '1', name: 'submit_json_result', arguments: {} },
  });
  renderer.eventSink({
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: '1',
      name: 'submit_json_result',
      text: '{"ok":true}',
      outcome: 'success',
      terminal: 'json_result',
    },
  });
  renderer.eventSink({ kind: 'turn_end', turn: 1, outcome: 'tool_terminal', committed: true });
  renderer.renderAssistantFinal('{"ok":true}');
  const text = terminal.text();
  assertEquals((text.match(/tool> submit_json_result/g) ?? []).length, 1);
  assertEquals((text.match(/tool< submit_json_result success>/g) ?? []).length, 1);
  assertEquals((text.match(/assistant> \{"ok":true\}/g) ?? []).length, 1);
});

Deno.test('renderer truncates display fields without changing source values', () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: 'x'.repeat(65_537) } },
  });
  assert(terminal.text().includes('… [display truncated]'));
  assert(!terminal.text().includes('x'.repeat(65_537)));
});

Deno.test('renderer falls back to last valid console size and blocks late writes', () => {
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.setEditor('editor');
  terminal.size = { columns: 0, rows: -1 };
  renderer.setEditor('still safe');
  renderer.close();
  const before = terminal.text();
  renderer.clearLiveLine();
  try {
    renderer.eventSink({
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text: 'late' } },
    });
  } catch {
    // Closing gate rejects late event delivery before any terminal write.
  }
  assert(terminal.text().length >= before.length);
  assert(!terminal.text().includes('late'));
});

Deno.test('progress replaces one live line, escapes dynamic text, and never enters scrollback', () => {
  const terminal = new FakeTerminal();
  terminal.size = { columns: 120, rows: 4 };
  const renderer = new TuiRenderer(terminal);
  renderer.eventSink({ kind: 'turn_start', turn: 1 });
  renderer.eventSink({
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'progress', name: 'read\x1b', arguments: {} },
  });
  const before = terminal.writes.length;
  renderer.eventSink({
    kind: 'tool_progress',
    turn: 1,
    callId: 'progress',
    name: 'read\x1b',
    text: 'a\nb\t\u202e',
  });
  renderer.eventSink({
    kind: 'tool_progress',
    turn: 1,
    callId: 'progress',
    name: 'read\x1b',
    text: 'accumulated',
  });
  const liveWrites = terminal.writes.slice(before);
  assertEquals(liveWrites.length, 2);
  assert(liveWrites.every((write) => !write.includes('\n')));
  assert(liveWrites[0].includes('tool~'));
  assert(liveWrites[0].includes('\\u{001B}'));
  assert(liveWrites[0].includes('↵'));
  assert(liveWrites[0].includes('⇥'));
  assert(liveWrites[0].includes('\\u{202E}'));
  assert(liveWrites[1].includes('accumulated'));
  renderer.eventSink({
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'progress',
      name: 'read\x1b',
      text: 'done',
      outcome: 'success',
    },
  });
  const afterResult = terminal.writes.slice(-2);
  assert(afterResult.every((write) => !write.includes('tool~')));
  assert(afterResult.some((write) => write.includes('tool< read')));
  renderer.eventSink({ kind: 'turn_end', turn: 1, outcome: 'final', committed: true });
  renderer.close();
  const closedLength = terminal.writes.length;
  renderer.clearLiveProgress();
  assertEquals(terminal.writes.length, closedLength);
});

Deno.test('progress display bounds wide 8,192-byte snapshots without mutating source text', () => {
  const terminal = new FakeTerminal();
  terminal.size = { columns: 40, rows: 4 };
  const renderer = new TuiRenderer(terminal);
  const source = `${'中'.repeat(2_730)}aa`;
  renderer.eventSink({
    kind: 'tool_progress',
    turn: 1,
    callId: 'wide',
    name: 'bash',
    text: source,
  });
  const write = terminal.writes.at(-1)!;
  assert(write.includes('[ready]'));
  assert(!write.includes(source));
  assert(!write.includes('\n'));
  assertEquals(new TextEncoder().encode(source).byteLength, 8_192);
});
