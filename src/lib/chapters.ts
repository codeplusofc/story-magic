export type StoryChapter = {
  /** Ordem na lista (0 = abertura ou primeiro bloco). */
  index: number;
  /** Título exibido (ex.: "CAPÍTULO II" ou "Abertura"). */
  label: string;
  /** Texto desse bloco, incluindo a linha do título quando for capítulo numerado. */
  body: string;
};

/**
 * Parte o .txt em blocos delimitados por linhas do tipo "CAPÍTULO I" / "CAPITULO V".
 * O que vier antes do primeiro marcador vira "Abertura" (sumário, notas, etc.).
 */
export function splitIntoChapters(fullText: string): StoryChapter[] {
  const text = fullText.replace(/\r\n/g, "\n").trim();
  if (!text.length) return [];

  const re = /^\s*(CAP[IÍ]TULO\s+[IVXLCDM0-9]+)\s*$/gim;
  const matches: { start: number; headline: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, headline: m[1].replace(/\s+/g, " ").trim() });
  }

  if (matches.length === 0) {
    return [{ index: 0, label: "Texto", body: text }];
  }

  const out: StoryChapter[] = [];
  const firstStart = matches[0].start;
  if (firstStart > 0) {
    const pre = text.slice(0, firstStart).trim();
    if (pre.length > 80) {
      out.push({ index: 0, label: "Abertura", body: pre });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const body = text.slice(start, end).trim();
    out.push({
      index: out.length,
      label: matches[i].headline,
      body,
    });
  }

  return out;
}
