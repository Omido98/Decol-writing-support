import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/useAppStore";
import ProjectNavigator from "@/components/workspace/ProjectNavigator";
import DocumentPane from "@/components/workspace/DocumentPane";
import InspectorPanel from "@/components/workspace/InspectorPanel";
import WorkspaceStatusBar from "@/components/workspace/WorkspaceStatusBar";
import CommandPalette from "@/components/workspace/CommandPalette";
import SettingsDialog from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";
import { PanelLeft, PanelRight, Settings, FolderOpen, Search } from "lucide-react";
import { NAVIGATOR_WIDTH_RANGE, INSPECTOR_WIDTH_RANGE } from "@/stores/useAppStore";

/** Below this centre width a side panel gives way to its rail/drawer. */
const MIN_CENTRE_WIDTH = 480;
/** The slim rail a collapsed or auto-hidden panel folds to. */
const RAIL_WIDTH = 32;
/** The drag separator's width. */
const HANDLE_WIDTH = 4;
/** One keyboard resize step (DESIGN.md 4px grid). */
const RESIZE_STEP = 16;

interface PanelFit {
  /** The panel does not fit inline and must be reached as a drawer. */
  hideNavigator: boolean;
  hideInspector: boolean;
}

/**
 * Whether each side panel fits inline for the ACTUAL container and panel
 * widths (B20c): the inspector gives way first (writing is central), then
 * the navigator; a panel that does not fit is auto-hidden, never silently
 * unreachable (its rail opens a drawer).
 */
export function fitPanels(
  containerWidth: number,
  navigatorCollapsed: boolean,
  inspectorCollapsed: boolean,
  navigatorWidth: number,
  inspectorWidth: number,
): PanelFit {
  const navigatorPart = navigatorCollapsed
    ? RAIL_WIDTH
    : navigatorWidth + HANDLE_WIDTH;
  const inspectorPart = inspectorCollapsed
    ? RAIL_WIDTH
    : inspectorWidth + HANDLE_WIDTH;
  if (containerWidth - navigatorPart - inspectorPart >= MIN_CENTRE_WIDTH) {
    return { hideNavigator: false, hideInspector: false };
  }
  // The inspector is hidden first; recompute before deciding the navigator.
  if (containerWidth - navigatorPart - RAIL_WIDTH >= MIN_CENTRE_WIDTH) {
    return { hideNavigator: false, hideInspector: !inspectorCollapsed };
  }
  return { hideNavigator: !navigatorCollapsed, hideInspector: !inspectorCollapsed };
}

/**
 * The document-centred workspace shell: left navigator (240px,
 * collapsible), centre document pane, right inspector (360px,
 * collapsible), and the status bar (DESIGN.md).
 *
 * B20c:
 * - collapse decisions are measured from the REAL container and the
 *   current panel widths (ResizeObserver), not `window.innerWidth`
 *   arithmetic against the default widths;
 * - a panel that does not fit is never unreachable: its rail opens an
 *   explicit drawer (Escape/scrim closes; focus moves into the panel);
 * - panels stay MOUNTED when collapsed/hidden/focus mode, so their local
 *   state (project expansion, assistant drafts, scroll) survives;
 * - both widths persist across sessions and the separators resize by
 *   keyboard (Arrow keys, aria-valuenow);
 * - the inspector handle sits on its inner edge.
 */
