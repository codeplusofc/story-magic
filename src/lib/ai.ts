import type { StoryCharacter } from "../data/types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Tom inferido da última mensagem do leitor, para orientar a ramificação narrativa. */
export type ReaderStoryBranch =
  | "confiança e aliança"
  | "ceticismo e distância"
  | "paixão e risco"
  | "desafio e conflito"
  | "calma e observação";

const READER_BRANCH_LABELS: ReaderStoryBranch[] = [
  "confiança e aliança",
  "ceticismo e distância",
  "paixão e risco",
  "desafio e conflito",
  "calma e observação",
];

export function classifyReaderStoryBranchHeuristic(userMessage: string): ReaderStoryBranch {
  const t = userMessage.trim().toLowerCase();
  if (!t) return "calma e observação";
  if (
    /amo|risco|beij|corre|fugi|sentimento|paix(ão|ao)|desej|fogo|corpo|noite/.test(t) ||
    (t.includes("quero") && (t.includes("você") || t.includes("voce")))
  ) {
    return "paixão e risco";
  }
  if (/não confio|nao confio|mentir|engan|prova|duvid|desconfi|cetic|fing/.test(t)) {
    return "ceticismo e distância";
  }
  if (/odeio|mata|revolt|desafi|nunca|exijo|ameaç|ameac|infern|diab/.test(t)) {
    return "desafio e conflito";
  }
  if (/sim\b|junto|aliad|proteg|ajud|fico contigo|estou contigo|acredito|vamos/.test(t)) {
    return "confiança e aliança";
  }
  return "calma e observação";
}

function normalizeBranchLabel(raw: string): ReaderStoryBranch | null {
  const s = raw.trim().toLowerCase();
  for (const label of READER_BRANCH_LABELS) {
    if (s === label.toLowerCase()) return label;
  }
  return null;
}

/** Com IA (se houver chave), senão heurística em português. */
export async function classifyReaderStoryBranch(userMessage: string): Promise<ReaderStoryBranch> {
  const fallback = classifyReaderStoryBranchHeuristic(userMessage);
  if (detectProvider() === "mock") return fallback;

  const system = [
    "Você classifica UMA única etiqueta em português para o tom da mensagem do leitor.",
    `Etiquetas permitidas (responda só com o texto exato de uma delas, sem aspas nem pontuação extra):`,
    READER_BRANCH_LABELS.map((l) => `- ${l}`).join("\n"),
  ].join("\n");

  try {
    const out = await callLlmWith429Fallback(
      system,
      [{ role: "user", content: userMessage.slice(0, 800) }],
      { groqMaxTokens: 40, geminiMaxOutput: 32 },
    );
    const cleaned =
      normalizeBranchLabel(out) ?? normalizeBranchLabel((out.split("\n")[0] ?? "").trim());
    return cleaned ?? fallback;
  } catch {
    return fallback;
  }
}

function mockReply(_character: StoryCharacter, userText: string): string {
  const t = userText.trim().toLowerCase();
  if (!t) {
    return "Estou aqui — diga o que quer saber ou mudar.";
  }
  if (t.includes("medo") || t.includes("assust") || t.includes("fear")) {
    return "Respira. O medo aqui é barulho — o perigo é silêncio demais.";
  }
  if (t.includes("sim") || t.includes("vamos") || t.includes("seguir") || t.includes("yes")) {
    return "Então vamos. Mas fique perto: histórias gostam de testar quem acha que manda.";
  }
  if (t.includes("não") || t.includes("espera") || t.includes("wait")) {
    return "Esperar também é escolha. Só não espere sozinho no escuro.";
  }
  return "Entendi. Não sei se isso muda tudo… mas muda como eu te olho daqui pra frente.";
}

function httpErrorMessage(
  provedor: "Groq" | "Gemini",
  status: number,
  modelOrHint: string,
  corpo: string,
): Error {
  const trecho = corpo.slice(0, 280);
  console.warn(`[${provedor}] HTTP ${status} (${modelOrHint}):`, trecho);
  if (status === 429) {
    return new Error(
      "O serviço de inteligência artificial está no limite de uso no momento. Aguarde um pouco e tente de novo.",
    );
  }
  if (status === 401 || status === 403) {
    return new Error("Não foi possível acessar o serviço de inteligência artificial.");
  }
  return new Error("Não foi possível gerar a resposta agora. Tente de novo em instantes.");
}

async function groqComplete(
  apiKey: string,
  system: string,
  messages: ChatTurn[],
  maxTokens = 400,
): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.85,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw httpErrorMessage("Groq", res.status, "llama-3.1-8b-instant", errText);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("A resposta da IA veio vazia. Tente de novo.");
  return text;
}

function geminiModelId(): string {
  const raw = import.meta.env.VITE_GEMINI_MODEL?.trim();
  // gemini-1.5-flash deixou de existir nesse endpoint para muitas chaves do AI Studio (404).
  return raw || "gemini-2.0-flash";
}

