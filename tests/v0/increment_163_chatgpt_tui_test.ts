import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { ApiSelection, CatalogReadInput, CatalogReadResult } from '../../v0/api/contract.ts';
import type {
  ChatGPTAuthResult,
  ChatGPTOperation,
  ChatGPTState,
} from '../../v0/api/chatgpt_contract.ts';
import { RemoteCatalogUi } from '../../v0/tui/remote_catalog_ui.ts';
import type { RemoteCatalogUiOptions } from '../../v0/tui/remote_catalog_ui.ts';

const originalSelection: ApiSelection = {
  provider: 'openrouter',
  modelId: 'openrouter/parent-model',
  effort: 'auto',
};

const emptyState: ChatGPTState = { accounts: [] };

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for ChatGPT TUI behavior');
};

const harness = (
  chatgptAuth: (operation: ChatGPTOperation) =>
    | ChatGPTAuthResult
    | Promise<ChatGPTAuthResult>,
) => {
  let lines: readonly string[] = [];
  let controls: readonly string[] = [];
  let selection = originalSelection;
  const selectionChanges: ApiSelection[] = [];
  const retainedNotices: string[] = [];
  const modelReads: Extract<CatalogReadInput, { kind: 'models' }>[] = [];
  const client: RemoteCatalogUiOptions['client'] = {
    catalogRead: (input): Promise<CatalogReadResult> => {
      if (input.kind === 'credentials') {
        return Promise.resolve({
          kind: 'credentials',
          profiles: [{
            authProfile: 'openai-chatgpt',
            providers: ['openai-chatgpt'],
            method: 'chatgpt',
            label: 'Sign in with ChatGPT',
          }],
        });
      }
      if (input.kind === 'models') {
        modelReads.push(input);
        return Promise.resolve({
          kind: 'models',
          provider: input.provider,
          metadataStatus: 'loaded',
          models: [{
            modelId: 'gpt-5.6-sol',
            name: 'GPT 5.6 Sol',
            favorite: false,
            defaultEffort: 'medium',
            efforts: ['low', 'medium', 'high'],
          }],
        });
      }
      return Promise.reject(new Error('unexpected catalog read'));
    },
    modelFavorite: () => Promise.reject(new Error('unexpected favorite request')),
    selectionChange: (_sessionId, input) => {
      selectionChanges.push(input.selection);
      return Promise.resolve({
        kind: 'accepted',
        commandId: input.commandId,
        target: { kind: 'session', sessionId: 'session' },
        value: { result: 'selected', selection: input.selection },
      });
    },
    commandRead: () => Promise.reject(new Error('unexpected command read')),
    credentialPresenceRead: () =>
      Promise.resolve({
        profiles: [{
          authProfile: 'openai-chatgpt',
          providers: ['openai-chatgpt'],
          status: 'unknown',
        }],
      }),
    credentialRegister: () => Promise.reject(new Error('unexpected API key registration')),
    chatgptAuth: async (operation) => await chatgptAuth(operation),
  };
  const ui = new RemoteCatalogUi({
    client,
    renderer: {
      renderChoicePicker: (next, nextControls) => {
        lines = next;
        controls = nextControls ?? [];
      },
      clearModal: () => lines = [],
    },
    sessionId: () => 'session',
    selection: () => selection,
    selectionChanged: (next) => selection = next,
    canChangeSelection: () => false,
    canRegisterCredential: () => false,
    setNotice() {},
    retainNotice: (_sessionId, _identity, text) => retainedNotices.push(text),
  });

  return {
    ui,
    lines: () => lines,
    controls: () => controls,
    selection: () => selection,
    selectionChanges,
    retainedNotices,
    modelReads,
  };
};

