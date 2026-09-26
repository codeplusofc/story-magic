import type { Ebook, StoryCharacter } from "../data/types";
import { CAST_COLORS, suggestBookCharacters } from "./ai";

const CAST_KEY = (bookId: string) => `storyverse:cast:${bookId}`;

function readCached(bookId: string): StoryCharacter[] | null {
  try {
    const raw = localStorage.getItem(CAST_KEY(bookId));
    const list = raw ? (JSON.parse(raw) as StoryCharacter[]) : null;
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

/**
 * Elenco digitado pelo leitor ao importar um livro, um por linha: "Nome" ou "Nome — quem é".
 * Não chama a IA: o modelo já conhece os personagens de livros famosos pelo nome.
 */
export function castFromNames(title: string, raw: string): StoryCharacter[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line, i) => {
      const [name, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
      const about = rest.join(" ").trim();
      return {
        id: `leitor-${i}`,
        name: name.trim(),
        role: about || `Personagem de ${title}`,
        color: CAST_COLORS[i % CAST_COLORS.length],
        systemHint: [
          `Você é ${name.trim()} em "${title}".`,
          about ? `Quem você é: ${about}.` : "",
          "Fale como esse personagem da obra, com a personalidade e o jeito de falar dele, em primeira pessoa, em português do Brasil, em 2 a 4 frases.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    })
    .filter((c) => c.name.length > 0);
}

export function forgetCast(bookId: string) {
  try {
    localStorage.removeItem(CAST_KEY(bookId));
  } catch {
    // Nada a limpar.
  }
}

/** Elenco do livro: escrito à mão, guardado no navegador, ou sugerido pela IA (uma vez só). */
export async function loadCast(book: Ebook, opening: string): Promise<StoryCharacter[]> {
  if (book.characters?.length) return book.characters;
  const cached = readCached(book.id);
  if (cached) return cached;

  const cast = await suggestBookCharacters({ title: book.title, author: book.author, opening });
  // Só guarda elenco de verdade; o narrador de reserva pode ser trocado quando a IA voltar.
  if (!(cast.length === 1 && cast[0].id === "narrador")) {
    try {
      localStorage.setItem(CAST_KEY(book.id), JSON.stringify(cast));
    } catch {
      // Sem armazenamento: a IA será chamada de novo na próxima vez.
    }
  }
  return cast;
}
