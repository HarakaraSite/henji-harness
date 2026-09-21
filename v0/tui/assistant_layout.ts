import { cellWidth } from './editor_render.ts';
import type {
  AssistantContentRenderer,
  AssistantLine,
  AssistantSpan,
} from './conversation_renderer.ts';

const cells = (text: string): number =>
  [...text].reduce((total, character) => total + cellWidth(character), 0);

const scalarLength = (text: string): number => [...text].length;

const spaces = (count: number): string => ' '.repeat(Math.max(0, count));

const padTo = (text: string, width: number): string => text + spaces(width - cells(text));

const shiftSpans = (spans: readonly AssistantSpan[], by: number): AssistantSpan[] =>
  spans.map((span) => ({ ...span, start: span.start + by }));

/** Split text at cell width without word awareness (used for code lines). */
const hardSplit = (text: string, width: number): string[] => {
  const limit = Math.max(1, width);
  const result: string[] = [];
  let line = '';
  let used = 0;
  for (const character of text) {
    const size = cellWidth(character);
    if (used + size > limit) {
      result.push(line);
      line = '';
      used = 0;
    }
    line += character;
    used += size;
  }
  result.push(line);
  return result;
};

/** Word-aware wrap: break at spaces, hard-split oversized tokens, CJK breaks by cell. */
const wrapCells = (text: string, width: number): string[] => {
  const limit = Math.max(1, width);
  if (cells(text) <= limit) return [text];
  const result: string[] = [];
  let line = '';
  let used = 0;
  const tokens: string[] = [];
  let token = '';
  for (const character of text) {
    if (character === ' ' || character === '\t') {
      if (token.length > 0) {
        tokens.push(token);
        token = '';
      }
      tokens.push(' ');
    } else {
      token += character;
    }
  }
  if (token.length > 0) tokens.push(token);
  for (const part of tokens) {
    if (part === ' ') {
      if (used === 0) continue;
      if (used + 1 > limit) {
        result.push(line);
        line = '';
        used = 0;
      } else {
        line += ' ';
        used += 1;
      }
      continue;
    }
    const size = cells(part);
    if (used + size <= limit) {
      line += part;
      used += size;
      continue;
    }
    if (used > 0) {
      result.push(line);
      line = '';
      used = 0;
    }
    for (const character of part) {
      const widthOf = cellWidth(character);
      if (used + widthOf > limit) {
        result.push(line);
        line = '';
        used = 0;
      }
      line += character;
      used += widthOf;
    }
  }
  if (line.length > 0 || result.length === 0) result.push(line);
  return result;
};

const wrapHanging = (body: string, firstWidth: number, indent: string): string[] =>
  wrapCells(body, Math.max(1, firstWidth)).map((part, index) =>
    index === 0 ? part : `${indent}${part}`
  );

const scalarOffset = (text: string, codeUnitIndex: number): number =>
  scalarLength(text.slice(0, codeUnitIndex));

