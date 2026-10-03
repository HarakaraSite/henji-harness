/** Standalone diagnosis using the production adapter and the A1 spike's stream reader. */
import {
  ChatGPTResponsesModel,
  DeclaredResponsesModel,
  OpenAIResponsesModel,
  OpenRouterResponsesModel,
} from '../v0/agent/provider/openai_responses_model.ts';
import type { Message, ModelRequest } from '../v0/agent/core/contracts.ts';
import { consumeResponse, type Fact, ProbeHttp, refresh } from './spike_chatgpt_sign_in.ts';

type Item = Record<string, unknown>;
type Reporter = (fact: Fact) => Promise<void>;

const items = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter((x): x is Item => typeof x === 'object' && x !== null) : [];

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};
const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Persist readable observations and counts, never raw bodies or encrypted content. */
export function itemFacts(value: unknown) {
  return items(value).map((item) => ({
    type: item.type,
    ...(item.type === 'reasoning'
      ? {
        encryptedPresent: typeof item.encrypted_content === 'string',
        encryptedCharacters: typeof item.encrypted_content === 'string'
          ? item.encrypted_content.length
          : 0,
        summary: items(item.summary).map((part) => part.text),
      }
      : {}),
    ...(item.type === 'message'
      ? {
        phase: item.phase ?? null,
        text: items(item.content).filter((part) => part.type === 'output_text')
          .map((part) => part.text).join(''),
      }
      : {}),
  }));
}

