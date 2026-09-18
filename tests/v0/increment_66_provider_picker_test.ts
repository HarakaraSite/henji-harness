import { presentationIntent } from '../../v0/presentation/contract_intent.ts';
import { TuiPresentationAdapter } from '../../v0/presentation/tui_presentation_adapter.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

Deno.test('Increment 66 accepts any provider id in the presentation intent contract', () => {
  for (
    const provider of [
      'openrouter-chat',
      'openrouter-responses',
      'openai-responses',
      'declared-example',
    ]
  ) {
    assertEquals(
      presentationIntent({ kind: 'select_provider', provider }),
      { kind: 'select_provider', provider },
    );
  }
});

Deno.test('Increment 66 switches to openrouter-responses without a fatal delivery error', async () => {
  let selection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION;
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.reject(new Error('not used')),
      modelSelectionSnapshot: () => selection,
      selectModel: (next) => {
        selection = next;
        return Promise.resolve('selected');
      },
    },
    () => {},
  );
  const expected = defaultModelSelectionFor('openrouter-responses');
  assertEquals(
    await adapter.dispatch({ kind: 'select_provider', provider: 'openrouter-responses' }),
    {
      kind: 'model_selection',
      status: 'selected',
      selection: {
        provider: expected.provider,
        modelId: expected.modelId,
        effort: expected.effort,
      },
    },
  );
  assertEquals(selection, expected);
});

Deno.test('Increment 66 rejects an unknown provider instead of failing fatally', async () => {
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.reject(new Error('not used')),
      modelSelectionSnapshot: () => ROOT_DEFAULT_MODEL_SELECTION,
      selectModel: () => {
        throw new Error('must not select an unknown provider');
      },
    },
    () => {},
  );
  assertEquals(
    await adapter.dispatch({ kind: 'select_provider', provider: 'not-a-provider' }),
    { kind: 'rejected', reason: 'invalid' },
  );
});