Deno.test('ChatGPT login completes, model browsing stays read-only, and account selection stays parent-independent', async () => {
  const operations: ChatGPTOperation[] = [];
  let state = emptyState;
  let completedCallback: string | undefined;
  let attemptNumber = 0;
  const view = harness((operation) => {
    operations.push(operation);
    if (operation.kind === 'status') {
      return { kind: 'chatgpt', state };
    }
    if (operation.kind === 'begin') {
      attemptNumber++;
      return {
        kind: 'chatgpt',
        state,
        attempt: {
          attemptId: `attempt-${attemptNumber}`,
          registrationId: operation.registrationId ?? 'registration-one',
          authorizationUrl: 'https://auth.example.test/authorize?state=opaque',
        },
      };
    }
    if (operation.kind === 'complete') {
      completedCallback = operation.callbackUrl;
      state = {
        selectedRegistrationId: 'registration-one',
        accounts: [
          {
            registrationId: 'registration-one',
            label: 'one@example.test',
            needsReauthentication: false,
          },
          {
            registrationId: 'registration-two',
            label: 'two@example.test',
            needsReauthentication: false,
          },
        ],
      };
      return { kind: 'chatgpt', state };
    }
    if (operation.kind === 'select') {
      state = { ...state, selectedRegistrationId: operation.registrationId };
      return { kind: 'chatgpt', state };
    }
    if (operation.kind === 'cancel') return { kind: 'chatgpt', state };
    return { kind: 'rejected', reason: 'unexpected_operation' };
  });

  await view.ui.openLogin();
  ok(view.lines().some((line) => line.includes('Sign in with ChatGPT')));
  view.ui.process({ kind: 'enter' });
  await waitFor(() =>
    view.lines().some((line) => line.includes('https://auth.example.test/authorize'))
  );
  deepStrictEqual(operations.slice(0, 2).map((operation) => operation.kind), [
    'status',
    'begin',
  ]);

  view.ui.process({ kind: 'enter' });
  ok(view.lines().some((line) => line.includes('callback URL')));
  const callbackUrl = 'http://localhost:1455/auth/callback?code=sample&state=return-state';
  view.ui.process({ kind: 'paste', text: callbackUrl });
  ok(!view.lines().join('\n').includes(callbackUrl));
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('Connected account')));
  strictEqual(completedCallback, callbackUrl);
  ok(view.lines().some((line) => line.includes('registration-one')));
  ok(view.lines().some((line) => line.includes('registration-two')));

  view.ui.process({ kind: 'printable', text: 'm', codePoint: 109 });
  await waitFor(() => view.lines().some((line) => line.includes('ChatGPT models')));
  ok(view.lines().some((line) => line.includes('gpt-5.6-sol')));
  deepStrictEqual(view.modelReads.map((input) => input.registrationId), [
    'registration-one',
  ]);
  strictEqual(view.modelReads[0].sessionId, undefined);
  strictEqual(operations.some((operation) => operation.kind === 'select'), false);

  view.ui.process({ kind: 'escape' });
  ok(view.lines().some((line) => line.includes('ChatGPT accounts')));
  view.ui.process({ kind: 'down' });
  view.ui.process({ kind: 'printable', text: 'm', codePoint: 109 });
  await waitFor(() => view.modelReads.length === 2);
  strictEqual(view.modelReads[1].registrationId, 'registration-two');
  strictEqual(operations.some((operation) => operation.kind === 'select'), false);
  view.ui.process({ kind: 'escape' });

  view.ui.process({ kind: 'down' });
  view.ui.process({ kind: 'enter' });
  await waitFor(() =>
    operations.some((operation) =>
      operation.kind === 'select' && operation.registrationId === 'registration-two'
    )
  );
  await waitFor(() => !view.ui.isOpen);
  deepStrictEqual(view.lines(), []);
  ok(
    view.retainedNotices.some((notice) =>
      notice.includes('Selected ChatGPT account') && notice.includes('two@example.test')
    ),
  );
  strictEqual(view.selection().provider, 'openrouter');
  deepStrictEqual(view.selection(), originalSelection);
  deepStrictEqual(view.selectionChanges, []);
  strictEqual(view.retainedNotices.some((notice) => notice.includes(callbackUrl)), false);

  // Reopening login on the already selected account must also allow Enter to finish.
  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('ChatGPT accounts')));
  view.ui.process({ kind: 'enter' });
  await waitFor(() => !view.ui.isOpen);
  deepStrictEqual(view.lines(), []);
  deepStrictEqual(view.selection(), originalSelection);

  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('ChatGPT accounts')));
  view.ui.process({ kind: 'printable', text: 'r', codePoint: 114 });
  await waitFor(() => operations.filter((operation) => operation.kind === 'begin').length === 2);
  const reauthentication = operations.filter((operation) => operation.kind === 'begin')[1];
  if (reauthentication.kind !== 'begin') throw new Error('expected reauthentication begin');
  strictEqual(reauthentication.registrationId, 'registration-two');
  await waitFor(() => view.lines().some((line) => line.includes('/authorize')));
  view.ui.process({ kind: 'escape' });
  await waitFor(() => operations.filter((operation) => operation.kind === 'cancel').length === 1);

  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('ChatGPT accounts')));
  view.ui.process({ kind: 'printable', text: 'a', codePoint: 97 });
  await waitFor(() => operations.filter((operation) => operation.kind === 'begin').length === 3);
  const addedAccount = operations.filter((operation) => operation.kind === 'begin')[2];
  if (addedAccount.kind !== 'begin') throw new Error('expected add-account begin');
  strictEqual(addedAccount.registrationId, undefined);
  await waitFor(() => view.lines().some((line) => line.includes('/authorize')));
  view.ui.process({ kind: 'escape' });
  await waitFor(() => operations.filter((operation) => operation.kind === 'cancel').length === 2);
});

