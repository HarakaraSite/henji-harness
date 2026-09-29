import type { SessionSnapshot } from '../api/contract.ts';
import { freezeUiLogEntry, presentationFailureReason, type UiLogEntry } from './state.ts';

interface RetainedNotice {
  entry: UiLogEntry;
  anchor?: string;
  steeringText?: string;
}

/** Display memory belongs to this TUI; Core semantic history and queue records remain authoritative. */
export class RemoteSystemNotices {
  private readonly sessions = new Map<string, Map<string, RetainedNotice>>();
  private readonly semantic = new Map<string, readonly UiLogEntry[]>();

  retain(
    sessionId: string,
    identity: string,
    text: string,
    failureWord?: string,
    executionId?: string,
  ): void {
    let notices = this.sessions.get(sessionId);
    if (notices === undefined) {
      notices = new Map();
      this.sessions.set(sessionId, notices);
    }
    const id = `system:${sessionId}:${identity}`;
    const previous = notices.get(id);
    if (previous?.entry.text === text && previous.entry.failureWord === failureWord) return;
    const entries = this.semantic.get(sessionId) ?? [];
    const anchor = previous === undefined
      ? (executionId === undefined
        ? entries.at(-1)?.id
        : entries.findLast((entry) => entry.executionId === executionId)?.id ?? entries.at(-1)?.id)
      : previous.anchor;
    notices.set(id, {
      ...previous,
      ...(anchor === undefined ? {} : { anchor }),
      entry: freezeUiLogEntry({
        id,
        kind: 'system',
        label: 'system>',
        text,
        ...(failureWord === undefined ? {} : { failureWord }),
        ...(executionId === undefined ? {} : { executionId }),
        revision: (previous?.entry.revision ?? 0) + 1,
        live: false,
      }),
    });
  }

  merge(snapshot: SessionSnapshot, entries: readonly UiLogEntry[]): readonly UiLogEntry[] {
    const sessionId = snapshot.session.id;
    this.semantic.set(sessionId, entries);
    const execution = snapshot.runtime.execution;
    if (execution?.lifecycle === 'settled' && execution.outcome !== 'completed') {
      const word = execution.outcome.toUpperCase();
      const reason = execution.diagnostic === undefined
        ? execution.stopReason === 'max_steps'
          ? 'step limit reached'
          : execution.outcome === 'failed'
          ? 'execution failed'
          : execution.outcome === 'unknown'
          ? 'execution result unavailable'
          : execution.outcome
        : presentationFailureReason(execution.diagnostic);
      this.retain(
        sessionId,
        `execution:${execution.executionId}`,
        reason === execution.outcome ? word : `${word} · ${reason}`,
        word,
        execution.executionId,
      );
    }
    const records = [
      ...(snapshot.pending.followUp === undefined ? [] : [snapshot.pending.followUp]),
      ...snapshot.pending.followUps,
    ];
    for (const record of records) {
      const word = record.status === 'queued'
        ? 'RESERVED'
        : record.status === 'started'
        ? 'STARTED'
        : 'NOT STARTED';
      const reason = record.reason?.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
      this.retain(
        sessionId,
        `queue:${record.queueId}`,
        `${word} · ${record.text}${reason === undefined ? '' : ` · ${reason}`}`,
        word === 'NOT STARTED' ? word : undefined,
        record.afterExecutionId,
      );
    }
    const notices = this.sessions.get(sessionId);
    if (notices !== undefined) {
      for (const [id, notice] of notices) {
        if (
          notice.steeringText !== undefined &&
          entries.some((entry) =>
            entry.label === 'steer>' && entry.executionId === notice.entry.executionId &&
            entry.text === notice.steeringText
          )
        ) notices.delete(id);
      }
    }
    const steering = snapshot.pending.steering;
    if (
      steering !== undefined &&
      !entries.some((entry) =>
        entry.label === 'steer>' && entry.executionId === steering.executionId &&
        entry.text === steering.text
      )
    ) {
      this.retain(
        sessionId,
        `steering:${steering.commandId}`,
        `Additional instruction received · ${steering.text}`,
        undefined,
        steering.executionId,
      );
      this.sessions.get(sessionId)!.get(`system:${sessionId}:steering:${steering.commandId}`)!
        .steeringText = steering.text;
    }
    const retained = [...(this.sessions.get(sessionId)?.values() ?? [])];
    const ids = new Set(entries.map((entry) => entry.id));
    const result: UiLogEntry[] = [];
    for (const notice of retained) {
      if (notice.anchor === undefined) result.push(notice.entry);
    }
    for (const entry of entries) {
      result.push(entry);
      for (const notice of retained) {
        if (notice.anchor === entry.id) result.push(notice.entry);
      }
    }
    for (const notice of retained) {
      if (notice.anchor !== undefined && !ids.has(notice.anchor)) result.push(notice.entry);
    }
    return result;
  }
}