export default function WorkspaceShell() {
  const navigatorCollapsed = useAppStore((s) => s.navigatorCollapsed);
  const inspectorCollapsed = useAppStore((s) => s.inspectorCollapsed);
  const focusMode = useAppStore((s) => s.focusMode);
  const toggleNavigator = useAppStore((s) => s.toggleNavigator);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const setView = useAppStore((s) => s.setView);

  const [showSettings, setShowSettings] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  /** The one auto-hidden panel currently reached as a drawer. */
  const [drawer, setDrawer] = useState<"navigator" | "inspector" | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  const navigatorWidth = useAppStore((s) => s.navigatorWidth);
  const inspectorWidth = useAppStore((s) => s.inspectorWidth);
  const setNavigatorWidth = useAppStore((s) => s.setNavigatorWidth);
  const setInspectorWidth = useAppStore((s) => s.setInspectorWidth);

  // Measure the REAL shell container (the layout decision must follow the
  // window AND the user's panel widths).
  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width || element.clientWidth;
      setContainerWidth(width > 0 ? width : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // jsdom (tests) reports no layout: fall back to the window width.
  const layoutWidth =
    containerWidth ?? (typeof window === "undefined" ? 0 : window.innerWidth);
  const fit = fitPanels(
    layoutWidth,
    navigatorCollapsed,
    inspectorCollapsed,
    navigatorWidth,
    inspectorWidth,
  );

  // A drawer is only for panels that do not fit inline; when the width
  // grows the panel returns inline and the drawer closes.
  const drawerOpen =
    drawer === "navigator" && fit.hideNavigator && !navigatorCollapsed
      ? "navigator"
      : drawer === "inspector" && fit.hideInspector && !inspectorCollapsed
        ? "inspector"
        : null;

  const inlineNavigator =
    !focusMode && !navigatorCollapsed && !fit.hideNavigator;
  const inlineInspector =
    !focusMode && !inspectorCollapsed && !fit.hideInspector;

  useEffect(() => {
    if (drawerOpen) drawerRef.current?.focus();
  }, [drawerOpen]);

  // Escape closes the drawer (outside click closes the scrim).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawer(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Drag-resize: the panels' widths are stored (and clamped) in the shell
  // state, so a resized layout persists across sessions.
  const dragRef = useRef<null | "navigator" | "inspector">(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current === "navigator") {
        setNavigatorWidth(e.clientX);
      } else if (dragRef.current === "inspector") {
        setInspectorWidth(window.innerWidth - e.clientX);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setNavigatorWidth, setInspectorWidth]);

  const startNavigatorDrag = () => {
    dragRef.current = "navigator";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const startInspectorDrag = () => {
    dragRef.current = "inspector";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const resizeNavigatorByKey = (delta: number) => {
    setNavigatorWidth(navigatorWidth + delta);
  };
  const resizeInspectorByKey = (delta: number) => {
    setInspectorWidth(inspectorWidth - delta);
  };

  // Ctrl/Cmd+K opens the command palette — EXCEPT while a contenteditable
  // (the manuscript editor) owns the keystroke, where Ctrl+K is the Link
  // command instead (B20a). Exactly one of the two handles the chord.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("[contenteditable='true'], .ProseMirror")
      ) {
        return;
      }
      e.preventDefault();
      setPaletteOpen((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Shell state (layout + last view) is hydrated by the app startup
  // sequence AFTER storage bootstrap and the inventories, so a restored
  // conversation selection can load its owner immediately.

  // A rail button opens the panel inline when it fits, otherwise as a
  // drawer — the panel is never a dead control at narrow widths.
  const showPanel = (panel: "navigator" | "inspector") => {
    if (panel === "navigator") {
      if (fit.hideNavigator) setDrawer("navigator");
      else toggleNavigator();
    } else {
      if (fit.hideInspector) setDrawer("inspector");
      else toggleInspector();
    }
  };

  /** The classes one side panel needs for its current presentation. */
  const panelClass = (
    panel: "navigator" | "inspector",
    inline: boolean,
  ): string => {
    if (drawerOpen === panel) {
      return `fixed inset-y-0 ${
        panel === "navigator" ? "left-0 border-r" : "right-0 border-l"
      } z-50 flex flex-col bg-background border-border shadow-[0_4px_16px_rgba(0,0,0,0.25)] focus:outline-none`;
    }
    if (inline) {
      return `shrink-0 ${
        panel === "navigator" ? "border-r" : "border-l"
      } border-border bg-background overflow-hidden flex flex-col`;
    }
    return "hidden";
  };

  return (
    <div
      ref={shellRef}
      className="flex flex-col h-screen w-screen bg-background overflow-hidden"
    >
      <div className="flex flex-1 min-h-0">
        {/* Left navigator: always mounted, hidden when collapsed/auto-hidden. */}
        <aside
          ref={drawerOpen === "navigator" ? drawerRef : undefined}
          aria-label="Navigator"
          role={drawerOpen === "navigator" ? "dialog" : undefined}
          aria-modal={drawerOpen === "navigator" ? true : undefined}
          tabIndex={drawerOpen === "navigator" ? -1 : undefined}
          hidden={!inlineNavigator && drawerOpen !== "navigator"}
          style={{
            width:
              drawerOpen === "navigator" ? navigatorWidth : inlineNavigator ? navigatorWidth : undefined,
          }}
          className={panelClass("navigator", inlineNavigator)}
        >
          <div className="flex items-center gap-1 px-2 pt-2 pb-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-text-secondary"
              onClick={() => setPaletteOpen(true)}
              title="Search everything (Ctrl+K)"
              aria-label="Search everything"
            >
              <Search className="size-3.5 mr-1" />
              Search
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setView({ kind: "manage" })}
              title="Browse and manage the library (filters, import, export)"
              aria-label="Manage library"
              className="size-6"
            >
              <FolderOpen className="size-3.5 text-text-secondary" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowSettings(true)}
              title="Settings"
              aria-label="Settings"
              className="size-6"
            >
              <Settings className="size-3.5 text-text-secondary" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleNavigator}
              title="Collapse navigator"
              aria-label="Collapse navigator"
              className="size-6"
            >
              <PanelLeft className="size-3.5 text-text-secondary" />
            </Button>
          </div>
          <div className="flex-1 min-h-0">
            <ProjectNavigator />
          </div>
        </aside>

        {/* Rail: show the navigator inline or as a drawer. */}
        {!focusMode && !inlineNavigator && drawerOpen !== "navigator" && (
          <button
            type="button"
            onClick={() => showPanel("navigator")}
            aria-label="Show navigator"
            title="Show navigator"
            className="w-8 shrink-0 border-r border-border bg-background text-text-muted hover:text-text-primary hover:bg-surface-alt focus-visible:text-text-primary transition-colors"
          >
            <PanelLeft className="size-4 mx-auto" />
          </button>
        )}

        {/* Drag handle: navigator (inner edge) */}
        {inlineNavigator && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize navigator"
            aria-valuenow={navigatorWidth}
            aria-valuemin={NAVIGATOR_WIDTH_RANGE[0]}
            aria-valuemax={NAVIGATOR_WIDTH_RANGE[1]}
            tabIndex={0}
            onMouseDown={startNavigatorDrag}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                resizeNavigatorByKey(-RESIZE_STEP);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                resizeNavigatorByKey(RESIZE_STEP);
              }
            }}
            className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none transition-colors"
          />
        )}

        {/* Centre document pane */}
        <main
          aria-label="Document"
          className="flex-1 min-w-0 overflow-hidden bg-background"
        >
          <DocumentPane onOpenSettings={() => setShowSettings(true)} />
        </main>

        {/* Drag handle: inspector (its INNER edge, before the panel). */}
        {inlineInspector && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            aria-valuenow={inspectorWidth}
            aria-valuemin={INSPECTOR_WIDTH_RANGE[0]}
            aria-valuemax={INSPECTOR_WIDTH_RANGE[1]}
            tabIndex={0}
            onMouseDown={startInspectorDrag}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                resizeInspectorByKey(-RESIZE_STEP);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                resizeInspectorByKey(RESIZE_STEP);
              }
            }}
            className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none transition-colors"
          />
        )}

        {/* Right inspector: always mounted, hidden when collapsed/auto-hidden. */}
        <aside
          ref={drawerOpen === "inspector" ? drawerRef : undefined}
          aria-label="Inspector"
          role={drawerOpen === "inspector" ? "dialog" : undefined}
          aria-modal={drawerOpen === "inspector" ? true : undefined}
          tabIndex={drawerOpen === "inspector" ? -1 : undefined}
          hidden={!inlineInspector && drawerOpen !== "inspector"}
          style={{
            width:
              drawerOpen === "inspector" ? inspectorWidth : inlineInspector ? inspectorWidth : undefined,
          }}
          className={panelClass("inspector", inlineInspector)}
        >
          <InspectorPanel />
        </aside>

        {/* Rail: show the inspector inline or as a drawer. */}
        {!focusMode && !inlineInspector && drawerOpen !== "inspector" && (
          <button
            type="button"
            onClick={() => showPanel("inspector")}
            aria-label="Show inspector"
            title="Show inspector"
            className="w-8 shrink-0 border-l border-border bg-background text-text-muted hover:text-text-primary hover:bg-surface-alt focus-visible:text-text-primary transition-colors"
          >
            <PanelRight className="size-4 mx-auto" />
          </button>
        )}
      </div>

      {drawerOpen && (
        <div
          aria-hidden="true"
          onClick={() => setDrawer(null)}
          className="fixed inset-0 z-40 bg-black/30"
        />
      )}

      <WorkspaceStatusBar />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}
