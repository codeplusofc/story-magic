import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { featuredBooks, suggestedBooks } from "./data/ebooks";
import type { Ebook, StoryCharacter } from "./data/types";
import {
  characterReply,
  detectProvider,
  providerDisplayLabel,
  USER_MESSAGE_MAX_CHARS,
  type ChatTurn,
} from "./lib/ai";
import { castFromNames, forgetCast, loadCast } from "./lib/cast";
import { forgetChat, loadChat, saveChat } from "./lib/chatHistory";
import { lookupWord, normalizeWord, type WordInfo } from "./lib/dictionary";
import {
  forgetHighlights,
  loadHighlights,
  MAX_HIGHLIGHT_CHARS,
  saveHighlights,
  splitByHighlights,
  type Highlight,
} from "./lib/highlights";
import { splitIntoChapters } from "./lib/chapters";
import { fetchBookText, searchBooks, type SearchLanguage } from "./lib/gutenberg";
import { ACCEPTED_EXTENSIONS, importBookFile, type ImportedBook } from "./lib/importBook";
import {
  deleteLocalBook,
  isLocalBook,
  listLocalBooks,
  loadLocalBookText,
  newLocalBookId,
  saveLocalBook,
} from "./lib/localBooks";
import {
  loadProgress,
  progressPct,
  recentProgress,
  removeProgress,
  saveProgress,
  type ReadingProgress,
} from "./lib/progress";
import { chapterTransitionMessage, midChapterReadingHint, missYouMessage } from "./lib/readingAmbient";
import { searchOutsideCatalog, type BookHint } from "./lib/openLibrary";
import { cachedPortrait, requestPortrait } from "./lib/portraits";
import { excerptNearScrollRatio } from "./lib/readingContext";
import {
  addReadingSeconds,
  GOAL_OPTIONS,
  hasAnyReading,
  lastReadDay,
  readingSummary,
  reconcileStreak,
  setReadingGoalMinutes,
  takeShieldNotice,
  type ReadingEvents,
} from "./lib/readingStats";
import {
  disableDailyNotifications,
  downloadIcs,
  enableDailyNotifications,
  googleCalendarUrl,
  lastCharacter,
  loadReminderPrefs,
  notificationSupport,
  rememberCharacter,
  reminderText,
  saveReminderPrefs,
  sendTestNotification,
  syncEngagementState,
} from "./lib/reminders";
import { useInstallPrompt, useUpdateReady } from "./lib/pwa";
import { renderShareCard, shareOrDownload, type ShareCardInput } from "./lib/shareCard";
import {
  listVoices,
  RATE_OPTIONS,
  saveRate,
  savedRate,
  savedVoiceUri,
  saveVoiceUri,
  speakParagraphs,
  speakSample,
  speechSupported,
  type SpeechSession,
  type VoiceOption,
} from "./lib/speech";
import { countMessage, DAILY_MESSAGE_LIMIT, messagesLeftToday } from "./lib/usageLimit";
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

/** Toque (celular): o menu da seleção vai abaixo do trecho, longe do menu nativo do sistema. */
function coarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
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

/**
 * Avatar do personagem: a inicial do nome e, por cima, o retrato (ilustração livre ou gerada),
 * quando houver. `generate` pede o retrato se ainda não existir (no leitor); sem ele, só mostra
 * retratos já guardados neste aparelho (página inicial, para não disparar dezenas de pedidos).
 */
