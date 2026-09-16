import { vi } from "vitest";

/**
 * Tests run in plain node. Act as if the app runs inside Tauri so the
 * storage layer exercises its native path against the mocked plugin-fs.
 * Individual test files may delete this flag to test the browser fallback.
 */
vi.stubGlobal("__TAURI_INTERNALS__", {});

/**
 * Global localStorage stub (individual files may re-stub with their own
 * backing store — stubGlobal replaces this one).
 */
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    for (const key of Object.keys(storage)) delete storage[key];
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() {
    return Object.keys(storage).length;
  },
});

// jsdom does not implement scrollIntoView (used by the chat auto-scroll).
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no layout engine; ProseMirror's scroll-to-selection asks nodes
// and ranges for client rects. Empty stubs keep the view code happy.
const emptyRects = () => [] as unknown as DOMRectList;
const zeroRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as unknown as DOMRect;
if (typeof Element !== "undefined") {
  Element.prototype.getClientRects = emptyRects;
  Element.prototype.getBoundingClientRect = zeroRect;
}
if (typeof Text !== "undefined") {
  const textProto = Text.prototype as unknown as {
    getClientRects: () => DOMRectList;
    getBoundingClientRect: () => DOMRect;
  };
  textProto.getClientRects = emptyRects;
  textProto.getBoundingClientRect = zeroRect;
}
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = emptyRects;
  Range.prototype.getBoundingClientRect = zeroRect;
}
