import { assertEquals } from '@std/assert';
import {
  fromOpenRouterResponse,
  OPENROUTER_MODEL,
  toOpenRouterRequest,
} from '../../plugins/model-adapter/provider_codec.ts';

Deno.test('model adapter creates one non-streaming OpenRouter request', () => {
  assertEquals(toOpenRouterRequest({ messages: [{ role: 'user', content: 'Create a plan' }] }), {
    model: OPENROUTER_MODEL,
    messages: [{ role: 'user', content: 'Create a plan' }],
    stream: false,
  });
});

Deno.test('model adapter extracts one text choice and rejects malformed output', () => {
  assertEquals(fromOpenRouterResponse({ choices: [{ message: { content: 'text' } }] }), {
    text: 'text',
  });
  assertEquals(fromOpenRouterResponse({ choices: [] }), {
    code: 'invalid_model_response',
    message: 'OpenRouter response requires exactly one text choice',
  });
});