function Avatar({
  character,
  size = "md",
  bookTitle,
  generate = false,
}: {
  character: StoryCharacter;
  size?: "sm" | "md" | "lg";
  bookTitle?: string;
  generate?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(() => (bookTitle ? cachedPortrait(character, bookTitle) : null));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!bookTitle) return;
    const cached = cachedPortrait(character, bookTitle);
    if (cached) {
      setSrc(cached);
      return;
    }
    setSrc(null);
    setLoaded(false);
    if (!generate) return;
    let alive = true;
    void requestPortrait(character, bookTitle).then((url) => {
      if (alive && url) setSrc(url);
    });
    return () => {
      alive = false;
    };
    // O objeto do personagem muda a cada render; nome e id bastam.
  }, [character.id, character.name, bookTitle, generate]);

  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ "--c": character.color } as React.CSSProperties}
      aria-hidden="true"
    >
      {shortNameOf(character).replace(/^(O|A|Mr\.|Mrs\.|Dr\.)\s+/i, "").charAt(0).toUpperCase()}
      {src ? (
        <img
          className={`avatar-photo ${loaded ? "is-loaded" : ""}`}
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setSrc(null)}
        />
      ) : null}
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
  speaker: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  bookmark: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12v18l-6-4-6 4V3z" />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M16 6l-4-4-4 4M12 2v13" />
    </svg>
  ),
  highlight: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 11l-6 6v3h3l6-6M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  ),
  book: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
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
function Explore({
  onOpen,
  onImport,
}: {
  onOpen: (b: Ebook) => void;
  /** Abre o formulário de importação; com `hint`, já preenchido com o livro escolhido. */
  onImport: (hint?: BookHint) => void;
}) {
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

  /** Livros famosos fora do acervo (Open Library), buscados junto com o Gutenberg. */
  const [outside, setOutside] = useState<BookHint[]>([]);
  useEffect(() => {
    setOutside([]);
    if (!searching) return;
    let cancelled = false;
    const t = setTimeout(() => {
      searchOutsideCatalog(term)
        .then((hints) => !cancelled && setOutside(hints))
        .catch(() => undefined); // Sem a Open Library, a busca do acervo continua normal.
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, searching]);

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
        <p className="explore-note">
          Nenhum livro encontrado para “{term}”. O acervo só tem livros em domínio público; se você
          tem o arquivo do livro,{" "}
          <button type="button" className="inline-link" onClick={() => onImport()}>
            importe o seu
          </button>
          .
        </p>
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

      {searching && outside.length > 0 ? (
        <div className="outside">
          <div className="outside-head">
            <h3>Fora do acervo</h3>
            <p>
              Estes livros ainda têm direitos autorais, então não estão no acervo. Tem o arquivo? Importe e
              leia aqui, com os personagens.
            </p>
          </div>
          <div className="result-grid">
            {outside.map((h) => (
              <div key={`${h.title}|${h.author}`} className="result outside-book">
                <div className="cover">
                  <img className="cover-photo is-loaded" src={h.coverUrl} alt="" loading="lazy" />
                </div>
                <strong>{h.title}</strong>
                <span>
                  {h.author}
                  {h.year ? ` · ${h.year}` : ""}
                </span>
                <button
                  type="button"
                  className="btn outside-import"
                  onClick={() => onImport(h)}
                  aria-label={`Importar o meu arquivo de ${h.title}`}
                >
                  {Icon.upload}
                  Importar
                </button>
              </div>
            ))}
          </div>
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

/** Livros do próprio leitor (.epub, .pdf, .txt): lidos e guardados só neste aparelho. */
function MyBooks({
  onOpen,
  onRemoved,
  request,
  setRequest,
}: {
  onOpen: (b: Ebook) => void;
  onRemoved: () => void;
  /**
   * Formulário aberto (`null` = fechado). Abre pelo topo da página, pelo destaque e pela busca;
   * vindo de um livro "Fora do acervo", já traz título, autor e capa.
   */
  request: BookHint | Record<string, never> | null;
  setRequest: (r: BookHint | Record<string, never> | null) => void;
}) {
  const open = request !== null;
  const hint = request && "title" in request ? request : null;
  const [books, setBooks] = useState<Ebook[]>([]);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ImportedBook | null>(null);
  const [fileName, setFileName] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [language, setLanguage] = useState<"pt" | "en">("pt");
  const [castText, setCastText] = useState("");

  useEffect(() => {
    void listLocalBooks().then(setBooks);
  }, []);

  const chapterCount = useMemo(() => (parsed ? splitIntoChapters(parsed.text).length : 0), [parsed]);

  const close = useCallback(() => {
    if (saving) return;
    setRequest(null);
    setParsing(false);
    setError(null);
    setParsed(null);
    setFileName("");
    setTitle("");
    setAuthor("");
    setCastText("");
  }, [saving, setRequest]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setParsed(null);
    setFileName(file.name);
    setParsing(true);
    try {
      const book = await importBookFile(file);
      setParsed(book);
      // Livro escolhido em "Fora do acervo": vale o título em português do catálogo.
      setTitle(hint?.title ?? book.title);
      setAuthor(hint?.author || book.author);
      setLanguage(book.language);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível ler este arquivo.");
    } finally {
      setParsing(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed || saving) return;
    const id = newLocalBookId();
    const bookTitle = title.trim() || "Meu livro";
    const characters = castFromNames(bookTitle, castText);
    const book: Ebook = {
      id: `local-${-id}`,
      gutenbergId: id,
      title: bookTitle,
      author: author.trim() || "Autor não informado",
      genre: "Meu livro",
      // Capa: a do catálogo (livro escolhido em "Fora do acervo") ou a que veio no arquivo.
      ...((hint?.coverUrl ?? parsed.cover) ? { coverUrl: hint?.coverUrl ?? parsed.cover } : {}),
      textLanguage: language,
      source: "local",
      // Sem nomes digitados, a IA sugere o elenco ao abrir o livro (uma vez só).
      ...(characters.length > 0 ? { characters } : {}),
    };
    setSaving(true);
    try {
      await saveLocalBook(book, parsed.text);
      setBooks((prev) => [book, ...prev]);
      setSaving(false);
      close();
      onOpen(book);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível guardar o livro.");
      setSaving(false);
    }
  }

  async function remove(b: Ebook) {
    if (!window.confirm(`Remover “${b.title}” deste aparelho? O progresso de leitura também será apagado.`)) {
      return;
    }
    await deleteLocalBook(b.gutenbergId).catch(() => undefined);
    removeProgress(b.gutenbergId);
    forgetCast(b.id);
    forgetChat(b.id);
    forgetHighlights(b.id);
    setBooks((prev) => prev.filter((x) => x.gutenbergId !== b.gutenbergId));
    onRemoved();
  }

  return (
    <section className="shelf my-books" id="meus-livros">
      <div className="shelf-head">
        <h2>Seus livros</h2>
        <p>Tem o arquivo de um livro? Importe e converse com os personagens.</p>
      </div>

      <div className="result-grid">
        <button type="button" className="result" onClick={() => setRequest({})}>
          <div className="cover import-cover" aria-hidden="true">
            <span className="import-plus">+</span>
            <span className="import-formats">EPUB · PDF · TXT</span>
          </div>
          <strong>Importar meu livro</strong>
          <span>Fica só neste aparelho</span>
        </button>
        {books.map((b) => (
          <div key={b.gutenbergId} className="my-book">
            <button type="button" className="result" onClick={() => onOpen(b)}>
              <BookCover book={b} />
              <strong>{b.title}</strong>
              <span>{b.author}</span>
            </button>
            <button type="button" className="link-btn my-book-remove" onClick={() => void remove(b)}>
              Remover
            </button>
          </div>
        ))}
      </div>

      {open ? (
        <div className="import-overlay" onClick={close}>
          <form
            className="import-panel"
            onSubmit={onSubmit}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <div className="import-head">
              <h3 id="import-title">{hint ? `Importar “${hint.title}”` : "Importar meu livro"}</h3>
              <button type="button" className="icon-btn" onClick={close} aria-label="Fechar">
                {Icon.close}
              </button>
            </div>

            <label className={`file-drop ${parsed ? "is-ready" : ""}`}>
              <input type="file" accept={ACCEPTED_EXTENSIONS} onChange={onFile} disabled={parsing || saving} />
              <strong>
                {parsing ? "Lendo o arquivo…" : fileName || "Escolher arquivo"}
              </strong>
              <span>
                {parsed
                  ? `${chapterCount} ${chapterCount === 1 ? "parte encontrada" : "partes encontradas"} · toque para trocar`
                  : ".epub, .pdf ou .txt"}
              </span>
            </label>

            {parsed ? (
              <>
                <label className="field">
                  <span>Título</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
                </label>
                <label className="field">
                  <span>Autor</span>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={120} />
                </label>
                <label className="field">
                  <span>Idioma do texto</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value as "pt" | "en")}>
                    <option value="pt">Português</option>
                    <option value="en">Inglês (dá para traduzir na leitura)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Personagens para conversar (opcional)</span>
                  <textarea
                    value={castText}
                    onChange={(e) => setCastText(e.target.value)}
                    rows={3}
                    maxLength={600}
                    placeholder={"Um por linha, por exemplo:\nBella Swan\nEdward Cullen — vampiro de 104 anos"}
                  />
                  <small>Em branco, a IA escolhe os personagens principais quando você abrir o livro.</small>
                </label>
              </>
            ) : null}

            {error ? <p className="import-error" role="alert">{error}</p> : null}

            <p className="import-note">
              O arquivo é lido no seu navegador e não é enviado para lugar nenhum. Livros com proteção
              contra cópia (DRM), como os comprados no Kindle, não abrem.
            </p>

            <div className="import-actions">
              <button type="button" className="btn" onClick={close} disabled={saving}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={!parsed || saving}>
                {saving ? "Guardando…" : "Importar e ler"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

type LastBook = { title: string; chapterLabel?: string; character?: string };

/** Lembrete diário: calendário (qualquer aparelho) e notificação (Android com o app instalado). */
function ReminderSetup({ lastBook }: { lastBook?: LastBook }) {
  const [prefs, setPrefs] = useState(loadReminderPrefs);
  const [status, setStatus] = useState<string | null>(null);
  const support = notificationSupport();
  const text = reminderText(lastBook);

  const update = (p: typeof prefs) => {
    setPrefs(p);
    saveReminderPrefs(p);
  };

  async function toggleNotifications() {
    if (prefs.notifications) {
      await disableDailyNotifications();
      update({ ...prefs, notifications: false });
      setStatus("Notificações desligadas.");
      return;
    }
    const result = await enableDailyNotifications();
    if (result === "enabled") {
      update({ ...prefs, notifications: true });
      setStatus("Pronto! Veja um exemplo de como o lembrete vai chegar.");
      void sendTestNotification();
    } else if (result === "denied") {
      setStatus("As notificações foram bloqueadas. Libere nas configurações do navegador para este site.");
    } else {
      setStatus("Este aparelho não permite lembretes automáticos. Use o calendário acima.");
    }
  }

  return (
    <div className="reminder">
      <label className="reminder-time">
        Todo dia às
        <input
          type="time"
          value={prefs.time}
          onChange={(e) => e.target.value && update({ ...prefs, time: e.target.value })}
        />
      </label>
      <div className="reminder-actions">
        <a className="btn" href={googleCalendarUrl(prefs.time, text)} target="_blank" rel="noreferrer">
          Google Agenda
        </a>
        <button type="button" className="btn" onClick={() => downloadIcs(prefs.time, text)}>
          iPhone / outro calendário
        </button>
      </div>
      <p className="reminder-note">
        O calendário do seu celular avisa todo dia no horário escolhido: <em>“{text.details}”</em>
      </p>

      {support === "supported" ? (
        <button type="button" className={`btn reminder-push ${prefs.notifications ? "is-on" : ""}`} onClick={() => void toggleNotifications()}>
          {prefs.notifications ? "🔔 Notificações ligadas — desligar" : "🔔 Receber notificações do app"}
        </button>
      ) : support === "install-first" ? (
        <p className="reminder-note">
          <strong>Instale o app</strong> (botão “Instalar”) para receber também notificações automáticas quando você
          esquecer de ler.
        </p>
      ) : null}
      {status ? <p className="reminder-status" role="status">{status}</p> : null}
    </div>
  );
}

/** Sequência de dias lendo, semana, escudos, meta diária de minutos e lembrete. */
function ReadingStreak({ lastBook }: { lastBook?: LastBook }) {
  const [summary, setSummary] = useState(readingSummary);
  const [reminderOpen, setReminderOpen] = useState(false);
  const pct = Math.min(100, (summary.todayMinutes / summary.goalMinutes) * 100);
  const goalDone = summary.todayMinutes >= summary.goalMinutes;
  return (
    <section className="streak" aria-label="Sua leitura">
      <div className="streak-main">
        <span className={`streak-flame ${summary.readToday ? "is-lit" : ""}`} aria-hidden="true">
          🔥
        </span>
        <div>
          <strong>
            {summary.streak} {summary.streak === 1 ? "dia seguido" : "dias seguidos"}
          </strong>
          <span>
            {summary.readToday
              ? "Você já leu hoje. Continue assim!"
              : summary.streak > 0
                ? "Leia hoje para não perder a sequência."
                : "Leia um pouco hoje para começar uma sequência."}
          </span>
          <span
            className="streak-shields"
            title="A cada 7 dias seguidos você ganha um escudo (até 2). Se um dia passar sem leitura, ele salva a sua sequência."
          >
            {summary.shields > 0
              ? `🛡️ ${summary.shields} ${summary.shields === 1 ? "escudo" : "escudos"} protegendo a sequência`
              : "🛡️ Ganhe um escudo a cada 7 dias seguidos"}
          </span>
        </div>
      </div>

      <ol className="streak-week" aria-label="Últimos 7 dias">
        {summary.week.map((d, i) => (
          <li
            key={i}
            className={[`is-${d.state}`, d.today ? "is-today" : ""].filter(Boolean).join(" ")}
            aria-label={`${d.today ? "Hoje" : d.label}: ${d.state === "read" ? "leu" : d.state === "frozen" ? "salvo por escudo" : "não leu"}`}
          >
            {d.state === "frozen" ? "🛡️" : d.label}
          </li>
        ))}
      </ol>

      <div className="streak-goal">
        <div className="streak-goal-text">
          <span>Meta de hoje</span>
          <strong>
            {goalDone ? "Meta cumprida! " : ""}
            {summary.todayMinutes} de {summary.goalMinutes} min
          </strong>
        </div>
        <div className={`streak-bar ${goalDone ? "is-done" : ""}`} aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="streak-goal-foot">
          <button
            type="button"
            className="inline-link"
            onClick={() => setReminderOpen((v) => !v)}
            aria-expanded={reminderOpen}
          >
            🔔 Lembrete diário
          </button>
          <label className="streak-select">
            Meta diária
            <select
              value={summary.goalMinutes}
              onChange={(e) => {
                setReadingGoalMinutes(Number(e.target.value));
                setSummary(readingSummary());
              }}
            >
              {GOAL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {reminderOpen ? <ReminderSetup lastBook={lastBook} /> : null}
    </section>
  );
}

/** Comemoração no centro da tela (meta do dia, sequência, livro terminado). */
type Celebration = { emoji: string; title: string; text?: string };

/** Quantos livros "Continue lendo" mostra antes de "Ver todos". */
const CONTINUE_PREVIEW = 4;

/** Livros começados, para retomar do ponto onde o leitor parou: os 4 mais recentes e "Ver todos". */
function ContinueReading({ items, onOpen }: { items: ReadingProgress[]; onOpen: (b: Ebook) => void }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, CONTINUE_PREVIEW);

  return (
    <section className="shelf continue">
      <div className="shelf-head">
        <h2>Continue lendo</h2>
        <p>Volte exatamente de onde parou.</p>
      </div>
      <div className="result-grid">
        {shown.map((p) => {
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
      {items.length > CONTINUE_PREVIEW ? (
        <div className="shelf-more">
          <button type="button" className="btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Mostrar menos" : `Ver todos (${items.length})`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Aplica os escudos uma vez por carregamento da página, antes de desenhar qualquer coisa (assim o
 * quadro da sequência já mostra o dia salvo). Devolve o tamanho da sequência salva, para o aviso.
 */
let shieldNoticeCache: number | null | undefined;
function shieldNoticeOnLoad(): number | null {
  if (shieldNoticeCache === undefined) {
    const r = reconcileStreak();
    shieldNoticeCache = r.shieldsUsed > 0 && takeShieldNotice() ? r.streak : null;
  }
  return shieldNoticeCache;
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
  const [messagesLeft, setMessagesLeft] = useState(messagesLeftToday);
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  useEffect(() => {
    if (!celebration) return;
    const t = window.setTimeout(() => setCelebration(null), 4200);
    return () => window.clearTimeout(t);
  }, [celebration]);
  /** Ao abrir o app: escudos salvam a sequência de ontem, se preciso (aviso uma vez por dia). */
  const [shieldNotice, setShieldNotice] = useState<number | null>(shieldNoticeOnLoad);
  /** Capítulos já comemorados nesta visita (para não repetir a cada rolagem). */
  const finishedChaptersRef = useRef(new Set<string>());
  /** Aviso curto no rodapé da tela ("Imagem salva", "Trecho destacado"). */
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  /* Marcações, seleção de texto e significado de palavras. */
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [selection, setSelection] = useState<{
    text: string;
    block: number;
    x: number;
    top: number;
    bottom: number;
    word: string | null;
  } | null>(null);
  const [wordCard, setWordCard] = useState<{ word: string; x: number; y: number; info: WordInfo | null } | null>(
    null,
  );

  /* Leitura em voz alta. */
  const [speaking, setSpeaking] = useState(false);
  const [speakingBlock, setSpeakingBlock] = useState<number | null>(null);
  const [speechRate, setSpeechRate] = useState(savedRate);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceUri, setVoiceUri] = useState<string | undefined>(undefined);
  const speechRef = useRef<SpeechSession | null>(null);
  /** A voz chegou ao fim do capítulo e segue no próximo. */
  const continueSpeechRef = useRef(false);
  /** Ao abrir um capítulo, rola até este parágrafo (vindo de uma marcação). */
  const jumpToBlockRef = useRef<number | null>(null);
  /** Última interação no leitor: o tempo de leitura só conta com o leitor presente. */
  const lastActivityRef = useRef(Date.now());

  const [prefs, setPrefs] = useState(loadPrefs);
  /** Redesenha a página inicial quando um livro importado é removido (sai de "Continue lendo"). */
  const [, setHomeTick] = useState(0);
  const [importRequest, setImportRequest] = useState<BookHint | Record<string, never> | null>(null);
  const { install } = useInstallPrompt();
  const updateReady = useUpdateReady();
  const updateBanner = updateReady ? (
    <div className="update-banner" role="status">
      <span>✨ Nova versão do Storyverse disponível.</span>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        Atualizar
      </button>
    </div>
  ) : null;
  /** Dados para a notificação diária do Android (o service worker não lê o localStorage). */
  useEffect(() => {
    if (book) return;
    const recent = recentProgress()[0];
    void syncEngagementState({
      streak: readingSummary().streak,
      lastReadDay: lastReadDay(),
      book: recent
        ? { title: recent.book.title, chapterLabel: recent.chapterLabel, character: lastCharacter(recent.book.id) }
        : undefined,
    });
  }, [book]);
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

    (isLocalBook(book) ? loadLocalBookText(book.gutenbergId) : fetchBookText(book.gutenbergId))
      .then((text) => {
        if (cancelled) return;
        const saved = loadProgress(book.gutenbergId);
        const labels = splitIntoChapters(text).map((c) => c.label);
        // Procura pelo nome do capítulo: se a divisão em capítulos mudar numa versão nova do app,
        // o número salvo pode apontar para outro capítulo.
        const savedIndex = !saved
          ? -1
          : labels[saved.chapterIndex] === saved.chapterLabel
            ? saved.chapterIndex
            : labels.indexOf(saved.chapterLabel);
        if (saved && savedIndex >= 0) {
          setChapterIndex(savedIndex);
          restoreScrollRef.current = saved.scrollRatio;
          // Quem volta para o meio do capítulo não precisa da dica de “meio de capítulo”.
          if (saved.scrollRatio >= 0.42) midChapterNudgeSentRef.current[savedIndex] = true;
        }
        setFullText(text);
        setLoadState("ready");
        // Voltou depois de dias sem abrir este livro: o personagem manda uma mensagem de saudade.
        const awayDays = saved ? Math.floor((Date.now() - saved.updatedAt) / 86_400_000) : 0;
        const awayChapter = saved?.chapterLabel;
        return loadCast(book, text.slice(0, 3000)).then((list) => {
          if (cancelled) return;
          setCast(list);
          // Conversa guardada da última vez; personagem sem conversa começa com a saudação.
          const saved = loadChat(book.id);
          const greetings = initialThreadsFor(list);
          setThreads((prev) =>
            Object.keys(prev).length > 0
              ? prev
              : Object.fromEntries(
                  list.map((c) => [c.id, saved?.threads[c.id]?.length ? saved.threads[c.id] : greetings[c.id]]),
                ),
          );
          const savedActive = saved?.activeCharId && list.some((c) => c.id === saved.activeCharId);
          const activeId = savedActive ? saved!.activeCharId : list[0]?.id;
          setActiveCharId((id) => id || activeId || "");
          if (awayDays >= 2 && awayChapter && activeId) {
            const line = missYouMessage(awayChapter, awayDays);
            setThreads((prev) => ({
              ...prev,
              [activeId]: [...(prev[activeId] ?? []), { id: uid(), role: "assistant", text: line }],
            }));
          }
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
    lastActivityRef.current = Date.now();
    setSelection(null);
    setWordCard(null);
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

  const stopSpeaking = useCallback(() => {
    speechRef.current?.stop();
    speechRef.current = null;
    continueSpeechRef.current = false;
    setSpeaking(false);
    setSpeakingBlock(null);
    setVoicePanelOpen(false);
  }, []);

  const leaveBook = useCallback(() => {
    stopSpeaking();
    setHighlightsOpen(false);
    setSelection(null);
    setWordCard(null);
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
  }, [stopSpeaking]);

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  const characters = cast ?? [];
  const character = useMemo(
    () => characters.find((c) => c.id === activeCharId) ?? characters[0],
    [activeCharId, characters],
  );

  const messages = character ? (threads[character.id] ?? EMPTY_THREAD) : EMPTY_THREAD;

  /** Guarda a conversa do livro para continuar na próxima vez. */
  useEffect(() => {
    if (!book || !cast || Object.keys(threads).length === 0) return;
    const t = window.setTimeout(() => saveChat(book.id, threads, activeCharId), 400);
    return () => window.clearTimeout(t);
  }, [book, cast, threads, activeCharId]);

  /** Marcações do livro aberto. */
  useEffect(() => {
    setHighlights(book ? loadHighlights(book.id) : []);
  }, [book]);

  /** Tempo de leitura (para a sequência de dias e a meta): conta de 15 em 15 s com o leitor ativo. */
  useEffect(() => {
    if (!book || loadState !== "ready") return;
    const TICK = 15;
    const t = window.setInterval(() => {
      const active = Date.now() - lastActivityRef.current < 120_000 || speechRef.current !== null;
      if (document.visibilityState === "visible" && active) celebrate(addReadingSeconds(TICK));
    }, TICK * 1000);
    return () => window.clearInterval(t);
  }, [book, loadState]);

  function celebrate(ev: ReadingEvents) {
    if (ev.dayCompleted) {
      const n = ev.streak;
      const milestone = [3, 7, 14, 30, 50, 100, 365].includes(n);
      setCelebration({
        emoji: "🔥",
        title: n === 1 ? "Sequência começou!" : `${n} dias seguidos!`,
        text: ev.shieldEarned
          ? "Você ganhou um escudo 🛡️: se um dia passar sem leitura, ele salva a sua sequência."
          : milestone
            ? "Que marca! Os personagens estão orgulhosos."
            : n === 1
              ? "Volte amanhã para manter o fogo aceso."
              : "Continue assim — volte amanhã para manter a sequência.",
      });
    } else if (ev.goalReached) {
      setCelebration({ emoji: "🎯", title: "Meta do dia cumprida!", text: "Você leu tudo o que planejou hoje." });
    }
  }

  /** Guarda com quem o leitor conversou por último (usado no texto dos lembretes). */
  useEffect(() => {
    if (book && character) rememberCharacter(book.id, character.name);
  }, [book, character]);

  /** A voz para ao sair do livro ou fechar a página. */
  useEffect(() => () => speechRef.current?.stop(), []);

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
      const jump = jumpToBlockRef.current;
      jumpToBlockRef.current = null;
      if (!el) return;
      if (jump !== null) scrollToBlock(jump);
      else el.scrollTop = ratio ? ratio * (el.scrollHeight - el.clientHeight) : 0;
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

  /** Chegou ao fim do capítulo: aviso rápido; no último capítulo, comemoração de livro terminado. */
  useEffect(() => {
    if (!book || loadState !== "ready" || !currentChapter || scrollRatio < 0.97) return;
    const key = `${book.gutenbergId}:${chapterIndex}`;
    if (finishedChaptersRef.current.has(key)) return;
    // Capítulo curtíssimo cabe na tela inteira: ainda não foi "lido".
    const el = readRef.current;
    if (!el || el.scrollHeight < el.clientHeight * 1.5) return;
    finishedChaptersRef.current.add(key);
    if (chapterIndex >= chapters.length - 1) {
      setCelebration({ emoji: "🏆", title: `Você terminou “${book.title}”!`, text: "Que jornada. Conte para os personagens o que achou do final." });
    } else {
      setToast(`✓ ${currentChapter.label} concluído`);
    }
  }, [book, loadState, currentChapter, scrollRatio, chapterIndex, chapters.length]);

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

  /** Rola até um parágrafo do capítulo aberto e o destaca por um instante. */
  function scrollToBlock(i: number) {
    const target = readRef.current?.querySelector<HTMLElement>(`[data-block="${i}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("flash");
    window.setTimeout(() => target.classList.remove("flash"), 1800);
  }

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

  /** Texto na tela de cada parágrafo: a tradução, quando ligada e pronta, ou o original. */
  const shownTexts = useMemo(
    () =>
      blocks.map((b, i) => {
        const c = chunkOfBlock[i];
        return (translateOn ? translations[c]?.[i - chunks[c][0]] : null) ?? b.text;
      }),
    [blocks, chunkOfBlock, chunks, translateOn, translations],
  );
  /** Idioma do parágrafo na tela (para a voz e o dicionário). */
  const blockLanguage = (i: number): "pt" | "en" => {
    if (!book) return "pt";
    const c = chunkOfBlock[i];
    const translatedNow = translateOn && translations[c]?.[i - (chunks[c]?.[0] ?? 0)];
    return translatedNow ? "pt" : book.textLanguage;
  };

  /* ---- Leitura em voz alta ---- */
  const canSpeak = speechSupported();
  const speakLang: "pt" | "en" = !book ? "pt" : translateOn ? "pt" : book.textLanguage;

  useEffect(() => {
    if (!voicePanelOpen) return;
    let alive = true;
    void listVoices(speakLang).then((list) => {
      if (!alive) return;
      setVoices(list);
      const saved = savedVoiceUri(speakLang);
      setVoiceUri(list.some((v) => v.uri === saved) ? saved : list[0]?.uri);
    });
    return () => {
      alive = false;
    };
  }, [voicePanelOpen, speakLang]);

  function chooseVoice(uri: string) {
    setVoiceUri(uri);
    saveVoiceUri(speakLang, uri);
    if (speaking) startSpeaking(speakingBlock ?? firstVisibleBlock());
    else speakSample(uri, speakLang, speechRate);
  }

  function chooseRate(rate: number) {
    setSpeechRate(rate);
    saveRate(rate);
    if (speaking) startSpeaking(speakingBlock ?? firstVisibleBlock(), rate);
  }

  function firstVisibleBlock(): number {
    const el = readRef.current;
    if (!el) return 0;
    const top = el.getBoundingClientRect().top;
    const els = Array.from(el.querySelectorAll<HTMLElement>("[data-block]"));
    const first = els.find((b) => b.getBoundingClientRect().bottom > top + 8);
    return first ? Number(first.dataset.block) : 0;
  }

  function startSpeaking(from: number, rate = speechRate) {
    if (!book) return;
    speechRef.current?.stop();
    const lang = speakLang;
    const hasNext = chapterIndex < chapters.length - 1;
    setSpeaking(true);
    speechRef.current = speakParagraphs(
      shownTexts,
      from,
      lang,
      rate,
      (i) => {
        setSpeakingBlock(i);
        lastActivityRef.current = Date.now();
        const target = readRef.current?.querySelector<HTMLElement>(`[data-block="${i}"]`);
        const page = readRef.current;
        if (target && page) {
          const r = target.getBoundingClientRect();
          const pr = page.getBoundingClientRect();
          if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) target.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      },
      () => {
        speechRef.current = null;
        if (hasNext) {
          // Fim do capítulo: continua lendo o próximo.
          continueSpeechRef.current = true;
          setChapterIndex((n) => n + 1);
        } else {
          setSpeaking(false);
          setSpeakingBlock(null);
        }
      },
    );
  }

  /** Troca de capítulo pelo leitor (não pela voz) ou tradução ligada/desligada: a voz para. */
  useEffect(() => {
    if (!continueSpeechRef.current) stopSpeaking();
  }, [chapterIndex, translateOn, stopSpeaking]);

  /** A voz terminou um capítulo: quando o próximo estiver na tela, continua do começo. */
  useEffect(() => {
    if (!continueSpeechRef.current || loadState !== "ready" || blocks.length === 0) return;
    continueSpeechRef.current = false;
    const frame = requestAnimationFrame(() => startSpeaking(0));
    return () => cancelAnimationFrame(frame);
  }, [blocks, loadState]);

  /* ---- Seleção de texto: destacar, significado, compartilhar ---- */
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  function handleSelection() {
    window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setSelection(null);
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (!text) return setSelection(null);
      const blockOf = (n: Node | null) =>
        (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-block]") ?? null;
      const a = blockOf(sel.anchorNode);
      // Só dentro de um parágrafo (destaques que atravessam parágrafos não teriam onde ser desenhados).
      if (!a || a !== blockOf(sel.focusNode)) return setSelection(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const word = !/\s/.test(text) ? normalizeWord(text) : null;
      setSelection({
        text,
        block: Number(a.dataset.block),
        x: rect.left + rect.width / 2,
        top: rect.top,
        bottom: rect.bottom,
        word,
      });
      setWordCard(null);
    }, 10);
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function addHighlight() {
    if (!book || !selection || !currentChapter) return;
    const text = selection.text.slice(0, MAX_HIGHLIGHT_CHARS);
    const next: Highlight[] = [
      ...highlights,
      {
        id: uid(),
        chapterIndex,
        chapterLabel: currentChapter.label,
        paragraph: selection.block,
        text,
        createdAt: Date.now(),
      },
    ];
    setHighlights(next);
    saveHighlights(book.id, next);
    clearSelection();
    setToast("Trecho destacado");
  }

  function removeHighlight(id: string) {
    if (!book) return;
    const next = highlights.filter((h) => h.id !== id);
    setHighlights(next);
    saveHighlights(book.id, next);
  }

  function openHighlight(h: Highlight) {
    setHighlightsOpen(false);
    if (h.chapterIndex === chapterIndex) {
      requestAnimationFrame(() => scrollToBlock(h.paragraph));
    } else {
      jumpToBlockRef.current = h.paragraph;
      setChapterIndex(h.chapterIndex);
    }
  }

  function showMeaning() {
    if (!selection?.word) return;
    const word = selection.word;
    const lang = blockLanguage(selection.block);
    setWordCard({ word, x: selection.x, y: selection.bottom, info: null });
    clearSelection();
    void lookupWord(word, lang, engine).then((info) =>
      setWordCard((c) => (c && c.word === word ? { ...c, info } : c)),
    );
  }

  const [sharing, setSharing] = useState(false);
  async function shareCard(input: Omit<ShareCardInput, "bookTitle" | "bookAuthor" | "coverUrl">) {
    if (!book || sharing) return;
    setSharing(true);
    try {
      const blob = await renderShareCard({
        ...input,
        bookTitle: book.title,
        bookAuthor: book.author,
        coverUrl: book.coverUrl,
      });
      const slug = book.title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const result = await shareOrDownload(blob, `storyverse-${slug || "livro"}.png`, `${book.title} no Storyverse`);
      if (result === "downloaded") setToast("Imagem salva — é só postar!");
    } catch (e) {
      console.warn("Falha ao gerar o card:", e);
      setToast("Não foi possível gerar a imagem.");
    } finally {
      setSharing(false);
    }
  }

  function shareMessage(m: Msg) {
    if (!character) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    const question = [...messages.slice(0, idx)].reverse().find((x) => x.role === "user")?.text;
    void shareCard({
      kind: "chat",
      text: m.text,
      characterName: character.name,
      characterRole: character.role,
      characterColor: character.color,
      question,
    });
  }

  function shareQuote(text: string, chapterLabel?: string) {
    void shareCard({ kind: "quote", text, chapterLabel });
  }

  function resetConversation() {
    if (!character) return;
    if (!window.confirm(`Recomeçar a conversa com ${character.name}? As mensagens desta conversa serão apagadas.`)) {
      return;
    }
    setThreads((prev) => ({ ...prev, [character.id]: initialThreadsFor([character])[character.id] }));
  }

  /** Posição aproximada no livro inteiro (capítulos anteriores + rolagem no atual). */
  const readingProgressPct =
    chapters.length > 0 ? ((chapterIndex + scrollRatio) / chapters.length) * 100 : 0;
  const textExcerpt = useMemo(
    () => excerptNearScrollRatio(displayedStory, scrollRatio, 2000),
    [displayedStory, scrollRatio],
  );

  const limitApplies = detectProvider() === "live";
  const outOfMessages = limitApplies && messagesLeft <= 0;

  async function sendMessage(raw: string) {
    if (!book || !character || loadState !== "ready" || !displayedStory) return;
    const text = raw.trim();
    if (!text || loading) return;
    if (limitApplies && messagesLeftToday() <= 0) {
      setMessagesLeft(0);
      return;
    }

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
      if (limitApplies) setMessagesLeft(countMessage());
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
    const summary = readingSummary();
    const lastBook = recent[0]
      ? {
          title: recent[0].book.title,
          chapterLabel: recent[0].chapterLabel,
          character: lastCharacter(recent[0].book.id),
        }
      : undefined;
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
          <div className="home-nav-actions">
            <span className="status" title="Mostra se o chat usa IA em tempo real ou respostas de demonstração.">
              <span className="status-dot" aria-hidden="true" />
              {providerLabel}
            </span>
            {install ? (
              <button type="button" className="btn nav-install" onClick={() => void install()}>
                Instalar app
              </button>
            ) : null}
            <button
              type="button"
              className="btn nav-import"
              onClick={() => setImportRequest({})}
              aria-label="Importar livro"
            >
              {Icon.upload}
              <span className="nav-import-long">Importar livro</span>
              <span className="nav-import-short">Importar</span>
            </button>
          </div>
        </nav>

        {install ? (
          // No celular o convite fica aqui, fora do topo (lá não cabe junto com "Importar livro").
          <div className="install-banner">
            <span>Instale o Storyverse no celular: abre em tela cheia e funciona sem internet.</span>
            <button type="button" className="btn btn-primary" onClick={() => void install()}>
              Instalar
            </button>
          </div>
        ) : null}

        {shieldNotice !== null ? (
          <div className="nudge nudge-shield" role="status">
            <span className="nudge-emoji" aria-hidden="true">
              🛡️
            </span>
            <div>
              <strong>Um escudo salvou sua sequência!</strong>
              <span>Você não leu ontem, mas a sequência de {shieldNotice} dias continua. Bora ler hoje?</span>
            </div>
            <button type="button" className="icon-btn" onClick={() => setShieldNotice(null)} aria-label="Fechar aviso">
              {Icon.close}
            </button>
          </div>
        ) : summary.streak > 0 && !summary.readToday && recent[0] ? (
          <div className="nudge" role="status">
            <span className="nudge-emoji" aria-hidden="true">
              🔥
            </span>
            <div>
              <strong>
                Sua sequência de {summary.streak} {summary.streak === 1 ? "dia" : "dias"} termina hoje!
              </strong>
              <span>
                {lastBook?.character ? `${lastBook.character} está te esperando` : "Sua história está te esperando"} em “
                {recent[0].book.title}”. Uns minutinhos já contam.
              </span>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => startBook(recent[0].book)}>
              Ler agora
            </button>
          </div>
        ) : null}

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
              <button type="button" className="btn btn-lg" onClick={() => setImportRequest({})}>
                {Icon.upload}
                Importar meu livro
              </button>
            </div>
            <p className="hero-hint">
              Não achou o seu livro favorito? Importe o arquivo (.epub, .pdf ou .txt) e converse com os
              personagens.
            </p>
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
                  <Avatar character={heroChar} size="sm" bookTitle={heroBook.title} />
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
            <p>Romances em português, terror, vampiros e mistério, qualquer livro do acervo ou um arquivo seu.</p>
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

        {recent.length > 0 || hasAnyReading() ? <ReadingStreak lastBook={lastBook} /> : null}

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
                              <Avatar key={c.id} character={c} size="sm" bookTitle={b.title} />
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

        <MyBooks
          onOpen={startBook}
          onRemoved={() => setHomeTick((n) => n + 1)}
          request={importRequest}
          setRequest={setImportRequest}
        />

        <Explore onOpen={startBook} onImport={(hint) => setImportRequest(hint ?? {})} />

        {celebration ? (
          <div className="celebration" role="status" onClick={() => setCelebration(null)}>
            <div className="celebration-card">
              <span className="celebration-emoji" aria-hidden="true">
                {celebration.emoji}
              </span>
              <strong>{celebration.title}</strong>
              {celebration.text ? <span>{celebration.text}</span> : null}
            </div>
            <div className="celebration-burst" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => (
                <i key={i} style={{ "--i": i } as React.CSSProperties} />
              ))}
            </div>
          </div>
        ) : null}

        {updateBanner}

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
          {canSpeak && ready ? (
            <>
              {speaking ? (
                <button
                  type="button"
                  className={`icon-btn text-btn rate-btn ${voicePanelOpen ? "is-active" : ""}`}
                  onClick={() => setVoicePanelOpen((v) => !v)}
                  aria-expanded={voicePanelOpen}
                  aria-label={`Voz e velocidade (${speechRate}x)`}
                  title="Voz e velocidade"
                >
                  {String(speechRate).replace(".", ",")}x
                </button>
              ) : null}
              <button
                type="button"
                className={`icon-btn ${speaking ? "is-active" : ""}`}
                onClick={() => (speaking ? stopSpeaking() : startSpeaking(firstVisibleBlock()))}
                aria-pressed={speaking}
                aria-label={speaking ? "Parar a leitura em voz alta" : "Ouvir o capítulo em voz alta"}
                title={speaking ? "Parar" : "Ouvir em voz alta"}
              >
                {speaking ? Icon.stop : Icon.speaker}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="icon-btn marks-btn"
            onClick={() => setHighlightsOpen(true)}
            aria-label={`Marcações (${highlights.length})`}
            title="Marcações e citações"
          >
            {Icon.bookmark}
            {highlights.length > 0 ? <span className="badge">{highlights.length}</span> : null}
          </button>
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
              {isLocalBook(book) ? "Abrindo o seu livro…" : "Buscando o livro no acervo…"}
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
            <article
              className="prose"
              aria-label="Texto do capítulo"
              onMouseUp={handleSelection}
              onTouchEnd={handleSelection}
              onKeyUp={handleSelection}
              onPointerDown={() => (lastActivityRef.current = Date.now())}
            >
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
                const pending = translateOn && !translations[c];
                const marks = highlights
                  .filter((h) => h.chapterIndex === chapterIndex && h.paragraph === i)
                  .map((h) => h.text);
                // Com destaque, o itálico (_assim_) sai: o trecho marcado precisa bater com o texto.
                const text =
                  marks.length > 0
                    ? splitByHighlights(shownTexts[i].replace(/_/g, ""), marks).map((piece, k) =>
                        piece.marked ? <mark key={k}>{piece.text}</mark> : piece.text,
                      )
                    : withItalics(shownTexts[i]);
                const className =
                  [
                    i === dropCapIndex ? "dropcap" : "",
                    pending ? "is-translating" : "",
                    speakingBlock === i ? "is-speaking" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined;
                return b.kind === "heading" ? (
                  <h2 key={i} data-chunk={c} data-block={i} className={className}>
                    {text}
                  </h2>
                ) : (
                  <p key={i} data-chunk={c} data-block={i} className={className}>
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
                {isLocalBook(book) ? (
                  <span className="source-link">Livro importado · guardado só neste aparelho</span>
                ) : (
                  <a
                    className="source-link"
                    href={`https://www.gutenberg.org/ebooks/${book.gutenbergId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ver esta obra no Project Gutenberg ↗
                  </a>
                )}
              </footer>
            </article>
          ) : null}
        </main>

        {voicePanelOpen && speaking ? (
          <>
            <div className="voice-backdrop" onClick={() => setVoicePanelOpen(false)} />
            <div className="voice-panel" role="dialog" aria-label="Voz e velocidade">
              <div className="voice-panel-head">
                <strong>Voz e velocidade</strong>
                <button type="button" className="icon-btn" onClick={() => setVoicePanelOpen(false)} aria-label="Fechar">
                  {Icon.close}
                </button>
              </div>

              <span className="voice-label">Velocidade</span>
              <div className="voice-rates" role="group" aria-label="Velocidade">
                {RATE_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={r === speechRate ? "active" : undefined}
                    aria-pressed={r === speechRate}
                    onClick={() => chooseRate(r)}
                  >
                    {String(r).replace(".", ",")}x
                  </button>
                ))}
              </div>

              <span className="voice-label">Voz</span>
              {voices.length === 0 ? (
                <p className="voice-tip">Procurando as vozes deste aparelho…</p>
              ) : (
                <ul className="voice-list">
                  {voices.map((v) => (
                    <li key={v.uri}>
                      <button
                        type="button"
                        className={v.uri === voiceUri ? "active" : undefined}
                        aria-pressed={v.uri === voiceUri}
                        onClick={() => chooseVoice(v.uri)}
                      >
                        <span>{v.label}</span>
                        {v.natural ? <em>natural</em> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {voices.length > 0 && !voices.some((v) => v.natural) ? (
                <p className="voice-tip">
                  Este aparelho só tem vozes simples. Para uma voz quase humana, grátis: abra o Storyverse no{" "}
                  <strong>Microsoft Edge</strong> (vozes Francisca e Antônio) ou, no iPhone, baixe uma voz{" "}
                  <strong>Aprimorada</strong> em Ajustes › Acessibilidade › Conteúdo Falado › Vozes.
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {selection ? (
          <div
            className="sel-toolbar"
            role="toolbar"
            aria-label="Ações do trecho selecionado"
            style={{
              // Metade da largura do menu (~180 px) + margem, para não sair da tela.
              left: Math.min(Math.max(selection.x, 190), window.innerWidth - 190),
              top: coarsePointer() || selection.top < 90 ? selection.bottom + 12 : selection.top - 54,
            }}
            // Clicar no menu não pode desfazer a seleção antes do clique.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
          >
            <button type="button" onClick={addHighlight}>
              {Icon.highlight} Destacar
            </button>
            {selection.word ? (
              <button type="button" onClick={showMeaning}>
                {Icon.book} Significado
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const text = selection.text;
                clearSelection();
                shareQuote(text, currentChapter?.label);
              }}
            >
              {Icon.share} Compartilhar
            </button>
          </div>
        ) : null}

        {wordCard ? (
          <div
            className="word-card"
            role="dialog"
            aria-label={`Significado de ${wordCard.word}`}
            style={{
              left: Math.min(Math.max(wordCard.x, 176), window.innerWidth - 176),
              top: Math.min(wordCard.y + 12, window.innerHeight - 240),
            }}
          >
            <div className="word-card-head">
              <strong>{wordCard.word}</strong>
              {wordCard.info?.kind ? <em>{wordCard.info.kind}</em> : null}
              <button type="button" className="icon-btn" onClick={() => setWordCard(null)} aria-label="Fechar">
                {Icon.close}
              </button>
            </div>
            {!wordCard.info ? (
              <p className="word-card-muted">Procurando…</p>
            ) : (
              <>
                {wordCard.info.translation ? (
                  <p className="word-card-translation">
                    <span>Em português:</span> {wordCard.info.translation}
                  </p>
                ) : null}
                {wordCard.info.definitions.length > 0 ? (
                  <ol>
                    {wordCard.info.definitions.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ol>
                ) : !wordCard.info.translation ? (
                  <p className="word-card-muted">Não encontramos esta palavra no dicionário.</p>
                ) : null}
                {wordCard.info.source ? (
                  <a className="word-card-source" href={wordCard.info.source.url} target="_blank" rel="noreferrer">
                    {wordCard.info.source.label} ↗
                  </a>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {highlightsOpen ? (
          <div className="import-overlay" onClick={() => setHighlightsOpen(false)}>
            <div
              className="import-panel marks-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="marks-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="import-head">
                <h3 id="marks-title">Marcações</h3>
                <button type="button" className="icon-btn" onClick={() => setHighlightsOpen(false)} aria-label="Fechar">
                  {Icon.close}
                </button>
              </div>
              {highlights.length === 0 ? (
                <p className="import-note">
                  Selecione um trecho do livro e toque em <strong>Destacar</strong> para guardar suas citações
                  favoritas aqui.
                </p>
              ) : (
                <ul className="marks-list">
                  {[...highlights]
                    .sort((a, b) => a.chapterIndex - b.chapterIndex || a.paragraph - b.paragraph)
                    .map((h) => (
                      <li key={h.id}>
                        <span className="marks-chapter">{h.chapterLabel}</span>
                        <blockquote>{h.text}</blockquote>
                        <div className="marks-actions">
                          <button type="button" className="link-btn" onClick={() => openHighlight(h)}>
                            Ir para o trecho
                          </button>
                          <button type="button" className="link-btn" onClick={() => shareQuote(h.text, h.chapterLabel)}>
                            Compartilhar
                          </button>
                          <button type="button" className="link-btn marks-remove" onClick={() => removeHighlight(h.id)}>
                            Remover
                          </button>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {celebration ? (
          <div className="celebration" role="status" onClick={() => setCelebration(null)}>
            <div className="celebration-card">
              <span className="celebration-emoji" aria-hidden="true">
                {celebration.emoji}
              </span>
              <strong>{celebration.title}</strong>
              {celebration.text ? <span>{celebration.text}</span> : null}
            </div>
            <div className="celebration-burst" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => (
                <i key={i} style={{ "--i": i } as React.CSSProperties} />
              ))}
            </div>
          </div>
        ) : null}

        {updateBanner}

        {toast || sharing ? (
          <div className="toast" role="status">
            {sharing ? "Gerando a imagem…" : toast}
          </div>
        ) : null}

        <aside className={`chat ${chatOpen ? "is-open" : ""}`} aria-label="Conversa com os personagens">
          {character ? (
            <div className="chat-head">
              <Avatar character={character} size="lg" bookTitle={book.title} generate />
              <div className="chat-head-text">
                <strong>{character.name}</strong>
                <span>{character.role}</span>
              </div>
              {userHasSpoken ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={resetConversation}
                  aria-label={`Recomeçar a conversa com ${character.name}`}
                  title="Recomeçar a conversa"
                >
                  {Icon.refresh}
                </button>
              ) : null}
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
                  <Avatar character={c} size="sm" bookTitle={book.title} generate />
                  {shortNameOf(c)}
                </button>
              ))}
            </div>
          ) : null}

          <div ref={chatBodyRef} className="chat-body">
            {messages.map((m) =>
              m.role === "assistant" && character ? (
                <div key={m.id} className="msg msg-assistant">
                  <Avatar character={character} size="sm" bookTitle={book.title} generate />
                  <div className="bubble assistant">{m.text}</div>
                  <button
                    type="button"
                    className="msg-share"
                    onClick={() => shareMessage(m)}
                    aria-label="Compartilhar esta fala como imagem"
                    title="Compartilhar como imagem"
                  >
                    {Icon.share}
                  </button>
                </div>
              ) : (
                <div key={m.id} className="msg msg-user">
                  <div className="bubble user">{m.text}</div>
                </div>
              ),
            )}
            {loading && character ? (
              <div className="msg msg-assistant">
                <Avatar character={character} size="sm" bookTitle={book.title} generate />
                <div className="bubble assistant typing" aria-label={`${character.name} está escrevendo`}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}
          </div>

          {error ? <div className="chat-err">{error}</div> : null}

          {!userHasSpoken && character && ready && !loading && !outOfMessages ? (
            <div className="suggestions">
              {suggestionsFor(character).map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => void sendMessage(s)}>
                  {s}
                </button>
              ))}
            </div>
          ) : null}

          {limitApplies && messagesLeft > 0 && messagesLeft <= 5 ? (
            <p className="limit-note">
              {messagesLeft === 1 ? "Resta 1 mensagem hoje." : `Restam ${messagesLeft} mensagens hoje.`}
            </p>
          ) : null}

          {outOfMessages ? (
            <div className="limit-out" role="status">
              <strong>Por hoje é só 💛</strong>
              <span>
                Você usou as {DAILY_MESSAGE_LIMIT} mensagens de hoje. Os personagens voltam a conversar amanhã —
                enquanto isso, a leitura continua.
              </span>
            </div>
          ) : (
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
          )}
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
            {character ? <Avatar character={character} size="sm" bookTitle={book.title} generate /> : null}
            {character ? `Conversar com ${shortNameOf(character)}` : "Conversar"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
