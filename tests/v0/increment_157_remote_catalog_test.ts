import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { RemoteCatalogUi } from '../../v0/tui/remote_catalog_ui.ts';
import type { RemoteCatalogUiOptions } from '../../v0/tui/remote_catalog_ui.ts';
import type { ApiSelection, ModelCatalogResult } from '../../v0/api/contract.ts';

Deno.test('E6 picker searches names and preserves target/query across favorite reordering', async () => {
  let selection: ApiSelection = {
    provider: 'local',
    modelId: 'seed',
    effort: 'low',
  };
  let lines: readonly string[] = [];
  let reads = 0;
  let finishFirstRead: ((value: ModelCatalogResult) => void) | undefined;
  const choices: ApiSelection[] = [];
  const retainedNotices: Array<{ sessionId: string; text: string }> = [];
  const models = [
    {
      modelId: 'seed',
      name: 'Existing model',
      favorite: true,
      defaultEffort: 'low',
      efforts: ['auto', 'low'],
    },
    {
      modelId: 'newer',
      name: 'Searchable Newer',
      favorite: false,
      defaultEffort: 'auto',
      efforts: ['auto', 'high'],
    },
    {
      modelId: 'older',
      name: 'Searchable Older',
      favorite: false,
      defaultEffort: 'auto',
      efforts: ['auto'],
    },
  ];
  const result = (): ModelCatalogResult => ({
    kind: 'models',
    provider: 'local',
    metadataStatus: 'loaded',
    models: [...models].sort((a, b) => Number(b.favorite) - Number(a.favorite)),
  });
  const client: RemoteCatalogUiOptions['client'] = {
    catalogRead: () => {
      reads++;
      if (reads === 1) {
        return new Promise<ModelCatalogResult>((resolve) => finishFirstRead = resolve);
      }
      return Promise.resolve(result());
    },
    modelFavorite: ({ modelId, favorite }) => {
      models.find((model) => model.modelId === modelId)!.favorite = favorite;
      return Promise.resolve(result());
    },
    selectionChange: (_, input) => {
      choices.push(input.selection);
      return Promise.resolve({
        kind: 'accepted',
        commandId: input.commandId,
        target: { kind: 'session', sessionId: 'session' },
        value: { result: 'selected', selection: input.selection },
      });
    },
    commandRead: () => {
      throw new Error('unexpected command read');
    },
    credentialPresenceRead: () => {
      throw new Error('unexpected credential read');
    },
    credentialRegister: () => {
      throw new Error('unexpected credential register');
    },
  };
  const picker = new RemoteCatalogUi({
    client,
    renderer: {
      renderChoicePicker: (value) => {
        lines = value;
      },
      clearModal: () => {
        lines = [];
      },
    },
    sessionId: () => 'session',
    selection: () => selection,
    selectionChanged: (value) => {
      selection = value;
    },
    canChangeSelection: () => true,
    canRegisterCredential: () => true,
    setNotice() {},
    retainNotice: (sessionId, _identity, text) => {
      retainedNotices.push({ sessionId, text });
    },
  });
  const firstOpen = picker.openModels();
  strictEqual(picker.isOpen, true);
  strictEqual(lines[0], 'loading model catalog');
  picker.process({ kind: 'escape' });
  finishFirstRead!(result());
  await firstOpen;
  strictEqual(picker.isOpen, false);
  strictEqual(lines.length, 0);
  await picker.openModels();
  ok(lines.some((line) => line.includes('Tab favorite')));
  ok(lines.some((line) => line.includes('seed (current)')));
  picker.process({ kind: 'paste', text: 'SEARCHABLE' });
  strictEqual(lines[0].includes('2 matches'), true);
  picker.process({ kind: 'down' });
  picker.process({ kind: 'tab' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  strictEqual(lines[2], 'search> SEARCHABLE');
  ok(lines.some((line) => line.startsWith('> * older')));
  strictEqual(reads, 2);
  strictEqual(choices.length, 0);
  picker.process({ kind: 'enter' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  deepStrictEqual(choices, [{
    provider: 'local',
    modelId: 'older',
    effort: 'auto',
  }]);
  strictEqual(retainedNotices.length, 0);
  await picker.openModels();
  strictEqual(reads, 3);
  picker.process({ kind: 'escape' });
  strictEqual(picker.isOpen, false);
});

Deno.test('catalog loading stays in picker and failure is retained for its starting Session', async () => {
  let currentSessionId = 'session-before';
  let lines: readonly string[] = [];
  const retained: Array<{ sessionId: string; text: string; failureWord?: string }> = [];
  const client: RemoteCatalogUiOptions['client'] = {
    catalogRead: () => Promise.reject(new Error('unavailable')),
    modelFavorite: () => Promise.reject(new Error('unexpected favorite request')),
    selectionChange: () => Promise.reject(new Error('unexpected selection request')),
    commandRead: () => Promise.reject(new Error('unexpected command read')),
    credentialPresenceRead: () => Promise.reject(new Error('unexpected credential read')),
    credentialRegister: () => Promise.reject(new Error('unexpected credential register')),
  };
  const picker = new RemoteCatalogUi({
    client,
    renderer: {
      renderChoicePicker: (value) => lines = value,
      clearModal: () => lines = [],
    },
    sessionId: () => currentSessionId,
    selection: () => ({ provider: 'local', modelId: 'model', effort: 'auto' }),
    selectionChanged() {},
    canChangeSelection: () => true,
    canRegisterCredential: () => true,
    setNotice() {},
    retainNotice: (sessionId, _identity, text, failureWord) => {
      retained.push({
        sessionId,
        text,
        ...(failureWord === undefined ? {} : { failureWord }),
      });
    },
  });

  const opening = picker.openProviders();
  strictEqual(lines[0], 'loading provider catalog');
  currentSessionId = 'session-after';
  await opening;

  strictEqual(picker.isOpen, false);
  strictEqual(lines.length, 0);
  deepStrictEqual(retained, [{
    sessionId: 'session-before',
    text: 'FAILED · provider catalog unavailable',
    failureWord: 'FAILED',
  }]);
});
