// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ErrorBoundary from "@/components/ErrorBoundary";

function Bomb(): never {
  throw new Error("render exploded");
}

afterEach(() => {
  cleanup();
});

describe("ErrorBoundary", () => {
  it("shows a recoverable fallback instead of unmounting the app", () => {
    // React reports the caught error through console.error as well.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("render exploded");
      expect(screen.getByRole("button", { name: /reload/i })).toBeDefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders its children untouched while nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy content")).toBeDefined();
  });
});
