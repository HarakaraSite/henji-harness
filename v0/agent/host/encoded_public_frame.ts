import type { CoreCursor, SessionChange, SessionControlSnapshot } from '../../api/contract.ts';

const encoder = new TextEncoder();

/** Compose the small Core envelope around Data's encoded value without decoding that value. */
export const encodedEnvelope = (
  prefix: string,
  payload: Uint8Array<ArrayBuffer>,
  suffix: string,
): Uint8Array<ArrayBuffer> => {
  const head = encoder.encode(prefix);
  const tail = encoder.encode(suffix);
  const bytes = new Uint8Array(head.length + payload.length + tail.length);
  bytes.set(head);
  bytes.set(payload, head.length);
  bytes.set(tail, head.length + payload.length);
  return bytes;
};

export const encodedSessionSnapshot = (
  control: SessionControlSnapshot,
  conversation: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> =>
  encodedEnvelope(JSON.stringify(control).slice(0, -1) + ',"conversation":', conversation, '}');

export const encodedSessionSnapshotFrame = (
  control: SessionControlSnapshot,
  conversation: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> =>
  encodedEnvelope(
    '{"kind":"session.snapshot","snapshot":' + JSON.stringify(control).slice(0, -1) +
      ',"conversation":',
    conversation,
    '}}',
  );

export const encodedSessionUpdate = (
  cursor: CoreCursor,
  previousRevision: number,
  changes: readonly SessionChange[],
  delta?: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> => {
  const small = JSON.stringify({ kind: 'session.update', cursor, previousRevision, changes });
  return delta === undefined
    ? encoder.encode(small)
    : encodedEnvelope(small.slice(0, -1) + ',"conversationDelta":', delta, '}');
};
