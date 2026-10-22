import { create } from "zustand";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

interface ToastState {
  toasts: Toast[];
  show: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  show(text, kind = "info") {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-2), { id, text, kind }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 4000 : 2400);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = (text: string, kind?: Toast["kind"]) => useToast.getState().show(text, kind);
