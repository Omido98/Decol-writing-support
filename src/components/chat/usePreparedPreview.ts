import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useSourceStore } from "@/stores/sourceStore";
import { useProjectStore } from "@/stores/projectStore";
import { prepareChatRequest } from "@/services/chatPrepare";
import { messageKey } from "@/stores/chatStore";
import type { CompiledContext } from "@/services/contextCompiler";

// ──────────────────────────────────────────────
// Prepared preview (B14)
// ──────────────────────────────────────────────
// Every chat surface renders the manifest of the SAME prepared request
// the send will use. The hook prepares against the current store state
// (the typed draft decides fresh vs retry/regenerate boundary) with
// awaited source/brief hydration, guarded by cancellation so a slow
// preparation can never replace a newer one.

export function usePreparedPreview(): CompiledContext | null {
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threadLoaded = useChatStore((s) => s.threadLoaded);
  const messages = useChatStore((s) => s.messages);
  const draft = useChatStore((s) => s.drafts[s.activeThreadId ?? ""] ?? "");
  const config = useChatStore((s) => s.config);
  const brief = useChatStore((s) => s.brief);
  const attachments = useChatStore(
    (s) => s.threadAttachments[activeThreadId ?? ""],
  );
  const picks = useChatStore((s) =>
    activeThreadId ? s.threadSourcePicks[activeThreadId] : undefined,
  );
  const briefIncluded = useChatStore((s) => s.briefIncludedByThread);
  const sources = useSourceStore((s) => s.sources);
  const projects = useProjectStore((s) => s.projects);

  const [compiled, setCompiled] = useState<CompiledContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeThreadId || !threadLoaded || messages.length === 0) {
        setCompiled(null);
        return;
      }
      const trimmed = draft.trim();
      const last = messages[messages.length - 1];
      const kind = trimmed
        ? "fresh"
        : last.role === "assistant"
          ? "regenerate"
          : "retry";
      const request = await prepareChatRequest({
        kind,
        ...(trimmed ? { text: trimmed } : {}),
        ...(!trimmed && kind === "retry"
          ? { resendKey: messageKey(last) }
          : {}),
        ...(!trimmed && kind === "regenerate"
          ? { regenerateKey: messageKey(last) }
          : {}),
      });
      if (!cancelled) setCompiled(request?.compiled ?? null);
    };
    void run().catch(() => {
      if (!cancelled) setCompiled(null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeThreadId,
    threadLoaded,
    messages,
    draft,
    config,
    brief,
    attachments,
    picks,
    briefIncluded,
    sources,
    projects,
  ]);

  return compiled;
}
