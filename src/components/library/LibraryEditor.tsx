import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { textTypeLabel, type TextTypeId } from "@/types";
import { wordCount } from "@/utils/tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Save } from "lucide-react";

const TEXT_TYPE_IDS: TextTypeId[] = [
  "essay",
  "article",
  "research-paper",
  "letter",
  "talk",
  "other",
];

export default function LibraryEditor({
  id,
  initial,
  onDone,
  onBack,
}: {
  /** Existing text id, or null when creating a new text. */
  id: string | null;
  /** Prefill for a new text (e.g. pasted from the clipboard). */
  initial?: { title?: string; folder?: string; content?: string };
  onDone: (id: string) => void;
  onBack: () => void;
}) {
  const texts = useLibraryStore((s) => s.texts);
  const createText = useLibraryStore((s) => s.createText);
  const updateText = useLibraryStore((s) => s.updateText);

  const existing = id ? (texts.find((t) => t.id === id) ?? null) : null;

  const [title, setTitle] = useState(
    existing?.title ?? initial?.title ?? "",
  );
  const [textType, setTextType] = useState<TextTypeId>(
    existing?.textType ?? "other",
  );
  const [folder, setFolder] = useState(
    existing?.folder ?? initial?.folder ?? "",
  );
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load existing content once per text id.
  useEffect(() => {
    if (!id) {
      setContent(initial?.content ?? "");
      return;
    }
    let cancelled = false;
    void useLibraryStore.getState().loadTextContent(id).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
    // initial content only matters for new texts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const folders = [
    ...new Set(
      texts.map((t) => t.folder).filter((f): f is string => !!f),
    ),
  ].sort();

  const handleSave = async () => {
    if (content == null || saving) return;
    setSaving(true);
    if (id) {
      await updateText(id, {
        title: title.trim() || "Untitled text",
        textType,
        folder: folder.trim(),
        content,
      });
      setSaving(false);
      onDone(id);
    } else {
      const newId = await createText({
        title: title.trim() || "Untitled text",
        textType,
        folder: folder.trim() || undefined,
        content,
      });
      setSaving(false);
      onDone(newId);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back without saving" aria-label="Back without saving">
          <ArrowLeft className="size-4 text-text-secondary" />
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/80 text-primary-foreground"
          onClick={() => void handleSave()}
          disabled={content == null || saving}
        >
          <Save className="size-4 mr-1" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[768px] mx-auto px-6 py-6 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Text title…"
              className="bg-field"
              aria-label="Text title"
            />
          </div>
          <div className="flex gap-4">
            <div className="space-y-1.5 flex-1">
              <Label className="text-text-secondary text-xs">Type</Label>
              <Select
                value={textType}
                onValueChange={(v) => setTextType((v ?? "other") as TextTypeId)}
              >
                <SelectTrigger className="w-full bg-field h-9">
                  <SelectValue>{textTypeLabel(textType)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TEXT_TYPE_IDS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {textTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 flex-1">
              <Label className="text-text-secondary text-xs">Folder (optional)</Label>
              <Input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="e.g. Book project"
                list="library-editor-folders"
                className="bg-field"
              />
              <datalist id="library-editor-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-text-secondary text-xs">Content</Label>
              {content != null && (
                <span className="text-[11px] text-text-muted select-none">
                  {wordCount(content)} words
                </span>
              )}
            </div>
            <Textarea
              value={content ?? ""}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste or write your text here… Markdown is supported."
              rows={16}
              className="min-h-[320px] bg-field border-border resize-y [font-family:var(--font-doc)] text-[15px] leading-relaxed"
              aria-label="Text content"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
