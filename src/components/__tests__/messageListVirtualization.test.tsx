// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import MessageList from "@/components/chat/MessageList";
import { useChatStore } from "@/stores/chatStore";
import { resetOperations } from "@/services/aiOperations";

// ──────────────────────────────────────────────
// Virtualized message list
// ──────────────────────────────────────────────
// jsdom has no layout, so this file FAKES one: a 400px-tall scroll
// container and 120px-tall rows. Only a window of a 100-message
// conversation may exist in the DOM, and scrolling must bring the tail in.

/** ResizeObserver that reports the observed element immediately. */
class ImmediateResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    // The virtualizer reads the viewport size from contentRect.
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

const rect = (height: number, top = 0): DOMRect =>
  ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 800,
    bottom: top + height,
    width: 800,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

const ROW_HEIGHT = 120;
const VIEWPORT_HEIGHT = 400;
const CONTAINER_CLASS = "overflow-y-auto";
const MESSAGE_COUNT = 100;

/** jsdom reports 0 for every offset dimension; fake the two we need. */
function measureHeight(el: HTMLElement): number {
  if (el.getAttribute("data-index") != null) return ROW_HEIGHT;
  if (el.className.includes(CONTAINER_CLASS)) return VIEWPORT_HEIGHT;
  return 0;
}

function seed(): void {
  resetOperations();
  useChatStore.setState({
    activeThreadId: "th-v",
    threadLoaded: true,
    threadsLoaded: true,
    threads: [
      {
        id: "th-v",
        title: "Long conversation",
        mode: "text",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    messages: Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${i}`,
      timestamp: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    })),
    drafts: {},
    threadAttachments: {},
    threadSourcePicks: {},
    brief: null,
    briefIncludedByThread: {},
    error: null,
    threadErrors: {},
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const index = this.getAttribute("data-index");
      if (index != null) return rect(ROW_HEIGHT, Number(index) * ROW_HEIGHT);
      if (
        this instanceof HTMLElement &&
        this.className.includes(CONTAINER_CLASS)
      ) {
        return rect(VIEWPORT_HEIGHT);
      }
      return rect(0);
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return measureHeight(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.className.includes(CONTAINER_CLASS) ? 800 : 0;
    },
  });
  seed();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
});

describe("MessageList virtualization", () => {
  it("renders only a window of a long conversation", () => {
    render(<MessageList />);

    expect(screen.getByText("message-0")).toBeDefined();
    expect(screen.queryByText(`message-${MESSAGE_COUNT - 1}`)).toBeNull();

    const renderedRows = document.querySelectorAll("[data-index]").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(40);
  });

  it("brings the tail into the DOM when the user scrolls to the bottom", async () => {
    render(<MessageList />);
    expect(screen.queryByText(`message-${MESSAGE_COUNT - 1}`)).toBeNull();

    const container = document.querySelector(
      `.${CONTAINER_CLASS}`,
    ) as HTMLDivElement;
    Object.defineProperty(container, "scrollTop", {
      value: MESSAGE_COUNT * ROW_HEIGHT,
      writable: true,
      configurable: true,
    });
    await act(async () => {
      container.dispatchEvent(new Event("scroll"));
    });

    expect(screen.getByText(`message-${MESSAGE_COUNT - 1}`)).toBeDefined();
    expect(screen.queryByText("message-0")).toBeNull();
  });
});
