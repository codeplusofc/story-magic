export type StoryChapter = {
  /** Ordem na lista (0 = abertura ou primeiro bloco). */
  index: number;
  /** Título exibido (ex.: "CHAPTER II" ou "Abertura"). */
  label: string;
  /** Texto desse bloco, incluindo a linha do título quando for capítulo numerado. */
  body: string;
};

/** "Chapter 1.", "CHAPTER IV. Título", "CAPITULO I", "Capítulo 3". */
const CHAPTER_RE = /^[ \t]*((?:chapter|cap[ií]tulo)[ \t]+(?:[ivxlcdm]+|\d+)\b.{0,80})$/gim;
/** Contos numerados: "I. A SCANDAL IN BOHEMIA", "IV. The Mysterious Traveller". */
const ROMAN_TITLE_RE = /^((?:[IVXLC]+)\.[ \t]+\S.{0,80})$/gm;

/** Trecho menor que isso entre dois títulos é sumário, não capítulo. */
const MIN_CHAPTER_CHARS = 1000;
/** Capítulos maiores são divididos em partes (evita páginas enormes e pesadas). */
const MAX_CHAPTER_CHARS = 45_000;
/** Sem marcações de capítulo, o livro é dividido em partes deste tamanho. */
const PAGE_CHARS = 25_000;

function findHeadings(text: string, re: RegExp): { start: number; headline: string }[] {
  const found: { start: number; headline: string }[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push({ start: m.index, headline: m[1].replace(/\s+/g, " ").replace(/[\]\s]+$/, "").trim() });
  }
  const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Descarta entradas de sumário: títulos seguidos de quase nenhum texto,
  // ou que aparecem de novo mais adiante (o sumário vem antes do capítulo real).
  return found.filter((h, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : text.length;
    if (end - h.start < MIN_CHAPTER_CHARS) return false;
    return !found.slice(i + 1).some((later) => key(later.headline) === key(h.headline));
  });
}

/** Corta um texto longo em pedaços de ~`size` caracteres, sempre entre parágrafos. */
function splitByParagraphs(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size * 1.3) {
    let cut = rest.indexOf("\n\n", size);
    if (cut < 0) break;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

/**
 * Parte o texto em capítulos a partir de linhas como "CHAPTER I" / "CAPITULO V" / "I. TÍTULO".
 * O que vier antes do primeiro capítulo vira "Abertura" (prefácio, cartas, etc.).
 * Sem marcações, divide em "Parte 1, 2, 3…".
 */
export function splitIntoChapters(fullText: string): StoryChapter[] {
  const text = fullText.replace(/\r\n/g, "\n").trim();
  if (!text.length) return [];

  let headings = findHeadings(text, CHAPTER_RE);
  if (headings.length < 3) {
    const roman = findHeadings(text, ROMAN_TITLE_RE);
    if (roman.length >= 3) headings = roman;
  }

  const raw: { label: string; body: string }[] = [];
  if (headings.length < 2) {
    const pages = splitByParagraphs(text, PAGE_CHARS);
    pages.forEach((body, i) => raw.push({ label: pages.length > 1 ? `Parte ${i + 1}` : "Texto", body }));
  } else {
    // Uma abertura muito curta (só título/autor) entra junto com o primeiro capítulo.
    const pre = text.slice(0, headings[0].start).trim();
    const hasOpening = pre.length > 300;
    if (hasOpening) raw.push({ label: "Abertura", body: pre });
    headings.forEach((h, i) => {
      const start = i === 0 && !hasOpening ? 0 : h.start;
      const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
      raw.push({ label: h.headline, body: text.slice(start, end).trim() });
    });
  }

  const out: StoryChapter[] = [];
  for (const r of raw) {
    const pieces = r.body.length > MAX_CHAPTER_CHARS ? splitByParagraphs(r.body, PAGE_CHARS) : [r.body];
    pieces.forEach((body, i) => {
      out.push({
        index: out.length,
        label: pieces.length > 1 ? `${r.label} (${i + 1}/${pieces.length})` : r.label,
        body,
      });
    });
  }
  return out;
}
