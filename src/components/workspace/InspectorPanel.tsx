import { useAppStore, type InspectorView } from "@/stores/useAppStore";
import CompactAssistant from "@/components/workspace/CompactAssistant";
import SourcesPanel from "@/components/workspace/SourcesPanel";
import ReviewPanel from "@/components/workspace/ReviewPanel";
import { cn } from "@/lib/utils";

/**
 * The right inspector: Assistant / Sources / Review. All views stay
 * mounted (hidden when inactive) so the assistant's editor state survives
 * view switches.
 *
 * B20c: a proper tab pattern — tabs own `aria-controls` and the panels
 * `aria-labelledby`, exactly one tab is in the tab order at a time, and
 * Left/Right/Home/End move the selection (DESIGN.md: the tab bar responds
 * to arrow keys).
 */
const VIEWS: { id: InspectorView; label: string }[] = [
  { id: "assistant", label: "Assistant" },
  { id: "sources", label: "Sources" },
  { id: "review", label: "Review" },
];

const tabId = (id: InspectorView) => `inspector-tab-${id}`;
const panelId = (id: InspectorView) => `inspector-panel-${id}`;

export default function InspectorPanel() {
  const inspectorView = useAppStore((s) => s.inspectorView);
  const setInspectorView = useAppStore((s) => s.setInspectorView);
  const view = useAppStore((s) => s.view);
  /** The document whose proposals the Review tab shows. */
  const reviewDocumentId = view.kind === "edit" ? view.id : view.kind === "read" ? view.id : null;

  const moveSelection = (direction: 1 | -1 | "first" | "last") => {
    const at = VIEWS.findIndex((v) => v.id === inspectorView);
    const next =
      direction === "first"
        ? 0
        : direction === "last"
          ? VIEWS.length - 1
          : (at + direction + VIEWS.length) % VIEWS.length;
    const target = VIEWS[next];
    setInspectorView(target.id);
    // All tabs exist already; moving focus is immediate.
    document.getElementById(tabId(target.id))?.focus();
  };

  return (
    <div className="flex flex-col h-full">
      {/* View switcher */}
      <div
        role="tablist"
        aria-label="Inspector views"
        className="flex items-center gap-1 px-2 py-2 border-b border-border shrink-0"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            id={tabId(v.id)}
            role="tab"
            type="button"
            aria-selected={inspectorView === v.id}
            aria-controls={panelId(v.id)}
            tabIndex={inspectorView === v.id ? 0 : -1}
            onClick={() => setInspectorView(v.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                moveSelection(1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                moveSelection(-1);
              } else if (e.key === "Home") {
                e.preventDefault();
                moveSelection("first");
              } else if (e.key === "End") {
                e.preventDefault();
                moveSelection("last");
              }
            }}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium transition-colors select-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              inspectorView === v.id
                ? "bg-primary text-primary-foreground"
                : "text-text-secondary hover:bg-surface-alt hover:text-text-primary",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Views stay mounted so their state survives switching. */}
      <div
        role="tabpanel"
        id={panelId("assistant")}
        aria-labelledby={tabId("assistant")}
        className={cn("flex-1 min-h-0", inspectorView !== "assistant" && "hidden")}
        aria-hidden={inspectorView !== "assistant"}
      >
        <CompactAssistant />
      </div>
      <div
        role="tabpanel"
        id={panelId("sources")}
        aria-labelledby={tabId("sources")}
        className={cn("flex-1 min-h-0", inspectorView !== "sources" && "hidden")}
        aria-hidden={inspectorView !== "sources"}
      >
        <SourcesPanel />
      </div>
      <div
        role="tabpanel"
        id={panelId("review")}
        aria-labelledby={tabId("review")}
        className={cn("flex-1 min-h-0", inspectorView !== "review" && "hidden")}
        aria-hidden={inspectorView !== "review"}
      >
        <ReviewPanel documentId={reviewDocumentId} />
      </div>
    </div>
  );
}
