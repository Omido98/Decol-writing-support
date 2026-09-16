// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@/utils/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/api")>();
  return { ...actual, sendMessage: vi.fn() };
});

import { sendMessage } from "@/utils/api";
import EvalReportView from "@/components/settings/EvalReportView";
import { useChatStore } from "@/stores/chatStore";

const sendMessageMock = sendMessage as Mock;

beforeEach(() => {
  sendMessageMock.mockReset();
  useChatStore.setState((state) => ({
    config: { ...state.config, apiKey: "test-key", model: "test-model" },
  }));
});

afterEach(() => cleanup());

describe("EvalReportView (B22)", () => {
  it("runs the real evaluation button and reports only scored samples", async () => {
    sendMessageMock.mockResolvedValue({
      content: "Mbembe archive memory",
      outcome: "complete",
    });
    render(<EvalReportView />);

    fireEvent.click(
      screen.getByRole("button", { name: /run ai evaluation/i }),
    );

    await waitFor(
      () => expect(screen.getByText(/tasks passed/)).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.getByText(/6 scored/)).toBeTruthy();
    expect(screen.getByText(/0 not scored/)).toBeTruthy();
  });

  it("a cancelled run cannot report Done and cannot overwrite a newer run", async () => {
    const pending: Array<(response: unknown) => void> = [];
    sendMessageMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    render(<EvalReportView />);

    // Run A — cancelled while its first request is in flight.
    fireEvent.click(
      screen.getByRole("button", { name: /run ai evaluation/i }),
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Run B — completes with unscored (stopped) samples.
    fireEvent.click(
      screen.getByRole("button", { name: /run ai evaluation/i }),
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    for (let i = 0; i < 6; i++) {
      await waitFor(() => expect(pending.length).toBe(2 + i));
      await act(async () => {
        pending[1 + i]({ content: "", outcome: "stopped" });
      });
    }
    await waitFor(
      () => expect(screen.getByText(/6 not scored/)).toBeTruthy(),
      { timeout: 5000 },
    );

    // The cancelled run's first request resolves late: its stale report
    // must be discarded, and it must not schedule any further tasks.
    await act(async () => {
      pending[0]({ content: "late complete sample", outcome: "complete" });
    });
    expect(screen.getByText(/6 not scored/)).toBeTruthy();
    expect(screen.queryByText(/1 scored/)).toBeNull();
    expect(sendMessageMock).toHaveBeenCalledTimes(7);
  });
});
