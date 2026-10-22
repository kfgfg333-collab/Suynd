import { AnimatePresence, motion } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { backButton } from "../lib/telegram";

/** Нижняя шторка: закрывается свайпом вниз, тапом по фону и кнопкой «Назад» Telegram */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    return backButton.show(onClose);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]">
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-surface pb-[max(16px,env(safe-area-inset-bottom))] no-scrollbar"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 100 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="sticky top-0 z-10 flex justify-center bg-surface pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-white/20" />
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function SheetItem({ icon, label, onClick, danger, hint }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; hint?: string }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-4 px-5 py-3.5 text-left active:bg-white/5 ${danger ? "text-red-400" : ""}`}>
      <span className={`flex h-5 w-5 items-center justify-center ${danger ? "" : "text-white/70"}`}>{icon}</span>
      <span className="flex-1 text-[15px] font-medium">{label}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </button>
  );
}
