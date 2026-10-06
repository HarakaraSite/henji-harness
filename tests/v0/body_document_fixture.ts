import { type BodyCursor, BodyDocument, type BodyRow } from '../../v0/tui/body_document.ts';

/** Collect every row for focused Markdown readability tests only. */
export const collectMarkdownBodyForTest = (
  text: string,
  width: number,
): readonly BodyRow[] => {
  const document = new BodyDocument(text, 'markdown');
  const rows: BodyRow[] = [];
  let cursor: BodyCursor | undefined = document.first(width);
  while (cursor !== undefined) {
    rows.push(document.render(cursor, width));
    cursor = document.next(cursor, width);
  }
  return Object.freeze(rows);
};
