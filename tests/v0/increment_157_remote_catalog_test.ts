import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { RemoteCatalogUi } from '../../v0/tui/remote_catalog_ui.ts';
import type { RemoteCatalogUiOptions } from '../../v0/tui/remote_catalog_ui.ts';
import type { ApiSelection, ModelCatalogResult } from '../../v0/api/contract.ts';

Deno.test('E6 picker searches names and preserves target/query across favorite reordering', async () => {
  let selection: ApiSelection = { provider: 'local', modelId: 'seed', effort: 'low' };
  let lines: readonly string[] = [];
  let reads = 0;
  const choices: ApiSelection[] = [];
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
    pathRead: () => {
      throw new Error('unexpected path read');
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
      setEditorSnapshot() {},
    },
    sessionId: () => 'session',
    selection: () => selection,
    selectionChanged: (value) => {
      selection = value;
    },
    canChangeSelection: () => true,
    canRegisterCredential: () => true,
    setNotice() {},
    credentialPresenceRead() {},
  });
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
  strictEqual(reads, 1);
  strictEqual(choices.length, 0);
  picker.process({ kind: 'enter' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  deepStrictEqual(choices, [{ provider: 'local', modelId: 'older', effort: 'auto' }]);
  await picker.openModels();
  strictEqual(reads, 2);
  picker.process({ kind: 'escape' });
  strictEqual(picker.isOpen, false);
});
