import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { featuredBooks, suggestedBooks } from "./data/ebooks";
import type { Ebook, StoryCharacter } from "./data/types";
import {
  characterReply,
  providerDisplayLabel,
  USER_MESSAGE_MAX_CHARS,
  type ChatTurn,
} from "./lib/ai";
import { loadCast } from "./lib/cast";
import { splitIntoChapters } from "./lib/chapters";
import { fetchBookText, searchBooks, type SearchLanguage } from "./lib/gutenberg";
import { loadProgress, progressPct, recentProgress, saveProgress, type ReadingProgress } from "./lib/progress";
import { chapterTransitionMessage, midChapterReadingHint } from "./lib/readingAmbient";
import { excerptNearScrollRatio } from "./lib/readingContext";
import {
  cachedTranslation,
  chunkRanges,
  detectTranslationEngine,
  storeTranslation,
  translateParagraphs,
  warmUpLocalTranslator,
  type TranslationEngine,
} from "./lib/translate";
import "./App.css";

type Msg = { id: string; role: "user" | "assistant"; text: string };

const EMPTY_THREAD: Msg[] = [];

type LoadState = "idle" | "loading" | "ready" | "error";

type ReadingTheme = "night" | "sepia";
const FONT_SIZES = [0.95, 1.05, 1.17, 1.3];
const PREFS_KEY = "storyverse:reading-prefs";

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initialThreadsFor(cast: StoryCharacter[]): Record<string, Msg[]> {
  const initial: Record<string, Msg[]> = {};
  for (const c of cast) {
    initial[c.id] = [
      {
        id: uid(),
        role: "assistant",
        text:
          c.greeting ??
          `Olá! Eu sou ${c.name}. Vamos ler juntos? Pode me perguntar o que quiser sobre a história.`,
      },
    ];
  }
  return initial;
}

function loadPrefs(): { theme: ReadingTheme; fontStep: number; translate: boolean } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { theme?: string; fontStep?: number; translate?: boolean };
      return {
        theme: p.theme === "sepia" ? "sepia" : "night",
        translate: p.translate === true,
        fontStep:
          typeof p.fontStep === "number" && p.fontStep >= 0 && p.fontStep < FONT_SIZES.length
            ? p.fontStep
            : 1,
      };
    }
  } catch {
    // Sem armazenamento disponível: usa o padrão.
  }
  return { theme: "night", fontStep: 1, translate: false };
}

function shortNameOf(c: StoryCharacter): string {
  return c.shortName ?? c.name;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

function suggestionsFor(c: StoryCharacter): string[] {
  return [
    `Quem é você de verdade, ${shortNameOf(c)}?`,
    "O que está sentindo agora?",
    "O que acha do que acabou de acontecer?",
  ];
}

type Block = { kind: "heading" | "p"; text: string };

/**
 * Os .txt do Gutenberg quebram as linhas a cada ~70 caracteres e separam parágrafos por
 * linha em branco: cada bloco vira um parágrafo; blocos curtos sem pontuação viram subtítulos.
 */
function toBlocks(text: string, skipHeadline?: string): Block[] {
  // Ignora o "(1/2)" que o app acrescenta quando divide um capítulo longo em partes.
  const norm = (s: string) =>
    s.toUpperCase().replace(/\s*\(\d+\/\d+\)$/, "").replace(/\s+/g, " ").replace(/[\].\s]+$/, "");
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (skipHeadline && paras[0] && norm(paras[0]) === norm(skipHeadline)) paras.shift();
  return paras.map((p) => {
    const isShortTitle = p.length <= 60 && !/[.!?…:;,"»”)\-—]$/.test(p);
    const isUpperTitle = p.length <= 90 && p === p.toUpperCase() && /[A-Z]/.test(p);
    return { kind: (isShortTitle || isUpperTitle) && !p.startsWith("—") ? "heading" : "p", text: p };
  });
}

/** O Gutenberg marca itálico como _assim_. */
function withItalics(text: string): React.ReactNode {
  const parts = text.split(/_([^_]+)_/);
  return parts.length === 1 ? text : parts.map((p, i) => (i % 2 === 1 ? <em key={i}>{p}</em> : p));
}

function Avatar({ character, size = "md" }: { character: StoryCharacter; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ "--c": character.color } as React.CSSProperties}
      aria-hidden="true"
    >
      {shortNameOf(character).replace(/^(O|A|Mr\.|Mrs\.|Dr\.)\s+/i, "").charAt(0).toUpperCase()}
    </span>
  );
}

