import { create } from "zustand";

export type TabId = "chat";

interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: "chat",
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
