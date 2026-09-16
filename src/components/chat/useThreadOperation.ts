import { useSyncExternalStore } from "react";
import {
  activeOperationForThread,
  failedSendsForThread,
  failedSendsVersion,
  operationsVersion,
  subscribeFailedSends,
  subscribeOperations,
  type AiOperation,
  type FailedSendRecord,
} from "@/services/aiOperations";

/**
 * Operation mirrors for chat surfaces (B15). The operation service owns
 * every request's lifetime; these hooks only mirror it into renders:
 * - `useThreadOperation` re-renders on every operation change (including
 *   stream deltas) and returns the RUNNING operation of a conversation —
 *   no other thread's spinner can appear because the lookup is scoped.
 * - `useThreadFailedSends` re-renders only when the retained-failure
 *   registry changes (not per delta) and returns that conversation's
 *   failed sends (Retry snapshots).
 */

function useOperationsVersion(): number {
  return useSyncExternalStore(
    subscribeOperations,
    operationsVersion,
    operationsVersion,
  );
}

function useFailedSendsVersion(): number {
  return useSyncExternalStore(
    subscribeFailedSends,
    failedSendsVersion,
    failedSendsVersion,
  );
}

/** The running operation of a conversation, if any. */
export function useThreadOperation(
  threadId: string | null | undefined,
): AiOperation | undefined {
  // Subscribe for this render; the lookup itself is a cheap scan.
  useOperationsVersion();
  return threadId ? activeOperationForThread(threadId) : undefined;
}

/** Retained failed sends of a conversation (Retry snapshots). */
export function useThreadFailedSends(
  threadId: string | null | undefined,
): FailedSendRecord[] {
  useFailedSendsVersion();
  return threadId ? failedSendsForThread(threadId) : [];
}
