import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { applyAccent, extractAccent } from "../lib/color";
import { mediaUrl } from "../lib/api";
import { useCurrentTrack } from "../store/player";
import { useToast } from "../store/toast";
import { useUi } from "../store/ui";
import { Button } from "./ui";

export function Toasts() {
  const toasts = useToast((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(12px,env(safe-area-inset-top))] z-[80] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.95 }}
            className={`max-w-sm rounded-2xl px-4 py-2.5 text-sm font-semibold shadow-xl backdrop-blur-xl ${
              t.kind === "error" ? "bg-red-500/90 text-white" : t.kind === "success" ? "bg-white/95 text-black" : "bg-surface-2/95 text-white"
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function PromptModal() {
  const prompt = useUi((s) => s.prompt);
  const close = useUi((s) => s.closePrompt);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prompt) {
      setValue(prompt.value);
      setTimeout(() => input.current?.focus(), 150);
    }
  }, [prompt]);

  return (
    <AnimatePresence>
      {prompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
          <motion.div className="absolute inset-0 bg-black/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => close(null)} />
          <motion.form
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            onSubmit={(e) => {
              e.preventDefault();
              close(value.trim() || null);
            }}
            className="relative w-full max-w-sm rounded-3xl bg-surface p-5"
          >
            <h3 className="mb-3 font-display text-lg font-bold">{prompt.title}</h3>
            <input
              ref={input}
              value={value}
              maxLength={80}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Название"
              className="w-full rounded-xl bg-surface-2 px-4 py-3 outline-none ring-accent focus:ring-2"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => close(null)}>
                Отмена
              </Button>
              <button type="submit" className="rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-black">
                Сохранить
              </button>
            </div>
          </motion.form>
        </div>
      )}
    </AnimatePresence>
  );
}

/** Акцентный цвет интерфейса = цвет обложки текущего трека */
export function AccentSync() {
  const track = useCurrentTrack();
  useEffect(() => {
    let cancelled = false;
    extractAccent(mediaUrl(track?.cover)).then((rgb) => !cancelled && applyAccent(rgb));
    return () => {
      cancelled = true;
    };
  }, [track?.cover]);
  return null;
}
