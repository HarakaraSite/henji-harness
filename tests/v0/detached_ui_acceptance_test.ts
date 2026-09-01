import { assertEquals } from './test_helpers.ts';
import { runRetainedAcceptance } from './fixtures/detached_ui_acceptance_fixture.ts';

Deno.test('provider-free retained acceptance exercises the shipped controller/renderer/adapter', async () => {
  const result = await runRetainedAcceptance();
  assertEquals(result, {
    ok: true,
    retained: true,
    threeBands: true,
    cursorRestored: true,
    startupCompact: true,
    helpOverlay: true,
    historyOverlay: true,
    contextOverlay: true,
    resizeReflow: true,
    overlayRestored: true,
    toolIdentityCount: 1,
    assistantFinalCount: 1,
    rawProviderIdLeaked: false,
    persistentStateUsed: false,
    providerUsed: false,
  });
});