Deno.test('Adding an account identifies the completed registration while the prior account remains selected', async () => {
  const prior = {
    registrationId: 'prior-account',
    label: 'prior@example.test',
    needsReauthentication: false,
  };
  const added = {
    registrationId: 'new-account',
    label: 'new@example.test',
    needsReauthentication: false,
  };
  const before: ChatGPTState = { selectedRegistrationId: prior.registrationId, accounts: [prior] };
  const view = harness((operation) => {
    if (operation.kind === 'status') return { kind: 'chatgpt', state: before };
    if (operation.kind === 'begin') {
      return {
        kind: 'chatgpt',
        state: before,
        attempt: {
          attemptId: 'new-attempt',
          registrationId: added.registrationId,
          authorizationUrl: 'https://auth.example.test/new',
        },
      };
    }
    if (operation.kind === 'complete') {
      return {
        kind: 'chatgpt',
        state: {
          selectedRegistrationId: prior.registrationId,
          accounts: [prior, added],
        },
      };
    }
    throw new Error('Account completion must not implicitly select an account');
  });
  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('ChatGPT accounts')));
  view.ui.process({ kind: 'printable', text: 'a', codePoint: 97 });
  await waitFor(() => view.lines().some((line) => line.includes('/new')));
  view.ui.process({ kind: 'enter' });
  view.ui.process({ kind: 'paste', text: 'http://localhost/auth/callback?code=mock' });
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('Connected account')));
  ok(view.lines().some((line) => line.includes('Connected account · new@example.test')));
  deepStrictEqual(view.selectionChanges, []);
});

