import type { Ebook } from "../data/types";

/**
 * Os .txt do gutenberg.org não liberam CORS, então passam pelo proxy do próprio site:
 * `vite.config.ts` (dev/preview) e `vercel.json` (produção) redirecionam `/gutenberg/*`
 * para o site oficial e `/gutenberg-mirror/*` para um espelho oficial (reserva).
 */
const TEXT_SOURCES = ["/gutenberg", "/gutenberg-mirror"];

export type SearchLanguage = "all" | "pt" | "en";

/** `total` só vem quando a busca cabe numa página (o catálogo não informa o total). */
export type SearchPage = { books: Ebook[]; total: number | null; next: string | null };

/**
 * Busca do próprio gutenberg.org (feed OPDS), pelo mesmo proxy dos textos. Responde em ~2 s;
 * o Gutendex, usado antes, levava de 30 s a mais de um minuto.
 */
const SEARCH_URL = `${TEXT_SOURCES[0]}/ebooks/search.opds/`;

/** Livros fora do inglês vêm com o idioma no fim do título: "Dom Casmurro (Portuguese)". */
const LANGUAGE_SUFFIX = /\s*\(([A-Z][a-z]+)\)$/;

/** Remove marcações do catálogo ("Peter Pan : $b [Peter and Wendy]", "Título :  Subtítulo"). */
function formatTitle(raw: string): string {
  return raw
    .replace(/\s*:\s*\$b.*$/, "")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .replace(/\s+:\s+/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFeed(xml: string, language: SearchLanguage): { books: Ebook[]; next: string | null } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const books: Ebook[] = [];
  for (const entry of Array.from(doc.getElementsByTagName("entry"))) {
    // Entradas de "Authors", "Subjects" e "Bookshelves" não são livros.
    const id = Number(entry.getElementsByTagName("id")[0]?.textContent?.match(/\/ebooks\/(\d+)\.opds$/)?.[1]);
    if (!id) continue;
    const rawTitle = entry.getElementsByTagName("title")[0]?.textContent?.trim() ?? "";
    const suffix = rawTitle.match(LANGUAGE_SUFFIX)?.[1];
    const lang = suffix === "Portuguese" ? "pt" : suffix ? null : "en";
    if (!lang || (language !== "all" && lang !== language)) continue;
    // Sem autor, o catálogo põe o número de downloads no lugar ("65509 downloads").
    const author = entry.getElementsByTagName("content")[0]?.textContent?.trim() ?? "";
    books.push({
      id: `gb-${id}`,
      gutenbergId: id,
      title: formatTitle(rawTitle.replace(LANGUAGE_SUFFIX, "")),
      author: /^[\d.,]+ downloads$/.test(author) || !author ? "Autor desconhecido" : author,
      coverUrl: coverUrlFor(id),
      textLanguage: lang,
    });
  }
  const nextHref = Array.from(doc.getElementsByTagName("link"))
    .find((l) => l.getAttribute("rel") === "next")
    ?.getAttribute("href");
  return { books, next: nextHref ? `${TEXT_SOURCES[0]}${nextHref.replace(/&amp;/g, "&")}` : null };
}

/** A busca costuma responder em ~2 s; às vezes uma chamada trava ou falha, e a segunda passa. */
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_ATTEMPTS = 2;

async function fetchFeed(url: string): Promise<string> {
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const body = res.ok ? await res.text() : "";
      if (body.includes("<feed")) return body;
      console.warn("Busca no Gutenberg falhou:", res.status);
    } catch (e) {
      console.warn("Busca no Gutenberg falhou:", e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Não foi possível buscar livros agora. Tente de novo em instantes.");
}

/** Cada busca feita fica guardada na sessão. */
const searchCache = new Map<string, SearchPage>();

export async function searchBooks(
  query: string,
  language: SearchLanguage,
  pageUrl?: string,
): Promise<SearchPage> {
  let url: string;
  if (pageUrl) {
    url = pageUrl;
  } else {
    // "l.pt" / "l.en" filtram o idioma na própria busca do Gutenberg.
    const filter = language === "all" ? "" : ` l.${language}`;
    url = `${SEARCH_URL}?${new URLSearchParams({ query: query.trim() + filter })}`;
  }
  const cacheKey = `${language}|${url}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;
  const body = await fetchFeed(url);
  const { books, next } = parseFeed(body, language);
  const page = { books, next, total: next || pageUrl ? null : books.length };
  searchCache.set(cacheKey, page);
  return page;
}

/** Capa pelo proxy (o gutenberg.org derruba muitas conexões diretas ao mesmo tempo). */
export function coverUrlFor(gutenbergId: number): string {
  return `${TEXT_SOURCES[0]}/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`;
}

/** Remove o cabeçalho/rodapé de licença do Gutenberg e marcações de ilustração. */
function stripGutenbergBoilerplate(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  const start = text.search(/^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start >= 0) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (end >= 0) text = text.slice(0, end);
  return text.replace(/\[Illustration[^\]]*\]/gi, "").trim();
}

const textCache = new Map<number, string>();

/** Se o proxy não estiver ativo, o servidor devolve a página do próprio site no lugar do livro. */
function looksLikeHtml(res: Response, body: string): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html") || /^\s*<(!doctype|html)/i.test(body);
}

export async function fetchBookText(gutenbergId: number): Promise<string> {
  const cached = textCache.get(gutenbergId);
  if (cached) return cached;

  let gotHtml = false;
  for (const base of TEXT_SOURCES) {
    try {
      const res = await fetch(`${base}/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`);
      if (!res.ok) {
        console.warn("Falha ao baixar livro do Gutenberg:", base, gutenbergId, res.status);
        continue;
      }
      const body = await res.text();
      if (looksLikeHtml(res, body)) {
        gotHtml = true;
        continue;
      }
      const text = stripGutenbergBoilerplate(body);
      textCache.set(gutenbergId, text);
      return text;
    } catch (e) {
      console.warn("Falha ao baixar livro do Gutenberg:", base, gutenbergId, e);
    }
  }

  if (gotHtml && import.meta.env.DEV) {
    throw new Error(
      "O proxy do Gutenberg não está ativo. Pare e rode de novo o npm run dev para carregar a configuração nova.",
    );
  }
  throw new Error("Não foi possível carregar o texto deste livro. Tente de novo daqui a pouco.");
}
