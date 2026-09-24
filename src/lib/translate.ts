/** Tamanho de cada pedido de tradução (cabe folgado na cota de tokens dos planos gratuitos). */
const CHUNK_CHARS = 2500;
/** Muda quando a divisão em trechos mudar, para não reaproveitar traduções desalinhadas. */
const CACHE_PREFIX = "storyverse:tr1:";

/** Divide os parágrafos em trechos consecutivos: devolve [início, fim) de cada trecho. */
export function chunkRanges(texts: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let size = 0;
  texts.forEach((t, i) => {
    if (i > start && size + t.length > CHUNK_CHARS) {
      ranges.push([start, i]);
      start = i;
      size = 0;
    }
    size += t.length;
  });
  if (texts.length > start) ranges.push([start, texts.length]);
  return ranges;
}

function cacheKey(gutenbergId: number, chapterIndex: number, chunk: number): string {
  return `${CACHE_PREFIX}${gutenbergId}:${chapterIndex}:${chunk}`;
}

export function cachedTranslation(
  gutenbergId: number,
  chapterIndex: number,
  chunk: number,
): (string | null)[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(gutenbergId, chapterIndex, chunk));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as (string | null)[]) : null;
  } catch {
    return null;
  }
}

export function storeTranslation(
  gutenbergId: number,
  chapterIndex: number,
  chunk: number,
  paragraphs: (string | null)[],
) {
  const key = cacheKey(gutenbergId, chapterIndex, chunk);
  const value = JSON.stringify(paragraphs);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Armazenamento cheio: descarta as traduções antigas e tenta mais uma vez.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
      // A tradução só não fica guardada.
    }
  }
}
