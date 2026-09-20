import { useState } from "react";
import type { WritingBrief } from "@/types";
import {
  AUDIENCES,
  CITATION_STYLES,
  LENGTHS,
  TEXT_TYPES,
  TONES,
} from "@/types";
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
import { ChevronDown, ChevronRight } from "lucide-react";

interface BriefFormProps {
  /** The brief being edited (controlled). */
  brief: WritingBrief;
  /** Called on every field change. */
  onChange: (brief: WritingBrief) => void;
  /** Called when the footer button is pressed. */
  onSubmit: () => void;
  /** Label of the footer button. */
  submitLabel: string;
  /** Disables the form and shows the button as busy. */
  busy?: boolean;
}

/** Dropdown for a fixed option set (an "other" textbox is rendered by the parent). */
function BriefSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-text-secondary text-xs">
        {label}
      </Label>
      <Select
        value={value}
        onValueChange={(v) => onChange((v ?? options[0].id) as T)}
      >
        <SelectTrigger
          id={id}
          className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9"
        >
          <SelectValue>
            {options.find((o) => o.id === value)?.label ?? options[0].label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The structured Writing Brief: the answers that start a chat thread (or
 * that can be edited mid-thread). Renders as a compact form; the footer
 * button ("Start discussion" / "Save brief") is owned by the parent via
 * `onSubmit` + `submitLabel`.
 */
export default function BriefForm({
  brief,
  onChange,
  onSubmit,
  submitLabel,
  busy = false,
}: BriefFormProps) {
  const set = <K extends keyof WritingBrief>(key: K, value: WritingBrief[K]) =>
    onChange({ ...brief, [key]: value });

  const canSubmit = brief.topic.trim().length > 0 && !busy;

  // Progressive disclosure: Topic (and the submit) are always visible;
  // the detailed questions collapse until the user opens them.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails =
    brief.background.trim() !== "" ||
    brief.mustInclude.trim() !== "" ||
    brief.mustAvoid.trim() !== "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <Label htmlFor="brief-topic" className="text-text-secondary text-xs">
          Topic
        </Label>
        <Input
          id="brief-topic"
          value={brief.topic}
          onChange={(e) => set("topic", e.target.value)}
          placeholder="What is the text about?"
          className="bg-field border-border"
          disabled={busy}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setDetailsOpen((o) => !o)}
          aria-expanded={detailsOpen}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors select-none py-1"
        >
          {detailsOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          {detailsOpen ? "Fewer details" : "More details"}
          {hasDetails && !detailsOpen && (
            <span className="text-text-muted">(some are filled in)</span>
          )}
        </button>

        {detailsOpen && (
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label
                htmlFor="brief-background"
                className="text-text-secondary text-xs"
              >
                Background (optional)
              </Label>
              <Textarea
                id="brief-background"
                value={brief.background}
                onChange={(e) => set("background", e.target.value)}
                placeholder="Context, occasion, or material the text should build on…"
                rows={3}
                className="bg-field border-border resize-y"
                disabled={busy}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <BriefSelect
                id="brief-text-type"
                label="Type of text"
                value={brief.textType}
                options={TEXT_TYPES}
                onChange={(v) => set("textType", v)}
              />

              <BriefSelect
                id="brief-length"
                label="Length"
                value={brief.length}
                options={LENGTHS}
                onChange={(v) => set("length", v)}
              />
              {brief.length === "other" && (
                <Input
                  value={brief.lengthOther ?? ""}
                  onChange={(e) => set("lengthOther", e.target.value)}
                  placeholder="Describe the length (e.g. under 500 words, 1000-2000, 3000 ±10%)…"
                  className="bg-field border-border self-end"
                  disabled={busy}
                  aria-label="Custom length"
                />
              )}

              <BriefSelect
                id="brief-audience"
                label="Audience"
                value={brief.audience}
                options={AUDIENCES}
                onChange={(v) => set("audience", v)}
              />
              {brief.audience === "other" && (
                <Input
                  value={brief.audienceOther ?? ""}
                  onChange={(e) => set("audienceOther", e.target.value)}
                  placeholder="Describe the audience…"
                  className="bg-field border-border self-end"
                  disabled={busy}
                  aria-label="Custom audience"
                />
              )}

              <BriefSelect
                id="brief-tone"
                label="Tone"
                value={brief.tone}
                options={TONES}
                onChange={(v) => set("tone", v)}
              />
              {brief.tone === "other" && (
                <Input
                  value={brief.toneOther ?? ""}
                  onChange={(e) => set("toneOther", e.target.value)}
                  placeholder="Describe the tone…"
                  className="bg-field border-border self-end"
                  disabled={busy}
                  aria-label="Custom tone"
                />
              )}

              <BriefSelect
                id="brief-citations"
                label="Citations"
                value={brief.citations}
                options={CITATION_STYLES}
                onChange={(v) => set("citations", v)}
              />
              {brief.citations === "other" && (
                <Input
                  value={brief.citationsOther ?? ""}
                  onChange={(e) => set("citationsOther", e.target.value)}
                  placeholder="Describe the citation style…"
                  className="bg-field border-border self-end"
                  disabled={busy}
                  aria-label="Custom citation style"
                />
              )}

              <div className="space-y-1.5">
                <Label
                  htmlFor="brief-language"
                  className="text-text-secondary text-xs"
                >
                  Language
                </Label>
                <Input
                  id="brief-language"
                  value={brief.language}
                  onChange={(e) => set("language", e.target.value)}
                  placeholder="English"
                  className="bg-field border-border"
                  disabled={busy}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="brief-must-include"
                className="text-text-secondary text-xs"
              >
                Must include (optional)
              </Label>
              <Textarea
                id="brief-must-include"
                value={brief.mustInclude}
                onChange={(e) => set("mustInclude", e.target.value)}
                placeholder="Points, sources, or angles the text must include…"
                rows={2}
                className="bg-field border-border resize-y"
                disabled={busy}
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="brief-must-avoid"
                className="text-text-secondary text-xs"
              >
                Must avoid (optional)
              </Label>
              <Textarea
                id="brief-must-avoid"
                value={brief.mustAvoid}
                onChange={(e) => set("mustAvoid", e.target.value)}
                placeholder="Words, framings, or sources the text must avoid…"
                rows={2}
                className="bg-field border-border resize-y"
                disabled={busy}
              />
            </div>
          </div>
        )}
      </div>

      <Button
        type="submit"
        disabled={!canSubmit}
        className="w-full bg-primary hover:bg-primary/80 text-primary-foreground"
      >
        {submitLabel}
      </Button>
    </form>
  );
}
