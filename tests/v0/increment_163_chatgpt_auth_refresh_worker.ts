import { createChatGPTAuthService } from '../../v0/agent/provider/chatgpt_auth.ts';

const fail = (message: string): never => {
  throw new Error(message);
};

const runRefreshWorker = async (
  credentialRoot: string,
  registrationId: string,
): Promise<string> => {
  const countPath = `${credentialRoot}/refresh-request-count.txt`;
  const fetcher: typeof fetch = async (_input, init) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (form.get('grant_type') !== 'refresh_token') {
      return new Response(
        JSON.stringify({ error: { code: 'unexpected_grant' } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    const countFile = await Deno.open(countPath, {
      write: true,
      append: true,
      create: true,
      mode: 0o600,
    });
    try {
      await countFile.write(new TextEncoder().encode('refresh\n'));
    } finally {
      countFile.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    return new Response(
      JSON.stringify({
        access_token: 'increment-163-replacement-access',
        refresh_token: 'increment-163-replacement-refresh',
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  const service = createChatGPTAuthService({ credentialRoot, fetcher });
  try {
    const credential = await service.resolve(registrationId);
    return credential.accessToken;
  } finally {
    await service.close();
  }
};

if (import.meta.main) {
  const credentialRoot = Deno.args[0] ?? fail('config root required');
  const registrationId = Deno.args[1] ?? fail('registration id required');
  console.log(await runRefreshWorker(credentialRoot, registrationId));
}
