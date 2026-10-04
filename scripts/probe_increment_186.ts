import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { HenjiApiClient } from '../v0/api/client.ts';

const call = (id: string, name: string, args: unknown) => ({
  type: 'function_call',
  id: `function-${id}`,
  status: 'completed',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const sse = (output: unknown[], text = '') => {
  const events: unknown[] = text ? [{ type: 'response.output_text.delta', delta: text }] : [];
  events.push({ type: 'response.completed', response: { id: crypto.randomUUID(), output } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
};

/** Run the extracted package with isolated config and localhost services, without a live provider. */
export const probePackage = async (packageFolder: string, evidenceDirectory: string) => {
  const root = await Deno.makeTempDir({ dir: evidenceDirectory, prefix: 'package-probe-' });
  const workspace = join(root, 'workspace');
  const config = join(root, 'config', 'henji-harness');
  const binaryDirectory = join(root, 'bin');
  const binary = join(binaryDirectory, 'henji');
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  await Deno.mkdir(workspace);
  const command = async (executable: string, args: string[]) => {
    const output = await new Deno.Command(executable, {
      args,
      env,
      cwd: workspace,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout);
  };
  const install = (extra: string[] = []) =>
    command('/bin/bash', [
      join(packageFolder, 'install.sh'),
      '--bin-dir',
      binaryDirectory,
      '--config-root',
      config,
      ...extra,
    ]);
  await install();
  const settings = join(config, 'tools', 'search', 'settings.ts');
  const packagedSettings = await Deno.readTextFile(settings);
  await Deno.writeTextFile(settings, packagedSettings + '\n// local edit retained on install\n');
  const catalogPath = join(config, 'tools.json');
  const catalog = JSON.parse(await Deno.readTextFile(catalogPath));
  catalog.tools.other = '/local/other-tool';
  await Deno.writeTextFile(catalogPath, JSON.stringify(catalog));
  await install();
  ok((await Deno.readTextFile(settings)).includes('local edit retained'));
  strictEqual(JSON.parse(await Deno.readTextFile(catalogPath)).tools.other, '/local/other-tool');
  await install(['--replace-tools']);
  strictEqual(await Deno.readTextFile(settings), packagedSettings);
  const inspections = [];
  for (const name of ['search', 'web_search', 'web_fetch']) {
    const inspection = JSON.parse(await command(binary, ['tool', 'inspect', '--name', name]));
    ok(JSON.stringify(inspection).includes(join(config, 'tools', name)));
    inspections.push(inspection);
  }
  const files = {
    'first.txt': 'needle first needle\nneedle second\n',
    '.hidden.txt': 'needle hidden\n',
    'nested/ignored.txt': 'needle ignored\n',
    '.gitignore': 'nested/\n',
  };
  await Deno.mkdir(join(workspace, 'nested'));
  for (const [path, text] of Object.entries(files)) {
    await Deno.writeTextFile(join(workspace, path), text);
  }
  const download = new Uint8Array([0, 1, 127, 255]);
  const outputs = new Map<string, string>();
  let modelRequests = 0;
  let exaRequests = 0;
  let origin = '';
  const calls = () => [
    call('paths', 'search', { mode: 'paths', glob: '*.txt' }),
    call('content', 'search', { mode: 'content', pattern: 'needle', glob: '*.txt', limit: 1 }),
    call('files', 'search', { mode: 'files', pattern: 'needle', glob: '*.txt' }),
    call('count', 'search', {
      mode: 'count',
      pattern: 'needle',
      patternKind: 'literal',
      glob: '*.txt',
      limit: 1,
    }),
    call('web', 'web_search', { query: 'local package probe' }),
    call('fetch', 'web_fetch', { url: `${origin}/page` }),
    call('download', 'web_fetch', { url: `${origin}/download`, save_to: 'downloads/probe.bin' }),
  ];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/page') {
      return new Response('<html><body><h1>Package page</h1><p>Fetched locally</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (path === '/download') {
      return new Response(download, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path === '/search') {
      exaRequests++;
      const body = await request.json();
      strictEqual(body.query, 'local package probe');
      strictEqual(body.stream, false);
      ok(request.headers.has('authorization'));
      return Response.json({
        requestId: 'local-exa',
        results: [{
          id: 'local-result',
          title: 'Local package result',
          url: `${origin}/page`,
          highlights: ['Local highlight'],
        }],
        searchType: 'auto',
      });
    }
    if (path !== '/v1/responses') return new Response('unknown local route', { status: 404 });
    modelRequests++;
    const body = await request.json();
    const names = body.tools.map((tool: { name: string }) => tool.name);
    for (const name of ['search', 'web_search', 'web_fetch']) ok(names.includes(name));
    const search = body.tools.find((tool: { name: string }) => tool.name === 'search');
    ok(search.parameters.properties.mode.enum.includes('count'));
    ok(search.description.includes('matchCount'));
    for (const item of body.input as Array<Record<string, unknown>>) {
      if (item.type === 'function_call_output') {
        outputs.set(item.call_id as string, item.output as string);
      }
    }
    const fallback = JSON.stringify(body.input).includes('Exercise grep fallback');
    const requested = fallback
      ? [
        call('grep', 'search', { mode: 'content', pattern: 'needle', glob: '*.txt' }),
        call('grep-count', 'search', {
          mode: 'count',
          pattern: 'needle',
          patternKind: 'literal',
          glob: '*.txt',
        }),
      ]
      : calls();
    const next = requested.find((entry) => !outputs.has(entry.call_id));
    if (next) return sse([next]);
    const text = 'PACKAGE_TOOLS_OK';
    return sse([{
      type: 'message',
      id: 'final',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }], text);
  });
  origin = `http://127.0.0.1:${server.addr.port}`;
  let core: Deno.ChildProcess | undefined;
  let client: HenjiApiClient | undefined;
  try {
    const webMain = join(config, 'tools', 'web_search', 'main.ts');
    const source = await Deno.readTextFile(webMain);
    ok(source.includes('https://api.exa.ai/search'), 'Exa endpoint missing from editable tool');
    await Deno.writeTextFile(
      webMain,
      source.replaceAll('https://api.exa.ai/search', `${origin}/search`),
    );
    await Deno.mkdir(join(config, 'providers'));
    await Deno.writeTextFile(
      join(config, 'providers', 'local.json'),
      JSON.stringify({
        schemaVersion: 1,
        providerId: 'increment-186-local',
        protocol: 'openai-responses',
        endpoint: `${origin}/v1`,
        authProfile: 'increment-186-local-key',
        modelCatalog: {
          kind: 'fixed',
          entries: [{ modelId: 'local', defaultEffort: 'auto', efforts: ['auto'] }],
        },
        defaults: { modelId: 'local', effort: 'auto' },
        modelListSource: 'catalog',
      }),
    );
    for (const profile of ['increment-186-local-key', 'exa-api-key']) {
      await Deno.writeTextFile(join(config, profile), 'synthetic-local-credential', {
        mode: 0o600,
      });
    }
    core = new Deno.Command(binary, {
      args: ['serve', '--json', '--new', '--root-provider', 'increment-186-local'],
      env: { ...env, PATH: binaryDirectory },
      cwd: workspace,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const stderr = new Response(core.stderr).text();
    const lines = core.stdout.pipeThrough(new TextDecoderStream());
    const reader = lines.getReader();
    let readyText = '';
    const readyDeadline = setTimeout(() => core?.kill('SIGTERM'), 20_000);
    try {
      while (!readyText.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Core exited before ready: ${await stderr}`);
        readyText += chunk.value;
      }
    } finally {
      clearTimeout(readyDeadline);
      reader.releaseLock();
    }
    const ready = JSON.parse(readyText.split('\n')[0]);
    client = new HenjiApiClient(ready.url);
    const state = await client.coreRead();
    ok(state.activeSessionId);
    const sessionId = state.activeSessionId;
    const receipt = await client.taskSubmit(sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Exercise packaged tools',
    });
    if (receipt.kind !== 'accepted') throw new Error(JSON.stringify(receipt));
    const executionId = receipt.value.executionId;
    const deadline = Date.now() + 30_000;
    let execution = (await client.executionRead(executionId)).execution;
    while (execution.processSettlement !== 'complete') {
      if (Date.now() > deadline) throw new Error('Package execution did not settle');
      await new Promise((accept) => setTimeout(accept, 25));
      execution = (await client.executionRead(executionId)).execution;
    }
    strictEqual(execution.outcome, 'completed');
    strictEqual(execution.adoption, 'canonical');
    const paths = JSON.parse(outputs.get('paths')!);
    deepStrictEqual(paths.records, ['.hidden.txt', 'first.txt', 'nested/ignored.txt']);
    const content = JSON.parse(outputs.get('content')!);
    strictEqual(content.backend, 'rg');
    strictEqual(content.records.length, 1);
    strictEqual(content.hasMore, true);
    strictEqual(content.nextOffset, 1);
    const matchingFiles = JSON.parse(outputs.get('files')!);
    deepStrictEqual(matchingFiles.records, paths.records);
    ok(outputs.get('web')?.includes('Local package result'));
    ok(outputs.get('fetch')?.includes('Fetched locally'));
    ok(outputs.get('download')?.includes('Saved:'));
    deepStrictEqual(await Deno.readFile(join(workspace, 'downloads/probe.bin')), download);
    strictEqual(exaRequests, 1);
    strictEqual(modelRequests, 8);
    deepStrictEqual(JSON.parse(outputs.get('count')!), {
      mode: 'count',
      backend: 'rg',
      matchCount: 5,
    });
    strictEqual(content.total, 4);
    const history = await command(binary, ['history', '--session', sessionId, '--view', 'detail']);
    for (const name of ['search', 'web_search', 'web_fetch']) ok(history.includes(name));
    ok(history.includes('PACKAGE_TOOLS_OK'));
    ok(history.includes('Local package result'));
    ok(history.includes('exa-search'));
    ok(history.includes('matchCount'));
    ok(!history.includes('synthetic-local-credential'));
    await Deno.writeTextFile(join(root, 'history.ndjson'), history);
    // A new Worker must read the editable folder again; its PATH can contain grep alone.
    const grepPath = join(root, 'grep-only');
    await Deno.mkdir(grepPath);
    await Deno.symlink('/usr/bin/grep', join(grepPath, 'grep'));
    await Deno.writeTextFile(
      settings,
      packagedSettings.replace(
        "'/usr/local/bin:/usr/bin:/bin'",
        JSON.stringify(grepPath),
      ),
    );
    const opened = await client.sessionOpen({
      commandId: crypto.randomUUID(),
      selection: { kind: 'new' },
    });
    if (opened.kind !== 'accepted') throw new Error(JSON.stringify(opened));
    const grepReceipt = await client.taskSubmit(opened.value.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'Exercise grep fallback',
    });
    if (grepReceipt.kind !== 'accepted') throw new Error(JSON.stringify(grepReceipt));
    let grepExecution = (await client.executionRead(grepReceipt.value.executionId)).execution;
    const grepDeadline = Date.now() + 15_000;
    while (grepExecution.processSettlement !== 'complete') {
      if (Date.now() > grepDeadline) throw new Error('grep execution did not settle');
      await new Promise((accept) => setTimeout(accept, 25));
      grepExecution = (await client.executionRead(grepReceipt.value.executionId)).execution;
    }
    strictEqual(grepExecution.outcome, 'completed');
    const grepOutput = JSON.parse(outputs.get('grep')!);
    strictEqual(grepOutput.backend, 'grep');
    strictEqual(grepOutput.total, content.total);
    strictEqual(modelRequests, 11);
    deepStrictEqual(JSON.parse(outputs.get('grep-count')!), {
      mode: 'count',
      backend: 'grep',
      matchCount: 5,
    });
    strictEqual(exaRequests, 1);
    const evidence = {
      root,
      packageFolder,
      binary,
      inspections,
      sessionId,
      executionId,
      outcome: execution.outcome,
      adoption: execution.adoption,
      modelRequests,
      exaRequests,
      searchBackend: content.backend,
      fallbackBackend: grepOutput.backend,
      checks: [
        'editable tools retained',
        'explicit replacement',
        'other mappings retained',
        'three external folders loaded',
        'hidden/ignored file scope',
        'record pagination',
        'count schema and total occurrences distinct from matching lines',
        'Exa request and result',
        'HTML text fetch',
        'original byte download',
        'semantic history and request fact readback',
        'edited tool loaded by new Worker and real grep fallback',
        'compiled runtime launched without Deno on PATH',
      ],
    };
    await Deno.writeTextFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
  } finally {
    if (client) await client.coreShutdown({ commandId: crypto.randomUUID() }).catch(() => {});
    else if (core) core.kill('SIGTERM');
    if (core) await core.status;
    await server.shutdown();
  }
};

if (import.meta.main) {
  const [packageFolder, evidenceDirectory] = Deno.args;
  if (!packageFolder || !evidenceDirectory) {
    throw new Error('usage: probe_increment_186.ts PACKAGE_FOLDER EVIDENCE_DIR');
  }
  await Deno.mkdir(resolve(evidenceDirectory), { recursive: true });
  console.log(
    JSON.stringify(await probePackage(resolve(packageFolder), resolve(evidenceDirectory))),
  );
}