/** Capa real do Gutenberg; se não houver (ou falhar), desenha uma capa tipográfica. */
function BookCover({ book }: { book: Ebook }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <div className="cover">
      {book.coverUrl && status !== "failed" ? (
        <img
          className={`cover-photo ${status === "loaded" ? "is-loaded" : ""}`}
          src={book.coverUrl}
          alt=""
          loading="lazy"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
        />
      ) : null}
      <div className="cover-frame">
        {book.genre ? <span className="cover-genre">{book.genre}</span> : null}
        <span className="cover-title">{book.title}</span>
        <span className="cover-ornament" aria-hidden="true">
          ✦
        </span>
        <span className="cover-author">{book.author}</span>
      </div>
    </div>
  );
}

function LangBadge({ book }: { book: Ebook }) {
  return (
    <span className={`lang-badge lang-${book.textLanguage}`}>
      {book.textLanguage === "pt" ? "Em português" : "Texto em inglês"}
    </span>
  );
}

const Icon = {
  back: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
};

const SHELVES: { id: NonNullable<Ebook["shelf"]>; title: string; subtitle: string }[] = [
  { id: "pt", title: "Em português", subtitle: "Romances e paixões proibidas, direto no nosso idioma." },
  { id: "terror", title: "Terror e vampiros", subtitle: "Os clássicos do medo. Texto em inglês, conversa em português." },
  { id: "classicos", title: "Mais clássicos", subtitle: "Mistério, romance e fantasia. Texto em inglês, conversa em português." },
];

const LANGUAGE_FILTERS: { id: SearchLanguage; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "pt", label: "Português" },
  { id: "en", label: "Inglês" },
];

