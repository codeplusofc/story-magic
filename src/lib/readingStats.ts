/**
 * Tempo de leitura por dia, sequência de dias seguidos e meta diária — tudo no navegador.
 * Só conta o tempo em que o leitor está de fato lendo: livro aberto, aba visível e alguma
 * interação (rolagem, toque, tecla) nos últimos 2 minutos.
 */
const KEY = "storyverse:reading-stats";
const GOAL_KEY = "storyverse:reading-goal";
/** Um dia entra na sequência a partir de 1 minuto de leitura. */
const MIN_SECONDS_FOR_STREAK = 60;
/** Dias guardados (o suficiente para sequências longas sem crescer para sempre). */
const KEEP_DAYS = 400;

export const GOAL_OPTIONS = [5, 10, 15, 20, 30] as const;

type Stats = Record<string, number>; // "2026-09-24" → segundos lidos

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function read(): Stats {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stats;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function addReadingSeconds(seconds: number) {
  const stats = read();
  const k = dayKey();
  stats[k] = (stats[k] ?? 0) + seconds;
  const days = Object.keys(stats).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete stats[old];
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {
    // Sem armazenamento.
  }
}

export function readingGoalMinutes(): number {
  try {
    const g = Number(localStorage.getItem(GOAL_KEY));
    return (GOAL_OPTIONS as readonly number[]).includes(g) ? g : 10;
  } catch {
    return 10;
  }
}

export function setReadingGoalMinutes(minutes: number) {
  try {
    localStorage.setItem(GOAL_KEY, String(minutes));
  } catch {
    // Sem armazenamento.
  }
}

export type ReadingSummary = {
  todayMinutes: number;
  goalMinutes: number;
  /** Dias seguidos com leitura, terminando hoje (ou ontem, se hoje ainda não leu). */
  streak: number;
  readToday: boolean;
  /** Últimos 7 dias, do mais antigo para hoje: leu (true) ou não. */
  week: { label: string; read: boolean; today: boolean }[];
};

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

export function readingSummary(): ReadingSummary {
  const stats = read();
  const readOn = (d: Date) => (stats[dayKey(d)] ?? 0) >= MIN_SECONDS_FOR_STREAK;
  const now = new Date();
  const readToday = readOn(now);

  let streak = 0;
  const cursor = new Date(now);
  if (!readToday) cursor.setDate(cursor.getDate() - 1);
  while (readOn(cursor)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    return { label: WEEKDAYS[d.getDay()], read: readOn(d), today: i === 6 };
  });

  return {
    todayMinutes: Math.floor((stats[dayKey(now)] ?? 0) / 60),
    goalMinutes: readingGoalMinutes(),
    streak,
    readToday,
    week,
  };
}

export function hasAnyReading(): boolean {
  return Object.values(read()).some((s) => s >= MIN_SECONDS_FOR_STREAK);
}
