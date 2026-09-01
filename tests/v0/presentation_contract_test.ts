import { assert, assertEquals } from './test_helpers.ts';
import {
  boundedPresentationText,
  PresentationDeliveryError,
  presentationIntent,
  snapshotPresentation,
} from '../../v0/presentation/contract.ts';

Deno.test('presentation snapshots are immutable and preserve bounded data', () => {
  const value = snapshotPresentation({ nested: { items: ['safe'] } });
  assert(Object.isFrozen(value));
  assert(Object.isFrozen((value as { nested: object }).nested));
  assert(Object.isFrozen((value as { nested: { items: object } }).nested.items));
  assertEquals((value as { nested: { items: string[] } }).nested.items[0], 'safe');
});

Deno.test('presentation text rejects terminal-dangerous values and bounds UTF-8 safely', () => {
  assertEquals(boundedPresentationText('日本語😀'), '日本語😀');
  let rejected = false;
  try {
    boundedPresentationText('secret\0');
  } catch (error) {
    rejected = error instanceof PresentationDeliveryError;
  }
  assert(rejected);
  assert(
    new TextEncoder().encode(boundedPresentationText('x'.repeat(70_000))).byteLength <= 64 * 1024,
  );
});

Deno.test('typed presentation intents are cloned before admission', () => {
  const intent = presentationIntent({ kind: 'ordinary_submit', text: 'task' });
  assertEquals(intent, { kind: 'ordinary_submit', text: 'task' });
  assert(Object.isFrozen(intent));
});

Deno.test('presentation snapshots reject accessors and cycles before delivery', () => {
  const accessor = {} as { readonly value?: string };
  Object.defineProperty(accessor, 'value', { get: () => 'secret' });
  let accessorRejected = false;
  try {
    snapshotPresentation(accessor);
  } catch (error) {
    accessorRejected = error instanceof PresentationDeliveryError;
  }
  assert(accessorRejected);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  let cyclicRejected = false;
  try {
    snapshotPresentation(cyclic);
  } catch (error) {
    cyclicRejected = error instanceof PresentationDeliveryError;
  }
  assert(cyclicRejected);
});
