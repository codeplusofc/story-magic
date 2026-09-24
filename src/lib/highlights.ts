/** Trechos destacados pelo leitor (citações favoritas), por livro, guardados no navegador. */

export type Highlight = {
  id: string;
  chapterIndex: number;
  chapterLabel: string;
  /** Parágrafo do capítulo onde o trecho está (para voltar direto a ele). */
  paragraph: number;
  text: string;
  createdAt: number;
};

const KEY = (bookId: string) => `storyverse:highlights:${bookId}`;
/** Trechos muito longos viram citação ruim de compartilhar e pesam no armazenamento. */
export const MAX_HIGHLIGHT_CHARS = 600;

export function loadHighlights(bookId: string): Highlight[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY(bookId)) ?? "[]") as Highlight[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveHighlights(bookId: string, list: Highlight[]) {
  try {
    if (list.length === 0) localStorage.removeItem(KEY(bookId));
    else localStorage.setItem(KEY(bookId), JSON.stringify(list));
  } catch {
    // Sem espaço: a marcação só não fica guardada.
  }
}

export function forgetHighlights(bookId: string) {
  saveHighlights(bookId, []);
}

/**
 * Divide o texto de um parágrafo em pedaços marcados e não marcados, para desenhar os destaques
 * (`<mark>`). Só marca trechos que aparecem inteiros no parágrafo.
 */
export function splitByHighlights(text: string, marks: string[]): { text: string; marked: boolean }[] {
  const ranges: [number, number][] = [];
  for (const m of marks) {
    const at = text.indexOf(m);
    if (at >= 0) ranges.push([at, at + m.length]);
  }
  if (ranges.length === 0) return [{ text, marked: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: { text: string; marked: boolean }[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (end <= pos) continue;
    const s = Math.max(start, pos);
    if (s > pos) out.push({ text: text.slice(pos, s), marked: false });
    out.push({ text: text.slice(s, end), marked: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), marked: false });
  return out;
}