/** Busca no acervo inteiro do Project Gutenberg; sem busca, mostra sugestões prontas. */
function Explore({ onOpen }: { onOpen: (b: Ebook) => void }) {
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<SearchLanguage>("pt");
  const [books, setBooks] = useState<Ebook[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [slow, setSlow] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const term = query.trim();
  const searching = term.length >= 2;

  useEffect(() => {
    if (!searching) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setSlow(false);
    const slowTimer = setTimeout(() => !cancelled && setSlow(true), 5000);
    const t = setTimeout(() => {
      searchBooks(term, language)
        .then((page) => {
          if (cancelled) return;
          setBooks(page.books);
          setTotal(page.total);
          setNext(page.next);
          setStatus("ready");
        })
        .catch(() => !cancelled && setStatus("error"))
        .finally(() => clearTimeout(slowTimer));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearTimeout(slowTimer);
    };
  }, [term, searching, language]);

  const loadMore = () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    searchBooks(term, language, next)
      .then((page) => {
        setBooks((prev) => [...prev, ...page.books]);
        setNext(page.next);
      })
      .catch(() => setNext(null))
      .finally(() => setLoadingMore(false));
  };

  const shown = searching
    ? books
    : suggestedBooks.filter((b) => language === "all" || b.textLanguage === language);

  return (
    <section className="explore" id="acervo">
      <div className="shelf-head">
        <h2>Explorar o acervo</h2>
        <p>Mais de 70 mil livros em domínio público, direto do Project Gutenberg.</p>
      </div>

      <div className="explore-controls">
        <label className="search-box">
          {Icon.search}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Busque por título ou autor, como Verne, Poe ou Austen"
            aria-label="Buscar livros"
          />
        </label>
        <div className="filter-pills" role="group" aria-label="Idioma do texto">
          {LANGUAGE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`filter-pill ${language === f.id ? "active" : ""}`}
              onClick={() => setLanguage(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {!searching ? (
        <p className="explore-note">Sugestões para começar. Os personagens aparecem quando você abre o livro.</p>
      ) : status === "error" ? (
        <p className="explore-note">Não foi possível buscar livros agora. Tente de novo em instantes.</p>
      ) : status === "loading" ? (
        <p className="explore-note">
          {slow ? "O acervo está demorando mais que o normal… quase lá." : "Procurando no acervo…"}
        </p>
      ) : status === "ready" && books.length === 0 ? (
        <p className="explore-note">Nenhum livro encontrado para “{term}”.</p>
      ) : (
        <p className="explore-note">
          {total === null
            ? `Livros para “${term}”`
            : `${total.toLocaleString("pt-BR")} ${total === 1 ? "livro" : "livros"} para “${term}”`}
        </p>
      )}

      {status !== "error" ? (
        <div className="result-grid">
          {searching && status === "loading"
            ? Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="result result-skeleton" aria-hidden="true">
                  <div className="cover" />
                  <span />
                  <span />
                </div>
              ))
            : shown.map((b) => (
                <button key={b.id} type="button" className="result" onClick={() => onOpen(b)}>
                  <BookCover book={b} />
                  <strong>{b.title}</strong>
                  <span>
                    {b.author}
                    {b.textLanguage === "pt" ? " · PT" : ""}
                  </span>
                </button>
              ))}
        </div>
      ) : null}

      {searching && status === "ready" && next ? (
        <div className="explore-more">
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Livros começados, para retomar do ponto onde o leitor parou. */
function ContinueReading({ items, onOpen }: { items: ReadingProgress[]; onOpen: (b: Ebook) => void }) {
  return (
    <section className="shelf continue">
      <div className="shelf-head">
        <h2>Continue lendo</h2>
        <p>Volte exatamente de onde parou.</p>
      </div>
      <div className="result-grid">
        {items.map((p) => {
          const pct = Math.round(progressPct(p));
          return (
            <button
              key={p.book.gutenbergId}
              type="button"
              className="result"
              onClick={() => onOpen(p.book)}
              aria-label={`Continuar ${p.book.title}, ${p.chapterLabel}, ${pct}% lido`}
            >
              <BookCover book={p.book} />
              <span className="continue-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(pct, 3)}%` }} />
              </span>
              <strong>{p.book.title}</strong>
              <span>
                {p.chapterLabel} · {pct}%
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const [book, setBook] = useState<Ebook | null>(null);

  const [fullText, setFullText] = useState("");
  const [chapterIndex, setChapterIndex] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  /** Elenco do livro aberto (null enquanto a IA ainda está sugerindo). */
  const [cast, setCast] = useState<StoryCharacter[] | null>(null);
  const [activeCharId, setActiveCharId] = useState<string>("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  /** No celular o chat abre como painel por cima do texto. */
  const [chatOpen, setChatOpen] = useState(false);

  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Preferência só não fica salva.
    }
  }, [prefs]);

  const readRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [scrollRatio, setScrollRatio] = useState(0);
  /** Uma dica de “meio de capítulo” por índice de capítulo (evita várias mensagens seguidas). */
  const midChapterNudgeSentRef = useRef<Record<number, boolean>>({});
  /** Rolagem salva a reaplicar quando o capítulo onde o leitor parou for desenhado. */
  const restoreScrollRef = useRef<number | null>(null);
  /** Livro + capítulo na tela: resultados de tradução de outro capítulo são descartados. */
  const chapterKey = book ? `${book.gutenbergId}:${chapterIndex}` : "";
  const chapterKeyRef = useRef(chapterKey);
  chapterKeyRef.current = chapterKey;
  /** Trecho de tradução no topo da tela, medido junto com a rolagem. */
  const [visibleChunk, setVisibleChunk] = useState<{ key: string; chunk: number } | null>(null);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;

    setLoadState("loading");
    setLoadError(null);
    setFullText("");
    setChapterIndex(0);
    setScrollRatio(0);
    midChapterNudgeSentRef.current = {};

    fetchBookText(book.gutenbergId)
      .then((text) => {
        if (cancelled) return;
        const saved = loadProgress(book.gutenbergId);
        const chapterCount = splitIntoChapters(text).length;
        if (saved && saved.chapterIndex < chapterCount) {
          setChapterIndex(saved.chapterIndex);
          restoreScrollRef.current = saved.scrollRatio;
          // Quem volta para o meio do capítulo não precisa da dica de “meio de capítulo”.
          if (saved.scrollRatio >= 0.42) midChapterNudgeSentRef.current[saved.chapterIndex] = true;
        }
        setFullText(text);
        setLoadState("ready");
        return loadCast(book, text.slice(0, 3000)).then((list) => {
          if (cancelled) return;
          setCast(list);
          setThreads((prev) => (Object.keys(prev).length > 0 ? prev : initialThreadsFor(list)));
          setActiveCharId((id) => id || list[0]?.id || "");
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(err instanceof Error ? err.message : "Erro ao carregar o livro.");
      });

    return () => {
      cancelled = true;
    };
  }, [book, loadAttempt]);

  const onReadScroll = useCallback(() => {
    const el = readRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const r = max <= 0 ? 0 : el.scrollTop / max;
    setScrollRatio(r);

    // Busca binária pelo primeiro parágrafo visível (estão em ordem na página).
    const els = el.querySelectorAll<HTMLElement>("[data-chunk]");
    if (els.length === 0) return;
    const top = el.getBoundingClientRect().top;
    let lo = 0;
    let hi = els.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (els[mid].getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    const chunk = Number(els[lo].dataset.chunk);
    const key = chapterKeyRef.current;
    setVisibleChunk((v) => (v?.key === key && v.chunk === chunk ? v : { key, chunk }));
  }, []);

  const prevChapterIdxRef = useRef<number | null>(null);

  const startBook = useCallback((b: Ebook) => {
    prevChapterIdxRef.current = null;
    setBook(b);
    setCast(null);
    setActiveCharId("");
    setThreads({});
    setError(null);
    setInput("");
    setChatOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  const leaveBook = useCallback(() => {
    prevChapterIdxRef.current = null;
    setBook(null);
    setCast(null);
    setActiveCharId("");
    setThreads({});
    setError(null);
    setInput("");
    setFullText("");
    setChapterIndex(0);
    midChapterNudgeSentRef.current = {};
    setLoadState("idle");
    setLoadError(null);
    setChatOpen(false);
  }, []);

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  const characters = cast ?? [];
  const character = useMemo(
    () => characters.find((c) => c.id === activeCharId) ?? characters[0],
    [activeCharId, characters],
  );

  const messages = character ? (threads[character.id] ?? EMPTY_THREAD) : EMPTY_THREAD;

  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activeCharId, loading, chatOpen]);

  const providerLabel = providerDisplayLabel();

  const chapters = useMemo(() => (fullText ? splitIntoChapters(fullText) : []), [fullText]);
  const currentChapter = chapters[chapterIndex] ?? chapters[0];

  useEffect(() => {
    setScrollRatio(0);
  }, [chapterIndex]);

  /** Capítulo novo começa do topo; ao reabrir o livro, volta para onde o leitor parou. */
  useEffect(() => {
    if (loadState !== "ready") return;
    const frame = requestAnimationFrame(() => {
      const el = readRef.current;
      const ratio = restoreScrollRef.current;
      restoreScrollRef.current = null;
      if (!el) return;
      el.scrollTop = ratio ? ratio * (el.scrollHeight - el.clientHeight) : 0;
      onReadScroll();
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterIndex, loadState, onReadScroll]);

  useEffect(() => {
    if (!book || loadState !== "ready" || !currentChapter) return;
    if (restoreScrollRef.current !== null) return; // Ainda não voltou para a posição salva.
    // Abrir e fechar um livro sem ler nada não o coloca em “Continue lendo”.
    if (chapterIndex === 0 && scrollRatio < 0.02 && !loadProgress(book.gutenbergId)) return;
    const t = setTimeout(
      () =>
        saveProgress({
          book,
          chapterIndex,
          chapterLabel: currentChapter.label,
          chapterCount: chapters.length,
          scrollRatio,
        }),
      300,
    );
    return () => clearTimeout(t);
  }, [book, loadState, chapterIndex, currentChapter, chapters.length, scrollRatio]);

  /** Ao trocar de personagem, não dispara de novo a dica do meio se a rolagem já passou do meio. */
  useEffect(() => {
    const el = readRef.current;
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    const r = !el || max <= 0 ? 0 : el.scrollTop / max;
    if (r >= 0.42) {
      midChapterNudgeSentRef.current[chapterIndex] = true;
    }
  }, [activeCharId, chapterIndex]);

  useEffect(() => {
    if (!character || loadState !== "ready" || !currentChapter) return;

    if (prevChapterIdxRef.current === null) {
      prevChapterIdxRef.current = chapterIndex;
      return;
    }
    if (prevChapterIdxRef.current === chapterIndex) return;

    prevChapterIdxRef.current = chapterIndex;
    const line = chapterTransitionMessage(currentChapter.label);
    setThreads((prev) => ({
      ...prev,
      [character.id]: [...(prev[character.id] ?? []), { id: uid(), role: "assistant", text: line }],
    }));
  }, [chapterIndex, character, loadState, currentChapter, activeCharId]);

  useEffect(() => {
    if (!character || !currentChapter || loadState !== "ready" || loading) return;
    if (scrollRatio < 0.42) return;
    if (midChapterNudgeSentRef.current[chapterIndex]) return;
    midChapterNudgeSentRef.current[chapterIndex] = true;
    const line = midChapterReadingHint(currentChapter.label);
    setThreads((prev) => ({
      ...prev,
      [character.id]: [...(prev[character.id] ?? []), { id: uid(), role: "assistant", text: line }],
    }));
  }, [scrollRatio, character, currentChapter, loadState, loading, chapterIndex]);

  const displayedStory = currentChapter?.body ?? "";

  const blocks = useMemo(
    () => toBlocks(displayedStory, currentChapter?.label),
    [displayedStory, currentChapter],
  );
  const dropCapIndex = useMemo(
    () => blocks.findIndex((b) => b.kind === "p" && b.text.length > 80),
    [blocks],
  );

  /* ---- Tradução dos livros em inglês: trecho a trecho, conforme o leitor avança. ---- */
  const [engine, setEngine] = useState<TranslationEngine>("google");
  useEffect(() => {
    let alive = true;
    void detectTranslationEngine().then((e) => alive && setEngine(e));
    return () => {
      alive = false;
    };
  }, []);
  const canTranslate = book?.textLanguage === "en";
  const translateOn = canTranslate && prefs.translate;
  const chunks = useMemo(() => chunkRanges(blocks.map((b) => b.text)), [blocks]);
  const [translated, setTranslated] = useState<{
    key: string;
    byChunk: Record<number, (string | null)[]>;
  }>({ key: "", byChunk: {} });
  const translations = translated.key === chapterKey ? translated.byChunk : {};
  const [translatingChunk, setTranslatingChunk] = useState<number | null>(null);
  const [failedChunks, setFailedChunks] = useState<number[]>([]);

  /** Troca de capítulo: começa com o que já foi traduzido antes e está guardado. */
  useEffect(() => {
    const cached: Record<number, (string | null)[]> = {};
    if (book && canTranslate) {
      chunks.forEach((_, c) => {
        const t = cachedTranslation(book.gutenbergId, chapterIndex, c);
        if (t) cached[c] = t;
      });
    }
    setTranslated({ key: chapterKeyRef.current, byChunk: cached });
    setTranslatingChunk(null);
    setFailedChunks([]);
  }, [book, canTranslate, chapterIndex, chunks]);

  /** Traduz o trecho visível e o seguinte, um pedido por vez. */
  useEffect(() => {
    if (!book || !translateOn || loadState !== "ready" || translatingChunk !== null) return;
    // Espera o capítulo carregar o que está guardado e a rolagem ser medida.
    if (translated.key !== chapterKey || visibleChunk?.key !== chapterKey) return;
    const c = [visibleChunk.chunk, visibleChunk.chunk + 1].find(
      (n) => n < chunks.length && !translations[n] && !failedChunks.includes(n),
    );
    if (c === undefined) return;
    const key = chapterKey;
    const [start, end] = chunks[c];
    // Espera a rolagem parar: quem passa correndo pelo capítulo não dispara um pedido por trecho.
    const t = setTimeout(() => {
      setTranslatingChunk(c);
      translateParagraphs(engine, blocks.slice(start, end).map((b) => b.text))
        .then((result) => {
          storeTranslation(book.gutenbergId, chapterIndex, c, result);
          if (chapterKeyRef.current === key) {
            setTranslated((prev) => ({ key, byChunk: { ...prev.byChunk, [c]: result } }));
          }
        })
        .catch((err) => {
          console.warn("Falha na tradução:", err);
          if (chapterKeyRef.current === key) setFailedChunks((prev) => [...prev, c]);
        })
        .finally(() => {
          if (chapterKeyRef.current === key) setTranslatingChunk(null);
        });
    }, 700);
    return () => clearTimeout(t);
  }, [
    engine,
    book,
    translateOn,
    loadState,
    translatingChunk,
    visibleChunk,
    chunks,
    translated,
    failedChunks,
    chapterKey,
    chapterIndex,
    blocks,
  ]);

  const chunkOfBlock = useMemo(() => {
    const map: number[] = [];
    chunks.forEach(([start, end], c) => {
      for (let i = start; i < end; i++) map[i] = c;
    });
    return map;
  }, [chunks]);

  /** Posição aproximada no livro inteiro (capítulos anteriores + rolagem no atual). */
  const readingProgressPct =
    chapters.length > 0 ? ((chapterIndex + scrollRatio) / chapters.length) * 100 : 0;
  const textExcerpt = useMemo(
    () => excerptNearScrollRatio(displayedStory, scrollRatio, 2000),
    [displayedStory, scrollRatio],
  );

  async function sendMessage(raw: string) {
    if (!book || !character || loadState !== "ready" || !displayedStory) return;
    const text = raw.trim();
    if (!text || loading) return;

    setError(null);
    setInput("");
    const userMsg: Msg = { id: uid(), role: "user", text };
    setThreads((prev) => ({
      ...prev,
      [character.id]: [...(prev[character.id] ?? []), userMsg],
    }));

    const prior = [...(threads[character.id] ?? []), userMsg];
    const history: ChatTurn[] = prior
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.text }));

    setLoading(true);
    try {
      const reply = await characterReply({
        character,
        history: history.slice(0, -1),
        userMessage: text,
        ebookTitle: book.title,
        ebookAuthor: book.author,
        textExcerpt,
        readingProgressPct,
        textLanguage: book.textLanguage,
      });
      const botMsg: Msg = { id: uid(), role: "assistant", text: reply };
      setThreads((prev) => ({
        ...prev,
        [character.id]: [...(prev[character.id] ?? []), botMsg],
      }));
    } catch (err) {
      console.warn("Falha no envio da mensagem:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível concluir o envio. Tente de novo.",
      );
      setThreads((prev) => ({
        ...prev,
        [character.id]: [...(prev[character.id] ?? []).filter((m) => m.id !== userMsg.id)],
      }));
      setInput(text);
    } finally {
      setLoading(false);
    }
  }

  function onSend(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  if (!book) {
    const recent = recentProgress();
    const progressById = new Map(recent.map((p) => [p.book.gutenbergId, p]));
    const heroBook = featuredBooks.find((b) => b.demo && b.characters?.length);
    const heroChar = heroBook?.characters?.[0];
    return (
      <div className="home">
        <nav className="home-nav">
          <span className="wordmark">
            <span className="wordmark-mark" aria-hidden="true">
              ✦
            </span>
            Storyverse
          </span>
          <span className="status" title="Mostra se o chat usa IA em tempo real ou respostas de demonstração.">
            <span className="status-dot" aria-hidden="true" />
            {providerLabel}
          </span>
        </nav>

        <header className="hero">
          <div className="hero-copy">
            <span className="eyebrow">Leitura interativa</span>
            <h1 className="hero-title">
              Leia o livro.
              <br />
              <em>Converse com quem vive nele.</em>
            </h1>
            <p className="hero-sub">
              Enquanto você lê, os personagens acompanham o seu ritmo e respondem no chat — com a voz, o
              tom e os segredos da própria história.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href="#destaques">
                Ver os destaques
              </a>
              <a className="btn btn-lg" href="#acervo">
                Buscar no acervo
              </a>
            </div>
          </div>

          {heroBook?.demo && heroChar ? (
            <button
              type="button"
              className="hero-demo"
              onClick={() => startBook(heroBook)}
              aria-label={`Abrir ${heroBook.title}`}
            >
              <div className="demo-page">
                <span className="demo-chapter">{heroBook.demo.chapterLabel}</span>
                <p>
                  <span className="demo-dropcap">{heroBook.demo.pageOpening.charAt(0)}</span>
                  {heroBook.demo.pageOpening.slice(1)}
                </p>
                <div className="demo-lines">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="demo-chat">
                <div className="demo-chat-head">
                  <Avatar character={heroChar} size="sm" />
                  <div>
                    <strong>{heroChar.name}</strong>
                    <small>{heroBook.title}</small>
                  </div>
                </div>
                <div className="bubble user">{heroBook.demo.question}</div>
                <div className="bubble assistant">{heroBook.demo.answer}</div>
              </div>
            </button>
          ) : null}
        </header>

        <section className="steps" aria-label="Como funciona">
          <div className="step">
            <span className="step-n">1</span>
            <h3>Escolha uma história</h3>
            <p>Romances em português, terror, vampiros e mistério, ou qualquer livro do acervo.</p>
          </div>
          <div className="step">
            <span className="step-n">2</span>
            <h3>Leia no seu ritmo</h3>
            <p>Capítulo a capítulo, com modo noturno ou sépia e letra do tamanho que preferir.</p>
          </div>
          <div className="step">
            <span className="step-n">3</span>
            <h3>Converse com os personagens</h3>
            <p>Pergunte, provoque, desabafe — eles sabem onde você parou e não dão spoiler.</p>
          </div>
        </section>

        {recent.length > 0 ? <ContinueReading items={recent} onOpen={startBook} /> : null}

        {SHELVES.map((shelf, si) => {
          const books = featuredBooks.filter((b) => (b.shelf ?? "classicos") === shelf.id);
          if (books.length === 0) return null;
          return (
            <section key={shelf.id} className="shelf" id={si === 0 ? "destaques" : undefined}>
              <div className="shelf-head">
                <h2>{shelf.title}</h2>
                <p>{shelf.subtitle}</p>
              </div>
              <div className="shelf-grid">
                {books.map((b) => (
                  <article key={b.id} className="book">
                    <button
                      type="button"
                      className="book-cover-btn"
                      onClick={() => startBook(b)}
                      aria-label={`Abrir ${b.title}`}
                    >
                      <BookCover book={b} />
                    </button>
                    <div className="book-info">
                      <div className="book-tags">
                        {b.genre ? <span className="genre-tag">{b.genre}</span> : null}
                        <LangBadge book={b} />
                      </div>
                      <h3>{b.title}</h3>
                      <p className="book-author">{b.author}</p>
                      {b.blurb ? <p className="book-blurb">{b.blurb}</p> : null}
                      {b.characters?.length ? (
                        <div className="book-cast">
                          <span className="avatar-stack">
                            {b.characters.map((c) => (
                              <Avatar key={c.id} character={c} size="sm" />
                            ))}
                          </span>
                          <span>Converse com {listNames(b.characters.map(shortNameOf))}</span>
                        </div>
                      ) : null}
                      <div className="book-actions">
                        <button type="button" className="btn btn-primary" onClick={() => startBook(b)}>
                          {progressById.has(b.gutenbergId) ? "Continuar lendo" : "Começar a ler"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}

        <Explore onOpen={startBook} />

        <footer className="home-foot">
          Storyverse · leitura que conversa com você · textos em domínio público do{" "}
          <a href="https://www.gutenberg.org" target="_blank" rel="noreferrer">
            Project Gutenberg
          </a>
          <span className="home-credit">
            Desenvolvido por <strong>Guilherme Pinheiro</strong>
          </span>
        </footer>
      </div>
    );
  }

  const ready = loadState === "ready" && fullText.length > 0;
  const castReady = cast !== null;
  const userHasSpoken = messages.some((m) => m.role === "user");
  const hasNextChapter = chapterIndex < chapters.length - 1;

  return (
    <div className={`reader theme-${prefs.theme}`}>
      <header className="reader-bar">
        <button type="button" className="icon-btn" onClick={leaveBook} aria-label="Voltar para a estante">
          {Icon.back}
        </button>
        <div className="reader-title">
          <strong>{book.title}</strong>
          <span>
            {book.author}
            {currentChapter ? ` · ${currentChapter.label}` : ""}
          </span>
        </div>

        {chapters.length > 1 ? (
          <div className="chapter-nav">
            <button
              type="button"
              className="icon-btn"
              disabled={chapterIndex <= 0}
              onClick={() => setChapterIndex((i) => Math.max(0, i - 1))}
              aria-label="Capítulo anterior"
            >
              {Icon.back}
            </button>
            <select
              className="chapter-select"
              value={chapterIndex}
              onChange={(e) => setChapterIndex(Number(e.target.value))}
              aria-label="Escolher capítulo"
            >
              {chapters.map((ch, i) => (
                <option key={ch.index} value={i}>
                  {ch.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              disabled={!hasNextChapter}
              onClick={() => setChapterIndex((i) => Math.min(chapters.length - 1, i + 1))}
              aria-label="Próximo capítulo"
            >
              {Icon.next}
            </button>
          </div>
        ) : null}

        <div className="reader-tools">
          {canTranslate ? (
            <button
              type="button"
              className={`icon-btn text-btn translate-btn ${prefs.translate ? "is-active" : ""}`}
              onClick={() => {
                if (!prefs.translate && engine === "local") warmUpLocalTranslator();
                setPrefs((p) => ({ ...p, translate: !p.translate }));
              }}
              aria-pressed={prefs.translate}
              aria-label={prefs.translate ? "Ver o texto original em inglês" : "Traduzir para o português"}
              title={prefs.translate ? "Ver o original em inglês" : "Traduzir para o português"}
            >
              {prefs.translate ? "PT" : "EN"}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn text-btn"
            disabled={prefs.fontStep <= 0}
            onClick={() => setPrefs((p) => ({ ...p, fontStep: p.fontStep - 1 }))}
            aria-label="Diminuir letra"
          >
            A<small>−</small>
          </button>
          <button
            type="button"
            className="icon-btn text-btn"
            disabled={prefs.fontStep >= FONT_SIZES.length - 1}
            onClick={() => setPrefs((p) => ({ ...p, fontStep: p.fontStep + 1 }))}
            aria-label="Aumentar letra"
          >
            A<small>+</small>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setPrefs((p) => ({ ...p, theme: p.theme === "night" ? "sepia" : "night" }))}
            aria-label={prefs.theme === "night" ? "Mudar para modo sépia" : "Mudar para modo noturno"}
          >
            {prefs.theme === "night" ? Icon.sun : Icon.moon}
          </button>
        </div>

        <div className="progress" aria-hidden="true">
          <span style={{ width: `${readingProgressPct}%` }} />
        </div>
      </header>

      <div className="reader-layout">
        <main
          ref={readRef}
          className="page"
          onScroll={onReadScroll}
          style={{ "--read-size": `${FONT_SIZES[prefs.fontStep]}rem` } as React.CSSProperties}
        >
          {loadState === "loading" ? (
            <div className="page-status">
              <span className="spinner" aria-hidden="true" />
              Buscando o livro no acervo…
            </div>
          ) : null}

          {loadState === "error" ? (
            <div className="page-status page-status-err">
              <p>{loadError}</p>
              <button type="button" className="btn btn-primary" onClick={retryLoad}>
                Tentar de novo
              </button>
            </div>
          ) : null}

          {ready && currentChapter ? (
            <article className="prose" aria-label="Texto do capítulo">
              <header className="chapter-head">
                <span>
                  {chapterIndex + 1} de {chapters.length}
                </span>
                <h1>{currentChapter.label}</h1>
                <span className="chapter-ornament" aria-hidden="true">
                  ✦
                </span>
              </header>

              {translateOn ? (
                <div className="translate-note" role="status">
                  {failedChunks.length > 0 ? (
                    <>
                      Parte deste capítulo não pôde ser traduzida agora.{" "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          if (engine === "local") warmUpLocalTranslator();
                          setFailedChunks([]);
                        }}
                      >
                        Tentar de novo
                      </button>
                    </>
                  ) : translatingChunk !== null && !translations[visibleChunk?.chunk ?? 0] ? (
                    "Traduzindo este trecho…"
                  ) : (
                    "Tradução automática. Pode conter imprecisões."
                  )}
                </div>
              ) : null}

              {blocks.map((b, i) => {
                const c = chunkOfBlock[i];
                const translated = translateOn ? translations[c]?.[i - chunks[c][0]] : null;
                const pending = translateOn && !translations[c];
                const text = withItalics(translated ?? b.text);
                const className =
                  [i === dropCapIndex ? "dropcap" : "", pending ? "is-translating" : ""]
                    .filter(Boolean)
                    .join(" ") || undefined;
                return b.kind === "heading" ? (
                  <h2 key={i} data-chunk={c} className={className}>
                    {text}
                  </h2>
                ) : (
                  <p key={i} data-chunk={c} className={className}>
                    {text}
                  </p>
                );
              })}

              <footer className="chapter-end">
                {hasNextChapter ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={() => setChapterIndex((i) => i + 1)}
                  >
                    Próximo capítulo {Icon.next}
                  </button>
                ) : (
                  <p className="the-end">Fim — mas a conversa continua ao lado.</p>
                )}
                <a
                  className="source-link"
                  href={`https://www.gutenberg.org/ebooks/${book.gutenbergId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Ver esta obra no Project Gutenberg ↗
                </a>
              </footer>
            </article>
          ) : null}
        </main>

        <aside className={`chat ${chatOpen ? "is-open" : ""}`} aria-label="Conversa com os personagens">
          {character ? (
            <div className="chat-head">
              <Avatar character={character} size="lg" />
              <div className="chat-head-text">
                <strong>{character.name}</strong>
                <span>{character.role}</span>
              </div>
              <button
                type="button"
                className="icon-btn chat-close"
                onClick={() => setChatOpen(false)}
                aria-label="Fechar conversa"
              >
                {Icon.close}
              </button>
            </div>
          ) : (
            <div className="chat-head chat-head-pending">
              <span className="spinner" aria-hidden="true" />
              <div className="chat-head-text">
                <strong>{ready ? "Conhecendo os personagens…" : "Abrindo o livro…"}</strong>
                <span>Em instantes eles chegam para conversar</span>
              </div>
              <button
                type="button"
                className="icon-btn chat-close"
                onClick={() => setChatOpen(false)}
                aria-label="Fechar conversa"
              >
                {Icon.close}
              </button>
            </div>
          )}

          {characters.length > 1 ? (
            <div className="cast" role="tablist" aria-label="Personagens">
              {characters.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === character?.id}
                  className={`cast-chip ${c.id === character?.id ? "active" : ""}`}
                  style={{ "--c": c.color } as React.CSSProperties}
                  onClick={() => setActiveCharId(c.id)}
                >
                  <Avatar character={c} size="sm" />
                  {shortNameOf(c)}
                </button>
              ))}
            </div>
          ) : null}

          <div ref={chatBodyRef} className="chat-body">
            {messages.map((m) =>
              m.role === "assistant" && character ? (
                <div key={m.id} className="msg msg-assistant">
                  <Avatar character={character} size="sm" />
                  <div className="bubble assistant">{m.text}</div>
                </div>
              ) : (
                <div key={m.id} className="msg msg-user">
                  <div className="bubble user">{m.text}</div>
                </div>
              ),
            )}
            {loading && character ? (
              <div className="msg msg-assistant">
                <Avatar character={character} size="sm" />
                <div className="bubble assistant typing" aria-label={`${character.name} está escrevendo`}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}
          </div>

          {error ? <div className="chat-err">{error}</div> : null}

          {!userHasSpoken && character && ready && !loading ? (
            <div className="suggestions">
              {suggestionsFor(character).map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => void sendMessage(s)}>
                  {s}
                </button>
              ))}
            </div>
          ) : null}

          <form className="composer" onSubmit={onSend}>
            <textarea
              ref={inputRef}
              rows={1}
              maxLength={USER_MESSAGE_MAX_CHARS}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                ready && character ? `Escreva para ${shortNameOf(character)}…` : "Aguarde um instante…"
              }
              disabled={loading || !ready || !castReady || !character}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage(input);
                }
              }}
            />
            <button
              type="submit"
              className="send-btn"
              disabled={loading || !ready || !character || !input.trim()}
              aria-label="Enviar"
            >
              {Icon.send}
            </button>
          </form>
        </aside>

        {!chatOpen ? (
          <button
            type="button"
            className="chat-fab"
            onClick={() => {
              setChatOpen(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            {character ? <Avatar character={character} size="sm" /> : null}
            {character ? `Conversar com ${shortNameOf(character)}` : "Conversar"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
