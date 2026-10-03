// Test-only transport redirect. The Agent bootstrap and credential resolver remain production code.
const endpoint = new URL(import.meta.url).searchParams.get('endpoint')!;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  const url = new URL(request.url);
  if (!['https://api.openai.com', 'https://openrouter.ai'].includes(url.origin)) {
    throw new Error('Increment 182 probe only supports its local model transport');
  }
  return originalFetch(new Request(`${endpoint}${url.pathname}${url.search}`, request));
};
await import('../../../v0/agent/worker/worker_bootstrap.ts');
export {};
