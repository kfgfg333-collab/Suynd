import { create } from "zustand";
import type { Track } from "../lib/types";

interface SheetContext {
  playlistId?: number;
  onRemoved?: () => void;
}

interface UiState {
  sheet: { track: Track; ctx: SheetContext } | null;
  openSheet: (track: Track, ctx?: SheetContext) => void;
  closeSheet: () => void;
  prompt: { title: string; value: string; resolve: (v: string | null) => void } | null;
  askText: (title: string, value?: string) => Promise<string | null>;
  closePrompt: (v: string | null) => void;
}

export const useUi = create<UiState>((set, get) => ({
  sheet: null,
  openSheet: (track, ctx = {}) => set({ sheet: { track, ctx } }),
  closeSheet: () => set({ sheet: null }),
  prompt: null,
  askText: (title, value = "") => new Promise((resolve) => set({ prompt: { title, value, resolve } })),
  closePrompt(v) {
    get().prompt?.resolve(v);
    set({ prompt: null });
  },
}));
