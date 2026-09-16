import { create } from "zustand";
import { getPref, setPref } from "@/utils/preferences";
import { loadJson } from "@/utils/storage";

// ──────────────────────────────────────────────
// Settings types
// ──────────────────────────────────────────────

export interface Settings {
  theme: "dark" | "light";
  accent: string;
}

export const DEFAULT_ACCENT = "#34d399";
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: DEFAULT_ACCENT,
};

// ──────────────────────────────────────────────
// Accent helpers
// ──────────────────────────────────────────────

/** Linearize one sRGB channel (WCAG relative luminance pipeline). */
function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a hex colour (0 = black, 1 = white). */
export function getAccentLuminance(hex: string): number {
  const n = hex.replace("#", "");
  if (n.length !== 6) return 0;
  const r = srgbChannel(parseInt(n.slice(0, 2), 16));
  const g = srgbChannel(parseInt(n.slice(2, 4), 16));
  const b = srgbChannel(parseInt(n.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_INK_LUMINANCE = getAccentLuminance("#0d2b22");
const WHITE_LUMINANCE = 1;

/**
 * Text colour (hex) that stays readable on top of the given accent.
 * Picks whichever candidate has the higher measured contrast — the old
 * non-linearized threshold picked unreadable pairs for mid-tone accents.
 */
export function getAccentForeground(hex: string): string {
  const l = getAccentLuminance(hex);
  const onDarkInk = contrastRatio(l, DARK_INK_LUMINANCE);
  const onWhite = contrastRatio(l, WHITE_LUMINANCE);
  return onDarkInk >= onWhite ? "#0d2b22" : "#ffffff";
}

/** WCAG contrast target for text on accent backgrounds. */
const ACCENT_CONTRAST_TARGET = 4.5;

function hexToHsl(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let t2 = t;
    if (t2 < 0) t2 += 1;
    if (t2 > 1) t2 -= 1;
    if (t2 < 1 / 6) return p + (q - p) * 6 * t2;
    if (t2 < 1 / 2) return q;
    if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to255 = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/**
 * An accent/foreground pair that MEETS the contrast target — not merely the
 * better of two failing candidates. The foreground is the fixed candidate
 * with the higher contrast; when even it falls short of 4.5:1 (mid-tone
 * custom accents), the accent's LIGHTNESS is adjusted step by step away
 * from the foreground until the target is met (the hue is never touched).
 */
export function accentWithContrast(
  accent: string,
): { accent: string; foreground: string } {
  const foreground = getAccentForeground(accent);
  const fgLuminance = getAccentLuminance(foreground);
  if (contrastRatio(getAccentLuminance(accent), fgLuminance) >= ACCENT_CONTRAST_TARGET) {
    return { accent, foreground };
  }
  const [h, s, l] = hexToHsl(accent);
  // Move the accent away from the foreground: darken under light text,
  // lighten under dark ink.
  const step = foreground === "#ffffff" ? -0.04 : 0.04;
  for (let i = 1; i <= 20; i++) {
    const candidate = hslToHex(h, s, Math.min(1, Math.max(0, l + step * i)));
    if (contrastRatio(getAccentLuminance(candidate), fgLuminance) >= ACCENT_CONTRAST_TARGET) {
      return { accent: candidate, foreground };
    }
  }
  // Should be unreachable (pure black/white bound at ±0.8 lightness);
  // fall back to the best-effort pair.
  return { accent, foreground };
}

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

interface SettingsState extends Settings {
  isLoaded: boolean;
  /** Non-fatal startup problem; the app still renders with defaults. */
  settingsError: string | null;
  loadSettings: () => Promise<void>;
  setTheme: (theme: "dark" | "light") => void;
  setAccent: (accent: string) => void;
}

/** Read the legacy settings.json file (pre-preferences installs). */
async function loadLegacySettings(): Promise<Settings | null> {
  try {
    return await loadJson<Settings>("settings.json");
  } catch {
    return null;
  }
}

function persist(theme: "dark" | "light", accent: string) {
  void setPref("settings", { theme, accent } as Settings).catch(() => {
    // Preference write failure: surfaced through the retryable preference
    // state in a later batch; the in-memory setting stays.
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  isLoaded: false,
  settingsError: null,

  loadSettings: async () => {
    // Handled startup state: a failed settings read must never leave a
    // permanently blank window — defaults apply and the error surfaces.
    try {
      // Preferences live in the SQLite table (migrated from settings.json on
      // first load); the legacy file remains the fallback for old installs.
      let data = await getPref<Settings>("settings").catch(() => null);
      if (data == null) {
        data = await loadLegacySettings();
        if (data) {
          void setPref("settings", data).catch(() => {});
        }
      }
      if (data) {
        set({
          theme: data.theme === "light" ? "light" : "dark",
          accent: data.accent || DEFAULT_ACCENT,
          isLoaded: true,
          settingsError: null,
        });
      } else {
        set({ ...DEFAULT_SETTINGS, isLoaded: true, settingsError: null });
      }
    } catch (err) {
      set({
        ...DEFAULT_SETTINGS,
        isLoaded: true,
        settingsError: `Settings could not be loaded; defaults are in use. ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  },

  setTheme: (theme) => {
    set({ theme });
    persist(theme, get().accent);
  },

  setAccent: (accent) => {
    set({ accent });
    persist(get().theme, accent);
  },
}));