async function geminiComplete(
  apiKey: string,
  system: string,
  messages: ChatTurn[],
  maxOutputTokens = 512,
): Promise<string> {
  const contents = messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));
  const model = geminiModelId();
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  );
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.9, maxOutputTokens },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw httpErrorMessage("Gemini", res.status, model, errText);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim();
  if (!text) throw new Error("A resposta da IA veio vazia. Tente de novo.");
  return text;
}

export function detectProvider(): "groq" | "gemini" | "mock" {
  if (import.meta.env.VITE_GROQ_API_KEY?.trim()) return "groq";
  if (import.meta.env.VITE_GEMINI_API_KEY?.trim()) return "gemini";
  return "mock";
}

function hasGroqKey(): boolean {
  return Boolean(import.meta.env.VITE_GROQ_API_KEY?.trim());
}

function hasGeminiKey(): boolean {
  return Boolean(import.meta.env.VITE_GEMINI_API_KEY?.trim());
}

/** Texto curto para o pill da UI. */
export function providerDisplayLabel(): string {
  const g = hasGroqKey();
  const m = hasGeminiKey();
  if (g && m) return "Groq + Gemini (troca em 429)";
  if (g) return "Groq (grátis)";
  if (m) return "Gemini (grátis)";
  return "Modo demo (sem chave)";
}

function is429Error(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("429") || err.message.includes("limite de uso");
}

type LlmCallOpts = { groqMaxTokens?: number; geminiMaxOutput?: number };

