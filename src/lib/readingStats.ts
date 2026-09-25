/**
 * Tempo de leitura por dia, sequência de dias seguidos, meta diária e escudos — tudo no navegador.
 * Só conta o tempo em que o leitor está de fato lendo: livro aberto, aba visível e alguma
 * interação (rolagem, toque, tecla) nos últimos 2 minutos.
 *
 * Escudo (como o "protetor de ofensiva" do Duolingo): a cada 7 dias seguidos o leitor ganha um
 * (máximo 2). Se um dia passar sem leitura, um escudo é gasto sozinho e a sequência continua.
 */
const KEY = "storyverse:reading-stats";
const GOAL_KEY = "storyverse:reading-goal";
const META_KEY = "storyverse:streak-meta";
/** Um dia entra na sequência a partir de 1 minuto de leitura. */
const MIN_SECONDS_FOR_STREAK = 60;
/** Dias guardados (o suficiente para sequências longas sem crescer para sempre). */
const KEEP_DAYS = 400;
const MAX_SHIELDS = 2;
const DAYS_PER_SHIELD = 7;

export const GOAL_OPTIONS = [5, 10, 15, 20, 30] as const;

type Stats = Record<string, number>; // "2026-09-24" → segundos lidos
type Meta = {
  shields: number;
  /** Dias salvos por escudo (contam na sequência, mas aparecem diferentes na semana). */
  frozen: string[];
  /** Tamanho da sequência em que o último escudo foi ganho (evita ganhar duas vezes). */
  awardedAt: number;
  /** Último dia em que o aviso "um escudo salvou sua sequência" foi mostrado. */
  shieldNoticeDay?: string;
};

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number, from = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

function read(): Stats {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stats;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function readMeta(): Meta {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) ?? "null") as Meta | null;
    if (m && typeof m.shields === "number" && Array.isArray(m.frozen)) return m;
  } catch {
    // Sem armazenamento.
  }
  return { shields: 0, frozen: [], awardedAt: 0 };
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sem armazenamento.
  }
}

const readOn = (stats: Stats, d: Date) => (stats[dayKey(d)] ?? 0) >= MIN_SECONDS_FOR_STREAK;

/** Dias seguidos com leitura (ou salvos por escudo), terminando hoje ou ontem. */
function computeStreak(stats: Stats, meta: Meta, now = new Date()): number {
  const kept = (d: Date) => readOn(stats, d) || meta.frozen.includes(dayKey(d));
  let streak = 0;
  let cursor = readOn(stats, now) ? now : daysAgo(1, now);
  while (kept(cursor)) {
    // Dia salvo por escudo mantém a sequência, mas não soma.
    if (readOn(stats, cursor)) streak++;
    cursor = daysAgo(1, cursor);
  }
  return streak;
}

/** Ganha escudo a cada 7 dias seguidos; sequência zerada volta a contar do começo. */
function awardShields(meta: Meta, streak: number): boolean {
  if (streak < meta.awardedAt) meta.awardedAt = 0;
  if (streak >= meta.awardedAt + DAYS_PER_SHIELD && meta.shields < MAX_SHIELDS) {
    meta.shields++;
    meta.awardedAt = streak - (streak % DAYS_PER_SHIELD);
    return true;
  }
  return false;
}

export type ReadingEvents = {
  /** Hoje acabou de entrar na sequência (passou de 1 minuto de leitura). */
  dayCompleted: boolean;
  /** Acabou de cumprir a meta de minutos do dia. */
  goalReached: boolean;
  streak: number;
  shieldEarned: boolean;
};

export function addReadingSeconds(seconds: number): ReadingEvents {
  const stats = read();
  const k = dayKey();
  const before = stats[k] ?? 0;
  const after = before + seconds;
  stats[k] = after;
  const days = Object.keys(stats).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete stats[old];
  write(KEY, stats);

  const meta = readMeta();
  const streak = computeStreak(stats, meta);
  const dayCompleted = before < MIN_SECONDS_FOR_STREAK && after >= MIN_SECONDS_FOR_STREAK;
  const shieldEarned = dayCompleted && awardShields(meta, streak);
  if (shieldEarned) write(META_KEY, meta);
  const goal = readingGoalMinutes() * 60;
  return { dayCompleted, goalReached: before < goal && after >= goal, streak, shieldEarned };
}

/**
 * Ao abrir o app: se ontem (ou até 2 dias) passou sem leitura e há escudos, eles salvam a
 * sequência. Devolve quantos escudos foram usados agora.
 */
export function reconcileStreak(): { shieldsUsed: number; streak: number } {
  const stats = read();
  const meta = readMeta();
  const now = new Date();
  const missed: string[] = [];
  let cursor = daysAgo(1, now);
  while (!readOn(stats, cursor) && !meta.frozen.includes(dayKey(cursor)) && missed.length < MAX_SHIELDS + 1) {
    missed.push(dayKey(cursor));
    cursor = daysAgo(1, cursor);
  }
  // Só vale a pena gastar escudo se havia uma sequência antes da falha.
  const hadStreak = readOn(stats, cursor) || meta.frozen.includes(dayKey(cursor));
  let shieldsUsed = 0;
  if (missed.length > 0 && hadStreak && missed.length <= meta.shields) {
    meta.frozen.push(...missed);
    meta.shields -= missed.length;
    shieldsUsed = missed.length;
  }
  // Não guarda dias salvos antigos para sempre.
  const oldest = dayKey(daysAgo(KEEP_DAYS, now));
  meta.frozen = meta.frozen.filter((d) => d >= oldest);
  write(META_KEY, meta);
  return { shieldsUsed, streak: computeStreak(stats, meta, now) };
}

/** Mostra o aviso "um escudo salvou sua sequência" uma vez só por dia. */
export function takeShieldNotice(): boolean {
  const meta = readMeta();
  const today = dayKey();
  if (meta.shieldNoticeDay === today) return false;
  meta.shieldNoticeDay = today;
  write(META_KEY, meta);
  return true;
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

export type DayState = "read" | "frozen" | "missed";

export type ReadingSummary = {
  todayMinutes: number;
  goalMinutes: number;
  /** Dias seguidos com leitura, terminando hoje (ou ontem, se hoje ainda não leu). */
  streak: number;
  readToday: boolean;
  shields: number;
  /** Últimos 7 dias, do mais antigo para hoje. */
  week: { label: string; state: DayState; today: boolean }[];
};

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

export function readingSummary(): ReadingSummary {
  const stats = read();
  const meta = readMeta();
  const now = new Date();
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = daysAgo(6 - i, now);
    const state: DayState = readOn(stats, d) ? "read" : meta.frozen.includes(dayKey(d)) ? "frozen" : "missed";
    return { label: WEEKDAYS[d.getDay()], state, today: i === 6 };
  });
  return {
    todayMinutes: Math.floor((stats[dayKey(now)] ?? 0) / 60),
    goalMinutes: readingGoalMinutes(),
    streak: computeStreak(stats, meta, now),
    readToday: readOn(stats, now),
    shields: meta.shields,
    week,
  };
}

/** Último dia com leitura de verdade (para o lembrete saber se a sequência está em risco). */
export function lastReadDay(): string | null {
  const days = Object.entries(read())
    .filter(([, s]) => s >= MIN_SECONDS_FOR_STREAK)
    .map(([d]) => d)
    .sort();
  return days[days.length - 1] ?? null;
}

export function hasAnyReading(): boolean {
  return Object.values(read()).some((s) => s >= MIN_SECONDS_FOR_STREAK);
}
