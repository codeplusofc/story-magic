/**
 * Tradução sem IA generativa (não gasta tokens) e sem chave, feita no aparelho de quem lê:
 * - "local": tradutor embutido do navegador (Chrome/Edge desktop), roda offline;
 * - "google": serviços públicos, para celular e os demais navegadores. Primeiro o Google
 *   Tradutor (não é uma API oficial: pode limitar ou mudar sem aviso); se ele recusar, o
 *   MyMemory (oficial, mas só ~5 mil caracteres por dia para cada leitor).
 */
export type TranslationEngine = "local" | "google";

/** Tamanho de cada pedido de tradução. */
const CHUNK_CHARS = 2500;
/**
 * Muda quando a divisão em capítulos ou trechos mudar, para não reaproveitar traduções
 * desalinhadas (tr2: capítulos curtos deixaram de ser juntados ao anterior).
 */
const CACHE_PREFIX = "storyverse:tr2:";

// Traduções guardadas pela versão anterior (tr1) não servem mais: libera o espaço.
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("storyverse:tr1:")) localStorage.removeItem(k);
  }
} catch {
  // Sem armazenamento disponível.
}
/** Parágrafos maiores vão em partes, para a URL do pedido não ficar longa demais. */
const GOOGLE_MAX_CHARS = 1500;
/** O MyMemory aceita no máximo 500 bytes por pedido. */
const MYMEMORY_MAX_CHARS = 450;
/** Pedidos simultâneos por trecho. */
const REMOTE_CONCURRENCY = 3;

type LocalTranslator = { translate: (text: string) => Promise<string> };
type TranslatorApi = {
  availability: (o: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (o: { sourceLanguage: string; targetLanguage: string }) => Promise<LocalTranslator>;
};

const LANGS = { sourceLanguage: "en", targetLanguage: "pt" };

function translatorApi(): TranslatorApi | null {
  return (globalThis as { Translator?: TranslatorApi }).Translator ?? null;
}

let enginePromise: Promise<TranslationEngine> | null = null;

/** Descobre (uma vez) se o navegador traduz sozinho; senão, usa o Google. */
export function detectTranslationEngine(): Promise<TranslationEngine> {
  enginePromise ??= (async () => {
    try {
      const api = translatorApi();
      if (api && (await api.availability(LANGS)) !== "unavailable") return "local";
    } catch {
      // Segue para o Google.
    }
    return "google";
  })();
  return enginePromise;
}

let localTranslator: Promise<LocalTranslator> | null = null;

/**
 * Cria o tradutor do navegador. Na primeira vez o Chrome baixa o pacote de idioma, e isso só é
 * permitido logo depois de um clique: chame também dentro do clique no botão de tradução.
 */
export function warmUpLocalTranslator(): void {
  const api = translatorApi();
  if (!api || localTranslator) return;
  localTranslator = api.create(LANGS);
  localTranslator.catch(() => {
    localTranslator = null; // Deixa tentar de novo no próximo clique.
  });
}

async function translateLocal(paragraphs: string[]): Promise<(string | null)[]> {
  warmUpLocalTranslator();
  if (!localTranslator) throw new Error("Tradutor do navegador indisponível.");
  const t = await localTranslator;
  const out: (string | null)[] = [];
  for (const p of paragraphs) out.push((await t.translate(p)).trim() || null);
  return out;
}

/** Quebra um parágrafo longo em grupos de frases de até `max` caracteres. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [text];
  const parts: string[] = [];
  let cur = "";
  for (const sentence of sentences) {
    // Frase maior que o limite (raro): corta no último espaço.
    for (let rest = sentence; rest; ) {
      const room = max - cur.length;
      if (rest.length <= room) {
        cur += rest;
        break;
      }
      if (cur) {
        parts.push(cur);
        cur = "";
        continue;
      }
      const cut = rest.lastIndexOf(" ", max) > 0 ? rest.lastIndexOf(" ", max) : max;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

async function googleTranslate(text: string): Promise<string> {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.search = new URLSearchParams({ client: "gtx", sl: "en", tl: "pt", dt: "t", q: text }).toString();
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google Tradutor HTTP ${res.status}`);
  // Formato: [[["frase traduzida", "frase original", ...], ...], ...]
  const data = (await res.json()) as [[string, string][] | null];
  return (data[0] ?? []).map((seg) => seg[0]).join("").trim();
}

async function myMemoryTranslate(text: string): Promise<string> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.search = new URLSearchParams({ q: text, langpair: "en|pt-BR" }).toString();
  const res = await fetch(url.toString());
  const data = (await res.json()) as {
    responseStatus?: number | string;
    quotaFinished?: boolean;
    responseData?: { translatedText?: string };
  };
  if (!res.ok || Number(data.responseStatus) !== 200 || data.quotaFinished) {
    throw new Error(`MyMemory ${data.responseStatus ?? res.status}`);
  }
  return data.responseData?.translatedText?.trim() ?? "";
}

/** Depois que o Google recusa (ex.: 429), a sessão segue direto para o MyMemory. */
let googleBlocked = false;

async function translateOne(paragraph: string): Promise<string> {
  if (!googleBlocked) {
    try {
      const parts = await Promise.all(splitLong(paragraph, GOOGLE_MAX_CHARS).map(googleTranslate));
      return parts.join(" ");
    } catch (err) {
      console.warn("Google Tradutor recusou, usando o MyMemory:", err);
      googleBlocked = true;
    }
  }
  const out: string[] = [];
  for (const part of splitLong(paragraph, MYMEMORY_MAX_CHARS)) out.push(await myMemoryTranslate(part));
  return out.join(" ");
}

async function translateRemote(paragraphs: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = paragraphs.map(() => null);
  let next = 0;
  let failures = 0;
  const worker = async () => {
    while (next < paragraphs.length) {
      const i = next++;
      try {
        out[i] = (await translateOne(paragraphs[i])).trim() || null;
      } catch {
        failures++;
      }
    }
  };
  await Promise.all(Array.from({ length: REMOTE_CONCURRENCY }, worker));
  if (failures === paragraphs.length) throw new Error("Nenhum serviço de tradução respondeu.");
  return out;
}

/** Traduz os parágrafos mantendo um item por parágrafo (`null` = fica o original). */
export async function translateParagraphs(
  engine: TranslationEngine,
  original: string[],
): Promise<(string | null)[]> {
  // As marcações de itálico do Gutenberg (_assim_) confundem os tradutores.
  const paragraphs = original.map((p) => p.replace(/_([^_]+)_/g, "$1"));
  if (engine === "local") {
    try {
      return await translateLocal(paragraphs);
    } catch (err) {
      // Pacote de idioma ainda não baixado ou recusado: o Google cobre este trecho.
      console.warn("Tradutor do navegador falhou, usando o Google:", err);
    }
  }
  return translateRemote(paragraphs);
}

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
        if (k.startsWith("storyverse:tr")) localStorage.removeItem(k);
      }
      localStorage.setItem(key, value);
    } catch {
      // A tradução só não fica guardada.
    }
  }
}
