import type { Ebook } from "../data/types";

/** Catálogo do Project Gutenberg (permite acesso direto do navegador). */
const GUTENDEX = "https://gutendex.com/books/";

/**
 * Os .txt do gutenberg.org não liberam CORS, então passam pelo proxy do próprio site:
 * `vite.config.ts` (dev/preview) e `vercel.json` (produção) redirecionam `/gutenberg/*`
 * para o site oficial e `/gutenberg-mirror/*` para um espelho oficial (reserva).
 */
const TEXT_SOURCES = ["/gutenberg", "/gutenberg-mirror"];

export type SearchLanguage = "all" | "pt" | "en";

type GutendexBook = {
  id: number;
  title: string;
  authors: { name: string }[];
  languages: string[];
  bookshelves: string[];
  formats: Record<string, string>;
};

type GutendexPage = { count: number; next: string | null; results: GutendexBook[] };

export type SearchPage = { books: Ebook[]; total: number; next: string | null };

/** "Doyle, Arthur Conan" → "Arthur Conan Doyle"; remove datas e parênteses. */
function formatAuthor(raw: string): string {
  const clean = raw.replace(/\s*\(.*?\)\s*/g, " ").trim();
  const [last, first] = clean.split(",").map((s) => s.trim());
  return first ? `${first} ${last}` : last;
}

/** Tira subtítulos técnicos do catálogo ("Peter Pan : $b [Peter and Wendy]"). */
function formatTitle(raw: string): string {
  return raw.replace(/\s*:\s*\$b.*$/, "").replace(/\s*\[.*?\]\s*/g, " ").trim();
}

function toEbook(b: GutendexBook): Ebook {
  const lang = b.languages.includes("pt") ? "pt" : "en";
  const shelf = b.bookshelves.find((s) => s.startsWith("Category: "))?.replace("Category: ", "");
  return {
    id: `gb-${b.id}`,
    gutenbergId: b.id,
    title: formatTitle(b.title),
    author: b.authors[0] ? formatAuthor(b.authors[0].name) : "Autor desconhecido",
    genre: shelf,
    coverUrl: b.formats["image/jpeg"] ? coverUrlFor(b.id) : undefined,
    textLanguage: lang,
  };
}

/** O Gutendex pode levar dezenas de segundos: cada busca feita fica guardada na sessão. */
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
    const u = new URL(GUTENDEX);
    u.searchParams.set("languages", language === "all" ? "pt,en" : language);
    u.searchParams.set("mime_type", "text/plain");
    if (query.trim()) u.searchParams.set("search", query.trim());
    url = u.toString();
  }
  const cached = searchCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Não foi possível buscar livros agora. Tente de novo em instantes.");
  const data = (await res.json()) as GutendexPage;
  const page = { books: data.results.map(toEbook), total: data.count, next: data.next };
  searchCache.set(url, page);
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
