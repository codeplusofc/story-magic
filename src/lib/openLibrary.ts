/**
 * Livros que não estão no acervo (ainda têm direitos autorais), vindos do catálogo aberto da
 * Open Library: só título, autor, ano e capa — nunca o texto. Servem para o leitor encontrar o
 * livro famoso que procurou e importar o próprio arquivo com esses dados já preenchidos.
 */

/** Dados de um livro para preencher o formulário de importação. */
export type BookHint = { title: string; author: string; year?: number; coverUrl?: string };

const SEARCH_URL = "https://openlibrary.org/search.json";
const FIELDS = [
  "key",
  "title",
  "author_name",
  "first_publish_year",
  "cover_i",
  "edition_count",
  "editions",
  "editions.title",
  "editions.language",
  "editions.cover_i",
].join(",");
/** Livros publicados antes disso em geral já são domínio público (e aparecem no acervo). */
const MIN_YEAR = 1930;
const MAX_RESULTS = 6;
const TIMEOUT_MS = 10_000;

type OpenLibraryDoc = {
  key: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  edition_count?: number;
  editions?: { docs?: { title?: string; language?: string[]; cover_i?: number }[] };
};

const coverUrl = (id: number) => `https://covers.openlibrary.org/b/id/${id}-M.jpg`;

const cache = new Map<string, BookHint[]>();

export async function searchOutsideCatalog(query: string): Promise<BookHint[]> {
  const term = query.trim().toLowerCase();
  const cached = cache.get(term);
  if (cached) return cached;

  // lang=pt faz a Open Library devolver a edição em português, quando existe ("Crepúsculo").
  const url = `${SEARCH_URL}?${new URLSearchParams({ q: term, fields: FIELDS, limit: "20", lang: "pt" })}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let docs: OpenLibraryDoc[];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Open Library HTTP ${res.status}`);
    docs = ((await res.json()) as { docs?: OpenLibraryDoc[] }).docs ?? [];
  } finally {
    clearTimeout(timer);
  }

  const ptEdition = (d: OpenLibraryDoc) => d.editions?.docs?.find((e) => e.language?.includes("por"));
  // Quem busca "crepúsculo" quer o livro lançado no Brasil, não outros livros com "twilight" no
  // título: se algum resultado tem edição em português, ficam só os que têm.
  const onlyPt = docs.some((d) => ptEdition(d));

  // A Open Library também casa a busca com assuntos e descrições; aqui só interessa quando todas as
  // palavras buscadas estão no título ou no autor (busca por título ou por autor).
  const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = norm(term).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const matches = (title: string, author: string) => {
    const hay = norm(`${title} ${author}`);
    return words.every((w) => hay.includes(w));
  };

  const seen = new Set<string>();
  const hints: BookHint[] = [];
  for (const d of docs) {
    const author = d.author_name?.[0];
    const year = d.first_publish_year;
    // Sem autor, sem capa ou com uma edição só costuma ser cadastro duplicado ou incompleto.
    if (!author || !year || year < MIN_YEAR || (d.edition_count ?? 0) < 2) continue;
    const pt = ptEdition(d);
    if (onlyPt && !pt) continue;
    const title = (pt?.title ?? d.title ?? "").trim();
    const cover = pt?.cover_i ?? d.cover_i;
    if (!title || !cover) continue;
    if (!matches(`${title} ${d.title ?? ""}`, d.author_name?.join(" ") ?? "")) continue;
    const key = `${title.toLowerCase()}|${author.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ title, author, year, coverUrl: coverUrl(cover) });
    if (hints.length >= MAX_RESULTS) break;
  }
  cache.set(term, hints);
  return hints;
}
