import { describe, it, expect } from "vitest";
import { composeBriefMessage, defaultBrief } from "@/utils/brief";

describe("composeBriefMessage", () => {
  it("composes labeled answers from a full brief", () => {
    const brief = defaultBrief();
    brief.topic = "Land rights in Sápmi";
    brief.background = "For a lecture series";
    brief.textType = "article";
    brief.audience = "students";
    brief.tone = "academic";
    brief.citations = "apa";
    brief.length = "medium";
    brief.mustAvoid = "Colonial framing of Sámi land use";

    const msg = composeBriefMessage(brief);
    expect(msg).toContain("Writing Brief:");
    expect(msg).toContain("Topic: Land rights in Sápmi");
    expect(msg).toContain("Background: For a lecture series");
    expect(msg).toContain("Type of text: Article");
    expect(msg).toContain("Audience: Students");
    expect(msg).toContain("Tone: Academic");
    expect(msg).toContain("Citations: APA");
    expect(msg).toContain("Length: Medium (~500-1500 words)");
    expect(msg).toContain("Language: English");
    expect(msg).toContain("Must avoid: Colonial framing of Sámi land use");
  });

  it("uses the free-text value when a dropdown is set to Other", () => {
    const brief = defaultBrief();
    brief.topic = "Topic";
    brief.audience = "other";
    brief.audienceOther = "Municipal planners";
    brief.citations = "none";

    const msg = composeBriefMessage(brief);
    expect(msg).toContain("Audience: Municipal planners");
    expect(msg).toContain("Citations: No citations");
  });

  it("omits empty optional fields", () => {
    const brief = defaultBrief();
    brief.topic = "Topic";
    brief.background = "  ";
    brief.mustInclude = "";
    brief.mustAvoid = "";

    const msg = composeBriefMessage(brief);
    expect(msg).not.toContain("Background:");
    expect(msg).not.toContain("Must include:");
    expect(msg).not.toContain("Must avoid:");
  });
});
