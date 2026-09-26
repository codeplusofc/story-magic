/**
 * Lembretes para voltar a ler, sem servidor:
 * - Calendário: um evento diário (Google Agenda ou arquivo .ics para iPhone/Outlook). É o próprio
 *   celular que avisa na hora marcada, em qualquer aparelho.
 * - Notificação no Android: com o app instalado, o Chrome acorda o service worker mais ou menos
 *   uma vez por dia ("periodic background sync") e ele avisa se o leitor ainda não leu hoje. O
 *   horário e a frequência são decididos pelo navegador — é um reforço, não um despertador.
 */

const PREFS_KEY = "storyverse:reminder";
/** Cache lido pelo service worker (ele não enxerga o localStorage). Fora do prefixo "storyverse-"
 * para não ser apagado quando o service worker muda de versão. */
const STATE_CACHE = "sv-state";
const STATE_URL = "/__engagement";
const SYNC_TAG = "storyverse-daily";
const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type ReminderPrefs = { time: string; notifications?: boolean };

export function loadReminderPrefs(): ReminderPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as ReminderPrefs | null;
    if (p && /^\d{2}:\d{2}$/.test(p.time)) return p;
  } catch {
    // Sem armazenamento.
  }
  return { time: "20:00" };
}

export function saveReminderPrefs(p: ReminderPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Sem armazenamento.
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Próxima vez que o horário acontece (hoje, se ainda não passou; senão amanhã), em hora local. */
function nextOccurrence(time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

/** "20260925T200000": hora local sem fuso, o calendário usa o fuso do aparelho. */
const localStamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export type ReminderText = { title: string; details: string; url: string };

export function reminderText(lastBook?: { title: string; chapterLabel?: string; character?: string }): ReminderText {
  const url = window.location.origin;
  const who = lastBook?.character ? `${lastBook.character} está te esperando` : "Sua história está te esperando";
  const where = lastBook ? ` em “${lastBook.title}”${lastBook.chapterLabel ? ` (${lastBook.chapterLabel})` : ""}` : "";
  return {
    title: "📖 Hora de ler no Storyverse",
    details: `${who}${where}. Uns minutinhos hoje mantêm sua sequência 🔥`,
    url,
  };
}

/** Link do Google Agenda com o evento diário já preenchido. */
export function googleCalendarUrl(time: string, text: ReminderText): string {
  const start = nextOccurrence(time);
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: text.title,
    details: `${text.details}\n\n${text.url}`,
    dates: `${localStamp(start)}/${localStamp(end)}`,
    recur: "RRULE:FREQ=DAILY",
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const icsEscape = (t: string) => t.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Arquivo .ics (calendário do iPhone, Outlook…) com evento diário e aviso na hora. */
export function downloadIcs(time: string, text: ReminderText) {
  const start = nextOccurrence(time);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Storyverse//Lembrete de leitura//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:storyverse-leitura-${Date.now()}@storyverse`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${localStamp(start)}`,
    "DURATION:PT15M",
    "RRULE:FREQ=DAILY",
    `SUMMARY:${icsEscape(text.title)}`,
    `DESCRIPTION:${icsEscape(`${text.details}\n\n${text.url}`)}`,
    `URL:${text.url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(text.title)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "lembrete-storyverse.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const CHARACTER_KEY = "storyverse:last-character";

/** Personagem com quem o leitor conversou por último em cada livro (para o texto do lembrete). */
export function rememberCharacter(bookId: string, name: string) {
  try {
    const all = JSON.parse(localStorage.getItem(CHARACTER_KEY) ?? "{}") as Record<string, string>;
    if (all[bookId] === name) return;
    all[bookId] = name;
    localStorage.setItem(CHARACTER_KEY, JSON.stringify(all));
  } catch {
    // Sem armazenamento.
  }
}

export function lastCharacter(bookId: string): string | undefined {
  try {
    return (JSON.parse(localStorage.getItem(CHARACTER_KEY) ?? "{}") as Record<string, string>)[bookId];
  } catch {
    return undefined;
  }
}

/** Mostra agora uma notificação de exemplo (logo depois de ativar, para o leitor ver como fica). */
export async function sendTestNotification() {
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage("storyverse-test-reminder");
  } catch {
    // Sem service worker.
  }
}

/* ------------------------- Notificação no Android ------------------------- */

/** O que o service worker precisa para montar a notificação (ele não lê o localStorage). */
export type EngagementState = {
  streak: number;
  /** Último dia com leitura ("2026-09-25"). */
  lastReadDay: string | null;
  book?: { title: string; chapterLabel?: string; character?: string };
};

export async function syncEngagementState(state: EngagementState) {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(STATE_CACHE);
    await cache.put(STATE_URL, new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // Sem Cache Storage: a notificação só não terá os dados mais recentes.
  }
}

type PeriodicSyncRegistration = ServiceWorkerRegistration & {
  periodicSync?: {
    register: (tag: string, o: { minInterval: number }) => Promise<void>;
    unregister: (tag: string) => Promise<void>;
  };
};

export type NotificationSupport = "supported" | "install-first" | "unsupported";

/** Só o Chrome/Edge do Android (e desktop) com o app instalado acordam o app sozinhos. */
export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return "unsupported";
  }
  if (!("PeriodicSyncManager" in window)) return "unsupported";
  const installed = window.matchMedia?.("(display-mode: standalone)").matches;
  return installed ? "supported" : "install-first";
}

export async function enableDailyNotifications(): Promise<"enabled" | "denied" | "unavailable"> {
  if (notificationSupport() !== "supported") return "unavailable";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  try {
    const reg = (await navigator.serviceWorker.ready) as PeriodicSyncRegistration;
    const status = await navigator.permissions
      .query({ name: "periodic-background-sync" as PermissionName })
      .catch(() => null);
    if (status && status.state === "denied") return "unavailable";
    await reg.periodicSync?.register(SYNC_TAG, { minInterval: SYNC_INTERVAL_MS });
    return reg.periodicSync ? "enabled" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function disableDailyNotifications() {
  try {
    const reg = (await navigator.serviceWorker.ready) as PeriodicSyncRegistration;
    await reg.periodicSync?.unregister(SYNC_TAG);
  } catch {
    // Nada a desligar.
  }
}
