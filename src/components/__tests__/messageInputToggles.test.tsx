// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import MessageInput from "@/components/chat/MessageInput";

afterEach(() => cleanup());

describe("agent toggle pills in the composer", () => {
  it("reflects the flags and forwards toggles", () => {
    const onToggleWebSearch = vi.fn();
    const onToggleDeepResearch = vi.fn();
    render(
      <MessageInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        webSearchEnabled={false}
        deepResearchEnabled={true}
        onToggleWebSearch={onToggleWebSearch}
        onToggleDeepResearch={onToggleDeepResearch}
      />,
    );

    const web = screen.getByRole("button", { name: /web search/i });
    const deep = screen.getByRole("button", { name: /deep research/i });
    expect(web.getAttribute("aria-pressed")).toBe("false");
    expect(deep.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(web);
    fireEvent.click(deep);
    expect(onToggleWebSearch).toHaveBeenCalledTimes(1);
    expect(onToggleDeepResearch).toHaveBeenCalledTimes(1);
  });

  it("omits the pills when no toggle handlers are provided", () => {
    render(<MessageInput value="" onChange={() => {}} onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: /web search/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /deep research/i })).toBeNull();
  });
});
