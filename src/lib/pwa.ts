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

/** Versão nova do app já instalada pelo service worker, esperando a página recarregar. */
let updateReady = false;
/** App instalado costuma ficar dias aberto em segundo plano: procura versão nova ao voltar para ele. */
const UPDATE_CHECK_MS = 30 * 60 * 1000;

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  // Na primeira visita não há versão antiga: a troca de controlador só é "atualização" se já havia um.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || updateReady) return;
    updateReady = true;
    notify();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        let lastCheck = Date.now();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible" || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
          lastCheck = Date.now();
          reg.update().catch(() => undefined);
        });
      })
      .catch((e) => console.warn("Service worker não registrado:", e));
  });
}

/** `true` quando há uma versão nova pronta: basta recarregar a página. */
export function useUpdateReady(): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return updateReady;
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