/** Inline `*italic*`, `**bold**`, `***emphasis***`, and `` `code` `` spans. */
const inlineSpans = (text: string): AssistantSpan[] => {
  const spans: AssistantSpan[] = [];
  let match: RegExpExecArray | null;
  const emphasis3 = /\*\*\*([^*]+)\*\*\*/g;
  while ((match = emphasis3.exec(text)) !== null) {
    spans.push({
      start: scalarOffset(text, match.index) + 3,
      length: scalarLength(match[1]),
      tone: 'emphasis',
    });
  }
  const emphasis2 = /(?<!\*)\*\*(?!\*)([^*]+)\*\*/g;
  while ((match = emphasis2.exec(text)) !== null) {
    spans.push({
      start: scalarOffset(text, match.index) + 2,
      length: scalarLength(match[1]),
      tone: 'emphasis',
    });
  }
  const emphasis1 = /(?<!\*)\*(?!\*)([^*]+)\*/g;
  while ((match = emphasis1.exec(text)) !== null) {
    spans.push({
      start: scalarOffset(text, match.index) + 1,
      length: scalarLength(match[1]),
      tone: 'emphasis',
    });
  }
  const code = /`([^`]+)`/g;
  while ((match = code.exec(text)) !== null) {
    spans.push({
      start: scalarOffset(text, match.index) + 1,
      length: scalarLength(match[1]),
      tone: 'code',
    });
  }
  return spans;
};

const line = (text: string, spans: readonly AssistantSpan[] = []): AssistantLine =>
  Object.freeze({ text, spans: Object.freeze([...spans]) });

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const splitCells = (source: string): string[] =>
  source.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

const isSeparatorRow = (source: string): boolean => {
  const cellsRow = splitCells(source);
  return cellsRow.length > 0 && cellsRow.every((cell) => /^:?-+:?$/.test(cell));
};

type TableAlign = 'left' | 'center' | 'right';

const parseAligns = (source: string): TableAlign[] =>
  splitCells(source).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

const alignPadding = (text: string, width: number, align: TableAlign): number => {
  const pad = Math.max(0, width - cells(text));
  if (align === 'right') return pad;
  if (align === 'center') return Math.floor(pad / 2);
  return 0;
};

const alignCell = (text: string, width: number, align: TableAlign): string => {
  const pad = Math.max(0, width - cells(text));
  if (align === 'right') return `${spaces(pad)}${text}`;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return `${spaces(left)}${text}${spaces(pad - left)}`;
  }
  return padTo(text, width);
};

const records = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  width: number,
): AssistantLine[] => {
  const out: AssistantLine[] = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) out.push(line(''));
    headers.forEach((headerText, index) => {
      const label = `${headerText}: `;
      const labelLength = scalarLength(label);
      const wrapped = wrapHanging(
        row[index] ?? '',
        Math.max(1, width - labelLength),
        spaces(labelLength),
      );
      out.push(line(`${label}${wrapped[0]}`, [
        { start: 0, length: scalarLength(headerText), tone: 'list' },
      ]));
      for (const continuation of wrapped.slice(1)) out.push(line(continuation));
    });
  });
  return out;
};

const table = (
  header: readonly string[],
  aligns: readonly TableAlign[],
  rows: readonly (readonly string[])[],
  width: number,
): AssistantLine[] => {
  const columns = header.length;
  const columnsOf = (row: readonly string[]): string[] =>
    Array.from({ length: columns }, (_, index) => row[index] ?? '');
  const overhead = 3 * columns + 1;
  const minimum = 3;
  const natural = header.map((cell, index) =>
    Math.max(cells(cell), ...rows.map((row) => cells(row[index] ?? '')))
  );
  const available = width - overhead;
  if (available < columns * minimum) return records(header, rows, width);

  const widths = natural.map((value) => Math.max(minimum, value));
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    let widest = -1;
    let widestValue = minimum;
    for (let index = 0; index < columns; index++) {
      if (widths[index] > widestValue) {
        widest = index;
        widestValue = widths[index];
      }
    }
    if (widest < 0) break;
    widths[widest] -= 1;
  }
  if (widths.reduce((sum, value) => sum + value, 0) > available) {
    return records(header, rows, width);
  }

  const out: AssistantLine[] = [];
  const renderRow = (row: readonly string[], headerRow: boolean): void => {
    const wrapped = widths.map((value, index) => wrapCells(row[index] ?? '', value));
    const height = Math.max(...wrapped.map((value) => value.length));
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
      let text = '';
      const spans: AssistantSpan[] = [];
      for (let index = 0; index < columns; index++) {
        const cell = wrapped[index][rowIndex] ?? '';
        const align = aligns[index] ?? 'left';
        const padded = alignCell(cell, widths[index], align);
        text += '| ';
        spans.push({ start: scalarLength(text) - 1, length: 1, tone: 'table' });
        const contentStart = scalarLength(text) + alignPadding(cell, widths[index], align);
        if (headerRow && cell.length > 0) {
          spans.push({ start: contentStart, length: scalarLength(cell), tone: 'bold' });
        }
        text += `${padded} `;
      }
      text += '|';
      spans.push({ start: scalarLength(text) - 1, length: 1, tone: 'table' });
      out.push(line(text, spans));
    }
  };

  renderRow(header, true);
  const separator = `|${
    widths.map((value, index) => {
      const align = aligns[index] ?? 'left';
      const dashes = align === 'center'
        ? `:${'-'.repeat(Math.max(1, value - 2))}:`
        : align === 'right'
        ? `${'-'.repeat(Math.max(1, value - 1))}:`
        : '-'.repeat(value);
      return ` ${dashes} `;
    }).join('|')
  }|`;
  out.push(line(separator, [{ start: 0, length: scalarLength(separator), tone: 'table' }]));
  for (const row of rows) renderRow(columnsOf(row), false);
  return out;
};

const renderAssistant = (text: string, width: number): readonly AssistantLine[] => {
  const limit = Math.max(1, width);
  const source = text.split('\n');
  const out: AssistantLine[] = [];
  let index = 0;
  while (index < source.length) {
    const raw = source[index];

    const fence = FENCE.exec(raw);
    if (fence !== null) {
      const indent = fence[1];
      const marker = fence[2];
      const opener = `${indent}${marker}${fence[3].trimEnd()}`;
      out.push(
        line(opener, [{ start: scalarLength(indent), length: scalarLength(marker), tone: 'code' }]),
      );
      index += 1;
      const body: string[] = [];
      let closed = false;
      while (index < source.length) {
        const close = CLOSE_FENCE.exec(source[index]);
        if (close !== null && close[2][0] === marker[0] && close[2].length >= marker.length) {
          closed = true;
          break;
        }
        body.push(source[index]);
        index += 1;
      }
      for (const bodyLine of body) {
        for (const piece of hardSplit(bodyLine, limit)) {
          out.push(
            line(
              piece,
              piece.length === 0 ? [] : [{ start: 0, length: scalarLength(piece), tone: 'code' }],
            ),
          );
        }
      }
      if (closed) {
        out.push(line(`${indent}${marker}`, [
          { start: scalarLength(indent), length: scalarLength(marker), tone: 'code' },
        ]));
        index += 1;
      }
      continue;
    }

    if (raw.includes('|') && index + 1 < source.length && isSeparatorRow(source[index + 1])) {
      const headers = splitCells(raw);
      const aligns = parseAligns(source[index + 1]);
      const rows: string[][] = [];
      index += 2;
      while (
        index < source.length && source[index].includes('|') && source[index].trim().length > 0
      ) {
        rows.push(splitCells(source[index]));
        index += 1;
      }
      out.push(...table(headers, aligns, rows, limit));
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading !== null) {
      const prefix = `${heading[1]} `;
      const prefixCells = cells(prefix);
      const parts = wrapCells(heading[2].trimEnd(), Math.max(1, limit - prefixCells));
      parts.forEach((part, partIndex) => {
        const text = partIndex === 0 ? `${prefix}${part}` : `${spaces(prefixCells)}${part}`;
        out.push(line(text, [{ start: 0, length: scalarLength(text), tone: 'heading' }]));
      });
      index += 1;
      continue;
    }

    if (RULE.test(raw)) {
      const dash = '─'.repeat(Math.max(1, Math.min(limit, 40)));
      out.push(line(dash, [{ start: 0, length: scalarLength(dash), tone: 'table' }]));
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote !== null) {
      const indent = quote[1];
      const prefixCells = cells(`${indent}> `);
      const parts = wrapCells(quote[2].trimEnd(), Math.max(1, limit - prefixCells));
      parts.forEach((part, partIndex) => {
        if (partIndex === 0) {
          out.push(line(`${indent}> ${part}`, [
            { start: scalarLength(indent), length: 1, tone: 'quote' },
            ...shiftSpans(inlineSpans(part), scalarLength(`${indent}> `)),
          ]));
        } else {
          const cont = `${indent}${spaces(2)}`;
          out.push(line(`${cont}${part}`, shiftSpans(inlineSpans(part), scalarLength(cont))));
        }
      });
      index += 1;
      continue;
    }

    const list = LIST.exec(raw);
    if (list !== null) {
      const indent = list[1];
      const marker = list[2];
      const prefix = `${indent}${marker} `;
      const prefixCells = cells(prefix);
      const parts = wrapCells(list[3].trimEnd(), Math.max(1, limit - prefixCells));
      parts.forEach((part, partIndex) => {
        if (partIndex === 0) {
          out.push(line(`${prefix}${part}`, [
            { start: scalarLength(indent), length: scalarLength(marker), tone: 'list' },
            ...shiftSpans(inlineSpans(part), scalarLength(prefix)),
          ]));
        } else {
          const cont = spaces(prefixCells);
          out.push(line(`${cont}${part}`, shiftSpans(inlineSpans(part), scalarLength(cont))));
        }
      });
      index += 1;
      continue;
    }

    if (raw.trim().length === 0) {
      out.push(line(''));
      index += 1;
      continue;
    }

    for (const wrapped of wrapCells(raw, limit)) {
      out.push(line(wrapped, inlineSpans(wrapped)));
    }
    index += 1;
  }
  return Object.freeze(out);
};

/** Host-local markdown readability renderer for assistant bodies. */
export const markdownAssistantRenderer: AssistantContentRenderer = Object.freeze({
  render: (
    text: string,
    _phase: 'streaming' | 'settled',
    width: number,
  ): readonly AssistantLine[] => renderAssistant(text, width),
});