async function callLlmWith429Fallback(
  system: string,
  messages: ChatTurn[],
  opts?: LlmCallOpts,
): Promise<string> {
  const groqKey = import.meta.env.VITE_GROQ_API_KEY?.trim();
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY?.trim();
  const gMax = opts?.groqMaxTokens ?? 400;
  const mMax = opts?.geminiMaxOutput ?? 512;

  const chain: Array<{ id: string; run: () => Promise<string> }> = [];
  if (groqKey) chain.push({ id: "groq", run: () => groqComplete(groqKey, system, messages, gMax) });
  if (geminiKey)
    chain.push({ id: "gemini", run: () => geminiComplete(geminiKey, system, messages, mMax) });

  if (chain.length === 0) {
    throw new Error("Nenhum serviço de IA está configurado neste ambiente.");
  }

  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    try {
      return await chain[i].run();
    } catch (e) {
      lastErr = e;
      const canTryNext = is429Error(e) && i < chain.length - 1;
      if (!canTryNext) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function characterReply(params: {
  character: StoryCharacter;
  history: ChatTurn[];
  userMessage: string;
  ebookTitle?: string;
  ebookAuthor?: string;
  /** Trecho do texto integral perto da posição de leitura. */
  textExcerpt: string;
  /** 0–100: posição aproximada no livro. */
  readingProgressPct: number;
  /** Idioma principal do texto na tela. */
  textLanguage: "pt" | "en";
}): Promise<string> {
  const {
    character,
    history,
    userMessage,
    ebookTitle,
    ebookAuthor,
    textExcerpt,
    readingProgressPct,
    textLanguage,
  } = params;
  const provider = detectProvider();

  const langNote =
    textLanguage === "en"
      ? "O leitor está lendo o texto original em inglês na tela. Trecho próximo da posição atual (pode começar/terminar com reticências):"
      : "O leitor está lendo o texto em português na tela. Trecho próximo da posição atual:";

  const obra =
    ebookTitle && ebookAuthor
      ? `Obra: "${ebookTitle}" (${ebookAuthor}). Mantenha fidelidade ao espírito do personagem.`
      : ebookTitle
        ? `História: "${ebookTitle}".`
        : null;

  const storyContext = [
    `Posição aproximada de leitura: ${Math.round(readingProgressPct)}% do livro.`,
    langNote,
    textExcerpt.slice(0, 4500),
  ].join("\n");

  const system = [
    `Você é ${character.name}, ${character.role} em uma experiência de leitura interativa do livro acima.`,
    ...(obra ? [obra] : []),
    character.systemHint,
    "O leitor vê o texto integral na interface; não resuma o livro inteiro. Responda à mensagem do leitor como o personagem.",
    "Não invente fatos enormes que contradigam grosseiramente a obra; se o leitor pedir fanfiction, deixe claro que é brincadeira ou ramificação imaginada.",
    storyContext,
  ].join("\n");

  const messages: ChatTurn[] = [...history, { role: "user", content: userMessage }];

  if (provider === "mock") {
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
    return mockReply(character, userMessage);
  }

  return callLlmWith429Fallback(system, messages);
}

/** Frases curtas do leitor que pedem avanço da cena no painel de leitura. */
export function wantsStoryContinuation(userMessage: string): boolean {
  const t = userMessage.trim().toLowerCase();
  if (t.length > 160) return false;
  const checks = [
    /\b(quero\s+)?(seguir|continuar|continua|prosseguir|avançar|avancar)\b/,
    /\bcontinua(r)?\s+(a\s+)?hist(o|ó)ria\b/,
    /\bcontinua(r)?\s+(o\s+)?cap[ií]tulo\b/,
    /\b(adiciona|acrescenta|inventa)\s+(algo\s+)?(no\s+)?cap[ií]tulo\b/,
    /\b(vamos|vamo)\s+(seguir|adiante|em\s+frente)\b/,
    /\b(ir\s+)?em\s+frente\b/,
    /^(seguir|continuar|prosseguir)\s*[!?.…]*$/i,
  ];
  return checks.some((re) => re.test(t));
}

/** Gera trecho narrativo em terceira pessoa para anexar ao livro (painel esquerdo). */
export async function narrateStoryContinuation(params: {
  bookTitle: string;
  bookAuthor: string;
  storySoFarTail: string;
  userMessage: string;
  characterName: string;
  characterReply: string;
  textLanguage: "pt" | "en";
  /** Quando definido, a continuação inclina-se a esse tom (ramificação interativa). */
  readerBranch?: ReaderStoryBranch;
  /** Se o leitor pediu extensão só de um capítulo, restringe o desdobramento a esse bloco. */
  chapterLabel?: string;
}): Promise<string> {
  const provider = detectProvider();
  const lang =
    params.textLanguage === "en"
      ? "English, third person, literary tone matching the excerpt."
      : "português do Brasil, terceira pessoa, tom literário coerente com o trecho.";

  const branchNote = params.readerBranch
    ? `Esta passagem é uma ramificação: o leitor empurrou o enredo na direção de "${params.readerBranch}". Deixe essa tonalidade moldar o que acontece a seguir, sem negar o texto já lido — é um desdobramento possível, como se o leitor estivesse na sala com os personagens.`
    : "";

  const chapterNote = params.chapterLabel
    ? `O leitor pediu material extra só no âmbito do trecho "${params.chapterLabel}". Escreva uma continuação que encaixe logo após o final desse capítulo/trecho (não salte para capítulos posteriores da obra).`
    : "";

  const system = [
    `Você é o narrador onisciente de "${params.bookTitle}" (${params.bookAuthor}).`,
    `Escreva APENAS a continuação da história em ${lang}`,
    "2 a 5 parágrafos curtos. Sem título. Sem prefixos como \"Narrador:\". Sem lista numerada.",
    `Não repita o trecho fornecido; avance a cena. Incorpore o clima da fala do leitor e o que ${params.characterName} acabou de responder.`,
    branchNote,
    chapterNote,
  ]
    .filter(Boolean)
    .join("\n");

  const userPayload = [
    "--- Final recente da história (contexto) ---",
    params.storySoFarTail.slice(-2800),
    "--- Fala do leitor ---",
    params.userMessage,
    `--- Resposta recente de ${params.characterName} ---`,
    params.characterReply,
  ].join("\n\n");

  const messages: ChatTurn[] = [{ role: "user", content: userPayload }];

  if (provider === "mock") {
    await new Promise((r) => setTimeout(r, 450));
    const b = params.readerBranch ?? "calma e observação";
    if (params.textLanguage === "pt") {
      const lines: Record<ReaderStoryBranch, string> = {
        "confiança e aliança":
          "Algo se afrouxa no ar — não é trégua completa, mas um acordo tácito. Os passos encontram ritmo comum; até o silêncio parece combinado. O que vem à frente ainda guarda espinhos, porém agora há duas sombras caminhando na mesma direção.",
        "ceticismo e distância":
          "Cada gesto passa a ser medido duas vezes. O olhar demora um instante a mais nas mãos, nas fechaduras, nas palavras ditas com doçura demais. A cena não explode; ela esfria, e nesse frio nascem perguntas que ninguém quer nomear em voz alta.",
        "paixão e risco":
          "O pulso dispara onde a etiqueta manda calar. Um detalhe insignificante — um olhar um segundo longo demais — vira faísca. O risco não anuncia chegada com trombetas; ele se senta perto, quente, como se já fosse tarde para recuar sem pagar preço.",
        "desafio e conflito":
          "As palavras deixam de ser véu. O que era insinuação vira linha na areia: alguém avança, alguém recua com a espinha eriçada. O ambiente estreita; até o mobiliário parece encostar nas costas, empurrando a cena para o confronto que estava adiado.",
        "calma e observação":
          "O tempo da sala desacelera. Ninguém precisa gritar para que o peso se note: é na ordem das xícaras, na poeira no raio de sol, no jeito de segurar a saia ou a luva. Nesse ritmo, os detalhes falam alto — e a história escuta antes de decidir o próximo passo.",
      };
      return lines[b];
    }
    return "The moment tilts—not toward noise, but toward consequence. What follows refuses a tidy name; it insists, step by step, on becoming inevitable.";
  }

  return callLlmWith429Fallback(system, messages, {
    groqMaxTokens: 720,
    geminiMaxOutput: 768,
  });
}
