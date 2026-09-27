import { Globe, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentTogglesProps {
  /** Whether web search is enabled for the next send. */
  webSearchEnabled?: boolean;
  /** Whether deep research is enabled for the next send. */
  deepResearchEnabled?: boolean;
  /** Toggles web search (applies to the next sends). */
  onToggleWebSearch?: () => void;
  /** Toggles deep research (applies to the next sends). */
  onToggleDeepResearch?: () => void;
  disabled?: boolean;
}

/**
 * The agent's web search and deep research pills, shared by the composer
 * and the empty-thread start panels (so both the first message and later
 * sends can change the flags).
 */
export default function AgentToggles({
  webSearchEnabled = true,
  deepResearchEnabled = false,
  onToggleWebSearch,
  onToggleDeepResearch,
  disabled = false,
}: AgentTogglesProps) {
  return (
    <>
      {onToggleWebSearch && (
        <button
          type="button"
          onClick={onToggleWebSearch}
          disabled={disabled}
          aria-pressed={webSearchEnabled}
          title={
            webSearchEnabled
              ? "Web search is ON: the agent may search the web and fetch pages to check facts. Click to turn it off."
              : "Web search is OFF: the agent answers without web tools. Click to turn it on (one search and up to 5 pages per turn)."
          }
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
            webSearchEnabled
              ? "bg-primary/10 border-primary/40 text-text-primary"
              : "bg-surface border-border text-text-muted",
          )}
        >
          <Globe
            className={cn(
              "size-3 shrink-0",
              webSearchEnabled ? "text-primary" : "text-text-muted",
            )}
          />
          Web search
        </button>
      )}
      {onToggleDeepResearch && (
        <button
          type="button"
          onClick={onToggleDeepResearch}
          disabled={disabled}
          aria-pressed={deepResearchEnabled}
          title={
            deepResearchEnabled
              ? "Deep research is ON: multiple searches and many page fetches until key claims are verified (slower, more tokens). Click to turn it off."
              : "Deep research is OFF. Click to research thoroughly: multiple searches with varied queries and many page fetches. Needs web search."
          }
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
            deepResearchEnabled
              ? "bg-primary/10 border-primary/40 text-text-primary"
              : "bg-surface border-border text-text-muted",
          )}
        >
          <Telescope
            className={cn(
              "size-3 shrink-0",
              deepResearchEnabled ? "text-primary" : "text-text-muted",
            )}
          />
          Deep research
        </button>
      )}
    </>
  );
}