Deno.test('A submitted sign-in waits for completion without advertising or sending cancellation', async () => {
  let resolveCompletion!: (value: ChatGPTAuthResult) => void;
  const completion = new Promise<ChatGPTAuthResult>((resolve) => resolveCompletion = resolve);
  const operations: ChatGPTOperation[] = [];
  const view = harness((operation) => {
    operations.push(operation);
    if (operation.kind === 'status') return { kind: 'chatgpt', state: emptyState };
    if (operation.kind === 'begin') {
      return {
        kind: 'chatgpt',
        state: emptyState,
        attempt: {
          attemptId: 'submitted-attempt',
          registrationId: 'submitted-account',
          authorizationUrl: 'https://auth.example.test/submitted',
        },
      };
    }
    if (operation.kind === 'complete') return completion;
    throw new Error('A submitted sign-in is awaiting completion');
  });
  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('/submitted')));
  view.ui.process({ kind: 'enter' });
  view.ui.process({ kind: 'paste', text: 'http://localhost/auth/callback?code=mock' });
  view.ui.process({ kind: 'enter' });
  await waitFor(() => operations.some((operation) => operation.kind === 'complete'));
  ok(view.lines().some((line) => line.includes('Sign-in submitted')));
  deepStrictEqual(view.controls(), []);
  view.ui.process({ kind: 'escape' });
  strictEqual(view.ui.isOpen, true);
  strictEqual(operations.some((operation) => operation.kind === 'cancel'), false);
  resolveCompletion({
    kind: 'chatgpt',
    state: {
      selectedRegistrationId: 'submitted-account',
      accounts: [
        {
          registrationId: 'submitted-account',
          label: 'submitted@example.test',
          needsReauthentication: false,
        },
      ],
    },
  });
  await waitFor(() => view.lines().some((line) => line.includes('Connected account')));
});

Deno.test('Esc cancels the pending ChatGPT attempt and discards hidden callback input', async () => {
  const operations: ChatGPTOperation[] = [];
  const view = harness((operation) => {
    operations.push(operation);
    if (operation.kind === 'status') return { kind: 'chatgpt', state: emptyState };
    if (operation.kind === 'begin') {
      return {
        kind: 'chatgpt',
        state: emptyState,
        attempt: {
          attemptId: 'attempt-cancel',
          registrationId: 'account-cancel',
          authorizationUrl: 'https://auth.example.test/cancel',
        },
      };
    }
    if (operation.kind === 'cancel') return { kind: 'chatgpt', state: emptyState };
    return { kind: 'rejected', reason: 'unexpected_operation' };
  });

  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('/cancel')));
  view.ui.process({ kind: 'enter' });
  const callbackUrl = 'http://localhost:1455/auth/callback?code=hidden';
  view.ui.process({ kind: 'paste', text: callbackUrl });
  ok(!view.lines().join('\n').includes(callbackUrl));
  view.ui.process({ kind: 'escape' });
  await waitFor(() => operations.some((operation) => operation.kind === 'cancel'));

  strictEqual(view.ui.isOpen, false);
  strictEqual(view.lines().join('\n').includes(callbackUrl), false);
  strictEqual(operations.some((operation) => operation.kind === 'complete'), false);
  deepStrictEqual(view.selectionChanges, []);
});

Deno.test('ChatGPT authentication failures display the returned reason code', async () => {
  const operations: ChatGPTOperation[] = [];
  const view = harness((operation) => {
    operations.push(operation);
    if (operation.kind === 'status') return { kind: 'chatgpt', state: emptyState };
    if (operation.kind === 'begin') {
      return {
        kind: 'chatgpt',
        state: emptyState,
        attempt: {
          attemptId: 'attempt-failure',
          registrationId: 'account-failure',
          authorizationUrl: 'https://auth.example.test/failure',
        },
      };
    }
    if (operation.kind === 'complete') {
      return { kind: 'rejected', reason: 'callback_mismatch' };
    }
    if (operation.kind === 'cancel') return { kind: 'chatgpt', state: emptyState };
    return { kind: 'rejected', reason: 'unexpected_operation' };
  });

  await view.ui.openLogin();
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('/failure')));
  view.ui.process({ kind: 'enter' });
  view.ui.process({ kind: 'paste', text: 'http://localhost/callback?code=failure-secret' });
  view.ui.process({ kind: 'enter' });
  await waitFor(() => view.lines().some((line) => line.includes('callback_mismatch')));

  strictEqual(view.lines().join('\n').includes('failure-secret'), false);
  ok(view.retainedNotices.some((notice) => notice.includes('callback_mismatch')));
  deepStrictEqual(view.selectionChanges, []);
});
