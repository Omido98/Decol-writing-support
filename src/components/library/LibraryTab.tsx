import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import LibraryList from "@/components/library/LibraryList";
import LibraryReader from "@/components/library/LibraryReader";
import LibraryEditor from "@/components/library/LibraryEditor";

type View =
  | { kind: "list" }
  | { kind: "read"; id: string }
  | { kind: "edit"; id: string | null; prefill?: { content: string } };

export default function LibraryTab() {
  const textsLoaded = useLibraryStore((s) => s.textsLoaded);
  const loadTexts = useLibraryStore((s) => s.loadTexts);
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    if (!textsLoaded) void loadTexts();
  }, [textsLoaded, loadTexts]);

  if (!textsLoaded) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <p className="text-text-muted">Loading library…</p>
      </div>
    );
  }

  switch (view.kind) {
    case "read":
      return (
        <LibraryReader
          id={view.id}
          onBack={() => setView({ kind: "list" })}
          onEdit={(id) => setView({ kind: "edit", id, prefill: undefined })}
        />
      );
    case "edit":
      return (
        <LibraryEditor
          id={view.id}
          initial={view.prefill}
          onBack={() =>
            view.id
              ? setView({ kind: "read", id: view.id })
              : setView({ kind: "list" })
          }
          onDone={(id) => setView({ kind: "read", id })}
        />
      );
    case "list":
    default:
      return (
        <LibraryList
          onOpen={(id) => setView({ kind: "read", id })}
          onNew={(prefill) =>
            setView({ kind: "edit", id: null, prefill })
          }
        />
      );
  }
}
