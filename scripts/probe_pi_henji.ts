/** Henji summary and installed Pi comparisons; credentials and opaque payloads stay in memory. */
import { ChatGPTResponsesModel } from '../v0/agent/provider/openai_responses_model.ts';
import type { Message } from '../v0/agent/core/contracts.ts';
import { consumeResponse, ProbeHttp, refresh } from './spike_chatgpt_sign_in.ts';
import { itemFacts } from './probe_chatgpt_thinking.ts';
import { readableThinkingFromState } from '../v0/agent/core/readable_thinking.ts';

const sourceTask = Deno.args.includes('--source-task');
const summaryComparison = Deno.args.includes('--summary-comparison');
const henjiOnly = Deno.args.includes('--henji-only');
const outIndex = Deno.args.indexOf('--out');
const out = outIndex >= 0
  ? Deno.args[outIndex + 1]
  : summaryComparison
  ? '.tools/henji-summary-comparison'
  : sourceTask
  ? '.tools/pi-henji-comparison/source-task'
  : '.tools/pi-henji-comparison';
await Deno.mkdir(out, { recursive: true });
let credential = JSON.parse(await Deno.readTextFile('.tools/a1-chatgpt-spike/credential.json'));
const report = async (fact: unknown) => {
  const line = JSON.stringify(fact).replaceAll(credential.accessToken, '[credential]');
  await Deno.writeTextFile(`${out}/facts.jsonl`, line + '\n', { append: true });
};
if (credential.expiresAt <= Date.now() + 120000) {
  credential = await refresh('.tools/a1-chatgpt-spike', credential, new ProbeHttp(report));
}
const piRoot =
  '/home/agent/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai';
const { stream } = summaryComparison || henjiOnly
  ? {}
  : await import(`${piRoot}/dist/api/openai-responses.js`);
const { normalizeContext } = summaryComparison || henjiOnly
  ? {}
  : await import(`${piRoot}/dist/utils/transcript.js`);
const piVersion = summaryComparison || henjiOnly
  ? null
  : JSON.parse(await Deno.readTextFile(`${piRoot}/package.json`)).version;
const modelId = 'gpt-5.6-sol';
const sourcePath = 'v0/agent/provider/openai_responses_model.ts';
const instruction = sourceTask
  ? 'You are diagnosing a coding agent adapter. Read the available local source with read_file exactly once. Before the tool call, give a brief progress sentence. Then analyze the source and answer the user in Japanese, under 250 words. Do not modify files. On follow-up turns use the source already read; do not call tools again.'
  : 'Check the local echo tool exactly once with text HENJI_PI_COMPARISON_OK. Before the tool call, give a brief progress sentence. After its result, reply exactly HENJI_PI_COMPARISON_OK. Do not use a tool again unless the user asks.';
const user = sourceTask
  ? `Read ${sourcePath}. Diagnose whether missing readable thinking means encrypted reasoning is not replayed. Trace request, stream, replay and displayed text separately. Identify concrete differences needed for showing thinking; distinguish evidence from uncertainty.`
  : 'Check the local echo tool, then confirm the result.';
const nextUser = sourceTask
  ? 'Without tools, review your preceding diagnosis: if response.completed.output is empty but output_item.done has reasoning, text and a tool call, what will this adapter save and resend? Give the exact code path, and explain whether that establishes reasoning was actually used by the server.'
  : 'Without calling tools, repeat the marker returned by the earlier echo.';
const toolName = sourceTask ? 'read_file' : 'echo';
const toolDescription = sourceTask
  ? 'Read the indicated local source file.'
  : 'Return the supplied text locally.';
const property = sourceTask ? 'path' : 'text';
const schema = {
  type: 'object',
  properties: { [property]: { type: 'string' } },
  required: [property],
};
const toolText = sourceTask
  ? await Deno.readTextFile(sourcePath)
  : JSON.stringify({ text: 'HENJI_PI_COMPARISON_OK' });
