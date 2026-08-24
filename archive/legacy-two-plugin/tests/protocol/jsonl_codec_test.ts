import { assertEquals } from '@std/assert';
import { decodeJsonlLine, encodeJsonl } from '../../src/protocol/jsonl_codec.ts';
import type { RequestEnvelope } from '../../src/protocol/envelope.ts';

const request: RequestEnvelope = {
  v: 1,
  kind: 'request',
  id: 'r1',
  method: 'plugin.execute',
  payload: { task: 'plan' },
};

Deno.test('JSONL encodes and decodes an envelope', () => {
  assertEquals(
    encodeJsonl(request),
    '{"v":1,"kind":"request","id":"r1","method":"plugin.execute","payload":{"task":"plan"}}\n',
  );
  assertEquals(
    decodeJsonlLine(
      '{"v":1,"kind":"request","id":"r1","method":"plugin.execute","payload":{"task":"plan"}}',
    ),
    request,
  );
});

Deno.test('JSONL rejects invalid JSON, newlines, and oversized messages', () => {
  assertEquals(decodeJsonlLine('not-json'), {
    code: 'invalid_jsonl',
    message: 'JSONL message is not valid JSON',
  });
  assertEquals(decodeJsonlLine('{"v":1}\n'), {
    code: 'invalid_jsonl',
    message: 'JSONL decoder accepts exactly one line without a newline',
  });
  assertEquals(decodeJsonlLine(JSON.stringify(request), 8), {
    code: 'message_limit_exceeded',
    message: 'JSONL message exceeds the configured byte limit',
  });
});
