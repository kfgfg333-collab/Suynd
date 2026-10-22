import { create } from "zustand";
import { api, enc } from "../lib/api";
import { listOffline, removeOffline, saveOffline } from "../lib/offline";
import { haptic } from "../lib/telegram";
import type { Artist, Subscription, Track } from "../lib/types";
import { toast } from "./toast";

interface LibraryState {
  liked: Set<string>;
  subscriptions: Map<string, Subscription>;
  offline: Set<string>;
  downloading: Map<string, number>; // id → прогресс 0..1
  version: number; // меняется после изменений коллекции — страницы перезагружают данные
  loadInitial: () => Promise<void>;
  toggleLike: (t: Track) => Promise<void>;
  toggleSubscription: (a: Artist) => Promise<void>;
  download: (t: Track) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  refreshOffline: () => Promise<void>;
  sendToChat: (t: Track) => Promise<void>;
  bump: () => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  liked: new Set(),
  subscriptions: new Map(),
  offline: new Set(),
  downloading: new Map(),
  version: 0,

  async loadInitial() {
    const [fav, subs] = await Promise.all([
      api<{ ids: string[] }>("/api/favorites/ids").catch(() => ({ ids: [] })),
      api<{ items: Subscription[] }>("/api/subscriptions").catch(() => ({ items: [] })),
    ]);
    set({ liked: new Set(fav.ids), subscriptions: new Map(subs.items.map((s) => [s.artistKey, s])) });
    await get().refreshOffline();
  },

  async toggleLike(t) {
    const liked = new Set(get().liked);
    const wasLiked = liked.has(t.id);
    wasLiked ? liked.delete(t.id) : liked.add(t.id);
    set({ liked });
    haptic.impact(wasLiked ? "light" : "medium");
    try {
      if (wasLiked) await api(`/api/favorites/${enc(t.id)}`, { method: "DELETE" });
      else await api(`/api/favorites/${enc(t.id)}`, { method: "PUT", body: { track: t } });
      get().bump();
    } catch (e) {
      const back = new Set(get().liked);
      wasLiked ? back.add(t.id) : back.delete(t.id);
      set({ liked: back });
      toast((e as Error).message, "error");
    }
  },

  async toggleSubscription(a) {
    const subs = new Map(get().subscriptions);
    const was = subs.has(a.id);
    try {
      if (was) {
        subs.delete(a.id);
        set({ subscriptions: subs });
        await api(`/api/subscriptions/${enc(a.id)}`, { method: "DELETE" });
        toast(`Вы отписались от ${a.name}`);
      } else {
        subs.set(a.id, { artistKey: a.id, source: a.source, name: a.name, picture: a.picture, createdAt: Date.now() });
        set({ subscriptions: subs });
        haptic.success();
        await api("/api/subscriptions", { method: "POST", body: { artistId: a.id, name: a.name, picture: a.picture } });
        toast(`Следим за новинками ${a.name} 🔔`, "success");
      }
      get().bump();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  async download(t) {
    if (get().downloading.has(t.id) || get().offline.has(t.id)) return;
    const setProgress = (p: number) => set({ downloading: new Map(get().downloading).set(t.id, p) });
    setProgress(0);
    haptic.impact("light");
    try {
      await saveOffline(t, setProgress);
      const offline = new Set(get().offline).add(t.id);
      set({ offline });
      haptic.success();
      toast("Сохранено для офлайна", "success");
    } catch (e) {
      haptic.error();
      toast((e as Error).message || "Не удалось скачать", "error");
    } finally {
      const d = new Map(get().downloading);
      d.delete(t.id);
      set({ downloading: d });
    }
  },

  async removeDownload(id) {
    await removeOffline(id);
    const offline = new Set(get().offline);
    offline.delete(id);
    set({ offline });
  },

  async refreshOffline() {
    const list = await listOffline();
    set({ offline: new Set(list.map((e) => e.id)) });
  },

  async sendToChat(t) {
    toast("Отправляю файл в чат…");
    try {
      await api(`/api/send/${enc(t.id)}`, { method: "POST" });
      haptic.success();
      toast("Файл отправлен в чат с ботом", "success");
    } catch (e) {
      haptic.error();
      toast((e as Error).message, "error");
    }
  },

  bump() {
    set({ version: get().version + 1 });
  },
}));