if (sourceTask) await Deno.writeTextFile(`${out}/tool-source.txt`, toolText);
const objects = (value: any): any[] => Array.isArray(value) ? value : [];
const same = (a: any, b: any): boolean => {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
await report({
  kind: 'conditions',
  piVersion,
  modelId,
  effort: 'high',
  instruction,
  user,
  nextUser,
  maxInferenceRequests: henjiOnly || Deno.args.includes('--pi-only') ? 3 : 6,
  payloadOverrides: summaryComparison
    ? { henji_summary_omitted: ['reasoning.summary omitted'] }
    : [],
  toolName,
  toolResultCharacters: toolText.length,
});
let baselineFirstBody: any;
for (
  const arm of summaryComparison
    ? ['henji_summary_omitted', 'henji_current']
    : henjiOnly
    ? ['henji_current']
    : Deno.args.includes('--pi-only')
    ? ['pi_native']
    : ['henji_current', 'pi_native']
) {
  let step = 0;
  let previous: any[] = [];
  let observed: Promise<void> = Promise.resolve();
  const fetcher = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (arm === 'henji_summary_omitted') {
      delete body.reasoning.summary;
      init = { ...init, body: JSON.stringify(body) };
    }
    if (arm === 'henji_summary_omitted' && step === 1) baselineFirstBody = body;
    const withoutSummary = { ...body, reasoning: { ...body.reasoning } };
    delete withoutSummary.reasoning.summary;
    const input = objects(body.input);
    const headers = new Headers(init.headers);
    await report({
      kind: 'request',
      arm,
      step,
      url: String(url),
      keys: Object.keys(body),
      reasoning: body.reasoning ?? null,
      sameInitialRequestExceptSummary: summaryComparison && arm === 'henji_current' && step === 1
        ? same(baselineFirstBody, withoutSummary)
        : null,
      include: body.include ?? null,
      store: body.store,
      stream: body.stream,
      instructions: body.instructions ?? null,
      promptCacheKeyPresent: typeof body.prompt_cache_key === 'string',
      sessionHeaderPresent: headers.has('session_id'),
      clientRequestIdPresent: headers.has('x-client-request-id'),
      toolTypes: objects(body.tools).map((t) => t.type),
      toolDeclarations: body.tools,
      input: input.map((i) => ({
        type: i.type ?? null,
        role: i.role ?? null,
        phase: i.phase ?? null,
        encryptedPresent: typeof i.encrypted_content === 'string',
        encryptedCharacters: typeof i.encrypted_content === 'string'
          ? i.encrypted_content.length
          : 0,
        contentTypes: objects(i.content).map((c) => c.type),
        contentForm: typeof i.content,
        callIdPresent: typeof i.call_id === 'string',
        namespace: i.namespace ?? null,
      })),
      replayedEncryptedFromDone: previous.filter((i) => i.type === 'reasoning').map((i) => ({
        present: input.some((j) => j.id === i.id),
        unchanged: input.some((j) => j.id === i.id && j.encrypted_content === i.encrypted_content),
      })),
      changedReplayFields: previous.map((i) => {
        const replayed = input.find((j) => j.id === i.id && j.type === i.type);
        return {
          type: i.type,
          missing: !replayed,
          changed: replayed
            ? [...new Set([...Object.keys(i), ...Object.keys(replayed)])].filter((k) =>
              !same(i[k], replayed[k])
            )
            : [],
        };
      }),
    });
    const response = await fetch(url, init);
    await report({ kind: 'http', arm, step, status: response.status });
    if (response.ok) {
      observed = consumeResponse(response.clone(), (fact) => report({ ...fact, arm, step }))
        .then(async (r) => {
          previous = objects(r.output);
          await report({
            kind: 'response',
            arm,
            step,
            reasoning: r.reasoning ?? null,
            items: itemFacts(r.output),
            functionCalls: previous.filter((i) => i.type === 'function_call')
              .map((i) => ({
                name: i.name,
                namespace: i.namespace ?? null,
                arguments: i.arguments,
              })),
            usage: r.usage ?? null,
            status: r.status,
            model: r.model,
          });
        }).catch((e) => report({ kind: 'reader_error', arm, step, error: String(e) }));
    } else {
      const error = await response.clone().json().catch(() => ({}));
      await report({ kind: 'rejection', arm, step, error: error.error ?? error });
    }
    return response;
  };
  const henji = new ChatGPTResponsesModel({
    selection: {
      provider: 'openai-chatgpt',
      api: 'openai-responses',
      authProfile: 'openai-chatgpt',
      modelId,
      effort: 'high',
    },
    credentialSource: () => credential.accessToken,
    fetcher,
  });
  const ht: Message[] = [{ role: 'user', content: { kind: 'text', text: user } }];
  const pt: any[] = [{ role: 'user', content: user, timestamp: 0 }];
  const piModel = {
    id: modelId,
    name: modelId,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  };
  try {
    for (step = 1; step <= 3; step++) {
      if (step === 3) {
        ht.push({ role: 'user', content: { kind: 'text', text: nextUser } });
        pt.push({ role: 'user', content: nextUser, timestamp: 0 });
      }
      if (arm !== 'pi_native') {
        const thinking: unknown[] = [];
        let progress = '';
        const result = await henji.generate({
          systemInstruction: instruction,
          transcript: ht,
          tools: [{
            name: toolName,
            description: toolDescription,
            inputSchema: schema,
          }],
        }, {
          reportAssistantProgress: (text) => {
            progress = text;
          },
          reportThinkingDelta: (delta) => {
            thinking.push(delta);
          },
        });
        await observed;
        await report({
          kind: 'adapter',
          arm,
          step,
          resultKind: result.kind,
          text: result.text ?? '',
          progress,
          thinking,
          savedReadableThinking: readableThinkingFromState(result.providerState) ?? null,
        });
        if (result.kind === 'tool_calls') {
          ht.push({
            role: 'assistant',
            content: result.calls.map((call) => ({ kind: 'tool_call', ...call })),
            ...(result.text ? { text: result.text } : {}),
            providerState: result.providerState,
          });
          ht.push({
            role: 'tool',
            content: result.calls.map((call) => ({
              kind: 'tool_result',
              callId: call.callId,
              name: call.name,
              text: toolText,
              outcome: 'success',
            })),
          });
        } else {ht.push({
            role: 'assistant',
            content: { kind: 'text', text: result.text },
            providerState: result.providerState,
          });}
      } else {
        const events: unknown[] = [];
        const source = stream(
          piModel,
          normalizeContext({
            systemPrompt: instruction,
            messages: pt,
            tools: [{
              name: toolName,
              description: toolDescription,
              parameters: schema,
            }],
          }),
          {
            apiKey: credential.accessToken,
            reasoningEffort: 'high',
            sessionId: 'henji-pi-probe',
            maxRetries: 0,
            timeoutMs: 120000,
            fetch: fetcher,
          },
        );
        for await (const event of source) {
          if (['thinking_delta', 'text_delta'].includes(event.type)) {
            events.push({ type: event.type, delta: event.delta });
          }
        }
        const result = await source.result();
        await observed;
        await report({
          kind: 'adapter',
          arm,
          step,
          stopReason: result.stopReason,
          error: result.errorMessage ?? null,
          events,
          content: result.content.map((b: any) => ({
            type: b.type,
            text: b.text ?? b.thinking ?? null,
            signaturePresent: Boolean(b.thinkingSignature || b.textSignature),
            name: b.name ?? null,
          })),
        });
        if (result.stopReason === 'error') break;
        pt.push(result);
        for (const b of result.content) {
          if (b.type === 'toolCall') {
            pt.push({
              role: 'toolResult',
              toolCallId: b.id,
              toolName: b.name,
              content: [{ type: 'text', text: toolText }],
              isError: false,
              timestamp: 0,
            });
          }
        }
      }
    }
  } catch (e) {
    await observed;
    await report({ kind: 'arm_error', arm, step, error: String(e) });
  }
}
console.log(`Probe finished: ${out}/facts.jsonl`);
