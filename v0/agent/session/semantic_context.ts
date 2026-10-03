import type { Message, ModelRequest } from '../core/contracts.ts';
import type { SemanticContextCheckpointV1 } from './session_store.ts';
import { indexSessionHistoryPrefix } from './session_history.ts';

const checkpointMessageText = (
  coveredThroughTurn: number,
  summary: string,
): string =>
  `[henji-context-checkpoint:v1]\ncovered-through-turn: ${coveredThroughTurn}\nretained-from-turn: ${
    coveredThroughTurn + 1
  }\nsummary:\n${summary}`;

const checkpointMessage = (
  checkpoint: SemanticContextCheckpointV1,
): Message => ({
  role: 'user',
  content: {
    kind: 'text',
    text: checkpointMessageText(checkpoint.coveredThroughTurn, checkpoint.summary),
  },
});

/** Compose summary + retained canonical suffix + current draft without changing their content. */
export const projectSemanticContext = (
  request: ModelRequest,
  checkpoint: SemanticContextCheckpointV1,
): ModelRequest => {
  const indexed = indexSessionHistoryPrefix(request.transcript);
  const turns = indexed?.turns ?? [];
  if (checkpoint.coveredThroughTurn < 1 || checkpoint.coveredThroughTurn >= turns.length + 1) {
    throw new Error('checkpoint boundary is invalid');
  }
  const end = turns[checkpoint.coveredThroughTurn - 1]?.end;
  if (end === undefined) throw new Error('checkpoint boundary is invalid');
  const projected = [checkpointMessage(checkpoint), ...request.transcript.slice(end)];
  return {
    ...(request.systemInstruction === undefined
      ? {}
      : { systemInstruction: request.systemInstruction }),
    transcript: structuredClone(projected),
    tools: structuredClone(request.tools),
  };
};
