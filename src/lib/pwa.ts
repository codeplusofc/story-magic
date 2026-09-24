import { useEffect, useState } from "react";

/**
 * App instalável (PWA): registra o service worker (leitura offline) e guarda o convite de
 * instalação do navegador para o botão "Instalar app".
 */

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  // O evento chega cedo, antes do React montar: fica guardado aqui.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Service worker não registrado:", e));
  });
}

/** `install` só existe quando o navegador oferece a instalação (Chrome/Edge/Android). */
export function useInstallPrompt(): { install: (() => Promise<void>) | null } {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (!deferred) return { install: null };
  return {
    install: async () => {
      const e = deferred;
      if (!e) return;
      await e.prompt();
      await e.userChoice.catch(() => undefined);
      deferred = null;
      notify();
    },
  };
}
