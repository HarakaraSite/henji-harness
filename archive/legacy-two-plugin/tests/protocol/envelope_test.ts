import { assertEquals } from '@std/assert';
import { parseEnvelope } from '../../src/protocol/envelope.ts';

Deno.test('parseEnvelope accepts each supported envelope kind', () => {
  assertEquals(
    parseEnvelope({ v: 1, kind: 'request', id: 'r1', method: 'plugin.execute', payload: {} }),
    {
      v: 1,
      kind: 'request',
      id: 'r1',
      method: 'plugin.execute',
      payload: {},
    },
  );
  assertEquals(
    parseEnvelope({
      v: 1,
      kind: 'response',
      id: 's1',
      replyTo: 'r1',
      ok: false,
      error: { code: 'failed', message: 'nope' },
    }),
    {
      v: 1,
      kind: 'response',
      id: 's1',
      replyTo: 'r1',
      ok: false,
      error: { code: 'failed', message: 'nope' },
    },
  );
  assertEquals(parseEnvelope({ v: 1, kind: 'event', id: 'e1', name: 'progress', payload: 1 }), {
    v: 1,
    kind: 'event',
    id: 'e1',
    name: 'progress',
    payload: 1,
  });
  assertEquals(parseEnvelope({ v: 1, kind: 'cancel', id: 'c1', replyTo: 'r1' }), {
    v: 1,
    kind: 'cancel',
    id: 'c1',
    replyTo: 'r1',
  });
});

Deno.test('parseEnvelope rejects protocol shape violations', () => {
  assertEquals(parseEnvelope({ v: 2, kind: 'request', id: 'r1', method: 'x', payload: {} }), {
    code: 'invalid_envelope',
    message: 'envelope requires v: 1 and a non-empty id',
  });
  assertEquals(parseEnvelope({ v: 1, kind: 'response', id: 's1', replyTo: 'r1', ok: true }), {
    code: 'invalid_envelope',
    message: 'successful response requires payload; failed response requires error',
  });
});
