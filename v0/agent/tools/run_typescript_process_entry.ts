import { executeTypescriptBody } from './run_typescript_executor.ts';
import type { TypescriptProcessInput, TypescriptProcessReply } from './run_typescript_process.ts';

/** Internal single-call entry: no Session, model, credential or database composition. */
export const runTypescriptProcessEntry = async (
  inputPath: string,
  resultPath: string,
): Promise<number> => {
  let reply: TypescriptProcessReply;
  try {
    const input: TypescriptProcessInput = JSON.parse(await Deno.readTextFile(inputPath));
    reply = {
      ok: true,
      result: await executeTypescriptBody(input.code, input.workspace, input.input),
    };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await Deno.writeTextFile(resultPath, JSON.stringify(reply));
  return 0;
};
