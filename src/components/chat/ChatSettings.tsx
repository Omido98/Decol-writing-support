import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getStandardPrompt } from "@/utils/systemPrompt";

interface ChatSettingsProps {
  onDone?: () => void;
  /** Opens the general Settings dialog (where the API is configured). */
  onOpenSettings?: () => void;
}

export default function ChatSettings({
  onDone,
  onOpenSettings,
}: ChatSettingsProps) {
  const config = useChatStore((s) => s.config);
  const setConfig = useChatStore((s) => s.setConfig);

  const [promptMode, setPromptMode] = useState(
    config.systemPromptMode ?? "standard",
  );
  const [customPrompt, setCustomPrompt] = useState(
    config.customSystemPrompt ?? "",
  );

  const standardPrompt = useMemo(() => getStandardPrompt(), []);

  useEffect(() => {
    setPromptMode(config.systemPromptMode ?? "standard");
    setCustomPrompt(config.customSystemPrompt ?? "");
  }, [config.systemPromptMode, config.customSystemPrompt]);

  const handleSave = async () => {
    await setConfig({
      systemPromptMode: promptMode,
      customSystemPrompt: customPrompt,
    });
    onDone?.();
  };

  return (
    <div className="space-y-4">
      {onOpenSettings && (
        <p className="text-xs text-text-muted">
          Your AI provider, API key and model are configured in{" "}
          <button
            onClick={onOpenSettings}
            className="text-primary hover:text-primary/80 select-none"
          >
            Settings
          </button>
          . The options below only apply to the chat agent.
        </p>
      )}
      <p className="text-xs text-text-muted">
        Web search and deep research are toggled in the conversation itself —
        the pills above the message box apply to the next sends.
      </p>
      {/* Chat Agent Prompt */}
      <div className="space-y-1.5">
        <Label className="text-text-secondary text-xs">
          Chat Agent Prompt
        </Label>
        <Select
          value={promptMode}
          onValueChange={(v) =>
            setPromptMode((v ?? "standard") as "standard" | "custom")
          }
        >
          <SelectTrigger className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9">
            <SelectValue>
              {(v) => (v === "custom" ? "Custom prompt" : "Standard prompt")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">Standard prompt</SelectItem>
            <SelectItem value="custom">Custom prompt</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-text-muted">
          The standard prompt is the built-in instructions for the chat agent
          (shown below, read-only). A custom prompt replaces the built-in
          instructions entirely.
        </p>

        <Label className="text-text-secondary text-xs">
          Standard prompt (read-only)
        </Label>
        <Textarea
          readOnly
          value={standardPrompt}
          rows={8}
          className="text-xs leading-relaxed bg-field border-border text-text-muted resize-y"
        />

        <Label className="text-text-secondary text-xs">Custom prompt</Label>
        <Textarea
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Write your own instructions for the chat agent…"
          rows={6}
          className="text-xs leading-relaxed bg-field border-border resize-y"
        />
      </div>

      <div className="flex gap-2">
        {/* Back discards: closing unmounts this form, and reopening reads
            the saved config again — unsaved edits never leak. */}
        <Button
          variant="outline"
          onClick={() => onDone?.()}
          className="flex-1"
        >
          Back
        </Button>
        <Button
          onClick={handleSave}
          className="flex-1 bg-primary hover:bg-primary/80 text-primary-foreground"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
