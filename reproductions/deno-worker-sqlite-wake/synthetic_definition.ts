import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from "../../v0/agent/worker_agent_api.ts";

const usage = (id: string, finishReason: "stop" | "tool_calls"): string =>
  `data: ${
    JSON.stringify({
      id,
      choices: [{
        index: 0,
        delta: { content: "", role: "assistant" },
        finish_reason: finishReason,
        native_finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cost: 0.001,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\n`;

const toolStream = `data: ${
  JSON.stringify({
    id: "synthetic-tool",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "synthetic-search-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "official Deno documentation" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  })
}\n\n${usage("synthetic-tool", "tool_calls")}data: [DONE]\n\n`;

const finalStream = `data: ${
  JSON.stringify({
    id: "synthetic-final",
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "synthetic final answer" },
      finish_reason: "stop",
    }],
  })
}\n\n${usage("synthetic-final", "stop")}data: [DONE]\n\n`;

const sonarResponse = {
  id: "synthetic-sonar",
  model: "perplexity/sonar",
  choices: [{
    finish_reason: "stop",
    message: {
      role: "assistant",
      content: "The official Deno documentation is available.[1]",
      annotations: [{
        type: "url_citation",
        url_citation: {
          url: "https://docs.deno.com/",
          title: "Deno Docs",
          start_index: 0,
          end_index: 0,
        },
      }],
    },
  }],
};

let rootRequests = 0;
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (
  _input: string | URL | Request,
  init?: RequestInit,
) => {
  if (Deno.env.get("HENJI_DENO_REPRO_PASSTHROUGH") === "1") {
    return await nativeFetch(_input, init);
  }
  const rawBody = init?.body instanceof Uint8Array
    ? new TextDecoder().decode(init.body)
    : String(init?.body ?? "{}");
  const body = JSON.parse(rawBody) as {
    model?: string;
    stream?: boolean;
  };
  const endpoint = Deno.env.get("HENJI_DENO_REPRO_ENDPOINT");
  if (endpoint === undefined) {
    throw new Error("missing localhost reproduction endpoint");
  }
  const remoteProbe = Deno.env.get("HENJI_DENO_REPRO_REMOTE_PROBE");
  if (remoteProbe !== undefined) {
    const probeResponse = remoteProbe === "original"
      ? await nativeFetch(_input, init)
      : await nativeFetch(remoteProbe, { method: "GET" });
    await probeResponse.body?.cancel();
  }
  if (body.stream === false || body.model === "perplexity/sonar") {
    return await nativeFetch(`${endpoint}/sonar`);
  }
  rootRequests += 1;
  return await nativeFetch(`${endpoint}/root/${rootRequests}`);
};

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input);
export default definition;
