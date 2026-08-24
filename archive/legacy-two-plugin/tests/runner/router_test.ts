import { assertEquals } from '@std/assert';
import { Router } from '../../src/runner/router.ts';

const request = {
  v: 1 as const,
  kind: 'request' as const,
  id: 'r1',
  method: 'plugin.execute',
  payload: {},
};
const response = {
  v: 1 as const,
  kind: 'response' as const,
  id: 's1',
  replyTo: 'r1',
  ok: true,
  payload: {},
};

Deno.test('router correlates one final response to a request', () => {
  const router = new Router();
  assertEquals(router.register(request), undefined);
  assertEquals(router.accept(response), request);
  assertEquals(router.accept(response), {
    code: 'protocol_violation',
    message: 'request received more than one final response',
  });
});

Deno.test('router rejects unknown and duplicate request ids', () => {
  const router = new Router();
  assertEquals(router.accept(response), {
    code: 'protocol_violation',
    message: 'response does not correlate to a pending request',
  });
  router.register(request);
  assertEquals(router.register(request), {
    code: 'protocol_violation',
    message: 'request id has already been registered',
  });
});
