import { collectMarkdownBodyForTest } from './body_document_fixture.ts';
import type {
  PresentationPosition,
  PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import { startupHeaderLines } from '../../v0/tui/startup_render.ts';
import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import {
  cellWidth,
  segmentTerminalText,
  truncateTerminalCells,
  truncateTerminalCellsFromEnd,
  truncateText,
} from '../../v0/tui/terminal_text.ts';
import { layoutUi } from '../../v0/tui/layout.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('Increment 154 measures observed emoji, combining text, and CJK by grapheme', () => {
  const text = 'x👨‍👩‍👧👋🏽🇯🇵e\u0301あ';
  const segments = segmentTerminalText(text);
  assert(segments.map((segment) => segment.text).join('|') === 'x|👨‍👩‍👧|👋🏽|🇯🇵|e\u0301|あ');
  assert(segments.map((segment) => segment.cellWidth).join(',') === '1,2,2,2,1,2');
  assert(
    segments.map((segment) => `${segment.scalarStart}-${segment.scalarEnd}`).join(',') ===
      '0-1,1-6,6-8,8-10,10-12,12-13',
  );
  assert(cellWidth('👨‍👩‍👧X') === 3);
  assert(cellWidth('👋🏽') === 2);
  assert(cellWidth('🇯🇵') === 2);
  assert(cellWidth('e\u0301') === 1);
  assert(cellWidth('あ') === 2);
});

Deno.test('Increment 154 cell and byte truncation keeps grapheme clusters whole', () => {
  const family = '👨‍👩‍👧';
  assert(truncateTerminalCells(`A${family}B`, 2) === 'A');
  assert(truncateTerminalCells(`A${family}B`, 3) === `A${family}`);
  assert(truncateTerminalCellsFromEnd(`A${family}B`, 3) === `${family}B`);
  assert(truncateText(`${family}X`, new TextEncoder().encode(family).byteLength).text === family);
  assert(truncateText('e\u0301x', 2).text === '');
});

Deno.test('Increment 154 assistant wrap and table columns preserve emoji clusters', () => {
  const family = '👨‍👩‍👧';
  const wrapped = collectMarkdownBodyForTest(`${family}X`, 2).map((line) => line.text);
  assert(wrapped.length === 2);
  assert(wrapped[0] === family && wrapped[1] === 'X');

  const table = [
    '| Item | Value |',
    '| --- | --- |',
    `| family | ${family} |`,
    '| other | x |',
  ].join('\n');
  const lines = collectMarkdownBodyForTest(table, 30).map((line) => line.text);
  const pipeColumns = lines.map((line) => {
    const positions: number[] = [];
    let cell = 0;
    for (const segment of segmentTerminalText(line)) {
      if (segment.text === '|') positions.push(cell);
      cell += segment.cellWidth;
    }
    return positions.join(',');
  });
  assert(pipeColumns.every((positions) => positions === pipeColumns[0]), pipeColumns.join('\n'));
  assert(lines.some((line) => line.includes(family)));
  assert(lines.every((line) => cellWidth(line) <= 30));
});

Deno.test('Increment 154 editor cursor maps a cluster interior to its start cell', () => {
  const family = '👨‍👩‍👧';
  const text = `${family}X`;
  const make = (cursorScalar: number) =>
    layoutUi(
      reduceUiEvent(
        createUiState({
          text,
          cursorScalar,
          byteLength: new TextEncoder().encode(text).byteLength,
        }),
        { kind: 'lifecycle', lifecycle: 'idle', generation: 0 },
      ),
      80,
      24,
    );
  assert(make(2).cursor.cell === 2, 'cluster-internal cursor should map to the cluster start');
  assert(make(5).cursor.cell === 4, 'cluster-end cursor should map after two cells');
  assert(make(6).cursor.cell === 5, 'cursor after X should advance by one cell');
});

Deno.test('Increment 154 compact startup header keeps the workspace suffix cluster whole', () => {
  const family = '👨‍👩‍👧';
  const state: PresentationStartupState = {
    productVersion: '0.1.3',
    workspace: `/tmp/${'w'.repeat(40)}${family}`,
    agentId: 'default',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'deepseek/deepseek-v4.1-flash',
      effort: 'high',
    },
    sessionMode: { kind: 'none' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  const position: PresentationPosition = {
    createdAt: '2026-09-29T00:00:00.000Z',
    agent: 'default',
    committedTurn: 0,
    messageCount: 0,
  };
  const lines = startupHeaderLines(state, position, 40, 12);
  assert(lines[1].includes(family), 'workspace suffix lost its final family emoji');
  assert(lines.every((line) => cellWidth(line) <= 40));
});
