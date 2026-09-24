import { translateParagraphs, type TranslationEngine } from "./translate";

/**
 * Significado de uma palavra selecionada no texto, com fontes abertas e sem chave:
 * - palavra em inglês: tradução para o português + definição do Wikcionário em inglês;
 * - palavra em português: definição do Wikcionário em português.
 */
export type WordInfo = {
  word: string;
  /** Tradução para o português (só para palavras em inglês). */
  translation?: string;
  /** Classe gramatical, se o dicionário informar ("Adjective", "substantivo"). */
  kind?: string;
  definitions: string[];
  source?: { label: string; url: string };
};

const MAX_DEFINITIONS = 3;
const TIMEOUT_MS = 8000;
const cache = new Map<string, WordInfo>();

async function getJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Palavra "limpa" a partir da seleção (tira pontuação e aspas das pontas). */
export function normalizeWord(selection: string): string | null {
  const w = selection.trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  return /^[\p{L}][\p{L}'’-]{0,39}$/u.test(w) ? w : null;
}

type EnWiktionary = Record<string, { partOfSpeech: string; definitions: { definition: string }[] }[]>;

async function englishDefinitions(word: string): Promise<Pick<WordInfo, "kind" | "definitions">> {
  for (const w of [word, word.toLowerCase()]) {
    const data = await getJson<EnWiktionary>(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`,
    );
    const entries = data?.en ?? [];
    const defs = entries
      .flatMap((e) => e.definitions.map((d) => ({ kind: e.partOfSpeech, text: stripHtml(d.definition) })))
      .filter((d) => d.text);
    if (defs.length > 0) {
      return { kind: defs[0].kind, definitions: defs.slice(0, MAX_DEFINITIONS).map((d) => d.text) };
    }
  }
  return { definitions: [] };
}

type PtWiktionary = { query?: { pages?: Record<string, { extract?: string; missing?: string }> } };

/** Pega as primeiras acepções da seção "Português" do verbete. */
async function portugueseDefinitions(word: string): Promise<Pick<WordInfo, "kind" | "definitions">> {
  for (const w of [word.toLowerCase(), word]) {
    const url =
      "https://pt.wiktionary.org/w/api.php?" +
      new URLSearchParams({
        action: "query",
        prop: "extracts",
        titles: w,
        format: "json",
        explaintext: "1",
        redirects: "1",
        origin: "*",
      });
    const data = await getJson<PtWiktionary>(url);
    const page = Object.values(data?.query?.pages ?? {})[0];
    const extract = page?.extract;
    if (!extract) continue;

    const section = extract.split(/^= (?!Português)[^=]+ =$/m)[0].split(/^= Português =$/m).pop() ?? "";
    let kind: string | undefined;
    const definitions: string[] = [];
    for (const raw of section.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const heading = line.match(/^==+\s*(.+?)\s*==+$/);
      if (heading) {
        // Para no primeiro bloco que não é de sentido (tradução, etimologia, expressões…).
        if (definitions.length > 0 && !/^(substantivo|adjetivo|verbo|advérbio|forma)/i.test(heading[1])) break;
        if (!kind && /^(substantivo|adjetivo|verbo|advérbio|forma|pronome|preposição|conjunção|interjeição)/i.test(heading[1])) {
          kind = heading[1].toLowerCase();
        }
        continue;
      }
      // Linha de separação silábica/gênero ("sau.da.de, feminino") e exemplos longos ficam de fora.
      if (/^[\p{L}.]+(,| )\s*(masculino|feminino|comum|plural|singular)/iu.test(line)) continue;
      if (line.length < 3 || line.length > 260) continue;
      // Frases de exemplo e citações (vêm entre aspas) não são definição.
      if (/["“”«»]/.test(line)) continue;
      definitions.push(line);
      if (definitions.length >= MAX_DEFINITIONS) break;
    }
    if (definitions.length > 0) return { kind, definitions };
  }
  return { definitions: [] };
}

export async function lookupWord(
  rawWord: string,
  language: "pt" | "en",
  engine: TranslationEngine,
): Promise<WordInfo> {
  const word = normalizeWord(rawWord) ?? rawWord.trim();
  const key = `${language}:${word.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let info: WordInfo;
  if (language === "en") {
    const [translation, defs] = await Promise.all([
      translateParagraphs(engine, [word]).then((r) => r[0] ?? undefined).catch(() => undefined),
      englishDefinitions(word),
    ]);
    info = {
      word,
      translation: translation && translation.toLowerCase() !== word.toLowerCase() ? translation : undefined,
      ...defs,
      source: { label: "Wiktionary", url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}` },
    };
  } else {
    info = {
      word,
      ...(await portugueseDefinitions(word)),
      source: { label: "Wikcionário", url: `https://pt.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}` },
    };
  }
  cache.set(key, info);
  return info;
}
