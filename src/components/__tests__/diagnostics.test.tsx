// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import DiagnosticsDialog from "@/components/workspace/DiagnosticsDialog";
import { recordMark, clearMarks } from "@/utils/perfLog";

afterEach(() => {
  cleanup();
  clearMarks();
});

describe("DiagnosticsDialog (5.5b)", () => {
  it("shows recent marks with means and clears the buffer", () => {
    recordMark({ kind: "ttft", value: 300, detail: "send-1" });
    recordMark({ kind: "ttft", value: 500, detail: "send-2" });
    recordMark({ kind: "duration", value: 1200, detail: "send-2" });
    recordMark({ kind: "request-size", value: 4200, detail: "send-2" });

    render(<DiagnosticsDialog open onOpenChange={() => {}} />);

    // Aggregates are real means, not estimates.
    expect(screen.getByText(/mean TTFT 400 ms \(2\)/)).toBeTruthy();
    expect(screen.getByText(/mean duration 1200 ms \(1\)/)).toBeTruthy();
    // Rows: newest first (request-size is the latest mark), 5 table rows
    // = header + 4 marks.
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(5);
    expect(rows[1].textContent).toContain("request-size");
    // Locale-agnostic: `toLocaleString` may group as "4 200" (NBSP) or
    // "4,200" depending on the runner locale.
    expect(rows[1].textContent).toMatch(/4[^\d]?200 chars/);
    expect(rows[4].textContent).toContain("ttft");
    expect(screen.getByText("4 marks")).toBeTruthy();

    // Clear empties the ring buffer (and the readout says so).
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText(/No marks yet/)).toBeTruthy();
  });

  it("renders an empty buffer without marks", () => {
    render(<DiagnosticsDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/No marks yet/)).toBeTruthy();
  });
});
