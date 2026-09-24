import type { Ebook } from "../data/types";

const PROGRESS_KEY = "storyverse:reading-progress";
/** Guarda só os livros lidos mais recentemente (o localStorage é pequeno). */
const MAX_BOOKS = 30;

/** Onde o leitor parou em um livro. */
export type ReadingProgress = {
  /** O livro inteiro, para reabrir também os que vieram da busca no acervo. */
  book: Ebook;
  chapterIndex: number;
  chapterLabel: string;
  chapterCount: number;
  /** Rolagem dentro do capítulo, de 0 a 1. */
  scrollRatio: number;
  updatedAt: number;
};

type Store = Record<string, ReadingProgress>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(store));
  } catch {
    // Sem armazenamento disponível: o progresso só não fica salvo.
  }
}

export function loadProgress(gutenbergId: number): ReadingProgress | null {
  const p = readStore()[gutenbergId];
  if (!p || typeof p.chapterIndex !== "number" || typeof p.scrollRatio !== "number") return null;
  return p;
}

export function saveProgress(p: Omit<ReadingProgress, "updatedAt">) {
  const store = readStore();
  store[p.book.gutenbergId] = { ...p, updatedAt: Date.now() };
  const keep = Object.entries(store)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BOOKS);
  writeStore(Object.fromEntries(keep));
}

/** Livros começados, do lido mais recentemente para o mais antigo. */
export function recentProgress(): ReadingProgress[] {
  return Object.values(readStore())
    .filter((p) => p?.book && typeof p.chapterIndex === "number")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Posição aproximada no livro inteiro, em %. */
export function progressPct(p: ReadingProgress): number {
  if (p.chapterCount <= 0) return 0;
  return Math.min(100, ((p.chapterIndex + p.scrollRatio) / p.chapterCount) * 100);
}