export async function probeRoundTrip(options: {
  model: string;
  accessToken: string;
  summary: boolean;
  auth?: 'chatgpt' | 'api_key' | 'openrouter' | 'opencode_go';
  label?: string;
  baseURL?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  sessionId?: string;
  nextTurn?: boolean;
  report: Reporter;
  fetcher?: typeof fetch;
}) {
  const { report, summary } = options;
  const auth = options.auth ?? 'chatgpt';
  const arm = options.label ?? options.auth ?? (summary ? 'summary_auto' : 'summary_omitted');
  const provider = auth === 'api_key'
    ? 'openai-responses'
    : auth === 'openrouter'
    ? 'openrouter-responses'
    : auth === 'opencode_go'
    ? 'opencode-go-responses'
    : 'openai-chatgpt';
  let step = 0;
  let previousOutput: Item[] = [];
  let previousReplay: Item[] = [];
  let observed: Promise<void> = Promise.resolve();
  const http = new ProbeHttp(
    (fact) =>
      report({
        ...fact,
        arm,
        provider,
      }),
    async (url, init) => {
      const response = await (options.fetcher ?? fetch)(url, init);
      if (!response.ok) {
        const body = await response.clone().json().catch(() => undefined);
        const error = body && typeof body.error === 'object' ? body.error : {};
        await report({
          kind: 'provider_rejection',
          arm,
          httpStatus: response.status,
          errorFields: Object.keys(error),
          error: Object.fromEntries(
            ['type', 'code', 'param', 'message']
              .filter((key) => typeof error[key] === 'string')
              .map((key) => [key, error[key].replaceAll(options.accessToken, '[credential]')]),
          ),
        });
      }
      return response;
    },
  );
  const shared = {
    credentialSource: () => options.accessToken,
    fetcher: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Bound this experiment to one echo and its continuation; both arms use the same choice.
      body.tool_choice = step === 1 ? 'required' : 'none';
      if (summary) body.reasoning = { ...body.reasoning, summary: 'auto' };
      else if (body.reasoning) delete body.reasoning.summary;
      // Compare authentication with identical tool declarations; the API-key route normally
      // emits flat functions, while ChatGPT requires a namespace.
      const groupTools = auth !== 'chatgpt' && auth !== 'opencode_go';
      if (groupTools) {
        body.tools = [{
          type: 'namespace',
          name: 'henji',
          description: 'Henji local tools.',
          tools: body.tools,
        }];
      }
      body.store = false;
      const input = items(body.input);
      const reasoning = previousOutput.filter((item) => item.type === 'reasoning');
      await report({
        kind: 'wire_input',
        arm,
        step,
        reasoning: body.reasoning,
        toolsGroupedForComparison: groupTools,
        ...(auth === 'opencode_go'
          ? {
            goSessionHeaderPresent: new Headers(init?.headers).has('x-opencode-session'),
          }
          : {}),
        bodyBytes: new TextEncoder().encode(JSON.stringify(body)).length,
        itemTypes: input.map((item) => item.type ?? item.role),
        reasoningItems: input.filter((item) => item.type === 'reasoning').length,
        encryptedItems: input.filter((item) => typeof item.encrypted_content === 'string').length,
        replayedAllOutputItems: step === 1
          ? null
          : previousOutput.every((old) => input.some((item) => sameJson(item, old))),
        replayedAllAdapterItems: step === 1
          ? null
          : previousReplay.every((old) => input.some((item) => sameJson(item, old))),
        encryptedReasoningPreservedFromStream: reasoning.length === 0
          ? null
          : reasoning.every((old) =>
            input.some((item) =>
              item.id === old.id && item.encrypted_content === old.encrypted_content
            )
          ),
        streamItemDifferences: previousOutput.flatMap<Fact>((old) => {
          const replayed = input.find((item) => item.type === old.type && item.id === old.id);
          if (replayed === undefined) return [{ type: old.type, missingItem: true }];
          const fields = [...new Set([...Object.keys(old), ...Object.keys(replayed)])]
            .filter((key) => !sameJson(old[key], replayed[key]));
          return fields.length === 0 ? [] : [{ type: old.type, changedFields: fields }];
        }),
        messagePhases: input.filter((item) => item.type === 'message')
          .map((item) => item.phase ?? null),
      });
      const response = await http.request('responses', String(url), {
        ...init,
        body: JSON.stringify(body),
      }, { model: options.model, modelStep: step });
      // The independent reader sees the same stream as the SDK, without another HTTP call.
      observed = consumeResponse(response.clone(), (fact) => report({ arm, step, ...fact }))
        .then(async (result) => {
          previousOutput = items(result.output);
          await report({
            kind: 'provider_output',
            arm,
            step,
            items: itemFacts(result.output),
            usage: result.usage ?? null,
            responseModel: result.model ?? null,
          });
        }).catch(async () => {
          await report({ kind: 'independent_reader_failure', arm, step });
        });
      return response;
    },
  };
  const model = auth === 'openrouter'
    ? new OpenRouterResponsesModel({
      ...shared,
      baseURL: options.baseURL,
      selection: {
        provider: 'openrouter-responses',
        api: 'openrouter-responses',
        authProfile: 'openrouter-api-key',
        modelId: options.model,
        effort: 'high',
      },
    })
    : auth === 'opencode_go'
    ? new DeclaredResponsesModel({
      ...shared,
      baseURL: options.baseURL ?? 'https://opencode.ai/zen/go/v1',
      requestHeaders: options.requestHeaders,
      sessionId: options.sessionId ?? crypto.randomUUID(),
      selection: {
        provider: 'opencode-go-responses',
        api: 'openai-responses',
        authProfile: 'opencode-go-api-key',
        modelId: options.model,
        effort: 'high',
      },
    })
    : auth === 'api_key'
    ? new OpenAIResponsesModel({
      ...shared,
      selection: {
        provider: 'openai-responses',
        api: 'openai-responses',
        authProfile: 'openai-api-key',
        modelId: options.model,
        effort: 'high',
      },
    })
    : new ChatGPTResponsesModel({
      ...shared,
      selection: {
        provider: 'openai-chatgpt',
        api: 'openai-responses',
        authProfile: 'openai-chatgpt',
        modelId: options.model,
        effort: 'high',
      },
    });
  const transcript: Message[] = [{
    role: 'user',
    content: { kind: 'text', text: 'Check the local echo tool, then confirm the result.' },
  }];
  const request: ModelRequest = {
    systemInstruction:
      'Before calling henji.echo, give one brief progress sentence. Call echo with text HENJI_THINKING_PROBE_OK. After receiving its result, reply exactly HENJI_THINKING_PROBE_OK.',
    transcript,
    tools: [{
      name: 'echo',
      description: 'Return the supplied text locally.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    }],
  };
  for (step = 1; step <= (options.nextTurn ? 3 : 2); step++) {
    let progress = '';
    const thinking: unknown[] = [];
    try {
      const result = await model.generate(request, {
        modelStep: step,
        reportAssistantProgress: (text) => {
          progress = text;
        },
        reportThinkingDelta: (delta) => {
          thinking.push(delta);
        },
      });
      await observed;
      previousReplay = items(
        result.providerState && 'replayItems' in result.providerState
          ? result.providerState.replayItems
          : [],
      );
      await report({
        kind: 'adapter_output',
        arm,
        step,
        resultKind: result.kind,
        text: result.text ?? '',
        progress,
        thinking,
        replayItems: itemFacts(
          result.providerState && 'replayItems' in result.providerState
            ? result.providerState.replayItems
            : [],
        ),
      });
      if (result.kind === 'final') {
        if (!options.nextTurn || step >= 3) return;
        transcript.push({
          role: 'assistant',
          content: { kind: 'text', text: result.text },
          providerState: result.providerState,
        }, {
          role: 'user',
          content: { kind: 'text', text: 'Repeat the confirmed marker once. Do not call tools.' },
        });
        continue;
      }
      transcript.push({
        role: 'assistant',
        content: result.calls.map((call) => ({ kind: 'tool_call' as const, ...call })),
        ...(result.text === undefined ? {} : { text: result.text }),
        providerState: result.providerState,
      });
      if (result.calls.some((call) => call.name !== 'echo')) {
        await report({ kind: 'unexpected_tool', arm, step });
        return;
      }
      transcript.push({
        role: 'tool',
        content: result.calls.map((call) => ({
          kind: 'tool_result' as const,
          callId: call.callId,
          name: call.name,
          outcome: 'success' as const,
          text: String((call.arguments as Item).text),
        })),
      });
    } finally {
      await observed;
    }
  }
}

async function main(args: string[]) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(
      'Usage: deno run --config deno.v0.json --allow-read --allow-write --allow-net --allow-env scripts/probe_chatgpt_thinking.ts --credential-dir PATH --out PATH [--model gpt-5.6-sol] [--api-key-file PATH]\n' +
        'Provider comparison: --out PATH --openrouter-key-file PATH --go-key-file PATH [--go-base-url URL]. Three requests each: OpenRouter Sol, OpenRouter Luna, Go Luna (nine inference requests).\n' +
        'Default: summary omitted/summary:auto, high effort, two echo requests per arm (four inference requests). With --api-key-file: compare API key/ChatGPT, summary:auto, echo round trip plus next turn (six inference requests). Plus one refresh if expired. Facts exclude credentials, Authorization, raw SSE and encrypted content.',
    );
    return;
  }
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const dir = option('--credential-dir');
  const out = option('--out');
  const routerFile = option('--openrouter-key-file');
  const goFile = option('--go-key-file');
  if (!out || (!dir && !(routerFile && goFile))) {
    throw new Error('credential paths and out are required');
  }
  const runId = crypto.randomUUID();
  await Deno.mkdir(out, { recursive: true });
  const report: Reporter = (fact) =>
    Deno.writeTextFile(
      `${out}/facts.jsonl`,
      JSON.stringify({ runId, occurredAt: new Date().toISOString(), ...fact }) + '\n',
      { append: true },
    );
  if (routerFile && goFile) {
    const routerKey = (await Deno.readTextFile(routerFile)).trim();
    const goKey = (await Deno.readTextFile(goFile)).trim();
    const goDeclarationFile = option('--go-provider-file');
    const goDeclaration = goDeclarationFile
      ? JSON.parse(await Deno.readTextFile(goDeclarationFile))
      : undefined;
    for (
      const target of [
        {
          auth: 'openrouter' as const,
          label: 'openrouter_sol',
          model: 'openai/gpt-5.6-sol',
          accessToken: routerKey,
        },
        {
          auth: 'openrouter' as const,
          label: 'openrouter_luna',
          model: 'openai/gpt-5.6-luna',
          accessToken: routerKey,
        },
        {
          auth: 'opencode_go' as const,
          label: 'opencode_go_luna',
          model: 'gpt-5.6-luna',
          accessToken: goKey,
          baseURL: option('--go-base-url') ?? goDeclaration?.endpoint,
          requestHeaders: goDeclaration?.headers,
        },
      ]
    ) {
      if (args.includes('--only-go') && target.auth !== 'opencode_go') continue;
      await probeRoundTrip({ ...target, summary: true, nextTurn: true, report });
    }
    console.log(`Probe facts: ${out}/facts.jsonl`);
    return;
  }
  if (!dir) throw new Error('credential-dir is required');
  let credential = JSON.parse(await Deno.readTextFile(`${dir}/credential.json`));
  if (credential.expiresAt <= Date.now()) {
    credential = await refresh(dir, credential, new ProbeHttp(report));
  }
  const keyFile = option('--api-key-file');
  const apiKey = keyFile ? (await Deno.readTextFile(keyFile)).trim() : undefined;
  for (const arm of keyFile ? ['api_key', 'chatgpt'] as const : [false, true] as const) {
    await probeRoundTrip({
      model: option('--model') ?? 'gpt-5.6-sol',
      accessToken: arm === 'api_key' ? apiKey! : credential.accessToken,
      summary: typeof arm === 'string' ? true : arm,
      ...(typeof arm === 'string' ? { auth: arm, nextTurn: true } : {}),
      report,
    });
  }
  console.log(`Probe facts: ${out}/facts.jsonl`);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch {
    console.error('Probe failed; inspect the recorded HTTP/stream facts.');
    Deno.exitCode = 1;
  }
}
