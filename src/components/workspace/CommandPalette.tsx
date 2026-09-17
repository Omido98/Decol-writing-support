import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { repo, type SearchHit } from "@/utils/repository";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  BookMarked,
  BookPlus,
  ClipboardList,
  FolderOpen,
  FolderPlus,
  Focus,
  MessageSquarePlus,
  Notebook,
  Search,
} from "lucide-react";

/**
 * The command palette (Ctrl/Cmd+K): jump to anything (documents,
 * projects, conversations), run actions, and full-text search across
 * documents, briefs, and conversations.
 *
 * B20b rebuilt it on the app's one modal primitive:
 * - focus is trapped inside and restored to the opener on close;
 * - keyboard and mouse share ONE active-result index, clamped whenever
 *   the result list changes;
 * - Enter is IME-safe and activates exactly once;
 * - a slow search response can never replace a newer query's results.
 */

interface PaletteItem {
  id: string;
  icon: typeof BookMarked;
  label: string;
  hint?: string;
  run: () => void;
}

function optionId(itemId: string, index: number): string {
  return `palette-option-${index}-${itemId}`;
}

export default function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setView = useAppStore((s) => s.setView);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);
  const openText = useAppStore((s) => s.openText);
  const openProject = useAppStore((s) => s.openProject);
  const openBrief = useAppStore((s) => s.openBrief);
  const openDiscussion = useAppStore((s) => s.openDiscussion);

  const texts = useLibraryStore((s) => s.texts);
  const createText = useLibraryStore((s) => s.createText);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);
  const threads = useChatStore((s) => s.threads);
  const createThread = useChatStore((s) => s.createThread);

  const [query, setQuery] = useState("");
  /** Full-text hits together with the query that produced them (F10): the
   * list never mixes a previous query's results into the current one. */
  const [hits, setHits] = useState<{ query: string; results: SearchHit[] }>({
    query: "",
    results: [],
  });
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The element focused when the palette opened: the dialog's explicit
  // return-focus target (Ctrl+K can open it from anywhere, so there is no
  // DialogTrigger to infer it from).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open !== wasOpenRef.current) {
    wasOpenRef.current = open;
    if (open) {
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
  }

  // Full-text search (debounced). A response whose query is no longer the
  // current one is discarded: slow A can never overwrite fast B (B20b).
  // F10: changing the query clears the previous hits immediately (the
  // debounce window must never show or activate a stale query's hits).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits({ query: "", results: [] });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void repo
        .search(q)
        .then((results) => {
          if (!cancelled) setHits({ query: q, results });
        })
        .catch(() => {
          if (!cancelled) setHits({ query: "", results: [] });
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits({ query: "", results: [] });
      setActive(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    // Actions.
    out.push(
      {
        id: "action:new-document",
        icon: BookPlus,
        label: "New blank document",
        run: () => {
          void createText({}).then((id) => setView({ kind: "edit", id }));
        },
      },
      {
        id: "action:paste-document",
        icon: ClipboardList,
        label: "Paste as new document",
        run: () => {
          void navigator.clipboard
            .readText()
            .then((clip) =>
              createText({
                title: "Pasted note",
                ...(clip.trim() ? { content: clip } : {}),
              })
            )
            .then((id) => setView({ kind: "edit", id }))
            .catch(() => {
              void createText({ title: "Pasted note" }).then((id) =>
                setView({ kind: "edit", id }),
              );
            });
        },
      },
      {
        id: "action:new-conversation",
        icon: MessageSquarePlus,
        label: "New conversation",
        run: () => {
          void createThread().then((id) => openDiscussion(id));
        },
      },
      {
        id: "action:new-project",
        icon: FolderPlus,
        label: "New project",
        run: () => {
          void createProject({}).then((id) => openProject(id));
        },
      },
      {
        id: "action:toggle-focus",
        icon: Focus,
        label: "Toggle focus mode",
        run: toggleFocusMode,
      },
    );

    // Navigator entries.
    for (const p of projects) {
      out.push({
        id: `project:${p.id}`,
        icon: FolderOpen,
        label: p.title,
        hint: "Project",
        run: () => openProject(p.id),
      });
      out.push({
        id: `brief:${p.id}`,
        icon: Notebook,
        label: p.title,
        hint: "Brief",
        run: () => openBrief(p.id),
      });
    }
    for (const t of texts) {
      out.push({
        id: `text:${t.id}`,
        icon: BookMarked,
        label: t.title,
        hint: "Document",
        run: () => openText(t.id),
      });
    }
    for (const t of threads) {
      out.push({
        id: `thread:${t.id}`,
        icon: MessageSquarePlus,
        label: t.title,
        hint: "Conversation",
        run: () => openDiscussion(t.id),
      });
    }

    // Filter by the query (title matching; full-text hits are appended).
    const q = query.trim().toLowerCase();
    const filtered = q
      ? out.filter((item) => item.label.toLowerCase().includes(q))
      : out;

    // Full-text results that are not already listed. Only the CURRENT
    // query's hits are shown: a previous query's results must not leak
    // into the new list (F10).
    if (hits.query === query.trim()) {
      for (const hit of hits.results) {
        if (!filtered.some((i) => i.id.startsWith(`${hit.kind}:${hit.docId}`))) {
          filtered.push({
            id: `search:${hit.kind}:${hit.docId}`,
            icon: Search,
            label: hit.title || hit.docId,
            hint: hit.excerpt || "Full-text match",
            run: () => {
              if (hit.kind === "text") openText(hit.docId);
              // Project hits come from either the title (empty excerpt) or
              // the brief body (excerpt): the latter belong in the brief view.
              else if (hit.kind === "project")
                hit.excerpt ? openBrief(hit.docId) : openProject(hit.docId);
              else openDiscussion(hit.docId);
            },
          });
        }
      }
    }
    return filtered;
  }, [
    projects,
    texts,
    threads,
    query,
    hits,
    createText,
    createProject,
    createThread,
    setView,
    openProject,
    openBrief,
    openText,
    openDiscussion,
    toggleFocusMode,
  ]);

  // ONE active-result model: the index is clamped whenever the list
  // changes, so a late search result can never leave it pointing past the
  // end or silently at a different row.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items]);

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return;
    // F10: a full-text hit belongs to the query that produced it; an
    // activation after the query changed is ignored (the hit is stale).
    if (item.id.startsWith("search:") && hits.query !== query.trim()) return;
    item.run();
    onOpenChange(false);
  };

  // Keep the active row visible.
  useEffect(() => {
    if (items.length === 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, items.length]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label="Command palette"
        finalFocus={() => returnFocusRef.current}
        className="top-[12vh] max-w-xl translate-y-0 gap-0 rounded-lg bg-surface p-0 sm:max-w-xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // F10: the previous query's full-text hits are no longer
              // activatable; clear them synchronously (the new query's
              // search is still debounced).
              setHits({ query: "", results: [] });
              setActive(0);
            }}
            onKeyDown={(e) => {
              // IME-safe: an Enter that belongs to an active composition
              // must not activate a result.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) =>
                  Math.min(a + 1, Math.max(0, items.length - 1)),
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                activate(items[active]);
              }
            }}
            placeholder="Search documents, conversations, and actions…"
            aria-label="Search commands and documents"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            aria-activedescendant={
              items[active] ? optionId(items[active].id, active) : undefined
            }
            aria-autocomplete="list"
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>
        <ul
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {items.length === 0 && (
            <li
              role="presentation"
              className="px-4 py-6 text-center text-sm text-text-muted"
            >
              Nothing matches “{query}”.
            </li>
          )}
          {items.map((item, i) => (
            <li
              key={item.id}
              id={optionId(item.id, i)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => activate(item)}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-sm transition-colors",
                i === active
                  ? "bg-selection text-text-primary"
                  : "text-text-secondary hover:bg-surface-alt",
              )}
            >
              <item.icon className="size-4 shrink-0 text-text-muted" />
              <span className="truncate flex-1">{item.label}</span>
              {item.hint && (
                <span className="max-w-[40%] shrink-0 truncate font-mono text-[10px] text-text-muted">
                  {item.hint}
                </span>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
