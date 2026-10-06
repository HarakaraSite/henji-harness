import { type Workspace } from './work_tool_contract.ts';
import { type Tool, ToolInputError } from './tools.ts';
import { TurnCancelledError } from '../core/cancellation.ts';
import type { ProcessExecutor } from '../runtime/process_contract.ts';
import { executeTypescriptProcess } from './run_typescript_process.ts';

/** Host-resolved sandbox additions for this Worker generation. */
export interface RunTypescriptToolSandbox {
  /** Config root that code may read and write; omitted when no config root is resolved. */
  readonly configRoot?: string;
  /** Additional read/write paths from the sandbox config file. */
  readonly allowedPaths: readonly string[];
  /** Deny audit entries from the sandbox config file. */
  readonly deniedPaths: readonly string[];
}

export const createRunTypescriptTool = (
  workspace: Workspace,
  processes: ProcessExecutor,
  sandbox: RunTypescriptToolSandbox,
): Tool => ({
  name: 'run_typescript',
  description:
    'Execute an async TypeScript function body using the Deno runtime embedded in Henji. Use await and TypeScript type annotations in code; input is optional JSON and defaults to null. The variable workspace is the absolute workspace directory. Read and write workspace files with Deno.readTextFile and Deno.writeTextFile using workspace + "/relative/path"; /tmp is also readable and writable. The variable henjiConfigRoot is the absolute path of the henji configuration directory (instruction.md, agents, tools, hooks, providers, model catalogs); it is readable and writable, while credential files and ChatGPT account files are neither readable nor writable. Network access is enabled for code. Use await import("jsr:@std/csv") to acquire Deno std at runtime, including its std dependencies. Only @std packages and their https://jsr.io/@std/ sources may be imported; npm, Node built-ins, local files and other module sources are rejected. Additional Workers are unavailable so imports remain subject to this policy. Ordinary fetch and JavaScript eval remain available. Environment variables, subprocesses, system information and FFI are disabled. Return a JSON-serializable value to receive it as the tool result; a body with no return produces null. Successful tool results are limited to 1 MiB of UTF-8, including a truncation marker when needed; oversized results may no longer be valid JSON. Write large results to workspace or /tmp files and return their path and count; file sizes are unrestricted. Each call uses a fresh execution process with code and module-acquisition Workers. Cancellation stops and settles that process, including synchronous computation.',
  promptGuidelines: Object.freeze([
    'For JSON/JSONL/CSV aggregation, transformations and small calculations, execute code with run_typescript rather than bash and return only the needed result. Read input files directly in code instead of copying them into model context. Successful results are limited to 1 MiB of UTF-8, including a truncation marker; larger results may no longer be valid JSON. Write large results to a workspace or /tmp file and return its path and count; file sizes are unrestricted.',
    'Supply the body of an async function, not a complete module. Use await import() for Deno std, await for IO, workspace + "/relative/path" for workspace files, and return a JSON-serializable result.',
    'Begin code with a one-line // comment stating the purpose in a short phrase; the tool row shows that comment.',
    'When the data to aggregate comes from another command, have that command write its output to a file (workspace scratch or /tmp) and read the file in code instead of copying excerpts through the model.',
  ]),
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Body of an async TypeScript function; return the JSON result.',
      },
      input: { description: 'Optional JSON input supplied to the code.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  async execute(argumentsValue, context) {
    const values = argumentsValue as Record<string, unknown> | null;
    if (
      argumentsValue === null || typeof argumentsValue !== 'object' ||
      Array.isArray(argumentsValue) || typeof values?.code !== 'string'
    ) {
      throw new ToolInputError('code must be a string');
    }
    if (context?.signal?.aborted) throw new TurnCancelledError();
    const allowedPaths = sandbox.configRoot === undefined
      ? [...sandbox.allowedPaths]
      : [sandbox.configRoot, ...sandbox.allowedPaths];
    return await executeTypescriptProcess(
      values.code,
      workspace,
      values.input ?? null,
      {
        read: allowedPaths,
        write: allowedPaths,
        deny: sandbox.deniedPaths,
        ...(sandbox.configRoot === undefined ? {} : { configRoot: sandbox.configRoot }),
      },
      processes,
      context,
    );
  },
});
