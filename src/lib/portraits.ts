import type { StoryCharacter } from "../data/types";

/**
 * Foto de perfil dos personagens no chat, sem chave e sem gastar os tokens de IA do chat:
 * 1. Ilustração livre da Wikipedia/Commons, quando o personagem é famoso (Sherlock, Drácula…).
 * 2. Retrato gerado pelo Pollinations (serviço gratuito de imagens) a partir de nome, papel e livro.
 *    A "semente" fixa faz o mesmo personagem ter sempre o mesmo rosto.
 * 3. Se nada der certo, o avatar continua com a inicial do nome.
 *
 * Cada retrato é pedido uma vez por aparelho (fila de um por vez, para não esbarrar no limite do
 * serviço gratuito) e fica guardado: o endereço aqui, a imagem no cache do navegador e do app.
 *
 * Marca d'água: sem registro, o Pollinations coloca o logo dele no canto. Registrando o domínio do
 * site em auth.pollinations.ai (grátis), os retratos passam a vir sem logo — nada muda no código.
 */

const CACHE_KEY = "storyverse:portraits";
const SIZE = 256;
const LOAD_TIMEOUT_MS = 45_000;

type PortraitCache = Record<string, string>;

function readCache(): PortraitCache {
  try {
    return (JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as PortraitCache) ?? {};
  } catch {
    return {};
  }
}

function writeCache(key: string, url: string) {
  try {
    const all = readCache();
    all[key] = url;
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Sem armazenamento: o retrato só é pedido de novo na próxima visita.
  }
}

export function portraitKey(character: StoryCharacter, bookTitle: string): string {
  return `${bookTitle}::${character.name}`.toLowerCase();
}

/** Retrato já conhecido neste aparelho (carrega na hora, sem pedir nada a ninguém). */
export function cachedPortrait(character: StoryCharacter, bookTitle: string): string | null {
  return readCache()[portraitKey(character, bookTitle)] ?? null;
}

/** Número estável a partir do texto: mesma semente, mesmo rosto. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 1_000_000;
}

function pollinationsUrl(character: StoryCharacter, bookTitle: string): string {
  const prompt = [
    `portrait of ${character.name}`,
    character.role,
    `character from the classic novel "${bookTitle}"`,
    "19th century oil painting style, head and shoulders, face centered, soft warm light",
    "dark plain background, no text, no frame, no border",
  ].join(", ");
  const params = new URLSearchParams({
    width: String(SIZE),
    height: String(SIZE),
    seed: String(seedOf(portraitKey(character, bookTitle))),
    nologo: "true",
    model: "flux",
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
}

type WikiSummary = { description?: string; thumbnail?: { source?: string } };

const plain = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * O nome do arquivo precisa citar o personagem: a página da Irene Adler, por exemplo, usa a capa
 * de um livro do Sherlock como imagem — e isso não é retrato dela.
 */
function fileMentions(src: string, name: string): boolean {
  const file = plain(decodeURIComponent(src.split("/").pop() ?? ""));
  return plain(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .some((w) => file.includes(w));
}

/** Ilustração do Commons (licença livre), só se a Wikipedia disser que é mesmo um personagem. */
async function commonsPortrait(character: StoryCharacter): Promise<string | null> {
  const name = character.name.trim();
  const tries: [string, string][] = [
    ["pt", `${name} (personagem)`],
    ["pt", name],
    ["en", `${name} (character)`],
    ["en", name],
  ];
  for (const [lang, title] of tries) {
    try {
      const res = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      );
      if (!res.ok) continue;
      const data = (await res.json()) as WikiSummary;
      const src = data.thumbnail?.source;
      const isCharacter = /personagem|fict[ií]ci|character|fictional/i.test(data.description ?? "");
      // Imagens em /wikipedia/commons/ têm licença livre; as de /wikipedia/pt|en/ podem ser "uso justo".
      if (src && isCharacter && src.includes("/wikipedia/commons/") && fileMentions(src, name)) return src;
    } catch {
      // Sem Wikipedia: segue para o retrato gerado.
    }
  }
  return null;
}

/** Carrega a imagem de verdade (e deixa no cache do navegador) antes de mostrar. */
function preload(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img.naturalWidth > 0);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    img.src = url;
  });
}

/** Um pedido por vez: o serviço gratuito recusa vários pedidos simultâneos do mesmo aparelho. */
let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<string | null>>();

export function requestPortrait(character: StoryCharacter, bookTitle: string): Promise<string | null> {
  const key = portraitKey(character, bookTitle);
  const cached = readCache()[key];
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = queue.then(async () => {
    const commons = await commonsPortrait(character);
    if (commons && (await preload(commons))) {
      writeCache(key, commons);
      return commons;
    }
    const generated = pollinationsUrl(character, bookTitle);
    // Uma segunda tentativa se o serviço estiver ocupado.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await preload(generated)) {
        writeCache(key, generated);
        return generated;
      }
      await new Promise((r) => window.setTimeout(r, 4000));
    }
    return null;
  });
  queue = job.catch(() => null);
  const result = job.catch(() => null).finally(() => inFlight.delete(key));
  inFlight.set(key, result);
  return result;
}
