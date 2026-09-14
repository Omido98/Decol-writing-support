import {
  audienceLabel,
  citationLabel,
  lengthLabel,
  textTypeLabel,
  toneLabel,
  type WritingBrief,
} from "@/types";

/**
 * A fresh brief with default field values. New threads are seeded from
 * the last submitted brief in the config, not here.
 */
export function defaultBrief(): WritingBrief {
  return {
    topic: "",
    background: "",
    textType: "essay",
    audience: "general-public",
    audienceOther: "",
    tone: "formal",
    toneOther: "",
    citations: "resource-list",
    citationsOther: "",
    length: "undecided",
    language: "English",
    mustInclude: "",
    mustAvoid: "",
  };
}

/**
 * The brief as resolved [label, value] pairs: human-readable labels for
 * the fixed options, the free-text values for "other", and empty
 * optional fields omitted. The single place that decides how a brief is
 * presented; both the first chat message and the system-prompt section
 * render from it.
 */
export function briefEntries(brief: WritingBrief): [string, string][] {
  const entries: [string, string][] = [];
  const add = (label: string, value: string) => {
    if (value.trim()) entries.push([label, value.trim()]);
  };
  add("Topic", brief.topic);
  add("Background", brief.background);
  add("Type of text", textTypeLabel(brief.textType));
  add(
    "Audience",
    brief.audience === "other" ? brief.audienceOther ?? "" : audienceLabel(brief.audience),
  );
  add("Tone", brief.tone === "other" ? brief.toneOther ?? "" : toneLabel(brief.tone));
  add(
    "Citations",
    brief.citations === "other"
      ? brief.citationsOther ?? ""
      : citationLabel(brief.citations),
  );
  add("Length", lengthLabel(brief.length));
  add("Language", brief.language);
  add("Must include", brief.mustInclude);
  add("Must avoid", brief.mustAvoid);
  return entries;
}

/**
 * Compose the structured first message of a thread from the Writing
 * Brief: labeled answers the chat agent treats as settled. This is the
 * message shown in the conversation when the user presses
 * "Start discussion".
 */
export function composeBriefMessage(brief: WritingBrief): string {
  return [
    "Writing Brief:",
    ...briefEntries(brief).map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
}
