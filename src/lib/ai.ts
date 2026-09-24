import type { StoryCharacter } from "../data/types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Quantas mensagens anteriores vão para a IA (o custo por mensagem fica constante). */
const HISTORY_WINDOW = 10;
/** Mensagens antigas muito longas são cortadas antes de ir no histórico. */
const HISTORY_MSG_MAX_CHARS = 600;
/** Tamanho máximo do trecho do livro enviado junto com cada mensagem. */
const EXCERPT_MAX_CHARS = 2000;
/** Limite de tokens da resposta do personagem (falas de chat são curtas). */
const REPLY_MAX_TOKENS = 250;
/** Tamanho máximo da mensagem do leitor (também aplicado no textarea). */
export const USER_MESSAGE_MAX_CHARS = 500;
/** Folga extra para modelos que raciocinam antes de responder (gpt-oss, qwen3). */
const REASONING_MAX_TOKENS = 200;
/** Tempo que um modelo fica "de castigo" depois de responder 429, quando a API não diz. */
const DEFAULT_COOLDOWN_MS = 60_000;

function mockReply(_character: StoryCharacter, userText: string): string {
  const t = userText.trim().toLowerCase();
  if (!t) {
    return "Estou aqui — diga o que quer saber.";
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

class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
  }
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

async function toHttpError(label: string, res: Response): Promise<LlmHttpError> {
  const corpo = await res.text().catch(() => "");
  console.warn(`[${label}] HTTP ${res.status}:`, corpo.slice(0, 280));
  return new LlmHttpError(res.status, retryAfterMs(res), `${label} HTTP ${res.status}`);
}

/** Groq e OpenRouter usam o mesmo formato de API (compatível com OpenAI). */
async function openAiCompatibleComplete(
  label: string,
  endpoint: string,
  apiKey: string,
  model: string,
  system: string,
  messages: ChatTurn[],
  maxTokens: number,
): Promise<string> {
  // Modelos que "pensam" antes de responder: pede raciocínio curto e deixa folga de tokens
  // para ele, senão a resposta sai vazia ou cortada.
  const reasoning: Record<string, unknown> = model.includes("gpt-oss")
    ? { reasoning_effort: "low" }
    : model.includes("qwen3")
      ? { reasoning_format: "hidden" }
      : {};
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.85,
      max_tokens: Object.keys(reasoning).length > 0 ? maxTokens + REASONING_MAX_TOKENS : maxTokens,
      ...(endpoint.includes("groq.com") ? reasoning : {}),
    }),
  });
  if (!res.ok) throw await toHttpError(label, res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${label}: resposta vazia`);
  return text;
}

async function geminiComplete(
  label: string,
  apiKey: string,
  model: string,
  system: string,
  messages: ChatTurn[],
  maxTokens: number,
): Promise<string> {
  const contents = messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  );
  url.searchParams.set("key", apiKey);

  // Prefira os modelos "lite": os maiores gastam os tokens de saída pensando e cortam a resposta.
  const generationConfig = { temperature: 0.9, maxOutputTokens: maxTokens };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig,
    }),
  });
  if (!res.ok) throw await toHttpError(label, res);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim();
  if (!text) throw new Error(`${label}: resposta vazia`);
  return text;
}

type Provider = {
  /** Identificador único (provedor + modelo), usado no controle de cota. */
  id: string;
  run: (system: string, messages: ChatTurn[], maxTokens: number) => Promise<string>;
};

function modelList(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/**
 * Cadeia de reservas: cada modelo de cada provedor tem cota própria no plano gratuito,
 * então tentar vários em sequência soma as cotas.
 */
function buildProviderChain(): Provider[] {
  const env = import.meta.env;
  const chain: Provider[] = [];

  const groqKey = env.VITE_GROQ_API_KEY?.trim();
  if (groqKey) {
    for (const model of modelList(env.VITE_GROQ_MODELS, [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ])) {
      const id = `groq:${model}`;
      chain.push({
        id,
        run: (s, m, t) =>
          openAiCompatibleComplete(
            id,
            "https://api.groq.com/openai/v1/chat/completions",
            groqKey,
            model,
            s,
            m,
            t,
          ),
      });
    }
  }

  const geminiKey = env.VITE_GEMINI_API_KEY?.trim();
  if (geminiKey) {
    // O Google aposenta modelos com frequência; "*-latest" sempre aponta para o atual.
    for (const model of modelList(env.VITE_GEMINI_MODEL, [
      "gemini-3.5-flash-lite",
      "gemini-flash-lite-latest",
    ])) {
      const id = `gemini:${model}`;
      chain.push({ id, run: (s, m, t) => geminiComplete(id, geminiKey, model, s, m, t) });
    }
  }

  const openRouterKey = env.VITE_OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    for (const model of modelList(env.VITE_OPENROUTER_MODELS, [
      "meta-llama/llama-3.3-70b-instruct:free",
    ])) {
      const id = `openrouter:${model}`;
      chain.push({
        id,
        run: (s, m, t) =>
          openAiCompatibleComplete(
            id,
            "https://openrouter.ai/api/v1/chat/completions",
            openRouterKey,
            model,
            s,
            m,
            t,
          ),
      });
    }
  }

  return chain;
}

const providerChain = buildProviderChain();

/** Até quando (timestamp) cada modelo deve ser pulado por ter estourado a cota. */
const cooldownUntil = new Map<string, number>();

export function detectProvider(): "live" | "mock" {
  return providerChain.length > 0 ? "live" : "mock";
}

/** Texto curto para o pill da UI (linguagem para quem lê, não para quem desenvolve). */
export function providerDisplayLabel(): string {
  if (providerChain.length > 1) return "IA ativa (com serviço reserva)";
  if (providerChain.length === 1) return "IA ativa";
  return "Modo demonstração";
}

async function callLlmWithFallback(
  system: string,
  messages: ChatTurn[],
  maxTokens = REPLY_MAX_TOKENS,
): Promise<string> {
  if (providerChain.length === 0) {
    throw new Error("Nenhum serviço de IA está configurado neste ambiente.");
  }

  const now = Date.now();
  const available = providerChain.filter((p) => (cooldownUntil.get(p.id) ?? 0) <= now);
  // Se todos estão em espera, tenta mesmo assim: a cota pode já ter voltado.
  const order = available.length > 0 ? available : providerChain;

  let sawRateLimit = false;
  for (const p of order) {
    try {
      const text = await p.run(system, messages, maxTokens);
      cooldownUntil.delete(p.id);
      return text;
    } catch (e) {
      // Qualquer falha (cota, modelo removido, chave inválida, rede) passa para o próximo.
      if (e instanceof LlmHttpError && e.status === 429) {
        sawRateLimit = true;
        cooldownUntil.set(p.id, Date.now() + (e.retryAfterMs ?? DEFAULT_COOLDOWN_MS));
      }
    }
  }

  throw new Error(
    sawRateLimit
      ? "O serviço de inteligência artificial está no limite de uso no momento. Aguarde um pouco e tente de novo."
      : "Não foi possível gerar a resposta agora. Tente de novo em instantes.",
  );
}

function trimHistory(history: ChatTurn[]): ChatTurn[] {
  const recent = history.slice(-HISTORY_WINDOW).map((m) => ({
    role: m.role,
    content:
      m.content.length > HISTORY_MSG_MAX_CHARS
        ? `${m.content.slice(0, HISTORY_MSG_MAX_CHARS)}…`
        : m.content,
  }));
  // Gemini exige que a conversa comece pelo usuário.
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return recent;
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

  if (detectProvider() === "mock") {
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
    return mockReply(character, userMessage);
  }

  const langNote =
    textLanguage === "en"
      ? "O leitor lê o original em inglês. Trecho perto da posição atual:"
      : "Trecho perto da posição atual de leitura:";

  const obra =
    ebookTitle && ebookAuthor
      ? `Obra: "${ebookTitle}" (${ebookAuthor}).`
      : ebookTitle
        ? `Obra: "${ebookTitle}".`
        : null;

  // Partes fixas primeiro e o trecho variável no fim.
  const system = [
    `Você é ${character.name}, ${character.role}, conversando com um leitor durante a leitura.`,
    ...(obra ? [obra] : []),
    character.systemHint,
    "Responda como o personagem, de forma breve. Não resuma o livro nem narre cenas novas; seja fiel à obra.",
    "Não revele acontecimentos que vêm depois do trecho em que o leitor está (sem spoilers).",
    `Posição de leitura: ~${Math.round(readingProgressPct)}% do livro.`,
    langNote,
    textExcerpt.slice(0, EXCERPT_MAX_CHARS),
  ].join("\n");

  const messages: ChatTurn[] = [
    ...trimHistory(history),
    { role: "user", content: userMessage.slice(0, USER_MESSAGE_MAX_CHARS) },
  ];

  return callLlmWithFallback(system, messages);
}

const CAST_COLORS = ["#c9a88c", "#9eb8c9", "#c49ab8", "#9cb9a8", "#c4b07a"];

/** Personagem neutro usado quando a IA não está disponível ou falha ao sugerir o elenco. */
export function narratorCharacter(title: string): StoryCharacter {
  return {
    id: "narrador",
    name: "Narrador",
    role: "A voz que conta esta história",
    color: CAST_COLORS[0],
    systemHint: `Você é o narrador de "${title}": conhece a obra por dentro, comenta personagens e cenas com tom literário, sem spoilers. Responda em português do Brasil, 2–4 frases.`,
  };
}

/**
 * Pede à IA os personagens principais de um livro que não tem elenco escrito à mão.
 * Chamada uma única vez por livro (o resultado fica guardado no navegador).
 */
export async function suggestBookCharacters(params: {
  title: string;
  author: string;
  /** Início do livro, para obras que o modelo talvez não conheça. */
  opening: string;
}): Promise<StoryCharacter[]> {
  if (detectProvider() === "mock") return [narratorCharacter(params.title)];

  const system = [
    "Você escolhe personagens de livros para um app onde leitores conversam com eles.",
    "Responda APENAS com um array JSON, sem texto antes ou depois, no formato:",
    '[{"name":"Nome completo","shortName":"Nome curto","role":"papel na história em até 6 palavras","personality":"personalidade e jeito de falar em 1–2 frases"}]',
    "Escolha de 2 a 3 personagens principais que existem de verdade na obra. Campos role e personality em português do Brasil.",
  ].join("\n");

  const user = [
    `Livro: "${params.title}" — ${params.author}.`,
    "Início do texto:",
    params.opening.slice(0, 1500),
  ].join("\n");

  try {
    const out = await callLlmWithFallback(system, [{ role: "user", content: user }], 500);
    const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
    const list = JSON.parse(json) as {
      name?: string;
      shortName?: string;
      role?: string;
      personality?: string;
    }[];
    const cast = list
      .filter((c) => c.name && c.personality)
      .slice(0, 3)
      .map((c, i) => ({
        id: `ia-${i}`,
        name: c.name!.trim(),
        shortName: c.shortName?.trim() || undefined,
        role: c.role?.trim() || "Personagem da história",
        color: CAST_COLORS[i % CAST_COLORS.length],
        systemHint: `Você é ${c.name} em "${params.title}". ${c.personality} Responda em português do Brasil, em primeira pessoa, 2–4 frases.`,
      }));
    return cast.length > 0 ? cast : [narratorCharacter(params.title)];
  } catch (e) {
    console.warn("Falha ao sugerir personagens:", e);
    return [narratorCharacter(params.title)];
  }
}
