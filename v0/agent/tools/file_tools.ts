import type { ToolExecutionContext } from '../core/execution_context.ts';
import {
  isCancellationCleanupError,
  isTurnCancelledError,
  throwIfCancelled,
} from '../core/cancellation.ts';
import { type Tool, ToolInputError } from './tools.ts';
import type { Workspace, WorkToolSeams } from './work_tool_contract.ts';
import {
  encoder,
  exactKeys,
  invalidToolArguments,
  isObject,
  MAX_TEXT_BYTES,
  validateObject,
  validTextArgument,
} from './work_tool_value.ts';
import { checkedPath } from './work_tool_workspace.ts';
import {
  atomicReplace,
  bytesEqual,
  readBytesBounded,
  readTarget,
  readWindow,
} from './work_tool_file_io.ts';

const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

const writeSchema = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
  additionalProperties: false,
} as const;

const editSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  required: ['path', 'edits'],
  additionalProperties: false,
} as const;

export const createReadTool = (workspace: Workspace): Tool => ({
  name: 'read',
  description:
    'Read complete lines from one UTF-8 workspace file (64 KiB result). offset is 1-based; use offset/limit and the continuation notice for large files.',
  inputSchema: readSchema,
  promptGuidelines: Object.freeze([
    'File調査ではcatやsedをbashで実行するよりreadを優先し、続きはoffset・limitで読む。',
  ]),
  async execute(argumentsValue, context?: ToolExecutionContext) {
    if (!isObject(argumentsValue)) throw invalidToolArguments('read');
    const keys = Object.keys(argumentsValue);
    if (
      !keys.includes('path') ||
      keys.some((key) => key !== 'path' && key !== 'offset' && key !== 'limit') ||
      typeof argumentsValue.path !== 'string' ||
      (argumentsValue.offset !== undefined &&
        (typeof argumentsValue.offset !== 'number' ||
          !Number.isSafeInteger(argumentsValue.offset) ||
          argumentsValue.offset < 1)) ||
      (argumentsValue.limit !== undefined &&
        (typeof argumentsValue.limit !== 'number' ||
          !Number.isSafeInteger(argumentsValue.limit) ||
          argumentsValue.limit < 1))
    ) throw invalidToolArguments('read');
    return await readWindow(
      workspace,
      argumentsValue.path,
      typeof argumentsValue.offset === 'number' ? argumentsValue.offset : 1,
      typeof argumentsValue.limit === 'number' ? argumentsValue.limit : undefined,
      context?.signal,
    );
  },
});

export const createWriteTool = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): Tool => ({
  name: 'write',
  description:
    'Create or replace one UTF-8 text file inside the workspace. Missing parent directories are created.',
  inputSchema: writeSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, ['path', 'content'], 'write');
    if (
      typeof args.path !== 'string' ||
      !validTextArgument(args.content, MAX_TEXT_BYTES)
    ) throw invalidToolArguments('write');
    const content = args.content;
    const encoded = encoder.encode(content);
    const checked = await checkedPath(
      workspace,
      args.path,
      true,
      context?.signal,
    ).catch(
      (error: unknown) => {
        if (error instanceof ToolInputError) throw error;
        if (isTurnCancelledError(error)) throw error;
        throw new Error('local write failed');
      },
    );
    if (checked.targetInfo && !checked.targetInfo.isFile) {
      throw new Error('target is not a regular file');
    }
    const mode = checked.targetInfo?.mode == null ? 0o644 : checked.targetInfo.mode & 0o7777;
    try {
      await atomicReplace(
        workspace,
        checked,
        encoded,
        mode,
        seams,
        undefined,
        context?.signal,
      );
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error) || isCancellationCleanupError(error)) {
        throw error;
      }
      throw new Error('local write failed');
    }
    return JSON.stringify({
      path: checked.relative,
      bytes: encoded.byteLength,
    });
  },
});

interface EditOperation {
  readonly oldText: string;
  readonly newText: string;
}

export const createEditTool = (
  workspace: Workspace,
  seams: WorkToolSeams = {},
): Tool => ({
  name: 'edit',
  description:
    'Apply up to 32 non-overlapping exact replacements to one existing UTF-8 text file. Each oldText must match exactly once in the original file.',
  inputSchema: editSchema,
  async execute(argumentsValue, context?: ToolExecutionContext) {
    const args = validateObject(argumentsValue, ['path', 'edits'], 'edit');
    if (
      typeof args.path !== 'string' || !Array.isArray(args.edits) ||
      args.edits.length < 1 ||
      args.edits.length > 32
    ) {
      throw invalidToolArguments('edit');
    }
    const operations: EditOperation[] = [];
    for (let index = 0; index < args.edits.length; index += 1) {
      const operation = args.edits[index];
      if (
        !isObject(operation) || !exactKeys(operation, ['oldText', 'newText']) ||
        typeof operation.oldText !== 'string' ||
        typeof operation.newText !== 'string' ||
        !validTextArgument(operation.oldText, MAX_TEXT_BYTES) ||
        !validTextArgument(operation.newText, MAX_TEXT_BYTES)
      ) {
        throw invalidToolArguments('edit');
      }
      if (operation.oldText.length === 0) {
        throw new ToolInputError(`edit ${index + 1} oldText is empty`);
      }
      if (operation.oldText === operation.newText) {
        throw new ToolInputError(`edit ${index + 1} does not change content`);
      }
      operations.push({
        oldText: operation.oldText,
        newText: operation.newText,
      });
    }
    const snapshot = await readTarget(
      workspace,
      args.path,
      'edit',
      context?.signal,
    );
    const spans: { start: number; end: number; operation: EditOperation }[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const first = snapshot.text.indexOf(operation.oldText);
      if (first < 0) {
        throw new ToolInputError(`edit ${index + 1} oldText was not found`);
      }
      if (snapshot.text.indexOf(operation.oldText, first + 1) >= 0) {
        throw new ToolInputError(`edit ${index + 1} oldText is not unique`);
      }
      spans.push({
        start: first,
        end: first + operation.oldText.length,
        operation,
      });
    }
    spans.sort((left, right) => left.start - right.start);
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index - 1].end > spans[index].start) {
        throw new ToolInputError('edits overlap');
      }
    }
    let output = '';
    let cursor = 0;
    for (const span of spans) {
      output += snapshot.text.slice(cursor, span.start) +
        span.operation.newText;
      cursor = span.end;
    }
    output += snapshot.text.slice(cursor);
    const encoded = encoder.encode(output);
    if (encoded.byteLength > MAX_TEXT_BYTES) {
      throw new Error('file exceeds 64 KiB');
    }
    throwIfCancelled(context?.signal);
    let latest: Uint8Array;
    try {
      latest = await readBytesBounded(snapshot.checked.absolute);
      throwIfCancelled(context?.signal);
    } catch (error) {
      if (isTurnCancelledError(error)) throw error;
      throw new Error('local edit failed');
    }
    if (!bytesEqual(snapshot.bytes, latest)) {
      throw new Error('local edit failed');
    }
    const mode = snapshot.checked.targetInfo?.mode == null
      ? 0o644
      : snapshot.checked.targetInfo.mode & 0o7777;
    try {
      await atomicReplace(
        workspace,
        snapshot.checked,
        encoded,
        mode,
        seams,
        snapshot.bytes,
        context?.signal,
      );
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (isTurnCancelledError(error) || isCancellationCleanupError(error)) {
        throw error;
      }
      throw new Error('local edit failed');
    }
    return JSON.stringify({
      path: snapshot.checked.relative,
      edits: operations.length,
      bytes: encoded.byteLength,
    });
  },
});
