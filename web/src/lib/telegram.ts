/* Тонкая обёртка над Telegram WebApp SDK: работает и вне Telegram (в обычном браузере). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const tg: any = (window as any).Telegram?.WebApp;

export const isTelegram = Boolean(tg?.initData);
export const initData: string = tg?.initData ?? "";

export function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor?.("#0b0b10");
    tg.setBackgroundColor?.("#0b0b10");
    tg.setBottomBarColor?.("#0b0b10");
    tg.disableVerticalSwipes?.(); // чтобы свайп вниз в плеере не закрывал приложение
  } catch {
    /* старые клиенты Telegram */
  }
}

type Impact = "light" | "medium" | "heavy" | "rigid" | "soft";
export const haptic = {
  impact(style: Impact = "light") {
    tg?.HapticFeedback?.impactOccurred(style);
  },
  success() {
    tg?.HapticFeedback?.notificationOccurred("success");
  },
  error() {
    tg?.HapticFeedback?.notificationOccurred("error");
  },
  select() {
    tg?.HapticFeedback?.selectionChanged();
  },
};

/** Стек обработчиков кнопки «Назад»: срабатывает верхний (шторка → плеер → страница) */
const backStack: (() => void)[] = [];
let backBound = false;
function syncBack() {
  if (!tg?.BackButton) return;
  if (!backBound) {
    tg.BackButton.onClick(() => backStack[backStack.length - 1]?.());
    backBound = true;
  }
  if (backStack.length) tg.BackButton.show();
  else tg.BackButton.hide();
}

export const backButton = {
  show(handler: () => void) {
    backStack.push(handler);
    syncBack();
    return () => {
      const i = backStack.lastIndexOf(handler);
      if (i >= 0) backStack.splice(i, 1);
      syncBack();
    };
  },
};

export function openLink(url: string) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) tg.showConfirm(message, (ok: boolean) => resolve(ok));
    else resolve(window.confirm(message));
  });
}

export function telegramUserName(): string | null {
  return tg?.initDataUnsafe?.user?.first_name ?? null;
}
