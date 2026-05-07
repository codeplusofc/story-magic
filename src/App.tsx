import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ebooks, getEbook } from "./data/ebooks";
import type { Ebook, StoryCharacter } from "./data/types";
import {
  characterReply,
  narrateStoryContinuation,
  providerDisplayLabel,
  wantsStoryContinuation,
  type ChatTurn,
} from "./lib/ai";
import { splitIntoChapters } from "./lib/chapters";
import { chapterTransitionMessage, midChapterReadingHint } from "./lib/readingAmbient";
import { excerptNearScrollRatio } from "./lib/readingContext";
import "./App.css";

type Msg = { id: string; role: "user" | "assistant"; text: string };

const EMPTY_THREAD: Msg[] = [];

type LoadState = "idle" | "loading" | "ready" | "error";

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove linhas técnicas comuns de .txt digitalizados. */
function normalizeLocalStoryText(raw: string): string {
  return raw.replace(/^#KBYTECOUNT\s*\d*\s*\r?\n/i, "").trimStart();
}

async function fetchLocalStoryText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Não foi possível abrir o arquivo (${res.status}). Coloque o .txt em public${url} (mesmo caminho que o URL).`,
    );
  }
  const raw = await res.text();
  return normalizeLocalStoryText(raw);
}

function initialThreadsFor(book: { characters: StoryCharacter[]; chapterReading?: boolean }): Record<string, Msg[]> {
  const note = book.chapterReading
    ? " Comento enquanto você lê o capítulo; se quiser um trecho extra só neste capítulo, diga “continua o capítulo” depois de falarmos."
    : "";
  const initial: Record<string, Msg[]> = {};
  for (const c of book.characters) {
    initial[c.id] = [
      {
        id: uid(),
        role: "assistant",
        text: `Sou ${c.name}. Estou aqui com você nesta leitura — o que gostaria de saber ou inventar juntos?${note}`,
      },
    ];
  }
  return initial;
}

export function App() {
  const [bookId, setBookId] = useState<string | null>(null);
  const book = bookId ? getEbook(bookId) : undefined;

  const [fullText, setFullText] = useState("");
  /** Trechos extras no fim da leitura (obras sem modo capítulo). */
  const [storyAppendix, setStoryAppendix] = useState("");
  /** Trechos extras por índice de capítulo (`chapterReading`). */
  const [chapterExtras, setChapterExtras] = useState<Record<number, string>>({});
  const [chapterIndex, setChapterIndex] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeCharId, setActiveCharId] = useState<string>("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});

  const readRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const [scrollRatio, setScrollRatio] = useState(0);
  /** Uma dica de “meio de capítulo” por índice de capítulo (evita várias mensagens seguidas). */
  const midChapterNudgeSentRef = useRef<Record<number, boolean>>({});

  useEffect(() => {
    if (!book) {
      setFullText("");
      setStoryAppendix("");
      setLoadState("idle");
      setLoadError(null);
      setScrollRatio(0);
      return;
    }

    setStoryAppendix("");
    setChapterExtras({});
    setChapterIndex(0);
    midChapterNudgeSentRef.current = {};

    if (book.embeddedFullText) {
      setFullText(book.embeddedFullText);
      setLoadState("ready");
      setLoadError(null);
      setScrollRatio(0);
      requestAnimationFrame(() => {
        const el = readRef.current;
        if (el) el.scrollTop = 0;
      });
      return;
    }

    let cancelled = false;

    if (book.localStoryUrl) {
      setLoadState("loading");
      setFullText("");
      setLoadError(null);
      setScrollRatio(0);

      fetchLocalStoryText(book.localStoryUrl)
        .then((text) => {
          if (cancelled) return;
          setFullText(text);
          setLoadState("ready");
          requestAnimationFrame(() => {
            const el = readRef.current;
            if (el) el.scrollTop = 0;
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
    }

    setLoadState("error");
    setLoadError("Este título ainda não tem o livro completo disponível aqui.");
    return () => {
      cancelled = true;
    };
  }, [book]);

  const onReadScroll = useCallback(() => {
    const el = readRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const r = max <= 0 ? 0 : el.scrollTop / max;
    setScrollRatio(r);
  }, []);

  const prevChapterIdxRef = useRef<number | null>(null);

  const startBook = useCallback((b: Ebook) => {
    prevChapterIdxRef.current = null;
    setBookId(b.id);
    setActiveCharId(b.characters[0]?.id ?? "");
    setThreads(initialThreadsFor(b));
    setError(null);
    setInput("");
  }, []);

  const leaveBook = useCallback(() => {
    prevChapterIdxRef.current = null;
    setBookId(null);
    setActiveCharId("");
    setThreads({});
    setError(null);
    setInput("");
    setFullText("");
    setStoryAppendix("");
    setChapterExtras({});
    setChapterIndex(0);
    midChapterNudgeSentRef.current = {};
    setLoadState("idle");
    setLoadError(null);
  }, []);

  const retryLoad = useCallback(() => {
    if (!book?.localStoryUrl) return;
    setLoadState("loading");
    setLoadError(null);
    setFullText("");
    setStoryAppendix("");
    setChapterExtras({});
    setChapterIndex(0);
    midChapterNudgeSentRef.current = {};
    fetchLocalStoryText(book.localStoryUrl)
      .then((text) => {
        setFullText(text);
        setLoadState("ready");
        requestAnimationFrame(() => {
          const el = readRef.current;
          if (el) el.scrollTop = 0;
        });
      })
      .catch((err) => {
        setLoadState("error");
        setLoadError(err instanceof Error ? err.message : "Erro ao carregar o livro.");
      });
  }, [book]);

  const characters = book?.characters ?? [];
  const character = useMemo(
    () => characters.find((c) => c.id === activeCharId) ?? characters[0],
    [activeCharId, characters],
  );

  const messages = character ? (threads[character.id] ?? EMPTY_THREAD) : EMPTY_THREAD;

  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activeCharId]);

  const providerLabel = providerDisplayLabel();

  const chapters = useMemo(() => {
    if (!book?.chapterReading || !fullText) return [];
    return splitIntoChapters(fullText);
  }, [book?.chapterReading, fullText]);

  const chapterMode = Boolean(book?.chapterReading && chapters.length > 0);
  const currentChapter = chapters[chapterIndex] ?? chapters[0];

  useEffect(() => {
    if (!chapterMode || chapters.length === 0) return;
    setChapterIndex((i) => Math.min(Math.max(0, i), chapters.length - 1));
  }, [chapters.length, chapterMode]);

  useEffect(() => {
    setScrollRatio(0);
  }, [chapterIndex]);

  /** Ao trocar de personagem, não dispara de novo a dica do meio se a rolagem já passou do meio. */
  useEffect(() => {
    if (!chapterMode) return;
    const el = readRef.current;
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    const r = !el || max <= 0 ? 0 : el.scrollTop / max;
    if (r >= 0.42) {
      midChapterNudgeSentRef.current[chapterIndex] = true;
    }
  }, [activeCharId, chapterMode, chapterIndex]);

  useEffect(() => {
    if (!chapterMode || !character || loadState !== "ready" || !currentChapter) return;

    if (prevChapterIdxRef.current === null) {
      prevChapterIdxRef.current = chapterIndex;
      requestAnimationFrame(() => {
        readRef.current?.scrollTo({ top: 0 });
        onReadScroll();
      });
      return;
    }
    if (prevChapterIdxRef.current === chapterIndex) return;

    prevChapterIdxRef.current = chapterIndex;
    const line = chapterTransitionMessage(currentChapter.label);
    setThreads((prev) => ({
      ...prev,
      [character.id]: [...(prev[character.id] ?? []), { id: uid(), role: "assistant", text: line }],
    }));
    requestAnimationFrame(() => {
      readRef.current?.scrollTo({ top: 0 });
      onReadScroll();
    });
  }, [chapterIndex, chapterMode, character, loadState, currentChapter, activeCharId, onReadScroll]);

  useEffect(() => {
    if (!chapterMode || !character || !currentChapter || loadState !== "ready" || loading) return;
    if (scrollRatio < 0.42) return;
    if (midChapterNudgeSentRef.current[chapterIndex]) return;
    midChapterNudgeSentRef.current[chapterIndex] = true;
    const line = midChapterReadingHint(currentChapter.label);
    setThreads((prev) => ({
      ...prev,
      [character.id]: [...(prev[character.id] ?? []), { id: uid(), role: "assistant", text: line }],
    }));
  }, [scrollRatio, chapterMode, character, currentChapter, loadState, loading, chapterIndex]);

  const displayedStory = useMemo(() => {
    if (!fullText) return "";
    if (chapterMode && currentChapter) {
      const extra = chapterExtras[chapterIndex] ?? "";
      return extra.length > 0
        ? `${currentChapter.body}\n\n* * *\n\n${extra}`
        : currentChapter.body;
    }
    return storyAppendix.length > 0
      ? `${fullText}\n\n* * *\n\n${storyAppendix}`
      : fullText;
  }, [fullText, storyAppendix, chapterMode, currentChapter, chapterExtras, chapterIndex]);

  const readingProgressPct = scrollRatio * 100;
  const textExcerpt = useMemo(
    () => excerptNearScrollRatio(displayedStory, scrollRatio, 3200),
    [displayedStory, scrollRatio],
  );

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!book || !character || loadState !== "ready" || !displayedStory) return;
    const text = input.trim();
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

      const baseDisplay =
        chapterMode && currentChapter
          ? (() => {
              const ex = chapterExtras[chapterIndex] ?? "";
              return ex.length > 0
                ? `${currentChapter.body}\n\n* * *\n\n${ex}`
                : currentChapter.body;
            })()
          : storyAppendix.length > 0
            ? `${fullText}\n\n* * *\n\n${storyAppendix}`
            : fullText;

      const appendContinuation = async (opts: { sectionTitle: string }) => {
        try {
          const continuation = await narrateStoryContinuation({
            bookTitle: book.title,
            bookAuthor: book.author,
            storySoFarTail: baseDisplay.slice(-3200),
            userMessage: text,
            characterName: character.name,
            characterReply: reply,
            textLanguage: book.textLanguage,
            chapterLabel: chapterMode && currentChapter ? currentChapter.label : undefined,
          });
          const block = `${opts.sectionTitle}\n\n${continuation}`;
          if (chapterMode) {
            setChapterExtras((prev) => {
              const cur = prev[chapterIndex] ?? "";
              const next = cur ? `${cur}\n\n${block}` : block;
              return { ...prev, [chapterIndex]: next };
            });
          } else {
            setStoryAppendix((prev) => (prev.length > 0 ? `${prev}\n\n${block}` : block));
          }
          requestAnimationFrame(() => {
            const el = readRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        } catch (contErr) {
          setError(
            contErr instanceof Error
              ? `${contErr.message} (a conversa foi salva; a leitura não foi estendida.)`
              : "Não foi possível gerar a continuação da leitura.",
          );
        }
      };

      if (book.readerContinuesStory && wantsStoryContinuation(text)) {
        await appendContinuation({
          sectionTitle: chapterMode ? "**Continuação deste capítulo**" : "**Continuação**",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
      setThreads((prev) => ({
        ...prev,
        [character.id]: [...(prev[character.id] ?? []).filter((m) => m.id !== userMsg.id)],
      }));
      setInput(text);
    } finally {
      setLoading(false);
    }
  }

  if (!book) {
    return (
      <div className="app">
        <header className="top">
          <div className="brand">
            <span className="kicker">Leitura que conversa com você</span>
            <h1>
              <span className="logo-text">Storyverse</span>
            </h1>
            <p>
              Página à esquerda, voz à direita: você <strong>lê capítulo a capítulo</strong> (quando o arquivo
              traz marcas como <strong>CAPÍTULO …</strong>) enquanto alguém da ficção{" "}
              <strong>acompanha o seu ritmo</strong> no chat. Se quiser um deslize a mais na narrativa, peça
              por escrito — por exemplo <strong>continua o capítulo</strong> — e o texto ganha um trecho
              extra <strong>só quando você pedir</strong>. Opcional: chaves Groq ou Gemini no{" "}
              <code className="inline-code">.env</code> deixam as respostas mais vivas; sem elas, o app ainda
              funciona em modo demonstração.
            </p>
          </div>
          <div
            className="pill"
            title="Opcional: no arquivo .env na pasta do projeto, defina VITE_GROQ_API_KEY ou VITE_GEMINI_API_KEY. Se as duas existirem, o app tenta uma e, em caso de limite, a outra."
          >
            Modelo: <strong>{providerLabel}</strong>
          </div>
        </header>

        <section className="library">
          <h2 className="library-title">Escolha onde sentar à mesa</h2>
          <p className="library-note">
            Cada cartão é uma mesa só sua: <strong>português</strong>, romance em arquivo local, e{" "}
            <strong>personagens que reagem</strong> ao que você lê e escreve. Nada de trecho inventado no
            livro sem o seu “sim” explícito — você manda no ritmo da história.
          </p>
          <div className="book-grid">
            {ebooks.map((b) => (
              <article key={b.id} className="book-card" style={{ background: b.cardGradient }}>
                <div className="book-card-inner">
                  <h3>{b.title}</h3>
                  <p className="book-author">{b.author}</p>
                  <p className="book-blurb">{b.blurb}</p>
                  <div className="book-actions">
                    {b.sourceUrl ? (
                      <a
                        className="source-link"
                        href={b.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {b.sourceLabel} ↗
                      </a>
                    ) : (
                      <span className="source-link source-link-static">{b.sourceLabel}</span>
                    )}
                    <button type="button" className="btn btn-primary" onClick={() => startBook(b)}>
                      Abrir esta leitura
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  const charCount = displayedStory.length;
  const ready = loadState === "ready" && fullText.length > 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand brand--session">
          <div className="reading-toolbar">
            <button type="button" className="btn back-library" onClick={leaveBook}>
              ← Biblioteca
            </button>
            <span className="reading-toolbar-divider" aria-hidden="true" />
            <span className="kicker">Nesta sessão</span>
          </div>
          <h1 className="page-title">{book.title}</h1>
          <p className="book-sub">{book.author}</p>
          <p>
            O texto à <strong>esquerda</strong> é o seu chão: rola no seu tempo. À{" "}
            <strong>direita</strong>, alguém da história responde como se estivesse na mesma sala — tom da
            obra, trecho em que você parou, e o que você escreve importa.
            {book.chapterReading ? (
              <>
                {" "}
                Neste modo, <strong>um capítulo por vez</strong>; o personagem pode mandar um sussurro no chat
                conforme você avança ou troca de capítulo. Um trecho novo no livro <strong>só aparece</strong>{" "}
                se você pedir (por exemplo <strong>continua o capítulo</strong> ou <strong>quero continuar</strong>)
                depois da resposta dele.
              </>
            ) : null}
            {book.readerContinuesStory && !book.chapterReading ? (
              <>
                {" "}
                Nesta história, se escrever <strong>quero seguir</strong> ou <strong>continuar</strong>, o painel
                da esquerda pode <strong>ganhar um novo trecho</strong> depois da fala do personagem.
              </>
            ) : null}
          </p>
        </div>
        <div
          className="pill"
          title="Opcional: no arquivo .env na pasta do projeto, defina VITE_GROQ_API_KEY ou VITE_GEMINI_API_KEY. Se as duas existirem, o app tenta uma e, em caso de limite, a outra."
        >
          Modelo: <strong>{providerLabel}</strong>
        </div>
      </header>

      <div className="layout">
        <section className="panel panel-read">
          <div className="panel-head">
            <h2>{chapterMode ? "Capítulo" : "Leitura"}</h2>
            <span className="pill">
              {loadState === "loading"
                ? "Carregando…"
                : loadState === "error"
                  ? "Erro"
                  : ready
                    ? `${chapterMode && chapters.length > 0 ? `${chapterIndex + 1}/${chapters.length} · ` : ""}${charCount.toLocaleString("pt-BR")} caracteres · ~${Math.round(readingProgressPct)}%`
                    : "—"}
            </span>
          </div>

          {chapterMode && chapters.length > 0 ? (
            <div className="chapter-bar">
              <button
                type="button"
                className="btn"
                disabled={chapterIndex <= 0}
                onClick={() => setChapterIndex((i) => Math.max(0, i - 1))}
              >
                ← Capítulo anterior
              </button>
              <span className="chapter-bar-title" title={currentChapter?.label}>
                {currentChapter?.label ?? "—"}
              </span>
              <button
                type="button"
                className="btn"
                disabled={chapterIndex >= chapters.length - 1}
                onClick={() => setChapterIndex((i) => Math.min(chapters.length - 1, i + 1))}
              >
                Próximo capítulo →
              </button>
            </div>
          ) : null}

          {loadState === "loading" ? (
            <div className="read-status">Abrindo o livro — quase lá…</div>
          ) : null}

          {loadState === "error" ? (
            <div className="read-status read-status-err">
              <p>{loadError}</p>
              {book.localStoryUrl != null ? (
                <div className="err-actions">
                  <button type="button" className="btn btn-primary" onClick={retryLoad}>
                    Tentar de novo
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {loadState === "ready" ? (
            <>
              <div
                ref={readRef}
                className="read read-full"
                onScroll={onReadScroll}
                role="article"
                aria-label={chapterMode ? "Texto do capítulo em leitura" : "Texto completo da obra"}
              >
                <pre className="full-book">{displayedStory}</pre>
              </div>
              <div className="nav-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    readRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  {chapterMode ? "Voltar ao início deste capítulo" : "Voltar ao início do livro"}
                </button>
                {book.sourceUrl ? (
                  <a className="btn" href={book.sourceUrl} target="_blank" rel="noreferrer">
                    Ver obra no site do acervo ↗
                  </a>
                ) : null}
              </div>
            </>
          ) : null}
        </section>

        <section className="panel panel-chat">
          <div className="panel-head">
            <h2>Personagens</h2>
            <span className="pill">{character?.name}</span>
          </div>
          <div className="tabs" role="tablist">
            {characters.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                className={`tab ${c.id === activeCharId ? "active" : ""}`}
                onClick={() => setActiveCharId(c.id)}
                style={c.id === activeCharId ? { borderBottomColor: c.color } : undefined}
              >
                {c.name}
              </button>
            ))}
          </div>
          {error ? <div className="err">{error}</div> : null}
          {loading ? (
            <div className="loading">O personagem está escolhendo as palavras…</div>
          ) : null}
          <div ref={chatBodyRef} className="chat-body">
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.role === "assistant" ? (
                  <span className="who" style={{ color: character?.color }}>
                    {character?.name}
                  </span>
                ) : (
                  <span className="who">Você</span>
                )}
                {m.text}
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={onSend}>
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                ready && character
                  ? `Escreva para ${character.name}…`
                  : "Aguarde o livro abrir…"
              }
              disabled={loading || !ready || !character}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend(e);
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !ready || !input.trim()}
            >
              Enviar
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
