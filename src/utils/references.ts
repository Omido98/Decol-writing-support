import type { ProjectMeta, ThreadMeta } from "@/types";

/**
 * Collect the reference entries for a thread: its own free-text references
 * plus, when linked, its project's. Used for both the token estimate and
 * the actual send, so the two always agree.
 */
export function collectReferences(
  thread: ThreadMeta | null | undefined,
  project: ProjectMeta | null | undefined,
): { source: string; content: string }[] {
  const refs: { source: string; content: string }[] = [];
  const threadRefs = thread?.references?.trim();
  if (threadRefs) {
    refs.push({
      source: "References for this text (provided before the chat started)",
      content: threadRefs,
    });
  }
  const projectRefs = project?.references?.trim();
  if (projectRefs) {
    refs.push({
      source: `References of project “${project!.title}”`,
      content: projectRefs,
    });
  }
  return refs;
}
