import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useAppStore } from "@/stores/useAppStore";
import {
  useSettingsStore,
  getAccentForeground,
} from "@/stores/settingsStore";
import { flushChatSave } from "@/stores/chatStore";
import { flushLibrarySave } from "@/stores/libraryStore";
import LibraryTab from "@/components/library/LibraryTab";
import ChatTab from "@/components/tabs/ChatTab";
import SettingsDialog from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";

type TabId = "library" | "chat";

const tabs: { id: TabId; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "chat", label: "Writing Support" },
];

function flushPendingSaves() {
  void flushChatSave();
  void flushLibrarySave();
}

function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const settingsLoaded = useSettingsStore((s) => s.isLoaded);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);

  const [showSettings, setShowSettings] = useState(false);

  // Load persisted settings on mount
  useEffect(() => {
    if (!settingsLoaded) loadSettings();
  }, [settingsLoaded, loadSettings]);

  // Flush debounced saves when the window closes, so the last edit is never lost
  useEffect(() => {
    window.addEventListener("beforeunload", flushPendingSaves);

    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const win = getCurrentWindow();
          unlisten = await win.onCloseRequested(async (event) => {
            event.preventDefault();
            await Promise.all([flushChatSave(), flushLibrarySave()]);
          try {
            await win.destroy();
          } catch {
            // destroy can fail (e.g. denied permission); never strand the user
            await exit(0);
          }
        });
      } catch {
        // Not running inside Tauri (e.g. browser dev) — beforeunload covers it.
      }
    })();

    return () => {
      window.removeEventListener("beforeunload", flushPendingSaves);
      unlisten?.();
    };
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  // Apply accent colour (+ readable foreground)
  useEffect(() => {
    const root = document.documentElement;
    const fg = getAccentForeground(accent);
    root.style.setProperty("--primary", accent);
    root.style.setProperty("--primary-foreground", fg);
    root.style.setProperty("--ring", accent);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-foreground", fg);
    root.style.setProperty("--chart-1", accent);
    root.style.setProperty("--sidebar-primary", accent);
    root.style.setProperty("--sidebar-primary-foreground", fg);
    root.style.setProperty("--sidebar-ring", accent);
  }, [accent]);

  const renderTab = () => {
    switch (activeTab as TabId) {
      case "library":
        return <LibraryTab />;
      case "chat":
        return <ChatTab onOpenSettings={() => setShowSettings(true)} />;
      default:
        return null;
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === activeTab);
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    setActiveTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  // Keep the app blank until settings are loaded, so the theme is applied
  // before any content paints (prevents a light/dark flash on cold start).
  if (!settingsLoaded) {
    return <div className="h-screen w-screen bg-background" />;
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-background overflow-hidden">
      {/* Tab Bar */}
      <header className="relative flex items-center justify-center px-6 py-4 border-b border-border">
        <nav className="flex gap-2" role="tablist" onKeyDown={handleTabKeyDown}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="tabpanel-main"
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-6 py-2 rounded-full text-sm font-medium transition-colors duration-200 select-none
                ${
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-text-secondary hover:bg-border hover:text-text-primary"
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Settings */}
        <div className="absolute right-6">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="size-4 text-text-secondary" />
          </Button>
        </div>
      </header>

      {/* Content Area */}
      <main className="flex-1 overflow-auto" role="tabpanel" id="tabpanel-main">
        {renderTab()}
      </main>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </div>
  );
}

export default App;
